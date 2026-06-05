/**
 * Cautious persona-proposal triage adapter (#1327).
 *
 * This module owns persona-specific policy while preserving the shared
 * pending-autopilot #1334 decision, reason, redaction, dry-run, lock/CAS, and
 * audit envelope. Proposal text is treated as untrusted input: it is never used
 * as instructions and raw proposal bodies are not persisted in output/audit.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProposalEntry, ProposalsDB } from "../backends/proposals-db.js";
import { buildAppliedContent, buildUnifiedDiff, parseSuggestedChange } from "../cli/proposals.js";
import type { HybridMemoryConfig } from "../config.js";
import { emitPersonaApplied, supersedeActiveProposedEvent, syncProposalWithdrawnInChangeFeed } from "./change-feed-emit.js";
import type { ChangeFeed } from "./change-feed.js";
import { writeProposalRollback } from "./proposal-rollback.js";
import { getEnv } from "../utils/env-manager.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { nowIso } from "../utils/dates.js";
import {
  type AutopilotMode,
  type PendingAutopilotCursor,
  type PendingDecision,
  type PendingDecisionActorContext,
  type PendingDecisionContext,
  type PendingItem,
  type PendingQueueAdapter,
  PendingAutopilotStore,
  canonicalJson,
  computePendingInputHash,
  createPendingAutopilotRunId,
  createStableRunSummary,
  redactAutopilotValue,
  shouldAdvancePendingCursor,
} from "./pending-autopilot/index.js";

export const PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION = "persona-proposal-triage-v1";
export const PERSONA_APPLY_CONFIDENCE_THRESHOLD = 0.95;
export const PERSONA_REJECT_CONFIDENCE_THRESHOLD = 0.7;

export type PersonaProposalTriagePolicy = "report-only" | "cautious" | "apply-safe";
export type PersonaProposalRisk = "low" | "medium" | "high" | "critical";
export const PERSONA_PROPOSAL_SENSITIVE_TARGET_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md"] as const;
export const PERSONA_PROPOSAL_CRITICAL_TARGET_FILES = [...PERSONA_PROPOSAL_SENSITIVE_TARGET_FILES, "TOOLS.md"] as const;
export type PersonaProposalTargetFile = (typeof PERSONA_PROPOSAL_CRITICAL_TARGET_FILES)[number];

export interface PersonaProposalTriageOptions {
  proposalsDb: ProposalsDB;
  cfg: Pick<HybridMemoryConfig, "personaProposals" | "liveChangeFeed">;
  stateDbPath?: string;
  workspace?: string;
  mode?: AutopilotMode;
  policy?: PersonaProposalTriagePolicy;
  max?: number;
  proposalId?: string;
  runId?: string;
  jobId?: string;
  actor?: PendingDecisionActorContext;
  now?: Date;
  runLifecycle?: "standalone" | "embedded";
  store?: PendingAutopilotStore;
  changeFeed?: ChangeFeed | null;
  sessionKey?: string;
  resolvedSqlitePath?: string;
}

export interface PersonaProposalTriageResult {
  schemaVersion: 1;
  runId: string;
  mode: AutopilotMode;
  policy: PersonaProposalTriagePolicy;
  policyVersion: string;
  counts: {
    inspected: number;
    classified: number;
    grouped: number;
    autoRejected: number;
    autoApplied: number;
    deferredForHuman: number;
    failedValidation: number;
    skippedByPolicy: number;
  };
  decisions: PersonaProposalDecisionView[];
  bundles: PersonaProposalReviewBundle[];
  humanSummary: string;
}

export interface PersonaProposalDecisionView {
  proposalId: string;
  targetFile: string;
  risk: PersonaProposalRisk;
  action: PendingDecision["action"];
  reason: PendingDecision["reasonCode"];
  capability: PendingDecision["capabilityClass"];
  confidence: number;
  humanReviewRequired: boolean;
  evidence: PendingDecision["evidence"];
  diffSummary: string;
  inputHash: string;
  targetHash: string | null;
}

export interface PersonaProposalReviewBundle {
  id: string;
  targetFile: string;
  risk: PersonaProposalRisk;
  recommendation: "reject" | "defer";
  proposalIds: string[];
  reasons: string[];
  rationale: string;
  commands: string[];
  evidence: PendingDecision["evidence"];
  diffPreview: string;
}

type PersonaProposalPayload = {
  proposalId: string;
  targetFile: string;
  title: string;
  confidence: number;
  evidenceSessions: string[];
  createdAt: number;
  targetHash: string | null;
  proposalHash: string;
};

export type PersonaProposalPendingItem = PendingItem<PersonaProposalPayload> & {
  proposal: ProposalEntry;
  targetPath: string;
  targetValid: boolean;
  targetHash: string | null;
  workspace: string;
};

type Analysis = {
  risk: PersonaProposalRisk;
  action: PendingDecision["action"];
  reasonCode: PendingDecision["reasonCode"];
  actionClass: PendingDecision["actionClass"];
  capabilityClass: PendingDecision["capabilityClass"];
  confidence: number;
  humanReviewRequired: boolean;
  diffSummary: string;
  evidence: PendingDecision["evidence"];
  applyAllowed: boolean;
};

const SENSITIVE_PERSONA_FILES = new Set<string>(PERSONA_PROPOSAL_SENSITIVE_TARGET_FILES);
const CRITICAL_TARGETS = new Set<string>(PERSONA_PROPOSAL_CRITICAL_TARGET_FILES);
const LOW_RISK_DRIFT_THRESHOLD = 2;
const SENSITIVE_TOOLS_RE = /^TOOLS\.md$/i;

function normalizePersonaProposalTriageMax(max: number | undefined): number {
  if (max === undefined) return 20;
  if (!Number.isFinite(max) || !Number.isInteger(max) || max < 0) {
    throw new Error(`persona proposal triage max must be a non-negative finite integer. Got: ${max}`);
  }
  return max;
}

export function createPersonaProposalTriageAdapter(input: {
  proposalsDb: ProposalsDB;
  cfg: Pick<HybridMemoryConfig, "personaProposals">;
  workspace?: string;
  allProposals?: ProposalEntry[];
  proposalId?: string;
}): PendingQueueAdapter<PersonaProposalPendingItem> & {
  proposalsDb: ProposalsDB;
  cfg: Pick<HybridMemoryConfig, "personaProposals">;
  workspace: string;
} {
  return {
    queue: "persona",
    listPending: (cursor) => listPersonaProposalItems(input, cursor),
    decide: (item, context) => decidePersonaProposal(item, context, input),
    apply: () => {
      throw new Error("Use runPersonaProposalTriage for lock/CAS guarded apply semantics.");
    },
    proposalsDb: input.proposalsDb,
    cfg: input.cfg,
    workspace: input.workspace ?? defaultWorkspace(),
  };
}

export async function runPersonaProposalTriage(
  opts: PersonaProposalTriageOptions,
): Promise<PersonaProposalTriageResult> {
  const mode = opts.mode ?? "dry-run";
  const policy = opts.policy ?? "report-only";
  validatePersonaPolicy(policy);
  if (mode !== "dry-run" && mode !== "apply") throw new Error(`Unsupported mode: ${mode}`);
  const max = normalizePersonaProposalTriageMax(opts.max);
  const runId = opts.runId ?? createPendingAutopilotRunId();
  const actor = opts.actor ?? ({ type: "agent", id: "persona-proposal-triage" } as const);
  const workspace = opts.workspace ?? defaultWorkspace();
  const stateDbPath = opts.stateDbPath ?? join(workspace, "memory", "pending-autopilot.db");
  const manageRunLifecycle = opts.runLifecycle !== "embedded";
  let store: PendingAutopilotStore | null = null;
  const allProposals = opts.proposalsDb.list();
  const adapter = createPersonaProposalTriageAdapter({
    proposalsDb: opts.proposalsDb,
    cfg: opts.cfg,
    workspace,
    allProposals,
    proposalId: opts.proposalId,
  });
  const decisions: PendingDecision[] = [];
  const views: PersonaProposalDecisionView[] = [];
  const startedAt = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const runInputHash = computePendingInputHash({ command: "proposals triage", mode, policy, max, startedAt: 0 });
  let cursorAdvanceCandidate: { decision: PendingDecision; cursor: string } | null = null;
  let cursorAdvanceBlocked = false;
  const ownStore = !opts.store;

  try {
    store =
      opts.store ?? (mode === "apply" && policy !== "report-only" ? new PendingAutopilotStore(stateDbPath) : null);
    if (manageRunLifecycle) {
      store?.createRun({
        runId,
        mode,
        policy,
        policyVersion: PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
        inputHash: runInputHash,
        queues: ["persona"],
        startedAt,
      });
    }

    const cursor = store?.getCursor("persona", policy) ?? null;
    const listed = await adapter.listPending(cursor);
    const pending = listed.slice(0, max);
    for (const item of pending) {
      const context: PendingDecisionContext = {
        runId,
        jobId: opts.jobId,
        mode,
        policy,
        policyVersion: PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
        inputHash: item.inputHash,
        actor,
      };
      const freshProposals = mode === "apply" ? opts.proposalsDb.list() : allProposals;
      const freshAdapter =
        mode === "apply"
          ? createPersonaProposalTriageAdapter({
              proposalsDb: opts.proposalsDb,
              cfg: opts.cfg,
              workspace,
              allProposals: freshProposals,
              proposalId: opts.proposalId,
            })
          : adapter;
      let decision = await freshAdapter.decide(item, context);
      if (mode === "apply" && policy !== "report-only" && isMutationDecision(decision)) {
        if (!store) throw new Error("apply mode requires pending-autopilot store");
        decision = applyPersonaDecisionWithLock({
          store,
          proposalsDb: opts.proposalsDb,
          item,
          decision,
          workspace,
          cfg: opts.cfg,
          changeFeed: opts.changeFeed,
          sessionKey: opts.sessionKey ?? "autopilot",
          resolvedSqlitePath: opts.resolvedSqlitePath,
        });
        if (decision.action === "failed-validation") {
          store.recordDecision(decision);
        } else {
          // Successful mutation decisions are already recorded inside mutateWithLockAndAudit
        }
      } else if (policy !== "report-only") {
        store?.recordDecision(decision);
      }
      const itemCursor = item.visibleAfterCursor ?? item.id;
      if (shouldAdvancePendingCursor(decision)) {
        if (!cursorAdvanceBlocked) {
          cursorAdvanceCandidate = { decision, cursor: itemCursor };
        }
      } else {
        cursorAdvanceBlocked = true;
      }
      decisions.push(decision);
      views.push(decisionToView(item, decision));
    }
    if (
      policy !== "report-only" &&
      opts.proposalId === undefined &&
      cursorAdvanceCandidate !== null &&
      pending.length > 0
    ) {
      store?.advanceCursorIfSafe(cursorAdvanceCandidate.decision, cursorAdvanceCandidate.cursor);
    }

    const summary = createStableRunSummary({
      runId,
      mode,
      policy,
      policyVersion: PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
      queues: ["persona"],
      startedAt,
      finishedAt: Math.floor((opts.now ?? new Date()).getTime() / 1000),
      decisions,
    });
    if (manageRunLifecycle) {
      store?.finishRun(runId, summary);
    }
    const result: PersonaProposalTriageResult = {
      schemaVersion: 1,
      runId,
      mode,
      policy,
      policyVersion: PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
      counts: countPersonaDecisions(decisions),
      decisions: views,
      bundles: buildPersonaReviewBundles(views),
      humanSummary: "",
    };
    result.humanSummary = renderPersonaProposalTriageHumanSummary(result);
    return result;
  } finally {
    if (ownStore) {
      store?.close();
    }
  }
}

export function stablePersonaProposalTriageJson(result: PersonaProposalTriageResult): string {
  return `${canonicalJson(redactAutopilotValue(result))}\n`;
}

export function renderPersonaProposalTriageHumanSummary(result: PersonaProposalTriageResult): string {
  const lines = [
    `Persona proposal triage ${result.runId} (${result.mode}, policy=${result.policy})`,
    `Inspected ${result.counts.inspected}; auto-rejected ${result.counts.autoRejected}; auto-applied ${result.counts.autoApplied}; deferred ${result.counts.deferredForHuman}; failed ${result.counts.failedValidation}.`,
  ];
  if (result.bundles.length > 0) {
    lines.push("Review bundles:");
    for (const bundle of result.bundles) {
      lines.push(
        `- ${bundle.id}: ${bundle.proposalIds.length} proposal(s), target=${bundle.targetFile}, risk=${bundle.risk}, recommendation=${bundle.recommendation}, reasons=${bundle.reasons.join(",")}`,
      );
    }
  } else {
    lines.push("Review bundles: none.");
  }
  lines.push(
    result.mode === "dry-run"
      ? "Dry-run wrote no proposal state, target files, or durable pending-autopilot state."
      : "Apply mode used shared pending-autopilot lock/CAS decision recording before any proposal/file mutation.",
  );
  return lines.join("\n");
}

export function decidePersonaProposal(
  item: PersonaProposalPendingItem,
  context: PendingDecisionContext,
  input: {
    proposalsDb: ProposalsDB;
    cfg: Pick<HybridMemoryConfig, "personaProposals">;
    workspace?: string;
    allProposals?: ProposalEntry[];
  },
): PendingDecision {
  const all = input.allProposals ?? input.proposalsDb.list();
  const analysis = analyzePersonaProposal(item, context.policy as PersonaProposalTriagePolicy, all);
  const reportOnly = context.policy === "report-only";
  const readOnlyCapability = context.mode === "dry-run" ? "dry-run" : "read-only";
  const action = reportOnly ? "reported" : analysis.action;
  const actionClass = reportOnly ? "observe" : analysis.actionClass;
  const capabilityClass = reportOnly ? readOnlyCapability : analysis.capabilityClass;
  const isSecurityCritical =
    analysis.reasonCode === "security-boundary-change" ||
    analysis.reasonCode === "secret-or-private-data-risk" ||
    analysis.reasonCode === "privacy-boundary-change";
  const humanReviewRequired = reportOnly
    ? isSecurityCritical
      ? analysis.humanReviewRequired
      : false
    : analysis.humanReviewRequired;

  return {
    queue: "persona",
    itemId: item.id,
    inputHash: item.inputHash,
    policy: context.policy,
    policyVersion: context.policyVersion,
    mode: context.mode,
    action,
    reasonCode: analysis.reasonCode,
    actionClass,
    capabilityClass,
    confidence: analysis.confidence,
    humanReviewRequired,
    evidence: analysis.evidence,
    actor: context.actor,
    runId: context.runId,
    jobId: context.jobId,
    summary: {
      title: item.proposal.title,
      body: analysis.diffSummary,
      metadata: {
        targetFile: item.proposal.targetFile,
        risk: analysis.risk,
        targetHash: item.targetHash,
        proposalHash: item.payload.proposalHash,
      },
    },
    audit: {
      queue: "persona",
      itemId: item.id,
      inputHash: item.inputHash,
      policy: context.policy,
      policyVersion: context.policyVersion,
      action,
      reasonCode: analysis.reasonCode,
      capabilityClass,
      humanReviewRequired,
      evidence: analysis.evidence,
      actor: context.actor,
      runId: context.runId,
      jobId: context.jobId,
      summary: {
        title: item.proposal.title,
        body: analysis.diffSummary,
        metadata: {
          targetFile: item.proposal.targetFile,
          proposalHash: item.payload.proposalHash,
          targetHash: item.targetHash,
          risk: analysis.risk,
        },
      },
    },
  };
}

function listPersonaProposalItems(
  input: {
    proposalsDb: ProposalsDB;
    cfg: Pick<HybridMemoryConfig, "personaProposals">;
    workspace?: string;
    proposalId?: string;
  },
  cursor?: PendingAutopilotCursor | null,
): PersonaProposalPendingItem[] {
  if (!input.cfg.personaProposals.enabled) return [];
  const pending = input.proposalsDb.list({ status: "pending" });
  const workspace = input.workspace ?? defaultWorkspace();
  return pending
    .sort(comparePersonaProposalNewestFirst)
    .filter((proposal) => input.proposalId === undefined || proposal.id === input.proposalId)
    .filter((proposal) => isVisibleAfterPersonaCursor(proposal, cursor))
    .map((proposal) => proposalToPendingItem(proposal, workspace, input.cfg));
}

function isVisibleAfterPersonaCursor(proposal: ProposalEntry, cursor?: PendingAutopilotCursor | null): boolean {
  if (!cursor?.cursor) return true;
  if (proposal.createdAt >= cursor.updatedAt) return true;
  // Persona proposals are listed newest-first by ProposalsDB. A durable cursor
  // therefore means "the newest processed boundary" for the already-seen backlog,
  // and subsequent pages must move toward older proposals without hiding proposals
  // created after the cursor was advanced.
  return comparePersonaCursor(proposalCursor(proposal), cursor.cursor) < 0;
}

function proposalCursor(proposal: Pick<ProposalEntry, "createdAt" | "id">): string {
  return `${proposal.createdAt.toString().padStart(12, "0")}:${proposal.id}`;
}

function comparePersonaCursor(a: string, b: string): number {
  return a.localeCompare(b);
}

function comparePersonaProposalNewestFirst(a: ProposalEntry, b: ProposalEntry): number {
  return comparePersonaCursor(proposalCursor(b), proposalCursor(a));
}

function proposalToPendingItem(
  proposal: ProposalEntry,
  workspace: string,
  cfg: Pick<HybridMemoryConfig, "personaProposals">,
  policyVersion = PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
): PersonaProposalPendingItem {
  const target = resolveAllowedPersonaTarget(workspace, proposal.targetFile, cfg.personaProposals.allowedFiles);
  let targetHash: string | null = null;
  if (target.ok) {
    try {
      targetHash = existsSync(target.path) ? fileHash(target.path) : null;
    } catch {
      targetHash = null;
    }
  }
  const proposalHash = computePendingInputHash({
    id: proposal.id,
    targetFile: proposal.targetFile,
    title: proposal.title,
    observation: proposal.observation,
    suggestedChange: proposal.suggestedChange,
    confidence: proposal.confidence,
    evidenceSessions: proposal.evidenceSessions,
    targetHash: proposal.targetHash ?? null,
    targetMtimeMs: proposal.targetMtimeMs ?? null,
  });
  const payload: PersonaProposalPayload = {
    proposalId: proposal.id,
    targetFile: proposal.targetFile,
    title: proposal.title,
    confidence: proposal.confidence,
    evidenceSessions: proposal.evidenceSessions,
    createdAt: proposal.createdAt,
    targetHash: proposal.targetHash ?? null,
    proposalHash,
  };
  return {
    queue: "persona",
    id: proposal.id,
    inputHash: computePendingInputHash({
      queue: "persona",
      id: proposal.id,
      payload,
      policyVersion,
    }),
    policyVersion,
    capabilityClasses: ["read-only", "safe-state-transition", "apply-low-risk-change"],
    payload,
    visibleAfterCursor: proposalCursor(proposal),
    requiresHumanReview: true,
    proposal,
    targetPath: target.path,
    targetValid: target.ok,
    targetHash,
    workspace,
  };
}

function analyzePersonaProposal(
  item: PersonaProposalPendingItem,
  policy: PersonaProposalTriagePolicy,
  allProposals: ProposalEntry[],
): Analysis {
  const p = item.proposal;
  const text = `${p.title}\n${p.observation}\n${p.suggestedChange}`;
  const evidence = buildEvidence(p);
  if (!item.targetValid) {
    return failed("critical", "validation-failed", `Target path rejected for ${p.targetFile}`, evidence, 0.1);
  }
  if (containsSecretOrPrivateData(text)) {
    return rejectOrDefer(
      policy,
      "critical",
      "secret-or-private-data-risk",
      "Secret/private-data risk detected; [REDACTED] raw content.",
      evidence,
      1,
    );
  }
  if (containsPromptInjection(text)) {
    return defer(
      "critical",
      "security-boundary-change",
      "Prompt-injection language is untrusted and cannot affect policy gates.",
      evidence,
      1,
    );
  }
  if (p.confidence < PERSONA_REJECT_CONFIDENCE_THRESHOLD) {
    return rejectOrDefer(
      policy,
      "low",
      "low-confidence",
      `Confidence ${p.confidence.toFixed(2)} below ${PERSONA_REJECT_CONFIDENCE_THRESHOLD}.`,
      evidence,
      1,
    );
  }
  if (isNonActionable(p.suggestedChange)) {
    return rejectOrDefer(
      policy,
      "low",
      "non-actionable",
      "Proposal lacks an actionable localized change.",
      evidence,
      0.95,
    );
  }
  const duplicate = findDuplicate(p, allProposals);
  if (duplicate?.status === "applied") {
    return rejectOrDefer(
      policy,
      "low",
      "duplicate-applied-proposal",
      `Duplicates already-applied proposal ${duplicate.id}.`,
      evidence,
      1,
    );
  }
  if (duplicate?.status === "pending") {
    return rejectOrDefer(
      policy,
      "low",
      "duplicate-pending-proposal",
      `Duplicates pending proposal ${duplicate.id}.`,
      evidence,
      1,
    );
  }
  const alreadyInFile = isAlreadyInTargetFile(p, item);
  if (alreadyInFile) {
    return rejectOrDefer(
      policy,
      "low",
      "already-in-file",
      "Proposed text already present (or substantially covered) in the target file.",
      evidence,
      1,
    );
  }
  if (isStaleTarget(item)) {
    return rejectOrDefer(
      policy,
      "low",
      "stale-target-context",
      "Target snapshot changed since proposal creation; safe rebase unavailable.",
      evidence,
      1,
    );
  }
  const risk = classifyRisk(p, item);
  const diffSummary = summarizeDiff(p, item);
  if (policy === "report-only") return report(risk, "policy-report-only", diffSummary, evidence, p.confidence);
  if (risk === "high" || risk === "critical") {
    return defer(risk, highRiskReason(p), diffSummary, evidence, p.confidence);
  }
  if (risk === "medium") {
    return defer("medium", "policy-requires-human", diffSummary, evidence, p.confidence);
  }
  if (!hasEvidence(p)) return defer("low", "missing-evidence", diffSummary, evidence, p.confidence);
  if (policy !== "apply-safe") return defer("low", "policy-requires-human", diffSummary, evidence, p.confidence);
  if (!hasReliableTargetSnapshot(p)) {
    return defer(
      "low",
      "stale-target-context",
      "Auto-apply requires target hash or mtime snapshot.",
      evidence,
      p.confidence,
    );
  }
  if (p.confidence < PERSONA_APPLY_CONFIDENCE_THRESHOLD) {
    return defer("low", "low-confidence", diffSummary, evidence, p.confidence);
  }
  const drift = lowRiskDriftGuard(p, allProposals);
  if (drift.blocked) {
    return defer("low", "policy-requires-human", `${diffSummary}; ${drift.summary}`, evidence, p.confidence);
  }
  return {
    risk: "low",
    action: "applied",
    reasonCode: "safe-low-risk-localized-change",
    actionClass: "low-risk-apply",
    capabilityClass: "apply-low-risk-change",
    confidence: p.confidence,
    humanReviewRequired: false,
    diffSummary,
    evidence,
    applyAllowed: true,
  };
}

function applyPersonaDecisionWithLock(input: {
  store: PendingAutopilotStore;
  proposalsDb: ProposalsDB;
  item: PersonaProposalPendingItem;
  decision: PendingDecision;
  workspace: string;
  cfg: Pick<HybridMemoryConfig, "personaProposals" | "liveChangeFeed">;
  changeFeed?: ChangeFeed | null;
  sessionKey?: string;
  resolvedSqlitePath?: string;
}): PendingDecision {
  const owner = `${input.decision.runId}:persona-triage`;
  const locked = input.store.acquireLock({
    queue: "persona",
    itemId: input.item.id,
    inputHash: input.item.inputHash,
    owner,
    ttlSeconds: 120,
    mode: input.decision.mode,
  });
  if (!locked) return validationFailure(input.decision, "lock-conflict", "Could not acquire persona proposal lock.");
  try {
    const current = input.proposalsDb.get(input.item.id);
    if (!current || current.status !== "pending") {
      return validationFailure(input.decision, "already-processed", "Proposal was already processed before apply.");
    }
    const actualHash = proposalToPendingItem(current, input.workspace, input.cfg).inputHash;
    if (actualHash !== input.decision.inputHash) {
      return validationFailure(
        input.decision,
        "input-hash-mismatch",
        "Proposal changed between classification and apply.",
      );
    }
    let preparedApply:
      | {
          targetPath: string;
          backupPath: string;
          original: string;
          appliedContent: string;
          preHash: string;
          postHash: string;
          auditDiff: string;
        }
      | undefined;
    if (input.decision.action === "applied") {
      const currentTarget = resolveAllowedPersonaTarget(
        input.workspace,
        current.targetFile,
        input.cfg.personaProposals.allowedFiles,
      );
      if (!currentTarget.ok || !existsSync(currentTarget.path)) {
        return validationFailure(
          input.decision,
          "stale-target-context",
          "Target file unavailable during apply revalidation.",
        );
      }
      const currentSnapshot = getFileSnapshot(currentTarget.path);
      if (!currentSnapshot) {
        return validationFailure(
          input.decision,
          "stale-target-context",
          "Target file unreadable during apply revalidation.",
        );
      }
      if (!hasReliableTargetSnapshot(current)) {
        return validationFailure(
          input.decision,
          "stale-target-context",
          "Auto-apply requires target hash or mtime snapshot.",
        );
      }
      if (current.targetHash && current.targetHash !== currentSnapshot.hash) {
        return validationFailure(input.decision, "input-hash-mismatch", "Target file changed before apply.");
      }
      if (!current.targetHash && current.targetMtimeMs != null && current.targetMtimeMs !== currentSnapshot.mtimeMs) {
        return validationFailure(input.decision, "input-hash-mismatch", "Target mtime changed before apply.");
      }
      const original = readFileSync(currentTarget.path, "utf-8");
      const applied = buildAppliedContent(original, current, nowIso());
      if (!applied.content.trim()) {
        return validationFailure(
          input.decision,
          "validation-failed",
          `Proposal ${input.item.id} does not contain replacement content to apply.`,
        );
      }
      if (!isAllowedSensitivePersonaApply(current.targetFile, original, applied.content, current.suggestedChange)) {
        return validationFailure(
          input.decision,
          "identity-boundary-change",
          "Sensitive persona files require mechanically verified formatting-only diffs for apply-safe auto-apply.",
        );
      }
      const auditDiff = redactedAuditDiff(original, applied.content, current.targetFile);
      preparedApply = {
        targetPath: currentTarget.path,
        backupPath: `${currentTarget.path}.backup-${Date.now()}`,
        original,
        appliedContent: applied.content,
        preHash: currentSnapshot.hash,
        postHash: hashText(applied.content),
        auditDiff,
      };
    }

    const decisionForMutation = preparedApply ? withPersonaApplyAudit(input.decision, preparedApply) : input.decision;
    let wroteRollback = false;
    const ok = input.store.mutateWithLockAndAudit({
      decision: decisionForMutation,
      owner,
      actualInputHash: actualHash,
      audit: () => {},
      mutate: () => {
        if (decisionForMutation.action === "rejected") {
          input.proposalsDb.updateStatus(input.item.id, "rejected", "persona-triage", decisionForMutation.reasonCode);
        } else if (decisionForMutation.action === "applied" && preparedApply) {
          if (input.resolvedSqlitePath) {
            writeProposalRollback(input.resolvedSqlitePath, {
              proposalId: input.item.id,
              proposalType: "persona",
              targetPath: preparedApply.targetPath,
              originalHash: preparedApply.preHash,
              originalContent: preparedApply.original,
              appliedHash: preparedApply.postHash,
              appliedAt: nowIso(),
            });
            wroteRollback = true;
          }
          applyPreparedPersonaChange(preparedApply, () => input.proposalsDb.markApplied(input.item.id));
        }
      },
    });
    if (!ok) return validationFailure(input.decision, "input-hash-mismatch", "Lock/CAS/audit mutation rejected.");
    if (decisionForMutation.action === "rejected") {
      syncProposalWithdrawnInChangeFeed(
        input.changeFeed,
        input.cfg as HybridMemoryConfig,
        `persona:${input.item.id}`,
        decisionForMutation.reasonCode ?? "Rejected via autopilot triage",
      );
    } else if (decisionForMutation.action === "applied" && preparedApply) {
      const current = input.proposalsDb.get(input.item.id);
      emitPersonaApplied(input.changeFeed, input.cfg as HybridMemoryConfig, {
        sessionKey: input.sessionKey ?? "autopilot",
        proposalId: input.item.id,
        targetFile: current?.targetFile ?? "unknown",
        title: current?.title,
        rollbackAvailable: wroteRollback,
      });
      supersedeActiveProposedEvent(input.changeFeed, `persona:${input.item.id}`);
    }
    return decisionForMutation;
  } finally {
    input.store.releaseLock({
      queue: "persona",
      itemId: input.item.id,
      inputHash: input.item.inputHash,
      owner,
      mode: input.decision.mode,
    });
  }
}

function validationFailure(
  decision: PendingDecision,
  reasonCode: PendingDecision["reasonCode"],
  body: string,
): PendingDecision {
  const capabilityClass = decision.mode === "dry-run" ? "dry-run" : "read-only";
  return {
    ...decision,
    action: "failed-validation",
    reasonCode,
    actionClass: "observe",
    capabilityClass,
    confidence: 0,
    humanReviewRequired: true,
    summary: { ...(decision.summary ?? {}), body },
    audit: decision.audit
      ? {
          ...decision.audit,
          action: "failed-validation",
          reasonCode,
          capabilityClass,
          humanReviewRequired: true,
        }
      : undefined,
  };
}

function decisionToView(item: PersonaProposalPendingItem, decision: PendingDecision): PersonaProposalDecisionView {
  const metadata = decision.summary?.metadata ?? {};
  return {
    proposalId: item.id,
    targetFile: item.proposal.targetFile,
    risk: (metadata.risk as PersonaProposalRisk | undefined) ?? "medium",
    action: decision.action,
    reason: decision.reasonCode,
    capability: decision.capabilityClass,
    confidence: decision.confidence,
    humanReviewRequired: decision.humanReviewRequired,
    evidence: decision.evidence,
    diffSummary: String(decision.summary?.body ?? ""),
    inputHash: decision.inputHash,
    targetHash: item.targetHash,
  };
}

function buildPersonaReviewBundles(views: PersonaProposalDecisionView[]): PersonaProposalReviewBundle[] {
  const reviewable = views.filter(
    (v) => v.humanReviewRequired || v.action === "reported" || v.action === "deferred-for-human",
  );
  const groups = new Map<string, PersonaProposalDecisionView[]>();
  for (const view of reviewable) {
    const semanticTopic = topicKey(
      view.evidence
        .map((entry) => entry.summary)
        .filter(Boolean)
        .join("\n"),
    );
    const key = `${view.targetFile}:${view.risk}:${view.reason}:${semanticTopic}`;
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }
  return [...groups.values()].map((items, idx) => {
    const risk = maxRisk(items.map((i) => i.risk));
    const targetFile = items[0]?.targetFile ?? "unknown";
    const reasons = [...new Set(items.map((i) => i.reason))];
    const proposalIds = items.map((i) => i.proposalId);
    return {
      id: `persona-bundle-${idx + 1}`,
      targetFile,
      risk,
      recommendation:
        risk === "low" && reasons.every((r) => r.startsWith("duplicate") || r === "non-actionable")
          ? "reject"
          : "defer",
      proposalIds,
      reasons,
      rationale: `Grouped by target=${targetFile}, risk=${risk}, and shared topic. Review each proposal independently before approval.`,
      commands: proposalIds.flatMap((id) => [
        `openclaw hybrid-mem proposals show ${id} --diff`,
        `openclaw hybrid-mem proposals reject ${id} --reason <reason>`,
      ]),
      evidence: items.flatMap((i) => i.evidence),
      diffPreview: items.map((i) => `[${i.proposalId}] ${i.diffSummary}`).join("\n"),
    };
  });
}

function countPersonaDecisions(decisions: PendingDecision[]): PersonaProposalTriageResult["counts"] {
  return {
    inspected: decisions.length,
    classified: decisions.filter((d) => d.action === "classified" || d.action === "reported").length,
    grouped: decisions.filter(
      (d) => d.humanReviewRequired || d.action === "reported" || d.action === "deferred-for-human",
    ).length,
    autoRejected: decisions.filter((d) => d.action === "rejected").length,
    autoApplied: decisions.filter((d) => d.action === "applied").length,
    deferredForHuman: decisions.filter((d) => d.action === "deferred-for-human").length,
    failedValidation: decisions.filter((d) => d.action === "failed-validation").length,
    skippedByPolicy: decisions.filter((d) => d.action === "skipped-by-policy").length,
  };
}

function rejectOrDefer(
  policy: PersonaProposalTriagePolicy,
  risk: PersonaProposalRisk,
  reasonCode: PendingDecision["reasonCode"],
  diffSummary: string,
  evidence: PendingDecision["evidence"],
  confidence: number,
): Analysis {
  if (policy === "cautious" || policy === "apply-safe") {
    return {
      risk,
      action: "rejected",
      reasonCode,
      actionClass: "state-transition",
      capabilityClass: "safe-state-transition",
      confidence,
      humanReviewRequired: false,
      diffSummary,
      evidence,
      applyAllowed: false,
    };
  }
  return report(risk, reasonCode, diffSummary, evidence, confidence);
}

function defer(
  risk: PersonaProposalRisk,
  reasonCode: PendingDecision["reasonCode"],
  diffSummary: string,
  evidence: PendingDecision["evidence"],
  confidence: number,
): Analysis {
  return {
    risk,
    action: "deferred-for-human",
    reasonCode,
    actionClass: "record-review",
    capabilityClass: "record-review-metadata",
    confidence,
    humanReviewRequired: true,
    diffSummary,
    evidence,
    applyAllowed: false,
  };
}

function report(
  risk: PersonaProposalRisk,
  reasonCode: PendingDecision["reasonCode"],
  diffSummary: string,
  evidence: PendingDecision["evidence"],
  confidence: number,
): Analysis {
  return {
    risk,
    action: "reported",
    reasonCode,
    actionClass: "observe",
    capabilityClass: "read-only",
    confidence,
    humanReviewRequired: false,
    diffSummary,
    evidence,
    applyAllowed: false,
  };
}

function failed(
  risk: PersonaProposalRisk,
  reasonCode: PendingDecision["reasonCode"],
  diffSummary: string,
  evidence: PendingDecision["evidence"],
  confidence: number,
): Analysis {
  return {
    risk,
    action: "failed-validation",
    reasonCode,
    actionClass: "observe",
    capabilityClass: "read-only",
    confidence,
    humanReviewRequired: true,
    diffSummary,
    evidence,
    applyAllowed: false,
  };
}

function classifyRisk(p: ProposalEntry, item: PersonaProposalPendingItem): PersonaProposalRisk {
  const text = `${p.title}
${p.observation}
${p.suggestedChange}`.toLowerCase();
  if (/\b(destructive|credential)\b|approval boundary|bypass approval|disable safeguard|bypass.*policy|bypass.*safety/.test(text)) return "critical";
  if (isCriticalTarget(p.targetFile)) {
    if (SENSITIVE_PERSONA_FILES.has(p.targetFile)) {
      if (!isMechanicallyVerifiedSensitiveFormatting(item, p.suggestedChange)) return "high";
      return "low";
    }
    if (!isCriticalTargetFormattingOnly(p.suggestedChange)) return "high";
    if (/\b(privacy|security|credential|destructive|safeguard)\b|bypass approval|approval boundary/.test(text)) return "high";
    if (item.targetHash && normalizeText(p.suggestedChange).length < 240) return "low";
    return "medium";
  }
  if (
    /\b(identit(?:y|ies)|personalit(?:y|ies)|voice|tone|privacy|security|external|group chat|user preferences?|profile|personal facts?|memory rules?)\b/.test(
      text,
    )
  ) {
    return "high";
  }
  if (/\b(preference|workflow|routing|project context|communication)\b/.test(text)) return "medium";
  if (isLargeOrBroadDiff(p)) return "medium";
  if (item.targetHash && normalizeText(p.suggestedChange).length < 240) return "low";
  return "medium";
}

function isCriticalTargetFormattingOnly(suggestedChange: string): boolean {
  const parsed = parseSuggestedChange(suggestedChange);
  if (parsed.changeType !== "replace") return false;
  const hasFormattingKeywords = /\b(formatting|typo|whitespace|punctuation)\b/i.test(suggestedChange);
  if (!hasFormattingKeywords) return false;
  const containsSemanticKeywords =
    /\b(personalit(?:y|ies)|voice|tone|behaviou?r(?:al)?|instructions?|responses?|reply|replies|always|never|must|should|redirect|defer|escalate|refer|contact|route|forward|delegate|friendlier|friendly|warmer|casual|greeting)\b/i.test(
      suggestedChange,
    );
  return !containsSemanticKeywords;
}

function isMechanicallyVerifiedSensitiveFormatting(item: PersonaProposalPendingItem, suggestedChange: string): boolean {
  const parsed = parseSuggestedChange(suggestedChange);
  if (parsed.changeType !== "replace" || !item.targetHash || !item.targetValid || !existsSync(item.targetPath))
    return false;
  try {
    const original = readFileSync(item.targetPath, "utf-8");
    return stripWhitespaceAndPunctuation(original) === stripWhitespaceAndPunctuation(parsed.content);
  } catch {
    return false;
  }
}

function lowRiskDriftGuard(
  proposal: ProposalEntry,
  allProposals: ProposalEntry[],
): { blocked: boolean; summary: string } {
  const target = proposal.targetFile;
  const topic = topicKey(`${proposal.title}\n${proposal.observation}\n${proposal.suggestedChange}`);
  const previous = allProposals.filter(
    (candidate) =>
      candidate.id !== proposal.id &&
      candidate.status === "applied" &&
      candidate.targetFile === target &&
      normalizeText(candidate.suggestedChange).length < 240 &&
      topicKey(`${candidate.title}\n${candidate.observation}\n${candidate.suggestedChange}`) === topic,
  );
  if (previous.length >= LOW_RISK_DRIFT_THRESHOLD) {
    return {
      blocked: true,
      summary: `cumulative low-risk drift guard: ${previous.length} previous auto-applied edit(s) for ${target}/${topic}`,
    };
  }
  return { blocked: false, summary: "" };
}

function isAllowedSensitivePersonaApply(
  targetFile: string,
  original: string,
  applied: string,
  suggestedChange: string,
): boolean {
  if (!isCriticalTarget(targetFile)) return true;
  const parsed = parseSuggestedChange(suggestedChange);
  if (parsed.changeType !== "replace") return false;
  return stripWhitespaceAndPunctuation(original) === stripWhitespaceAndPunctuation(applied);
}

function stripWhitespaceAndPunctuation(input: string): string {
  return input.replace(/[\s\p{P}]+/gu, "").toLowerCase();
}

function withPersonaApplyAudit(
  decision: PendingDecision,
  preparedApply: { preHash: string; postHash: string; auditDiff: string },
): PendingDecision {
  const metadata = {
    ...(decision.summary?.metadata ?? {}),
    targetPreHash: preparedApply.preHash,
    targetPostHash: preparedApply.postHash,
  };
  const summary = {
    ...(decision.summary ?? {}),
    metadata: {
      ...metadata,
      redactedBeforeAfterDiff: preparedApply.auditDiff,
    },
  };
  return {
    ...decision,
    summary,
    audit: decision.audit
      ? {
          ...decision.audit,
          summary: {
            ...(decision.audit.summary ?? {}),
            metadata: {
              ...(decision.audit.summary?.metadata ?? {}),
              ...metadata,
              redactedBeforeAfterDiff: preparedApply.auditDiff,
            },
          },
        }
      : undefined,
  };
}

function redactedAuditDiff(original: string, applied: string, targetFile: string): string {
  let diff: string;
  try {
    diff = buildUnifiedDiff(original, applied, targetFile);
  } catch {
    diff = `--- ${targetFile} (before)
+++ ${targetFile} (after)
@@ before
${original}
@@ after
${applied}`;
  }
  const redacted = String(redactAutopilotValue(diff));
  return redacted.length > 8000
    ? `${redacted.slice(0, 8000)}
... [diff truncated]`
    : redacted;
}

function highRiskReason(p: ProposalEntry): PendingDecision["reasonCode"] {
  const text = `${p.title}\n${p.observation}\n${p.suggestedChange}`.toLowerCase();
  if (/privacy/.test(text)) return "privacy-boundary-change";
  if (/bypass.*approval|approval boundary|bypass.*policy|bypass.*safety|\bcredential\b|\bdestructive\b|disable safeguard/.test(text)) return "security-boundary-change";
  if (/preference|profile|personal fact|user preference/.test(text)) return "user-preference-change-requires-approval";
  return "identity-boundary-change";
}

function isCriticalTarget(targetFile: string): boolean {
  return CRITICAL_TARGETS.has(targetFile) || SENSITIVE_TOOLS_RE.test(targetFile);
}

function isMutationDecision(decision: PendingDecision): boolean {
  return decision.mode === "apply" && (decision.action === "rejected" || decision.action === "applied");
}

function isStaleTarget(item: PersonaProposalPendingItem): boolean {
  return Boolean(item.proposal.targetHash && item.targetHash && item.proposal.targetHash !== item.targetHash);
}

/**
 * Check whether the proposed text is substantially already present in the target file.
 * Splits the suggestion into sentences and checks how many already appear verbatim
 * (case-insensitive, whitespace-normalised) in the live file content.
 * Returns true when >60% of non-trivial sentences are already covered.
 */
function isAlreadyInTargetFile(proposal: ProposalEntry, item: PersonaProposalPendingItem): boolean {
  if (!item.targetValid) return false;
  let fileContent: string;
  try {
    if (!existsSync(item.targetPath)) return false;
    fileContent = readFileSync(item.targetPath, "utf-8");
  } catch {
    return false;
  }
  const normalizedFile = fileContent.toLowerCase().replace(/\s+/g, " ");
  const change = proposal.suggestedChange;
  // Split into sentences / bullet lines; filter out trivial ones
  const sentences = change
    .split(/[.\n•\-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30);
  if (sentences.length === 0) return false;
  const covered = sentences.filter((s) =>
    normalizedFile.includes(s.toLowerCase().replace(/\s+/g, " ")),
  ).length;
  return covered / sentences.length >= 0.6;
}

function hasReliableTargetSnapshot(proposal: Pick<ProposalEntry, "targetHash" | "targetMtimeMs">): boolean {
  return Boolean(proposal.targetHash || proposal.targetMtimeMs != null);
}

function findDuplicate(proposal: ProposalEntry, all: ProposalEntry[]): ProposalEntry | null {
  const normalized = normalizeText(proposal.suggestedChange);
  if (!normalized) return null;
  const candidates = all.filter(
    (c) =>
      c.id !== proposal.id &&
      c.targetFile === proposal.targetFile &&
      (c.status === "applied" || c.status === "pending") &&
      normalizeText(c.suggestedChange) === normalized,
  );
  if (candidates.length === 0) return null;

  const appliedDuplicate = candidates
    .filter((c) => c.status === "applied")
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (appliedDuplicate) return appliedDuplicate;

  const earlierPending = candidates
    .filter((c) => c.status === "pending" && compareProposalCreationOrder(c, proposal) < 0)
    .sort(compareProposalCreationOrder)[0];
  return earlierPending ?? null;
}

function compareProposalCreationOrder(
  a: Pick<ProposalEntry, "createdAt" | "id">,
  b: Pick<ProposalEntry, "createdAt" | "id">,
): number {
  const createdAtDelta = a.createdAt - b.createdAt;
  if (createdAtDelta !== 0) return createdAtDelta;
  return a.id.localeCompare(b.id);
}

const NON_ACTIONABLE_PHRASES = new Set([
  "be better",
  "improve",
  "do better",
  "fix this",
  "update",
  "change",
  "misc",
  "note",
]);

function isNonActionable(change: string): boolean {
  const normalized = normalizeText(change);
  if (normalized.length === 0) return true;
  if (NON_ACTIONABLE_PHRASES.has(normalized)) return true;

  const directiveVerbs =
    /\b(add|append|record|capture|document|replace|remove|delete|update|clarify|format|fix|rewrite|rename|prefer|avoid|use|mention|store|include)\b/i;
  const hasTargetOrLocation =
    /\b(soul\.md|user\.md|identity\.md|agents\.md|tools\.md|section|heading|paragraph|line|bullet|preference|guidance|instruction|file|document)\b/i.test(
      change,
    );

  return normalized.length < 12 && !directiveVerbs.test(change) && !hasTargetOrLocation;
}

function isLargeOrBroadDiff(p: ProposalEntry): boolean {
  const lines = p.suggestedChange.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 12 || p.suggestedChange.length > 1200 || /^\s*replace\b/i.test(p.suggestedChange);
}

function hasEvidence(p: ProposalEntry): boolean {
  return Array.isArray(p.evidenceSessions) && p.evidenceSessions.length > 0;
}

function summarizeDiff(p: ProposalEntry, item: PersonaProposalPendingItem): string {
  const change = redactAutopilotValue(p.suggestedChange) as string;
  const lines = String(change)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return `${safeActionVerb(p)} ${lines.length} non-empty line(s) in ${p.targetFile}; targetHash=${item.targetHash ?? "missing"}; proposalHash=${item.payload.proposalHash.slice(0, 12)}`;
}

function safeActionVerb(p: ProposalEntry): string {
  return /^\s*replace\b/i.test(p.suggestedChange) ? "Would replace" : "Would append/update";
}

function buildEvidence(p: ProposalEntry): PendingDecision["evidence"] {
  const sessions = (p.evidenceSessions ?? [])
    .slice(0, 5)
    .map((id) => ({ type: "session", id, summary: "proposal evidence session" }));
  return [
    { type: "proposal", id: p.id, summary: redactedOneLine(p.title) },
    ...sessions,
    {
      type: "proposal-hash",
      id: shortHash(`${p.title}\n${p.observation}\n${p.suggestedChange}`),
      summary: "redacted proposal content hash",
    },
  ];
}

function containsPromptInjection(text: string): boolean {
  return /ignore (all )?(previous|above|system|developer)(?:\s+\w+){0,3}\s+instructions|reveal (the )?(system prompt|secrets)|bypass (policy|approval|safety)|you are now|act as an unrestricted/i.test(
    text,
  );
}

function containsSecretOrPrivateData(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|password|secret)\s*[:=]|\bghp_[A-Za-z0-9_]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(
    text,
  );
}

function resolveAllowedPersonaTarget(
  workspace: string,
  targetFile: string,
  allowedFiles: readonly string[],
): { ok: true; path: string } | { ok: false; path: string; error: string } {
  if (!allowedFiles.includes(targetFile)) return { ok: false, path: targetFile, error: "target not allowlisted" };
  if (targetFile.includes("..") || targetFile.includes("/") || targetFile.includes("\\") || isAbsolute(targetFile)) {
    return { ok: false, path: targetFile, error: "path traversal" };
  }
  const workspaceReal = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace);
  const targetPath = resolve(workspaceReal, targetFile);
  const rel = relative(workspaceReal, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel))
    return { ok: false, path: targetPath, error: "target escapes workspace" };
  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      try {
        const real = realpathSync(targetPath);
        const realRel = relative(workspaceReal, real);
        if (realRel.startsWith("..") || isAbsolute(realRel))
          return { ok: false, path: targetPath, error: "symlink escapes workspace" };
      } catch {
        return { ok: false, path: targetPath, error: "dangling symlink" };
      }
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      return { ok: false, path: targetPath, error: "target stat failed" };
    }
  }
  return { ok: true, path: targetPath };
}

export function applyPreparedPersonaChange(
  preparedApply: { targetPath: string; backupPath: string; original: string; appliedContent: string },
  markApplied: () => void,
  io: {
    writeBackup?: (path: string, content: string) => void;
    writeTargetAtomic?: (path: string, content: string) => void;
    removeBackup?: (path: string) => void;
  } = {},
): void {
  let backupWritten = false;
  let targetWritten = false;
  let targetRestored = false;
  let appliedMarked = false;
  try {
    (io.writeBackup ?? ((path, content) => writeFileSync(path, content, "utf-8")))(
      preparedApply.backupPath,
      preparedApply.original,
    );
    backupWritten = true;
    (io.writeTargetAtomic ?? writeFileAtomic)(preparedApply.targetPath, preparedApply.appliedContent);
    targetWritten = true;
    markApplied();
    appliedMarked = true;
    try {
      (io.removeBackup ?? ((path) => rmSync(path, { force: true })))(preparedApply.backupPath);
    } catch {
      // Bookkeeping has already succeeded and the target file contains the
      // applied content. Backup cleanup is best-effort at this point; do not
      // roll back a successful apply or surface it as an apply failure.
    }
  } catch (err) {
    if (targetWritten && !appliedMarked) {
      try {
        (io.writeTargetAtomic ?? writeFileAtomic)(preparedApply.targetPath, preparedApply.original);
        targetRestored = true;
      } catch {
        // Preserve original error; restore failed and the backup remains the recovery artifact.
      }
    }
    if (backupWritten && !appliedMarked && (!targetWritten || targetRestored)) {
      try {
        (io.removeBackup ?? ((path) => rmSync(path, { force: true })))(preparedApply.backupPath);
      } catch {
        // Preserve original error; backup cleanup failed but original error is more important.
      }
    }
    throw err;
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, path);
  } finally {
    try {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    } catch {
      // Suppress cleanup errors to preserve original error if any
    }
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function redactedOneLine(input: string): string {
  return String(redactAutopilotValue(input)).replace(/\s+/g, " ").slice(0, 160);
}

function topicKey(input: string): string {
  const text = input.toLowerCase();
  if (/security|privacy|credential|approval/.test(text)) return "security";
  if (/identity|voice|tone/.test(text)) return "identity";
  if (/preference|workflow|profile|user.?prefer|pr review|branch naming/.test(text)) return "preference";
  return "general";
}

function maxRisk(risks: PersonaProposalRisk[]): PersonaProposalRisk {
  const order: PersonaProposalRisk[] = ["low", "medium", "high", "critical"];
  return [...risks].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? "medium";
}

export function validatePersonaPolicy(policy: string): asserts policy is PersonaProposalTriagePolicy {
  if (policy !== "report-only" && policy !== "cautious" && policy !== "apply-safe") {
    throw new Error(`Unsupported persona proposal triage policy: ${policy}`);
  }
}

function defaultWorkspace(): string {
  return getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
}

export function createPersonaParentExecutionPath(
  adapter: PendingQueueAdapter<PersonaProposalPendingItem> & {
    proposalsDb: ProposalsDB;
    cfg: Pick<HybridMemoryConfig, "personaProposals">;
    workspace: string;
  },
) {
  return async (item: PersonaProposalPendingItem, context: PendingDecisionContext): Promise<PendingDecision> => {
    const listed = await adapter.listPending(null);
    const listedItem = listed.find((i) => i.id === item.id);
    if (!listedItem) {
      throw new Error(`Parent execution path: item ${item.id} not found in adapter.listPending()`);
    }
    return adapter.decide(listedItem, context);
  };
}

export function createPersonaStandaloneExecutionPath(adapter: PendingQueueAdapter<PersonaProposalPendingItem>) {
  return (
    item: PersonaProposalPendingItem,
    context: PendingDecisionContext,
  ): Promise<PendingDecision> | PendingDecision => adapter.decide(item, context);
}

export function createPersonaProposalFixtureItem(input: {
  proposal: ProposalEntry;
  workspace: string;
  allowedFiles: PersonaProposalTargetFile[];
  policyVersion?: string;
}): PersonaProposalPendingItem {
  const item = proposalToPendingItem(
    input.proposal,
    input.workspace,
    {
      personaProposals: { allowedFiles: input.allowedFiles },
    } as Pick<HybridMemoryConfig, "personaProposals">,
    input.policyVersion,
  );
  return item;
}
