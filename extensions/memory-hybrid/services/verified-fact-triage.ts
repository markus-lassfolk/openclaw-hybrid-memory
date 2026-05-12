import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FactsDB } from "../backends/facts-db.js";
import { rowToMemoryEntry } from "../backends/facts-db/index.js";
import type { MemoryEntry } from "../types/memory.js";
import {
  computePendingInputHash,
  createPendingAutopilotRunId,
  createStableRunSummary,
  type PendingAutopilotStore,
  type AutopilotAction,
  type AutopilotReasonCode,
  type PendingDecision,
  type PendingDecisionContext,
  type PendingDecisionEvidence,
  type PendingItem,
  type PendingQueueAdapter,
} from "./pending-autopilot/index.js";
import type { VerifiedFact } from "./verification-store.js";

export const VERIFIED_TRIAGE_POLICY_VERSION = "verified-fact-triage-v1";
export const VERIFIED_REVIEW_QUEUE_SOURCE =
  "Latest verified_facts rows whose next_verification timestamp is due (or whose verified_at is older than the verification window), as returned by VerificationStore.listDueForReverification semantics. This is intentionally not all verified facts.";

export const VERIFIED_TRIAGE_POLICIES = ["report-only", "classify", "apply-obvious"] as const;
export type VerifiedTriagePolicy = (typeof VERIFIED_TRIAGE_POLICIES)[number];

export const VERIFIED_TRIAGE_BUCKETS = [
  "still-current",
  "stale-candidate",
  "expired-ttl-candidate",
  "superseded-candidate",
  "contradicted-candidate",
  "missing-or-weak-provenance",
  "duplicate-candidate",
  "scope-or-ownership-unclear",
  "sensitive-needs-human",
  "needs-human-review",
  "failed-review",
] as const;
export type VerifiedTriageBucket = (typeof VERIFIED_TRIAGE_BUCKETS)[number];

export const VERIFIED_TRIAGE_ACTIONS = [
  "reported",
  "classified",
  "marked-reviewed",
  "linked-evidence",
  "flagged-stale",
  "flagged-superseded",
  "flagged-contradicted",
  "flagged-sensitive",
  "deferred-for-human",
  "failed-validation",
  "skipped-by-policy",
] as const;
export type VerifiedTriageAction = (typeof VERIFIED_TRIAGE_ACTIONS)[number];

export type VerifiedTriageReason =
  | "policy_report_only"
  | "still_current_no_action_needed"
  | "ttl_expired"
  | "newer_verified_fact_exists"
  | "contradicting_verified_fact_exists"
  | "weak_or_missing_provenance"
  | "duplicate_verified_fact_candidate"
  | "sensitive_security_fact"
  | "sensitive_privacy_fact"
  | "sensitive_personal_fact"
  | "sensitive_operational_runbook"
  | "scope_unclear"
  | "requires_human_approval"
  | "stale_due_for_reverification"
  | "low_confidence"
  | "backend_error"
  | "malformed_fact"
  | "evidence_query_failed";

export interface VerifiedFactTriageItem extends PendingItem<VerifiedFactTriagePayload> {
  queue: "verified";
}

export interface VerifiedFactTriagePayload extends Record<string, unknown> {
  reviewQueueSource: string;
  verified: VerifiedFact;
  fact: TriageFactSnapshot | null;
  verificationTier: string | null;
  reviewCursor: string | null;
  dueReason: "next_verification" | "verified_at_stale";
}

export interface TriageFactSnapshot {
  id: string;
  text: string;
  category: string;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  createdAt: number;
  expiresAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  supersedesId: string | null;
  supersededAt: number | null;
  supersededBy: string | null;
  tier: string | null;
  scope: string;
  scopeTarget: string | null;
  provenanceSession: string | null;
  sourceSessions: string | null;
  provenanceJson: string | null;
  tags: string[] | null;
  confidence: number;
}

export interface VerifiedTriageEvidence extends PendingDecisionEvidence {
  fields?: Record<string, unknown>;
}

export interface VerifiedTriageResultItem {
  factId: string;
  verifiedFactId: string;
  text: string;
  verificationTier: string | null;
  scope: string | null;
  scopeTarget: string | null;
  entity: string | null;
  key: string | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  provenanceSummary: string;
  bucket: VerifiedTriageBucket;
  recommendedAction: VerifiedTriageAction;
  confidence: number;
  evidence: VerifiedTriageEvidence[];
  sensitivityFlags: string[];
  reason: VerifiedTriageReason;
  humanReviewRequired: boolean;
  action: AutopilotAction;
  reasonCode: AutopilotReasonCode;
  capabilityClass: PendingDecision["capabilityClass"];
  actionClass: PendingDecision["actionClass"];
  inputHash: string;
  applied: boolean;
}

export interface VerifiedTriageRunResult {
  runId: string;
  mode: "dry-run" | "apply";
  policy: VerifiedTriagePolicy;
  policyVersion: string;
  reviewQueueSource: string;
  counts: {
    inspected: number;
    classified: number;
    stillCurrent: number;
    staleCandidates: number;
    expiredTtlCandidates: number;
    supersededCandidates: number;
    contradictedCandidates: number;
    duplicateCandidates: number;
    sensitiveNeedsHuman: number;
    needsHuman: number;
    applied: number;
    failed: number;
  };
  items: VerifiedTriageResultItem[];
}

export interface VerifiedFactTriageOptions {
  mode: "dry-run" | "apply";
  policy: VerifiedTriagePolicy;
  max?: number;
  actor?: PendingDecision["actor"];
  jobId?: string;
  runId?: string;
  store?: PendingAutopilotStore | null;
  nowMs?: number;
  lockTtlSeconds?: number;
}

interface RelatedFact extends TriageFactSnapshot {
  verifiedFactId?: string | null;
  verifiedAt?: string | null;
  verifiedVersion?: number | null;
}

const SENSITIVE_RULES: Array<{
  flag: string;
  reason: VerifiedTriageReason;
  pattern: RegExp;
}> = [
  {
    flag: "credentials",
    reason: "sensitive_security_fact",
    pattern: /\b(password|passwd|credential|secret|api[-_ ]?key|token|bearer|ssh key|private key|vault|oauth|pat_)\b/i,
  },
  {
    flag: "security",
    reason: "sensitive_security_fact",
    pattern: /\b(security|firewall|ssh|vpn|runbook|incident|breach|auth|mfa|2fa|permission|admin)\b/i,
  },
  {
    flag: "privacy",
    reason: "sensitive_privacy_fact",
    pattern: /\b(privacy|private|personal data|pii|gdpr|address|phone|email|medical|health|passport|identity)\b/i,
  },
  {
    flag: "external-comms",
    reason: "sensitive_personal_fact",
    pattern: /\b(external comms|external communication|email rule|reply rule|send to|contact\b|customer|client)\b/i,
  },
  {
    flag: "persona-preference",
    reason: "sensitive_personal_fact",
    pattern: /\b(preference|user identity|persona|edict|hard rule|user profile|personal fact)\b/i,
  },
  {
    flag: "operational-runbook",
    reason: "sensitive_operational_runbook",
    pattern: /\b(cron|runbook|operational|ops|production|deploy|restart|backup|restore)\b/i,
  },
];

export function assertVerifiedTriagePolicy(value: string): VerifiedTriagePolicy {
  if ((VERIFIED_TRIAGE_POLICIES as readonly string[]).includes(value)) return value as VerifiedTriagePolicy;
  throw new Error(`Unknown verified triage policy: ${value}`);
}

export function createVerifiedFactTriageAdapter(input: {
  factsDb: Pick<FactsDB, "getRawDb">;
  max?: number;
  nowMs?: number;
  reverificationDays?: number;
  policy?: VerifiedTriagePolicy;
}): PendingQueueAdapter<VerifiedFactTriageItem> {
  const db = input.factsDb.getRawDb();
  return {
    queue: "verified",
    listPending: () =>
      listVerifiedFactTriageItems(db, {
        max: input.max,
        nowMs: input.nowMs,
        reverificationDays: input.reverificationDays,
        policy: input.policy,
      }),
    decide: (item, context) => decideVerifiedFactTriage(item, context, { db, nowMs: input.nowMs }),
    apply: (_decision, _item) => {
      // Verified fact triage intentionally does not mutate core truth fields. Durable
      // state is recorded through PendingAutopilotStore decisions only.
    },
  };
}

export function listVerifiedFactTriageItems(
  db: DatabaseSync,
  opts: {
    max?: number;
    nowMs?: number;
    reverificationDays?: number;
    policy?: VerifiedTriagePolicy;
  } = {},
): VerifiedFactTriageItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - (opts.reverificationDays ?? 30) * 24 * 60 * 60 * 1000).toISOString();
  const policy = opts.policy ?? "classify";
  const latestRows = db
    .prepare(
      `SELECT vf.*
       FROM verified_facts vf
       JOIN (
         SELECT vf2.fact_id, MAX(vf2.version) AS max_version
         FROM verified_facts vf2
         LEFT JOIN facts f2 ON f2.id = vf2.fact_id
         GROUP BY vf2.fact_id
       ) latest ON vf.fact_id = latest.fact_id AND vf.version = latest.max_version
       LEFT JOIN facts f ON f.id = vf.fact_id
       WHERE (vf.next_verification IS NOT NULL AND vf.next_verification <= ?)
          OR vf.verified_at <= ?
       ORDER BY COALESCE(vf.next_verification, vf.verified_at) ASC, vf.verified_at ASC
       LIMIT ?`,
    )
    .all(nowIso, cutoffIso, opts.max ?? 100) as unknown as VerifiedFactRow[];

  return latestRows.filter(isVerifiedRowChecksumValid).map((row) => {
    const verified = rowToVerifiedFact(row);
    const fact = loadFactSnapshot(db, verified.factId);
    const payload: VerifiedFactTriagePayload = {
      reviewQueueSource: VERIFIED_REVIEW_QUEUE_SOURCE,
      verified,
      fact,
      verificationTier: fact?.tier ?? null,
      reviewCursor: verified.nextVerification ?? verified.verifiedAt,
      dueReason:
        verified.nextVerification && verified.nextVerification <= nowIso ? "next_verification" : "verified_at_stale",
    };
    const inputHash = computePendingInputHash({
      queue: "verified",
      id: verified.id,
      payload,
      policy,
      policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
    });
    return {
      queue: "verified",
      id: verified.id,
      inputHash,
      policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
      capabilityClasses: ["read-only", "record-review-metadata"],
      payload,
      visibleAfterCursor: verified.nextVerification ?? verified.verifiedAt,
      requiresHumanReview: false,
      validationFailed: !fact,
    } satisfies VerifiedFactTriageItem;
  });
}

function isVerifiedRowChecksumValid(row: VerifiedFactRow): boolean {
  return computeChecksum(row.canonical_text) === row.checksum;
}

function computeChecksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function decideVerifiedFactTriage(
  item: VerifiedFactTriageItem,
  context: PendingDecisionContext,
  opts: { db?: DatabaseSync; nowMs?: number } = {},
): PendingDecision {
  const triage = classifyVerifiedFact(item, {
    db: opts.db,
    nowMs: opts.nowMs,
    policy: context.policy,
  });
  return triageToPendingDecision(item, context, triage);
}

export async function runVerifiedFactTriage(
  factsDb: Pick<FactsDB, "getRawDb">,
  opts: VerifiedFactTriageOptions,
): Promise<VerifiedTriageRunResult> {
  const policy = assertVerifiedTriagePolicy(opts.policy);
  const adapter = createVerifiedFactTriageAdapter({
    factsDb,
    max: opts.max,
    nowMs: opts.nowMs,
    policy,
  });
  return runVerifiedFactTriageWithAdapter(factsDb, adapter, opts);
}

export async function runVerifiedFactTriageWithAdapter(
  factsDb: Pick<FactsDB, "getRawDb">,
  adapter: PendingQueueAdapter<VerifiedFactTriageItem>,
  opts: VerifiedFactTriageOptions,
): Promise<VerifiedTriageRunResult> {
  const policy = assertVerifiedTriagePolicy(opts.policy);
  const mode = opts.mode;
  const store = opts.store ?? null;
  const runId = opts.runId ?? createPendingAutopilotRunId();
  const actor = opts.actor ?? { type: "agent", id: "verified-triage-cli" };
  const items = await adapter.listPending(null);
  const runInputHash = computePendingInputHash({
    queue: "verified",
    itemIds: items.map((i) => i.id),
    policy,
    mode,
  });
  const startedAt = Math.floor((opts.nowMs ?? Date.now()) / 1000);

  const durableStore = policy === "report-only" ? null : store;

  durableStore?.createRun({
    runId,
    mode,
    policy,
    policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
    inputHash: runInputHash,
    queues: ["verified"],
    startedAt,
  });

  const decisions: PendingDecision[] = [];
  const resultItems: VerifiedTriageResultItem[] = [];
  for (const item of items) {
    const context: PendingDecisionContext = {
      runId,
      jobId: opts.jobId,
      mode,
      policy,
      policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
      inputHash: item.inputHash,
      actor,
    };
    const decision = await adapter.decide(item, context);
    decisions.push(decision);
    let applied = false;
    if (mode === "apply" && policy !== "report-only") {
      const locked =
        durableStore?.acquireLock({
          queue: "verified",
          itemId: item.id,
          inputHash: item.inputHash,
          owner: actor.id,
          ttlSeconds: opts.lockTtlSeconds ?? 60,
          mode,
        }) ?? false;
      const liveItem = locked
        ? ((await adapter.listPending(null)).find((candidate) => candidate.id === item.id) ?? null)
        : null;
      const actualInputHash = liveItem?.inputHash ?? "missing";
      if (locked && liveItem && actualInputHash === item.inputHash) {
        const { inserted } = durableStore?.recordDecision(decision) ?? {
          inserted: false,
        };
        if (inserted && decision.action !== "deferred-for-human" && decision.action !== "failed-validation") {
          durableStore?.advanceCursorIfSafe(decision, item.visibleAfterCursor ?? item.id);
        }
        applied = inserted && (decision.action === "classified" || decision.action === "reported");
      } else if (durableStore) {
        const staleDecision = validationFailureDecision(
          item,
          context,
          locked ? "input-hash-mismatch" : "lock-conflict",
          liveItem
            ? "Verified fact/fact row changed between classification and apply."
            : "Verified fact no longer matches due queue before apply.",
        );
        durableStore.recordDecision(staleDecision);
        decisions[decisions.length - 1] = staleDecision;
      }
      durableStore?.releaseLock({
        queue: "verified",
        itemId: item.id,
        inputHash: item.inputHash,
        owner: actor.id,
        mode,
      });
    }
    resultItems.push(decisionToResultItem(decisions[decisions.length - 1], item, applied));
  }

  const summary = createStableRunSummary({
    runId,
    mode,
    policy,
    policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
    queues: ["verified"],
    startedAt,
    finishedAt: Math.floor((opts.nowMs ?? Date.now()) / 1000),
    decisions,
  });
  durableStore?.finishRun(runId, summary, summary.finishedAt);

  return buildRunResult({ runId, mode, policy, items: resultItems });
}

export function classifyVerifiedFact(
  item: VerifiedFactTriageItem,
  opts: { db?: DatabaseSync; nowMs?: number; policy?: string } = {},
): Omit<
  VerifiedTriageResultItem,
  | "factId"
  | "verifiedFactId"
  | "text"
  | "verificationTier"
  | "scope"
  | "scopeTarget"
  | "entity"
  | "key"
  | "validFrom"
  | "validUntil"
  | "expiresAt"
  | "provenanceSummary"
  | "action"
  | "reasonCode"
  | "capabilityClass"
  | "actionClass"
  | "inputHash"
  | "applied"
> {
  const fact = item.payload.fact;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();

  if (!fact) {
    return {
      bucket: "failed-review",
      recommendedAction: "failed-validation",
      reason: "malformed_fact",
      confidence: 1,
      evidence: [
        {
          type: "verified-fact",
          id: item.payload.verified.id,
          summary: "Verified row references a missing fact row",
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  const sensitivity = detectSensitivity(fact, item.payload.verified.canonicalText);
  if (sensitivity.flags.length > 0) {
    return {
      bucket: "sensitive-needs-human",
      recommendedAction: "flagged-sensitive",
      reason: sensitivity.reason,
      confidence: 0.95,
      evidence: [
        {
          type: "sensitivity",
          id: fact.id,
          summary: `Matched sensitive categories: ${sensitivity.flags.join(", ")}`,
        },
      ],
      sensitivityFlags: sensitivity.flags,
      humanReviewRequired: true,
    };
  }

  if (hasScopeUnclearSignals(fact)) {
    return {
      bucket: "scope-or-ownership-unclear",
      recommendedAction: "deferred-for-human",
      reason: "scope_unclear",
      confidence: 0.9,
      evidence: [
        {
          type: "scope",
          id: fact.id,
          summary: "Fact has session/agent/user scope requiring explicit ownership proof",
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  if (fact.validUntil != null && fact.validUntil <= nowSec) {
    return {
      bucket: "expired-ttl-candidate",
      recommendedAction: "deferred-for-human",
      reason: "ttl_expired",
      confidence: 0.95,
      evidence: [
        {
          type: "validity",
          id: fact.id,
          summary: "Fact valid_until has expired",
          fields: { validUntil: fact.validUntil, now: nowSec },
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }
  if (fact.expiresAt != null && fact.expiresAt <= nowSec) {
    return {
      bucket: "expired-ttl-candidate",
      recommendedAction: "deferred-for-human",
      reason: "ttl_expired",
      confidence: 0.95,
      evidence: [
        {
          type: "ttl",
          id: fact.id,
          summary: "Fact expires_at has expired",
          fields: { expiresAt: fact.expiresAt, now: nowSec },
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  const newer = opts.db ? findExplicitNewerVerifiedFact(opts.db, fact) : null;
  if (newer) {
    return {
      bucket: "superseded-candidate",
      recommendedAction: "flagged-superseded",
      reason: "newer_verified_fact_exists",
      confidence: 0.9,
      evidence: [
        {
          type: "fact",
          id: newer.id,
          summary: "Explicit newer verified fact supersedes this fact",
          fields: {
            newerFactId: newer.id,
            verifiedFactId: newer.verifiedFactId,
          },
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  const contradiction = opts.db ? findConcreteContradictingEvidence(opts.db, fact) : null;
  if (contradiction) {
    return {
      bucket: "contradicted-candidate",
      recommendedAction: "flagged-contradicted",
      reason: "contradicting_verified_fact_exists",
      confidence: 0.92,
      evidence: [contradiction],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  const duplicate = opts.db ? findSameScopeDuplicateVerifiedFact(opts.db, fact) : null;
  if (duplicate) {
    return {
      bucket: "duplicate-candidate",
      recommendedAction: "deferred-for-human",
      reason: "duplicate_verified_fact_candidate",
      confidence: 0.82,
      evidence: [
        {
          type: "fact",
          id: duplicate.id,
          summary: "Same-scope verified fact has identical normalized text",
          fields: { duplicateFactId: duplicate.id },
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  const weak = weakProvenanceReason(fact);
  if (weak) {
    return {
      bucket: "missing-or-weak-provenance",
      recommendedAction: "deferred-for-human",
      reason: "weak_or_missing_provenance",
      confidence: 0.86,
      evidence: [{ type: "provenance", id: fact.id, summary: weak }],
      sensitivityFlags: [],
      humanReviewRequired: true,
    };
  }

  if (
    (item.payload.verified.nextVerification && item.payload.verified.nextVerification <= nowIso) ||
    item.payload.dueReason === "verified_at_stale"
  ) {
    return {
      bucket: "stale-candidate",
      recommendedAction: "classified",
      reason: "stale_due_for_reverification",
      confidence: 0.72,
      evidence: [
        {
          type: "verification",
          id: item.payload.verified.id,
          summary:
            item.payload.dueReason === "verified_at_stale"
              ? "Fact verified_at is older than the reverification window"
              : "Fact is due for scheduled reverification",
          fields: {
            nextVerification: item.payload.verified.nextVerification,
            verifiedAt: item.payload.verified.verifiedAt,
            dueReason: item.payload.dueReason,
            now: nowIso,
          },
        },
      ],
      sensitivityFlags: [],
      humanReviewRequired: false,
    };
  }

  return {
    bucket: "still-current",
    recommendedAction: opts.policy === "apply-obvious" ? "marked-reviewed" : "classified",
    reason: "still_current_no_action_needed",
    confidence: 0.74,
    evidence: [
      {
        type: "review",
        id: fact.id,
        summary: "No concrete TTL, supersession, contradiction, sensitivity, scope, or provenance blocker found",
        fields: { reviewedAt: nowIso, method: "deterministic-triage" },
      },
    ],
    sensitivityFlags: [],
    humanReviewRequired: false,
  };
}

function triageToPendingDecision(
  item: VerifiedFactTriageItem,
  context: PendingDecisionContext,
  triage: ReturnType<typeof classifyVerifiedFact>,
): PendingDecision {
  const mapped = mapTriageAction(context.policy, triage);
  const evidence = triage.evidence.map((ev) => ({
    type: ev.type,
    id: ev.id,
    summary: ev.summary,
    ...(ev.fields ? { fields: ev.fields } : {}),
  }));
  return {
    queue: "verified",
    itemId: item.id,
    inputHash: context.inputHash,
    policy: context.policy,
    policyVersion: context.policyVersion,
    mode: context.mode,
    action: mapped.action,
    reasonCode: mapped.reasonCode,
    actionClass: mapped.actionClass,
    capabilityClass: mapped.capabilityClass,
    confidence: triage.confidence,
    humanReviewRequired: triage.humanReviewRequired,
    evidence,
    actor: context.actor,
    runId: context.runId,
    jobId: context.jobId,
    summary: {
      title: `verified fact ${triage.bucket}`,
      body: `${item.payload.fact?.id ?? item.payload.verified.factId}: ${triage.reason}`,
      metadata: {
        bucket: triage.bucket,
        recommendedAction: triage.recommendedAction,
        sensitivityFlags: triage.sensitivityFlags,
        evidenceFields: triage.evidence.map((ev) => ev.fields).filter(Boolean),
      },
    },
    audit: {
      queue: "verified",
      itemId: item.id,
      inputHash: context.inputHash,
      policy: context.policy,
      policyVersion: context.policyVersion,
      action: mapped.action,
      reasonCode: mapped.reasonCode,
      capabilityClass: mapped.capabilityClass,
      humanReviewRequired: triage.humanReviewRequired,
      evidence,
      actor: context.actor,
      runId: context.runId,
      summary: {
        title: "verified-fact-triage",
        metadata: {
          previous: {
            verificationTier: item.payload.verificationTier,
            verifiedFactId: item.payload.verified.id,
            nextVerification: item.payload.verified.nextVerification,
          },
          after: {
            bucket: triage.bucket,
            recommendedAction: triage.recommendedAction,
            reason: triage.reason,
          },
          mutation: "none-core-truth-fields-preserved",
        },
      },
    },
  };
}

function mapTriageAction(
  policy: string,
  triage: Pick<VerifiedTriageResultItem, "recommendedAction" | "humanReviewRequired" | "reason">,
): Pick<PendingDecision, "action" | "reasonCode" | "actionClass" | "capabilityClass"> {
  if (policy === "report-only") {
    return {
      action: "reported",
      reasonCode: "dry-run",
      actionClass: "preview",
      capabilityClass: "read-only",
    };
  }
  if (triage.recommendedAction === "failed-validation") {
    return {
      action: "failed-validation",
      reasonCode: toAutopilotReason(triage.reason),
      actionClass: "observe",
      capabilityClass: "read-only",
    };
  }
  if (triage.humanReviewRequired) {
    return {
      action: "deferred-for-human",
      reasonCode: "human-review-required",
      actionClass: "record-review",
      capabilityClass: "record-review-metadata",
    };
  }
  return {
    action: "classified",
    reasonCode: toAutopilotReason(triage.reason),
    actionClass: "record-review",
    capabilityClass: "record-review-metadata",
  };
}

function toAutopilotReason(reason: VerifiedTriageReason): AutopilotReasonCode {
  switch (reason) {
    case "policy_report_only":
      return "dry-run";
    case "backend_error":
    case "evidence_query_failed":
      return "audit-write-failed";
    case "malformed_fact":
      return "invalid-item";
    case "requires_human_approval":
    case "scope_unclear":
    case "sensitive_security_fact":
    case "sensitive_privacy_fact":
    case "sensitive_personal_fact":
    case "sensitive_operational_runbook":
      return "human-review-required";
    default:
      return "policy-threshold-not-met";
  }
}

function decisionToResultItem(
  decision: PendingDecision,
  item: VerifiedFactTriageItem,
  applied: boolean,
): VerifiedTriageResultItem {
  const meta = decision.summary?.metadata ?? {};
  const fact = item.payload.fact;
  const bucket = String(meta.bucket ?? "failed-review") as VerifiedTriageBucket;
  const recommendedAction = String(meta.recommendedAction ?? "failed-validation") as VerifiedTriageAction;
  return {
    factId: item.payload.verified.factId,
    verifiedFactId: item.payload.verified.id,
    text: fact?.text ?? item.payload.verified.canonicalText,
    verificationTier: item.payload.verificationTier,
    scope: fact?.scope ?? null,
    scopeTarget: fact?.scopeTarget ?? null,
    entity: fact?.entity ?? null,
    key: fact?.key ?? null,
    validFrom: fact?.validFrom ?? null,
    validUntil: fact?.validUntil ?? null,
    expiresAt: fact?.expiresAt ?? null,
    provenanceSummary: summarizeProvenance(fact),
    bucket,
    recommendedAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    sensitivityFlags: Array.isArray(meta.sensitivityFlags) ? (meta.sensitivityFlags as string[]) : [],
    reason: extractVerifiedReason(decision, item),
    humanReviewRequired: decision.humanReviewRequired,
    action: decision.action,
    reasonCode: decision.reasonCode,
    capabilityClass: decision.capabilityClass,
    actionClass: decision.actionClass,
    inputHash: decision.inputHash,
    applied,
  };
}

function extractVerifiedReason(decision: PendingDecision, item: VerifiedFactTriageItem): VerifiedTriageReason {
  const after = decision.audit?.summary?.metadata as { after?: { reason?: string } } | undefined;
  const reason = after?.after?.reason;
  if (reason) return reason as VerifiedTriageReason;
  const reasonCodeMap: Partial<Record<AutopilotReasonCode, VerifiedTriageReason>> = {
    "input-hash-mismatch": "backend_error",
    "lock-conflict": "backend_error",
    "lock-missing": "backend_error",
  };
  return reasonCodeMap[decision.reasonCode] ?? (item.validationFailed ? "malformed_fact" : "requires_human_approval");
}

function buildRunResult(input: {
  runId: string;
  mode: "dry-run" | "apply";
  policy: VerifiedTriagePolicy;
  items: VerifiedTriageResultItem[];
}): VerifiedTriageRunResult {
  return {
    runId: input.runId,
    mode: input.mode,
    policy: input.policy,
    policyVersion: VERIFIED_TRIAGE_POLICY_VERSION,
    reviewQueueSource: VERIFIED_REVIEW_QUEUE_SOURCE,
    counts: {
      inspected: input.items.length,
      classified: input.items.filter((i) => i.action === "classified" || i.action === "reported").length,
      stillCurrent: input.items.filter((i) => i.bucket === "still-current").length,
      staleCandidates: input.items.filter((i) => i.bucket === "stale-candidate").length,
      expiredTtlCandidates: input.items.filter((i) => i.bucket === "expired-ttl-candidate").length,
      supersededCandidates: input.items.filter((i) => i.bucket === "superseded-candidate").length,
      contradictedCandidates: input.items.filter((i) => i.bucket === "contradicted-candidate").length,
      duplicateCandidates: input.items.filter((i) => i.bucket === "duplicate-candidate").length,
      sensitiveNeedsHuman: input.items.filter((i) => i.bucket === "sensitive-needs-human").length,
      needsHuman: input.items.filter((i) => i.humanReviewRequired).length,
      applied: input.items.filter((i) => i.applied).length,
      failed: input.items.filter((i) => i.bucket === "failed-review").length,
    },
    items: input.items,
  };
}

function rowToVerifiedFact(row: VerifiedFactRow): VerifiedFact {
  return {
    id: row.id,
    factId: row.fact_id,
    canonicalText: row.canonical_text,
    checksum: row.checksum,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by as VerifiedFact["verifiedBy"],
    nextVerification: row.next_verification,
    version: row.version,
    previousVersionId: row.previous_version_id,
    createdAt: row.created_at,
  };
}

interface VerifiedFactRow {
  id: string;
  fact_id: string;
  canonical_text: string;
  checksum: string;
  verified_at: string;
  verified_by: string;
  next_verification: string | null;
  version: number;
  previous_version_id: string | null;
  created_at: string;
}

function loadFactSnapshot(db: DatabaseSync, factId: string): TriageFactSnapshot | null {
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(factId) as Record<string, unknown> | undefined;
  return row ? memoryEntryToSnapshot(rowToMemoryEntry(row)) : null;
}

function memoryEntryToSnapshot(entry: MemoryEntry): TriageFactSnapshot {
  return {
    id: entry.id,
    text: entry.text,
    category: entry.category,
    entity: entry.entity,
    key: entry.key,
    value: entry.value,
    source: entry.source,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    validFrom: entry.validFrom ?? null,
    validUntil: entry.validUntil ?? null,
    supersedesId: entry.supersedesId ?? null,
    supersededAt: entry.supersededAt ?? null,
    supersededBy: entry.supersededBy ?? null,
    tier: entry.tier ?? null,
    scope: entry.scope ?? "global",
    scopeTarget: entry.scopeTarget ?? null,
    provenanceSession: entry.provenanceSession ?? null,
    sourceSessions: entry.sourceSessions ?? null,
    provenanceJson: entry.provenanceJson ?? null,
    tags: entry.tags ?? null,
    confidence: entry.confidence,
  };
}

function snapshotFromRow(row: Record<string, unknown>): RelatedFact {
  return memoryEntryToSnapshot(rowToMemoryEntry(row));
}

function detectSensitivity(
  fact: TriageFactSnapshot,
  canonicalText: string,
): { flags: string[]; reason: VerifiedTriageReason } {
  const haystack = [canonicalText, fact.text, fact.category, fact.entity, fact.key, fact.value, fact.tags?.join(" ")]
    .filter(Boolean)
    .join("\n");
  const flags: string[] = [];
  let reason: VerifiedTriageReason = "sensitive_personal_fact";
  for (const rule of SENSITIVE_RULES) {
    if (rule.pattern.test(haystack)) {
      flags.push(rule.flag);
      if (reason === "sensitive_personal_fact" || rule.reason === "sensitive_security_fact") reason = rule.reason;
    }
  }
  return { flags: [...new Set(flags)], reason };
}

function hasScopeUnclearSignals(fact: TriageFactSnapshot): boolean {
  return fact.scope !== "global" && !fact.scopeTarget;
}

function sameScope(a: TriageFactSnapshot, b: TriageFactSnapshot): boolean {
  return a.scope === b.scope && (a.scopeTarget ?? null) === (b.scopeTarget ?? null);
}

function findExplicitNewerVerifiedFact(db: DatabaseSync, fact: TriageFactSnapshot): RelatedFact | null {
  if (fact.supersededBy) {
    const newer = loadVerifiedRelatedFact(db, fact.supersededBy);
    if (newer && sameScope(fact, newer) && newer.createdAt >= fact.createdAt) return newer;
  }
  const rows = db
    .prepare(
      `SELECT f.*, vf.id AS verified_fact_id, vf.verified_at AS verified_at, vf.version AS verified_version
       FROM facts f
       JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.supersedes_id = ? AND f.created_at >= ?
       ORDER BY f.created_at DESC
       LIMIT 5`,
    )
    .all(fact.id, fact.createdAt) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const newer = {
      ...snapshotFromRow(row),
      verifiedFactId: row.verified_fact_id as string,
    };
    if (sameScope(fact, newer)) return newer;
  }
  return null;
}

function loadVerifiedRelatedFact(db: DatabaseSync, factId: string): RelatedFact | null {
  const row = db
    .prepare(
      `SELECT f.*, vf.id AS verified_fact_id, vf.verified_at AS verified_at, vf.version AS verified_version
       FROM facts f
       JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.id = ?
       ORDER BY vf.version DESC
       LIMIT 1`,
    )
    .get(factId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...snapshotFromRow(row),
    verifiedFactId: row.verified_fact_id as string,
  };
}

function findConcreteContradictingEvidence(db: DatabaseSync, fact: TriageFactSnapshot): VerifiedTriageEvidence | null {
  if (!fact.entity?.trim() || !fact.key?.trim() || fact.value == null || fact.value.trim() === "") return null;
  const scopeClause =
    fact.scopeTarget != null ? "AND f.scope = ? AND f.scope_target = ?" : "AND f.scope = ? AND f.scope_target IS NULL";
  const scopeParams: SQLInputValue[] = fact.scopeTarget != null ? [fact.scope, fact.scopeTarget] : [fact.scope];
  const row = db
    .prepare(
      `SELECT f.*, vf.id AS verified_fact_id
       FROM facts f
       JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.id != ?
         AND lower(f.entity) = lower(?)
         AND lower(f.key) = lower(?)
         AND f.value IS NOT NULL
         AND lower(f.value) != lower(?)
         AND f.superseded_at IS NULL
         ${scopeClause}
       ORDER BY f.created_at DESC
       LIMIT 1`,
    )
    .get(fact.id, fact.entity, fact.key, fact.value, ...scopeParams) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    type: "contradiction",
    id: row.id as string,
    summary: "Concrete same-entity/key/scope verified fact has conflicting structured value",
    fields: {
      subject: fact.entity,
      scope: fact.scope,
      scopeTarget: fact.scopeTarget,
      claimType: fact.key,
      currentValue: fact.value,
      conflictingValue: row.value,
      sourceId: row.id,
      verifiedFactId: row.verified_fact_id,
    },
  };
}

function findSameScopeDuplicateVerifiedFact(db: DatabaseSync, fact: TriageFactSnapshot): RelatedFact | null {
  const normalized = normalizeFactText(fact.text);
  if (!normalized) return null;
  const scopeClause =
    fact.scopeTarget != null ? "AND f.scope = ? AND f.scope_target = ?" : "AND f.scope = ? AND f.scope_target IS NULL";
  const scopeParams: SQLInputValue[] = fact.scopeTarget != null ? [fact.scope, fact.scopeTarget] : [fact.scope];
  const rows = db
    .prepare(
      `SELECT f.*, vf.id AS verified_fact_id
       FROM facts f
       JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.id != ? AND f.superseded_at IS NULL ${scopeClause}
       LIMIT 50`,
    )
    .all(fact.id, ...scopeParams) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const candidate = {
      ...snapshotFromRow(row),
      verifiedFactId: row.verified_fact_id as string,
    };
    if (normalizeFactText(candidate.text) === normalized) return candidate;
  }
  return null;
}

function normalizeFactText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function weakProvenanceReason(fact: TriageFactSnapshot): string | null {
  if (fact.source === "unknown" || fact.source === "") return "Fact source is missing or unknown";
  if (!fact.provenanceJson && !fact.provenanceSession && !fact.sourceSessions) {
    return "No provenance_json, provenance_session, or source_sessions recorded";
  }
  return null;
}

function summarizeProvenance(fact: TriageFactSnapshot | null): string {
  if (!fact) return "missing fact row";
  const parts = [
    fact.provenanceJson ? "provenance_json" : null,
    fact.provenanceSession ? `session:${fact.provenanceSession}` : null,
    fact.sourceSessions ? "source_sessions" : null,
    `source:${fact.source}`,
  ].filter(Boolean);
  return parts.join(", ");
}

function validationFailureDecision(
  item: VerifiedFactTriageItem,
  context: PendingDecisionContext,
  reasonCode: AutopilotReasonCode,
  body: string,
): PendingDecision {
  const evidence = [{ type: "input-hash", id: item.id, summary: body }];
  return {
    queue: "verified",
    itemId: item.id,
    inputHash: context.inputHash,
    policy: context.policy,
    policyVersion: context.policyVersion,
    mode: context.mode,
    action: "failed-validation",
    reasonCode,
    actionClass: "observe",
    capabilityClass: "read-only",
    confidence: 0,
    humanReviewRequired: true,
    evidence,
    actor: context.actor,
    runId: context.runId,
    jobId: context.jobId,
    summary: {
      title: "verified fact failed-review",
      body,
      metadata: {
        bucket: "failed-review",
        recommendedAction: "failed-validation",
        sensitivityFlags: [],
      },
    },
    audit: {
      queue: "verified",
      itemId: item.id,
      inputHash: context.inputHash,
      policy: context.policy,
      policyVersion: context.policyVersion,
      action: "failed-validation",
      reasonCode,
      capabilityClass: "read-only",
      humanReviewRequired: true,
      evidence,
      actor: context.actor,
      runId: context.runId,
      summary: {
        title: "verified-fact-triage",
        body,
        metadata: {
          previous: { verifiedFactId: item.payload.verified.id },
          after: {
            bucket: "failed-review",
            recommendedAction: "failed-validation",
            reason: "backend_error",
          },
          mutation: "none-core-truth-fields-preserved",
        },
      },
    },
  };
}
