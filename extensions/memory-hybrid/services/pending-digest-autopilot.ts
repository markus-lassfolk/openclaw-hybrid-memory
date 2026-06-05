/**
 * Parent pending-digest autopilot orchestration (#1326).
 *
 * This service is intentionally a read-only/classification skeleton. It consumes
 * the shared pending-autopilot foundation (#1334), builds live queue inventory
 * from the same sources as `digest pending`, and delegates decisions to queue
 * adapters. Child issues #1327/#1328/#1329 own deep persona/procedure/verified
 * policy and mutation semantics; this parent must not duplicate them.
 */

import type { DatabaseSync } from "node:sqlite";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ProcedureTriageReport, ProcedureTriageRow } from "../backends/facts-db/procedures.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { type ToolProposal, ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  type AutopilotMode,
  PENDING_QUEUES,
  type PendingAutopilotRunSummary,
  PendingAutopilotStore,
  canonicalJson,
  redactAutopilotValue,
  type PendingDecision,
  type PendingDecisionContext,
  type PendingItem,
  type PendingQueue,
  type PendingQueueAdapter,
  computePendingInputHash,
  createPendingAutopilotRunId,
  createStableRunSummary,
  shouldAdvancePendingCursor,
} from "./pending-autopilot/index.js";
import {
  createPersonaProposalTriageAdapter,
  runPersonaProposalTriage,
  type PersonaProposalDecisionView,
  type PersonaProposalPendingItem,
} from "./persona-proposal-triage.js";
import type { ChangeFeed } from "./change-feed.js";
import { resolveChangeFeed } from "./change-feed-emit.js";
import { buildPendingReviewDigestReport, pendingStorePaths } from "./pending-review-digest.js";

export const PENDING_DIGEST_AUTOPILOT_POLICY_VERSION = "parent-skeleton-v1";

export type PersonaAutopilotPolicy = "disabled" | "report-only" | "cautious" | "apply-safe";
export type ProcedureAutopilotPolicy = "disabled" | "report-only" | "dry-run-skills" | "auto-safe";
export type VerifiedAutopilotPolicy = "disabled" | "report-only" | "classify" | "apply-obvious";
export type ReadOnlyClassifyPolicy = "disabled" | "report-only" | "classify";
export type PendingDigestAutopilotPolicy =
  | PersonaAutopilotPolicy
  | ProcedureAutopilotPolicy
  | VerifiedAutopilotPolicy
  | ReadOnlyClassifyPolicy;

export interface PendingDigestAutopilotPolicies {
  persona: PersonaAutopilotPolicy;
  procedures: ProcedureAutopilotPolicy;
  verified: VerifiedAutopilotPolicy;
  tools: ReadOnlyClassifyPolicy;
  crystallization: ReadOnlyClassifyPolicy;
}

export interface PendingDigestAutopilotMaxima {
  persona: number;
  procedures: number;
  verified: number;
  tools: number;
  crystallization: number;
}

export interface PendingDigestAutopilotOptions {
  cfg: HybridMemoryConfig;
  factsDb: PendingDigestFactsDb;
  workspace?: string;
  mode?: AutopilotMode;
  policies?: Partial<PendingDigestAutopilotPolicies>;
  max?: Partial<PendingDigestAutopilotMaxima>;
  runId?: string;
  jobId?: string;
  actorId?: string;
  now?: Date;
  stateDbPath?: string;
  adapters?: Partial<Record<PendingQueue, PendingQueueAdapter>>;
  changeFeed?: ChangeFeed | null;
  resolvedSqlitePath?: string;
}

export interface PendingDigestFactsDb {
  proceduresCount(): number;
  proceduresValidatedCount(): number;
  proceduresPromotedCount(): number;
  countVerifiedFacts(): number;
  proceduresValidatedSince?(sinceSec: number): number;
  getRawDb?(): DatabaseSync | undefined | null;
  triageProcedures?(options?: {
    status?: "validated" | "all";
    notPromoted?: boolean;
    limit?: number;
    validationThreshold?: number;
  }): ProcedureTriageReport;
}

export interface PendingDigestAutopilotResult {
  schemaVersion: 1;
  runId: string;
  mode: AutopilotMode;
  policyVersion: string;
  applyBehavior: "child-guarded-persona-apply" | "record-decisions-only" | "non-mutating-dry-run";
  policies: PendingDigestAutopilotPolicies;
  max: PendingDigestAutopilotMaxima;
  counts: {
    inspected: number;
    classified: number;
    applied: number;
    deferred: number;
    rejected: number;
    failedValidation: number;
    skipped: number;
    humanReviewRequired: number;
  };
  queues: Record<PendingQueue, PendingDigestQueueResult>;
  foundationSummary: PendingAutopilotRunSummary;
  digestContext: ReturnType<typeof buildPendingReviewDigestReport>["pendingReview"];
  humanSummary: string;
}

export interface PendingDigestQueueResult {
  policy: PendingDigestAutopilotPolicy;
  inspected: number;
  skipped: boolean;
  skipReason?: "queue-disabled-by-policy" | "adapter-unavailable" | "inventory-failed";
  decisions: PendingDecision[];
}

type QueuePayload = Record<string, unknown>;
type QueueItem = PendingItem<QueuePayload>;

const DEFAULT_POLICIES: PendingDigestAutopilotPolicies = {
  persona: "cautious",
  procedures: "auto-safe",
  verified: "classify",
  tools: "classify",
  crystallization: "classify",
};

const DEFAULT_MAX: PendingDigestAutopilotMaxima = {
  persona: 20,
  procedures: 50,
  verified: 100,
  tools: 50,
  crystallization: 50,
};

export function normalizePendingDigestAutopilotOptions(input: {
  mode?: AutopilotMode;
  policies?: Partial<PendingDigestAutopilotPolicies>;
  max?: Partial<PendingDigestAutopilotMaxima>;
}): {
  mode: AutopilotMode;
  policies: PendingDigestAutopilotPolicies;
  max: PendingDigestAutopilotMaxima;
} {
  const mode = input.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") throw new Error(`Unsupported pending autopilot mode: ${mode}`);
  const policies: PendingDigestAutopilotPolicies = { ...DEFAULT_POLICIES };
  const policyInput = input.policies ?? {};
  if (policyInput.persona !== undefined) policies.persona = policyInput.persona;
  if (policyInput.procedures !== undefined) policies.procedures = policyInput.procedures;
  if (policyInput.verified !== undefined) policies.verified = policyInput.verified;
  if (policyInput.tools !== undefined) policies.tools = policyInput.tools;
  if (policyInput.crystallization !== undefined) policies.crystallization = policyInput.crystallization;
  validatePolicies(policies);
  const max: PendingDigestAutopilotMaxima = { ...DEFAULT_MAX };
  for (const [queue, value] of Object.entries(input.max ?? {})) {
    if (value !== undefined) max[queue as PendingQueue] = value;
  }
  for (const [queue, value] of Object.entries(max)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid max for ${queue}: ${value}`);
    max[queue as PendingQueue] = Math.floor(value);
  }
  return { mode, policies, max };
}

export async function runPendingDigestAutopilot(
  opts: PendingDigestAutopilotOptions,
): Promise<PendingDigestAutopilotResult> {
  const normalized = normalizePendingDigestAutopilotOptions(opts);
  const runId = opts.runId ?? createPendingAutopilotRunId();
  const startedAt = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const actor = {
    type: "agent" as const,
    id: opts.actorId ?? "pending-digest-autopilot",
  };
  if (normalized.mode === "apply" && !opts.stateDbPath) {
    throw new Error("--apply requires --state-db so parent classification decisions are recorded durably");
  }
  const digest = buildPendingReviewDigestReport({
    cfg: opts.cfg,
    factsDb: opts.factsDb,
    now: opts.now,
  });

  let store: PendingAutopilotStore | undefined;
  let adapters: Partial<Record<PendingQueue, PendingQueueAdapter>> | null = null;
  try {
    adapters = createPendingDigestAdapters(opts);
    store = normalized.mode === "apply" ? new PendingAutopilotStore(opts.stateDbPath as string) : undefined;
    const decisions: PendingDecision[] = [];
    const queues = Object.fromEntries(
      PENDING_QUEUES.map((queue) => [
        queue,
        {
          policy: normalized.policies[queue],
          inspected: 0,
          skipped: false,
          decisions: [] as PendingDecision[],
        },
      ]),
    ) as Record<PendingQueue, PendingDigestQueueResult>;

    const inputHash = computePendingInputHash({
      command: "digest-autopilot",
      policies: normalized.policies,
      max: normalized.max,
      digest: digest.pendingReview,
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    });
    store?.createRun({
      runId,
      mode: normalized.mode,
      policy: "parent",
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      inputHash,
      queues: [...PENDING_QUEUES],
      startedAt,
    });

    for (const queue of PENDING_QUEUES) {
      const policy = normalized.policies[queue];
      const adapter = adapters[queue];
      const queueResult = queues[queue];
      if (policy === "disabled") {
        const decision = makeSkippedDecision({
          queue,
          policy,
          mode: normalized.mode,
          runId,
          jobId: opts.jobId,
          actor,
        });
        decisions.push(decision);
        queueResult.decisions.push(decision);
        queueResult.inspected = 0;
        queueResult.skipped = true;
        queueResult.skipReason = "queue-disabled-by-policy";
        store?.recordDecision(decision);
        continue;
      }
      if (!adapter) {
        const decision = makeSkippedDecision({
          queue,
          policy,
          mode: normalized.mode,
          runId,
          jobId: opts.jobId,
          actor,
        });
        decisions.push(decision);
        queueResult.decisions.push(decision);
        queueResult.skipped = true;
        queueResult.skipReason = "adapter-unavailable";
        store?.recordDecision(decision);
        continue;
      }

      try {
        const listed = await adapter.listPending(store?.getCursor(queue, policy) ?? null);
        const items = listed.slice(0, normalized.max[queue]);
        queueResult.inspected = items.length;
        let cursorAdvanceCandidate: { decision: PendingDecision; cursor: string } | null = null;
        let cursorAdvanceBlocked = false;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const context: PendingDecisionContext = {
            runId,
            jobId: opts.jobId,
            mode: normalized.mode,
            policy,
            policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
            inputHash: item.inputHash,
            actor,
          };
          let decision = await adapter.decide(item, context);
          if (queue === "persona" && normalized.mode === "apply" && policy !== "report-only") {
            if (hasPersonaParentApplyMetadata(adapter)) {
              const applied = await runPersonaProposalTriage({
                proposalsDb: adapter.proposalsDb,
                cfg: opts.cfg,
                workspace: opts.workspace,
                stateDbPath: opts.stateDbPath,
                mode: "apply",
                policy: policy as "cautious" | "apply-safe",
                max: 1,
                proposalId: item.id,
                runId,
                jobId: opts.jobId,
                actor,
                now: opts.now,
                runLifecycle: "embedded",
                store,
                changeFeed: resolveChangeFeed(
                  opts.cfg,
                  opts.factsDb as import("../backends/facts-db.js").FactsDB,
                  opts.changeFeed,
                ),
                resolvedSqlitePath: opts.resolvedSqlitePath ?? opts.cfg.sqlitePath,
                sessionKey: "autopilot",
              });
              const childDecision = applied.decisions.find((d) => d.proposalId === item.id);
              const latestDecision = childDecision
                ? ((store?.listDecisions({ queue: "persona", itemId: item.id }).at(-1) as
                    | PendingDecision
                    | undefined) ?? decisionFromPersonaView(decision, childDecision))
                : makeUnprocessedPersonaDecision(decision);
              decision = latestDecision;
              if (!childDecision) {
                store?.recordDecision(decision);
              }
            } else {
              decision = makeUnsupportedPersonaApplyAdapterDecision(decision);
              store?.recordDecision(decision);
            }
          } else {
            store?.recordDecision(decision);
          }
          decisions.push(decision);
          queueResult.decisions.push(decision);
          const itemCursor = item.visibleAfterCursor ?? item.id;
          if (shouldAdvancePendingCursor(decision)) {
            if (!cursorAdvanceBlocked) {
              cursorAdvanceCandidate = { decision, cursor: itemCursor };
            }
          } else {
            cursorAdvanceBlocked = true;
          }
        }
        if (policy !== "report-only" && cursorAdvanceCandidate !== null && items.length > 0) {
          store?.advanceCursorIfSafe(cursorAdvanceCandidate.decision, cursorAdvanceCandidate.cursor);
        }
      } catch (err) {
        queueResult.inspected = queueResult.decisions.length;
        const decision = makeFailureDecision({
          queue,
          policy,
          mode: normalized.mode,
          runId,
          jobId: opts.jobId,
          actor,
          error: err,
        });
        decisions.push(decision);
        queueResult.decisions.push(decision);
        queueResult.skipped = true;
        queueResult.skipReason = "inventory-failed";
        try {
          store?.recordDecision(decision);
        } catch {
          // Best-effort record for inventory failure; do not cascade store errors.
        }
      }
    }

    const foundationSummary = createStableRunSummary({
      runId,
      mode: normalized.mode,
      policy: "parent",
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      queues: [...PENDING_QUEUES],
      startedAt,
      finishedAt: Math.floor((opts.now ?? new Date()).getTime() / 1000),
      decisions,
    });
    store?.finishRun(runId, foundationSummary);

    const result: PendingDigestAutopilotResult = {
      schemaVersion: 1,
      runId,
      mode: normalized.mode,
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
      applyBehavior: normalized.mode === "apply" ? "child-guarded-persona-apply" : "non-mutating-dry-run",
      policies: normalized.policies,
      max: normalized.max,
      counts: summarizeCounts(decisions),
      queues,
      foundationSummary,
      digestContext: digest.pendingReview,
      humanSummary: "",
    };
    result.humanSummary = renderPendingDigestAutopilotHumanSummary(result);
    return result;
  } finally {
    for (const adapter of Object.values(adapters ?? {})) {
      (adapter as { close?: () => void }).close?.();
    }
    store?.close();
  }
}

export function renderPendingDigestAutopilotHumanSummary(result: PendingDigestAutopilotResult): string {
  const lines = [
    `Pending digest autopilot ${result.runId} (${result.mode})`,
    `Apply behavior: ${result.applyBehavior}. Persona apply-mode decisions route through the guarded child adapter; other queues remain read-only parent classifications.`,
    `Inspected ${result.counts.inspected}; classified ${result.counts.classified}; deferred ${result.counts.deferred}; skipped ${result.counts.skipped}; failed validation ${result.counts.failedValidation}.`,
    "Queues:",
  ];
  for (const queue of PENDING_QUEUES) {
    const q = result.queues[queue];
    const human = q.decisions.filter((d) => d.humanReviewRequired).length;
    const suffix = q.skipped ? ` skipped (${q.skipReason ?? "unknown"})` : ` ${q.inspected} inspected`;
    lines.push(`- ${queue}: policy=${q.policy};${suffix}; humanReview=${human}`);
  }
  if (result.counts.humanReviewRequired > 0) {
    lines.push(
      "Next: review deferred human-review items; child adapters #1327/#1328/#1329 own queue-specific apply gates.",
    );
  } else {
    lines.push(
      "Next: no parent-applied non-persona queue mutations. Use child adapters for queue-specific review/apply when implemented.",
    );
  }
  return lines.join("\n");
}

export function createDefaultPendingDigestAdapters(
  opts: Pick<PendingDigestAutopilotOptions, "cfg" | "factsDb" | "workspace">,
): Record<PendingQueue, PendingQueueAdapter> {
  return createPendingDigestAdapters(opts) as Record<PendingQueue, PendingQueueAdapter>;
}

function createPendingDigestAdapters(
  opts: Pick<PendingDigestAutopilotOptions, "cfg" | "factsDb" | "workspace" | "adapters">,
): Partial<Record<PendingQueue, PendingQueueAdapter>> {
  const overrides = opts.adapters ?? {};
  const paths = pendingStorePaths(opts.cfg.sqlitePath);
  return {
    persona:
      overrides.persona ?? createPersonaProposalTriageAdapterWithCloseable(paths.proposals, opts.cfg, opts.workspace),
    procedures: overrides.procedures ?? createProcedureReadOnlyAdapter(opts.factsDb),
    verified: overrides.verified ?? createVerifiedReadOnlyAdapter(opts.factsDb),
    tools: overrides.tools ?? createToolProposalReadOnlyAdapter(paths.toolProposals),
    crystallization: overrides.crystallization ?? createCrystallizationReadOnlyAdapter(paths.crystallization),
  };
}

type PersonaParentAdapter = PendingQueueAdapter<QueueItem> & { proposalsDb: ProposalsDB; close?: () => void };

function hasPersonaParentApplyMetadata(adapter: PendingQueueAdapter): adapter is PersonaParentAdapter {
  return (adapter as { proposalsDb?: unknown }).proposalsDb instanceof ProposalsDB;
}

function createPersonaProposalTriageAdapterWithCloseable(
  dbPath: string,
  cfg: HybridMemoryConfig,
  workspace?: string,
): PersonaParentAdapter {
  const proposalsDb = new ProposalsDB(dbPath);
  return {
    queue: "persona",
    proposalsDb,
    listPending: (cursor) => {
      if (!cfg.personaProposals.enabled) return [];
      const adapter = createPersonaProposalTriageAdapter({ proposalsDb, cfg, workspace });
      return adapter.listPending(cursor);
    },
    decide: (item, context) => {
      const adapter = createPersonaProposalTriageAdapter({
        proposalsDb,
        cfg,
        workspace,
        allProposals: proposalsDb.list(),
      });
      return adapter.decide(item as PersonaProposalPendingItem, context);
    },
    close: () => proposalsDb.close(),
  };
}

function makeUnsupportedPersonaApplyAdapterDecision(base: PendingDecision): PendingDecision {
  const summaryBody =
    "Persona parent apply mode requires the built-in persona adapter metadata for guarded child triage; custom adapter output was left unmutated and the cursor will not advance.";
  return {
    ...base,
    action: "failed-validation",
    reasonCode: "capability-not-allowed",
    actionClass: "observe",
    capabilityClass: "read-only",
    humanReviewRequired: true,
    summary: {
      ...(base.summary ?? {}),
      body: summaryBody,
    },
    audit: {
      ...(base.audit ?? {
        queue: base.queue,
        itemId: base.itemId,
        inputHash: base.inputHash,
        policy: base.policy,
        policyVersion: base.policyVersion,
        action: base.action,
        reasonCode: base.reasonCode,
        capabilityClass: base.capabilityClass,
        humanReviewRequired: base.humanReviewRequired,
        evidence: base.evidence,
        actor: base.actor,
        runId: base.runId,
        jobId: base.jobId,
      }),
      action: "failed-validation",
      reasonCode: "capability-not-allowed",
      capabilityClass: "read-only",
      humanReviewRequired: true,
    },
  };
}

function makeUnprocessedPersonaDecision(base: PendingDecision): PendingDecision {
  return {
    ...base,
    action: "failed-validation",
    reasonCode: "invalid-item",
    actionClass: "observe",
    capabilityClass: "read-only",
    humanReviewRequired: true,
    summary: {
      ...(base.summary ?? {}),
      body: "Targeted persona child triage did not process this proposal; parent will not advance cursor or record fallback mutation.",
    },
    audit: {
      ...(base.audit ?? {
        queue: base.queue,
        itemId: base.itemId,
        inputHash: base.inputHash,
        policy: base.policy,
        policyVersion: base.policyVersion,
        action: base.action,
        reasonCode: base.reasonCode,
        capabilityClass: base.capabilityClass,
        humanReviewRequired: base.humanReviewRequired,
        evidence: base.evidence,
        actor: base.actor,
        runId: base.runId,
        jobId: base.jobId,
      }),
      action: "failed-validation",
      reasonCode: "invalid-item",
      capabilityClass: "read-only",
      humanReviewRequired: true,
    },
  };
}

function decisionFromPersonaView(base: PendingDecision, view: PersonaProposalDecisionView): PendingDecision {
  const actionClass = deriveActionClass(view.action);
  return {
    ...base,
    action: view.action,
    reasonCode: view.reason,
    actionClass,
    capabilityClass: view.capability,
    confidence: view.confidence,
    humanReviewRequired: view.humanReviewRequired,
    summary: { ...(base.summary ?? {}), body: view.diffSummary },
    audit: base.audit
      ? {
          ...base.audit,
          action: view.action,
          reasonCode: view.reason,
          capabilityClass: view.capability,
          humanReviewRequired: view.humanReviewRequired,
        }
      : undefined,
  };
}

function deriveActionClass(action: PendingDecision["action"]): PendingDecision["actionClass"] {
  if (action === "applied") return "low-risk-apply";
  if (action === "rejected") return "state-transition";
  if (action === "deferred-for-human") return "record-review";
  if (action === "failed-validation") return "observe";
  if (action === "reported") return "observe";
  if (action === "classified") return "preview";
  return "observe";
}

export function createProcedureReadOnlyAdapter(factsDb: PendingDigestFactsDb): PendingQueueAdapter<QueueItem> {
  return {
    queue: "procedures",
    listPending: () => {
      if (!factsDb.triageProcedures) return [];
      const report = factsDb.triageProcedures({
        status: "validated",
        notPromoted: true,
        limit: 10_000,
      });
      return report.rows.map(procedureRowToItem);
    },
    decide: decideReadOnlyItem,
  };
}

export function createVerifiedReadOnlyAdapter(factsDb: PendingDigestFactsDb): PendingQueueAdapter<QueueItem> {
  return {
    queue: "verified",
    listPending: () => {
      const count = Math.max(0, factsDb.countVerifiedFacts());
      return Array.from({ length: count }, (_, i) => verifiedPlaceholderToItem(i + 1));
    },
    decide: decideReadOnlyItem,
  };
}

export function createToolProposalReadOnlyAdapter(dbPath: string): PendingQueueAdapter<QueueItem> {
  return {
    queue: "tools",
    listPending: () =>
      withCloseable(
        () => new ToolProposalStore(dbPath),
        (store) => store.list({ status: "proposed" }).map(toolProposalToItem),
      ),
    decide: decideReadOnlyItem,
  };
}

export function createCrystallizationReadOnlyAdapter(dbPath: string): PendingQueueAdapter<QueueItem> {
  return {
    queue: "crystallization",
    listPending: () =>
      withCloseable(
        () => new CrystallizationStore(dbPath),
        (store) => store.list({ status: "pending" }).map(crystallizationProposalToItem),
      ),
    decide: decideReadOnlyItem,
  };
}

export function decideReadOnlyItem(item: QueueItem, context: PendingDecisionContext): PendingDecision {
  if (context.policy === "disabled") {
    return makeSkippedDecision({
      queue: item.queue,
      policy: context.policy,
      mode: context.mode,
      runId: context.runId,
      jobId: context.jobId,
      actor: context.actor,
    });
  }
  const reportOnly = context.policy === "report-only";
  const requiresHuman = item.requiresHumanReview === true || reportOnly;
  return {
    queue: item.queue,
    itemId: item.id,
    inputHash: item.inputHash,
    policy: context.policy,
    policyVersion: context.policyVersion,
    mode: context.mode,
    action: reportOnly ? "reported" : requiresHuman ? "deferred-for-human" : "classified",
    reasonCode: reportOnly
      ? "policy-denied"
      : requiresHuman
        ? "human-review-required"
        : context.mode === "dry-run"
          ? "dry-run"
          : "policy-threshold-not-met",
    actionClass: reportOnly ? "observe" : "preview",
    capabilityClass: context.mode === "dry-run" ? "dry-run" : "read-only",
    confidence: typeof item.payload.confidence === "number" ? item.payload.confidence : 0.5,
    humanReviewRequired: requiresHuman,
    evidence: [
      {
        type: "pending-item",
        id: item.id,
        summary: String(item.payload.title ?? item.id),
      },
    ],
    actor: context.actor,
    runId: context.runId,
    jobId: context.jobId,
    summary: {
      title: String(item.payload.title ?? item.id),
      body: String(item.payload.summary ?? "read-only pending digest classification"),
      metadata: {
        queue: item.queue,
        source: item.payload.source ?? "live-inventory",
      },
    },
  };
}

function procedureRowToItem(p: ProcedureTriageRow): QueueItem {
  const payload = {
    source: "procedures-triage",
    title: p.title,
    validatedAt: p.validatedAt,
    promotionBlockReason: p.promotionBlockReason,
    successCount: p.successCount,
    confidence: p.confidence,
    skillPath: p.skillPath,
    summary: `Procedure promotion candidate blocked by ${p.promotionBlockReason}`,
  };
  return makeItem("procedures", p.id, payload, true);
}

function verifiedPlaceholderToItem(index: number): QueueItem {
  const id = `verified-review-${index}`;
  return makeItem(
    "verified",
    id,
    {
      source: "verified-facts-count",
      title: `Verified fact review placeholder ${index}`,
      summary:
        "#1329 must define the exact verified-fact review queue. Parent #1326 only reports/classifies the current digest count.",
    },
    true,
  );
}

function toolProposalToItem(p: ToolProposal): QueueItem {
  return makeItem(
    "tools",
    p.id,
    {
      source: "tool-proposals",
      title: p.name,
      summary: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    false,
  );
}

function crystallizationProposalToItem(p: {
  id: string;
  skillName: string;
  createdAt: string;
  updatedAt: string;
}): QueueItem {
  return makeItem(
    "crystallization",
    p.id,
    {
      source: "crystallization-proposals",
      title: p.skillName,
      summary: "Pending crystallization proposal; #1326 parent only classifies/read-only reports.",
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    false,
  );
}

function makeItem(queue: PendingQueue, id: string, payload: QueuePayload, requiresHumanReview: boolean): QueueItem {
  return {
    queue,
    id,
    inputHash: computePendingInputHash({
      queue,
      id,
      payload,
      policy: "default",
      policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    }),
    policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    capabilityClasses: ["read-only"],
    payload,
    visibleAfterCursor: id,
    requiresHumanReview,
  };
}

function makeSkippedDecision(input: {
  queue: PendingQueue;
  policy: string;
  mode: AutopilotMode;
  runId: string;
  jobId?: string;
  actor: PendingDecision["actor"];
}): PendingDecision {
  const itemId = `${input.queue}:skipped`;
  const inputHash = computePendingInputHash({
    queue: input.queue,
    itemId,
    policy: input.policy,
    reason: "disabled",
  });
  return {
    queue: input.queue,
    itemId,
    inputHash,
    policy: input.policy,
    policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    mode: input.mode,
    action: "skipped-by-policy",
    reasonCode: "policy-denied",
    actionClass: "observe",
    capabilityClass: input.mode === "dry-run" ? "dry-run" : "read-only",
    confidence: 1,
    humanReviewRequired: false,
    evidence: [
      {
        type: "policy",
        id: input.policy,
        summary: "queue disabled or unavailable",
      },
    ],
    actor: input.actor,
    runId: input.runId,
    jobId: input.jobId,
    summary: {
      title: `${input.queue} skipped`,
      body: "Queue skipped by parent orchestration policy.",
    },
  };
}

function makeFailureDecision(input: {
  queue: PendingQueue;
  policy: string;
  mode: AutopilotMode;
  runId: string;
  jobId?: string;
  actor: PendingDecision["actor"];
  error: unknown;
}): PendingDecision {
  const itemId = `${input.queue}:inventory-failed`;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    queue: input.queue,
    itemId,
    inputHash: computePendingInputHash({
      queue: input.queue,
      itemId,
      policy: input.policy,
      message,
    }),
    policy: input.policy,
    policyVersion: PENDING_DIGEST_AUTOPILOT_POLICY_VERSION,
    mode: input.mode,
    action: "failed-validation",
    reasonCode: "schema-validation-failed",
    actionClass: "observe",
    capabilityClass: input.mode === "dry-run" ? "dry-run" : "read-only",
    confidence: 0,
    humanReviewRequired: true,
    evidence: [{ type: "error", summary: message }],
    actor: input.actor,
    runId: input.runId,
    jobId: input.jobId,
    summary: { title: `${input.queue} inventory failed`, body: message },
  };
}

function summarizeCounts(decisions: PendingDecision[]): PendingDigestAutopilotResult["counts"] {
  return {
    inspected: decisions.filter((d) => d.action !== "skipped-by-policy" && d.action !== "failed-validation").length,
    classified: decisions.filter((d) => d.action === "classified" || d.action === "reported").length,
    applied: decisions.filter((d) => d.action === "applied").length,
    deferred: decisions.filter((d) => d.action === "deferred-for-human").length,
    rejected: decisions.filter((d) => d.action === "rejected").length,
    failedValidation: decisions.filter((d) => d.action === "failed-validation").length,
    skipped: decisions.filter((d) => d.action === "skipped-by-policy").length,
    humanReviewRequired: decisions.filter((d) => d.humanReviewRequired).length,
  };
}

function validatePolicies(policies: PendingDigestAutopilotPolicies): void {
  const allowed: Record<PendingQueue, readonly string[]> = {
    persona: ["disabled", "report-only", "cautious", "apply-safe"],
    procedures: ["disabled", "report-only", "dry-run-skills", "auto-safe"],
    verified: ["disabled", "report-only", "classify", "apply-obvious"],
    tools: ["disabled", "report-only", "classify"],
    crystallization: ["disabled", "report-only", "classify"],
  };
  for (const queue of PENDING_QUEUES) {
    if (!allowed[queue].includes(policies[queue])) {
      throw new Error(`Unsupported ${queue} pending autopilot policy: ${policies[queue]}`);
    }
  }
}

function withCloseable<TStore extends { close?: () => void }, T>(factory: () => TStore, fn: (store: TStore) => T): T {
  let store: TStore | null = null;
  try {
    store = factory();
    const result = fn(store);
    if (result instanceof Promise) {
      return result.finally(() => {
        try {
          store?.close?.();
        } catch {
          // Best-effort close for inventory readers.
        }
      }) as T;
    }
    try {
      store?.close?.();
    } catch {
      // Best-effort close for inventory readers.
    }
    return result;
  } catch (err) {
    try {
      store?.close?.();
    } catch {
      // Best-effort close for inventory readers.
    }
    throw err;
  }
}

export function stablePendingDigestAutopilotJson(result: PendingDigestAutopilotResult): string {
  return `${canonicalJson(redactAutopilotValue(result))}\n`;
}
