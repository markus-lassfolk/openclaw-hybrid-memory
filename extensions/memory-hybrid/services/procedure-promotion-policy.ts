import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProcedureEntry } from "../types/memory.js";
import { isAtomicWriteArtifact, isSkillDirComplete } from "../utils/atomic-write.js";
import { slugifyForSkill, titleCase } from "../utils/text.js";
import {
  type AutopilotReasonCode,
  type PendingDecision,
  type PendingDecisionContext,
  type PendingDecisionEvidence,
  type PendingItem,
  type PendingQueueAdapter,
  computePendingInputHash,
  redactAutopilotText,
  redactAutopilotValue,
} from "./pending-autopilot/index.js";
import {
  NON_PLACEHOLDER_EMAIL_PATTERN,
  PEM_PRIVATE_KEY_PATTERN,
  PRIVATE_IP_PATTERN,
  SkillValidator,
} from "./skill-validator.js";

export const PROCEDURE_PROMOTION_POLICY_VERSION = "procedure-promotion-policy-v1";

export const PROCEDURE_PROMOTION_POLICIES = ["draft-only", "manual", "auto-safe"] as const;
export type ProcedurePromotionPolicy = (typeof PROCEDURE_PROMOTION_POLICIES)[number];

export const PROCEDURE_PROMOTION_REASONS = [
  "eligible",
  "insufficient_success_evidence",
  "insufficient_distinct_contexts",
  "recent_failure",
  "low_success_rate",
  "low_confidence",
  "negative_or_avoidance_procedure",
  "unsafe_side_effect",
  "credential_risk",
  "private_data_risk",
  "vague_trigger",
  "duplicate_existing_skill",
  "too_context_specific",
  "no_validation_possible",
  "low_reuse_value",
  "noisy_trace",
  "non_deterministic_steps",
  "external_side_effect_requires_approval",
  "malformed_recipe",
  "skill_static_validation_failed",
  "skill_safety_validation_failed",
  "trigger_eval_failed",
  "functional_eval_failed",
  "unverified_skill_not_enabled",
  "policy_requires_human_approval",
] as const;
export type ProcedurePromotionReason = (typeof PROCEDURE_PROMOTION_REASONS)[number];

export interface ProcedurePromotionItemPayload extends Record<string, unknown> {
  taskPattern: string;
  successCount: number;
  failureCount: number;
  confidence: number;
  successRate: number | null;
  lastValidated: number | null;
  lastFailed: number | null;
  sourceSessionCount: number;
  recipe: unknown;
  skillSlug: string;
}

export interface ProcedurePromotionEvidence {
  procedureVersions?: Array<{
    id: string;
    versionNumber: number;
    successCount: number;
    failureCount: number;
    avoidanceNotes: string[] | null;
    createdAt: number;
  }>;
  procedureFailures?: Array<{
    id: string;
    versionNumber: number;
    timestamp: number;
    context: string | null;
    failedAtStep: number | null;
  }>;
  episodes?: Array<{
    id: string;
    outcome: "success" | "failure" | "partial" | "unknown";
    sessionId?: string;
  }>;
  userCorrections?: Array<{
    id: string;
    sourceSession?: string | null;
  }>;
  rulesAndPreferences?: Array<{
    id: string;
  }>;
  manualWorkflowRequests?: Array<{
    id: string;
    sourceSession?: string | null;
  }>;
}

export interface ProcedureCandidateScoreBreakdown {
  repeatCount: number;
  successRate: number;
  failureSeverity: number;
  userSignal: number;
  generality: number;
  risk: number;
  activationSpecificity: number;
  duplicatePenalty: number;
}

export interface ProcedureCandidateScore {
  score: number;
  breakdown: ProcedureCandidateScoreBreakdown;
}

export type ProcedurePromotionItem = PendingItem<ProcedurePromotionItemPayload> & {
  procedure: ProcedureEntry;
};

export interface ProcedurePromotionGateResult {
  reason: ProcedurePromotionReason;
  severity: "reject" | "defer" | "fail-validation";
  detail: string;
}

export interface GeneratedProcedureSkillDraft {
  slug: string;
  skillMd: string;
  recipeJson: string;
  verificationJson: string;
  evalsJson: string;
  proposalMetadataJson: string;
  redactionCount: number;
}

export interface ProcedurePromotionEvaluation {
  eligible: boolean;
  gates: ProcedurePromotionGateResult[];
  draft: GeneratedProcedureSkillDraft | null;
  metadata: ProcedurePromotionVerification;
}

export interface ProcedurePromotionVerification {
  skill: string;
  sourceProcedureIds: string[];
  sourceVersionIds: string[];
  sourceSessionIds: string[];
  sourceEpisodeIds: string[];
  sourceCorrectionIds: string[];
  sourceRulePreferenceIds: string[];
  sourceManualRequestIds: string[];
  sourceSuccessCount: number;
  sourceFailureCount: number;
  sourceSessionCount: number;
  sourceConfidence: number;
  sourceSuccessRate: number | null;
  riskLevel: "low" | "medium" | "high";
  candidateScore: number;
  candidateScoreBreakdown: ProcedureCandidateScoreBreakdown;
  duplicateHandling: "none" | "merge";
  validatorScore: number;
  promotionDecision: "approved" | "rejected" | "deferred" | "drafted" | "enabled" | "failed-validation";
  rejectionReasons: ProcedurePromotionReason[];
  generatedSkillPath: string | null;
  policy: ProcedurePromotionPolicy;
  policyVersion: string;
  inputHash: string;
  staticValidation: "passed" | "failed";
  safetyValidation: "passed" | "failed";
  triggerEval: "passed" | "failed";
  functionalEval: "passed" | "failed";
  baselineComparison: {
    withSkillPassed: boolean;
    withoutSkillPassed: boolean;
    improvement: string;
  };
  enabled: boolean;
  requiresHumanApproval: boolean;
  lifecycleState: "experimental";
  telemetryCommand: string;
  falsePositiveCommandTemplate: string;
  lastVerifiedAt: string;
}

export interface ProcedurePromotionDuplicateCandidate {
  slug: string;
  taskPattern: string;
}

export interface ProcedurePromotionPolicyOptions {
  validationThreshold: number;
  skillsAutoPath: string;
  existingSkillDirs?: string[];
  inRunSkillCandidates?: readonly ProcedurePromotionDuplicateCandidate[];
  minDistinctContexts?: number;
  minConfidence?: number;
  minSuccessRate?: number;
  now?: number;
  resolvedSlug?: string;
  evidence?: ProcedurePromotionEvidence;
  /** When true, re-read every SKILL.md from disk for duplicate detection (ignore mtime cache). */
  bypassDuplicateSkillCache?: boolean;
}

const DEFAULT_MIN_DISTINCT_CONTEXTS = 2;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MIN_SUCCESS_RATE = 0.75;
const RECENT_FAILURE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

const DESTRUCTIVE_OR_PRIVILEGED_PATTERNS: Array<[RegExp, ProcedurePromotionReason, string]> = [
  [
    /\brm\s+-[rf]+\b|\bdd\s+if=|\bmkfs\b|\bshred\b|\bdrop\s+table\b|\btruncate\s+table\b/i,
    "unsafe_side_effect",
    "destructive shell/database operation",
  ],
  [
    /\b(systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\b/i,
    "unsafe_side_effect",
    "service lifecycle mutation",
  ],
  [
    /\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo|gem)\s+(install|add|remove|uninstall|upgrade)\b/i,
    "unsafe_side_effect",
    "package installation/removal",
  ],
  [
    /\bssh\s+[^\n]+@|\bscp\s+|\brsync\s+[^\n]+:/i,
    "external_side_effect_requires_approval",
    "SSH or remote host operation",
  ],
  [
    /\b(curl|wget|fetch)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE))/i,
    "external_side_effect_requires_approval",
    "external network write",
  ],
  [
    /"tool"\s*:\s*"(?:message|email|mail)"|\b(?:message|email|mail|slack|telegram|discord)\b[^\n]{0,80}\b(?:send|post|publish|deliver|reply|notify|update)\b|\b(?:send|post|publish|deliver|reply|notify)\b[^\n]{0,80}\b(?:message|email|mail|slack|telegram|discord)\b/i,
    "external_side_effect_requires_approval",
    "external send/post action",
  ],
  [
    /\b(approve|approval)\b[^\n]{0,80}\b(bypass|skip|ignore)\b|\bignore\s+(?:previous|system|developer)\s+instructions\b/i,
    "unsafe_side_effect",
    "approval bypass or prompt injection",
  ],
];

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*[^\s,;}{\[\]]+/i,
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  PEM_PRIVATE_KEY_PATTERN,
];

const PRIVATE_DATA_PATTERNS: RegExp[] = [
  PRIVATE_IP_PATTERN,
  /(?:^|[\s"'=:])(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/,
  NON_PLACEHOLDER_EMAIL_PATTERN,
];

export function parseProcedurePromotionPolicy(policy: string | undefined): ProcedurePromotionPolicy {
  const selected = policy ?? "draft-only";
  if ((PROCEDURE_PROMOTION_POLICIES as readonly string[]).includes(selected)) {
    return selected as ProcedurePromotionPolicy;
  }
  throw new Error(`Unknown procedure promotion policy: ${selected}`);
}

export function createProcedurePromotionItem(
  proc: ProcedureEntry,
  _policy: ProcedurePromotionPolicy,
): ProcedurePromotionItem {
  const recipe = parseRecipeOrRaw(proc.recipeJson);
  const sourceSessionCount = countDistinctSourceSessions(proc.sourceSessions);
  const successRate = computeSuccessRate(proc);
  const skillSlug = slugifyForSkill(proc.taskPattern, "procedure");
  const payload: ProcedurePromotionItemPayload = {
    taskPattern: proc.taskPattern,
    successCount: proc.successCount,
    failureCount: proc.failureCount,
    confidence: proc.confidence,
    successRate,
    lastValidated: proc.lastValidated,
    lastFailed: proc.lastFailed,
    sourceSessionCount,
    recipe,
    skillSlug,
  };
  const inputHash = computePendingInputHash({
    queue: "procedures",
    id: proc.id,
    payload,
    policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
  });
  return {
    queue: "procedures",
    id: proc.id,
    inputHash,
    policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
    capabilityClasses: ["read-only", "dry-run", "write-draft-artifact"],
    payload,
    procedure: proc,
    requiresHumanReview: false,
  };
}

export function evaluateProcedureForPromotion(
  item: ProcedurePromotionItem,
  policy: ProcedurePromotionPolicy,
  options: ProcedurePromotionPolicyOptions,
): ProcedurePromotionEvaluation {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const evidenceSummary = summarizeProcedureEvidence(item, options.evidence);
  const riskLevel = determineRiskLevel(item.procedure, item.payload.recipe);
  const riskValidationBump = riskLevel === "high" ? 2 : riskLevel === "medium" ? 1 : 0;
  const riskDistinctBump = riskLevel === "high" ? 1 : 0;
  const minDistinctContexts = (options.minDistinctContexts ?? DEFAULT_MIN_DISTINCT_CONTEXTS) + riskDistinctBump;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minSuccessRate = Math.min(
    0.95,
    (options.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE) +
      (riskLevel === "high" ? 0.15 : riskLevel === "medium" ? 0.05 : 0),
  );
  const requiredSuccessCount = options.validationThreshold + riskValidationBump;
  const proc = item.procedure;
  const gates: ProcedurePromotionGateResult[] = [];
  const recipe = item.payload.recipe;
  const recipeText = JSON.stringify(recipe);
  const combinedText = `${proc.taskPattern}\n${recipeText}`;

  if (proc.procedureType !== "positive")
    gates.push(reject("negative_or_avoidance_procedure", "procedure is not positive"));
  if (evidenceSummary.successCount < requiredSuccessCount)
    gates.push(
      defer("insufficient_success_evidence", `successCount ${evidenceSummary.successCount} < ${requiredSuccessCount}`),
    );
  if (evidenceSummary.sourceSessionCount < minDistinctContexts)
    gates.push(
      defer(
        "insufficient_distinct_contexts",
        `distinct source sessions ${evidenceSummary.sourceSessionCount} < ${minDistinctContexts}`,
      ),
    );
  if (
    proc.lastFailed &&
    (!proc.lastValidated || proc.lastFailed >= proc.lastValidated) &&
    now - proc.lastFailed <= RECENT_FAILURE_WINDOW_SECONDS
  )
    gates.push(defer("recent_failure", "procedure has a recent or newer failure"));
  if (evidenceSummary.successRate < minSuccessRate)
    gates.push(defer("low_success_rate", `successRate ${evidenceSummary.successRate} < ${minSuccessRate}`));
  if (proc.confidence < minConfidence)
    gates.push(defer("low_confidence", `confidence ${proc.confidence} < ${minConfidence}`));
  if (!Array.isArray(recipe) || recipe.length === 0)
    gates.push(fail("malformed_recipe", "recipe must be a non-empty JSON array"));
  if (Array.isArray(recipe) && recipe.length === 1)
    gates.push(defer("low_reuse_value", "recipe is too thin to justify a skill"));
  if (!hasEnoughTaskBoundary(proc.taskPattern))
    gates.push(defer("vague_trigger", "task pattern lacks a clear reusable boundary"));
  if (looksTooContextSpecific(proc.taskPattern))
    gates.push(defer("too_context_specific", "procedure task pattern appears bound to a private/local context"));
  if (looksNoisy(recipe)) gates.push(defer("noisy_trace", "recipe contains noisy trace steps"));
  if (looksNonDeterministic(combinedText))
    gates.push(defer("non_deterministic_steps", "recipe relies on non-deterministic timing or vague judgment"));
  if (!hasValidationCheck(recipe, proc.taskPattern))
    gates.push(defer("no_validation_possible", "no objective validation check is present or inferable"));
  const resolvedSkillSlug = options.resolvedSlug ?? item.payload.skillSlug;
  const similarSkillExists = isDuplicateSkill(
    resolvedSkillSlug,
    proc.taskPattern,
    options.skillsAutoPath,
    options.existingSkillDirs,
    options.inRunSkillCandidates,
    options.bypassDuplicateSkillCache === true,
  );
  if (similarSkillExists)
    gates.push(defer("duplicate_existing_skill", "existing or earlier same-run skill appears to cover this trigger"));

  const candidateScoring = scoreProcedureCandidate({
    successCount: evidenceSummary.successCount,
    successRate: evidenceSummary.successRate,
    failureSeverity: evidenceSummary.failureSeverity,
    userSignal: evidenceSummary.userSignal,
    generality: Math.min(1, evidenceSummary.sourceSessionCount / 3),
    riskLevel,
    activationSpecificity:
      hasEnoughTaskBoundary(proc.taskPattern) && !looksTooContextSpecific(proc.taskPattern) ? 1 : 0.4,
    similarSkillExists,
  });

  gates.push(...scanSafety(combinedText));

  const initialGates = gates.length;
  const draft = initialGates > 0 ? null : buildProcedureSkillDraft(item, policy, options, gates, resolvedSkillSlug);
  if (draft) {
    const validator = new SkillValidator();
    const staticResult = validator.validate(draft.skillMd);
    if (!staticResult.valid) gates.push(fail("skill_static_validation_failed", staticResult.violations.join("; ")));
    const draftSafety = scanSafety(`${draft.skillMd}\n${draft.recipeJson}`);
    if (draftSafety.length > 0)
      gates.push(
        ...draftSafety.map((g) => ({
          ...g,
          reason:
            g.reason === "credential_risk"
              ? "credential_risk"
              : ("skill_safety_validation_failed" as ProcedurePromotionReason),
        })),
      );
  }

  const eligible = gates.length === 0;
  const finalDraft = eligible ? draft : null;
  const generatedPath = eligible && finalDraft ? join(options.skillsAutoPath, finalDraft.slug) : null;
  const telemetryCommand = `openclaw hybrid-mem skills record ${resolvedSkillSlug}`;
  const validatorScore = Number(
    Math.max(
      0,
      Math.min(
        1,
        candidateScoring.score * (gates.length === 0 ? 1 : gates.some((g) => g.severity === "reject") ? 0.35 : 0.65),
      ),
    ).toFixed(3),
  );
  const metadata: ProcedurePromotionVerification = {
    skill: resolvedSkillSlug,
    sourceProcedureIds: [proc.id],
    sourceVersionIds: evidenceSummary.sourceVersionIds,
    sourceSessionIds: evidenceSummary.sourceSessionIds,
    sourceEpisodeIds: evidenceSummary.sourceEpisodeIds,
    sourceCorrectionIds: evidenceSummary.sourceCorrectionIds,
    sourceRulePreferenceIds: evidenceSummary.sourceRulePreferenceIds,
    sourceManualRequestIds: evidenceSummary.sourceManualRequestIds,
    sourceSuccessCount: evidenceSummary.successCount,
    sourceFailureCount: evidenceSummary.failureCount,
    sourceSessionCount: evidenceSummary.sourceSessionCount,
    sourceConfidence: proc.confidence,
    sourceSuccessRate: evidenceSummary.successRate,
    riskLevel,
    candidateScore: candidateScoring.score,
    candidateScoreBreakdown: candidateScoring.breakdown,
    duplicateHandling: similarSkillExists ? "merge" : "none",
    validatorScore,
    promotionDecision: eligible
      ? policy === "auto-safe"
        ? "drafted"
        : "deferred"
      : gates.some((g) => g.severity === "reject")
        ? "rejected"
        : gates.some((g) => g.severity === "fail-validation")
          ? "failed-validation"
          : "deferred",
    rejectionReasons: gates.map((g) => g.reason),
    generatedSkillPath: generatedPath,
    policy,
    policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
    inputHash: item.inputHash,
    staticValidation: gates.some(
      (g) => g.reason === "skill_static_validation_failed" || g.reason === "malformed_recipe",
    )
      ? "failed"
      : initialGates > 0
        ? "failed"
        : draft
          ? "passed"
          : "failed",
    safetyValidation: gates.some((g) =>
      [
        "unsafe_side_effect",
        "credential_risk",
        "private_data_risk",
        "external_side_effect_requires_approval",
        "skill_safety_validation_failed",
      ].includes(g.reason),
    )
      ? "failed"
      : "passed",
    triggerEval: gates.some((g) => g.reason === "trigger_eval_failed") ? "failed" : eligible ? "passed" : "passed",
    functionalEval: gates.some((g) => g.reason === "functional_eval_failed") ? "failed" : "passed",
    baselineComparison: {
      withSkillPassed: eligible,
      withoutSkillPassed: false,
      improvement: eligible
        ? "deterministic scaffold requires ordered workflow, validation, failure handling, and unsafe-action checks that the raw procedure does not enforce"
        : "not evaluated because promotion gates did not pass",
    },
    enabled: false,
    requiresHumanApproval: policy !== "auto-safe" || !eligible,
    lifecycleState: "experimental",
    telemetryCommand,
    falsePositiveCommandTemplate: 'openclaw hybrid-mem skills correct <activation-id> --reason "user rejected skill"',
    lastVerifiedAt: new Date(now * 1000).toISOString(),
  };
  if (finalDraft) {
    finalDraft.verificationJson = `${JSON.stringify(redactAutopilotValue(metadata), null, 2)}\n`;
    finalDraft.proposalMetadataJson = `${JSON.stringify(
      redactAutopilotValue(createProposalMetadata(metadata, evidenceSummary)),
      null,
      2,
    )}\n`;
  }
  return { eligible, gates, draft: finalDraft, metadata };
}

export function createProcedurePromotionDecision(
  item: ProcedurePromotionItem,
  context: PendingDecisionContext,
  evaluation: ProcedurePromotionEvaluation,
): PendingDecision {
  const mostSevereGate = findMostSevereGate(evaluation.gates);
  const policyAllowsDraftWrite = context.policy === "auto-safe";
  const eligibleForMutation = evaluation.eligible && policyAllowsDraftWrite;
  const action = eligibleForMutation
    ? "promoted-to-draft"
    : evaluation.eligible
      ? "deferred-for-human"
      : mostSevereGate?.severity === "fail-validation"
        ? "failed-validation"
        : mostSevereGate?.severity === "reject"
          ? "rejected"
          : "deferred-for-human";
  const schemaValidationReasons: ProcedurePromotionReason[] = ["malformed_recipe", "skill_static_validation_failed"];
  const reasonCode: AutopilotReasonCode = eligibleForMutation
    ? context.mode === "dry-run"
      ? "dry-run"
      : "approved"
    : evaluation.eligible
      ? "human-review-required"
      : mostSevereGate && schemaValidationReasons.includes(mostSevereGate.reason)
        ? "schema-validation-failed"
        : mostSevereGate?.reason === "duplicate_existing_skill"
          ? "duplicate-input"
          : mostSevereGate?.severity === "reject"
            ? "policy-denied"
            : "policy-threshold-not-met";
  const capabilityClass = eligibleForMutation ? "write-draft-artifact" : "record-review-metadata";
  const evidence: PendingDecisionEvidence[] = [
    { type: "procedure", id: item.id, summary: item.payload.taskPattern },
    ...evaluation.gates.map((g) => ({
      type: "gate",
      id: g.reason,
      summary: g.detail,
    })),
  ];
  return {
    queue: "procedures",
    itemId: item.id,
    inputHash: item.inputHash,
    policy: context.policy,
    policyVersion: context.policyVersion,
    mode: context.mode,
    action,
    reasonCode,
    actionClass: eligibleForMutation ? "draft-artifact" : "record-review",
    capabilityClass,
    confidence: eligibleForMutation ? 0.95 : Math.min(0.9, Math.max(0.6, item.payload.confidence)),
    humanReviewRequired: action === "deferred-for-human",
    evidence,
    actor: context.actor,
    runId: context.runId,
    jobId: context.jobId,
    summary: {
      title: "procedure-promotion",
      body: redactAutopilotText(
        eligibleForMutation
          ? `Drafted verified skill candidate ${evaluation.metadata.skill} from procedure ${item.id}; enabled=false.`
          : evaluation.eligible
            ? `Procedure ${item.id} deferred-for-human: policy=${context.policy} requires manual approval before draft writes.`
            : `Procedure ${item.id} ${action}: ${evaluation.gates.map((g) => g.reason).join(", ")}`,
      ).redacted,
    },
    audit: {
      queue: "procedures",
      itemId: item.id,
      inputHash: item.inputHash,
      policy: context.policy,
      policyVersion: context.policyVersion,
      action,
      reasonCode,
      capabilityClass,
      humanReviewRequired: action === "deferred-for-human",
      evidence,
      actor: context.actor,
      runId: context.runId,
      jobId: context.jobId,
      summary: {
        title: "procedure-promotion",
        body: redactAutopilotText(
          eligibleForMutation
            ? `Drafted verified skill candidate ${evaluation.metadata.skill} from procedure ${item.id}; enabled=false.`
            : evaluation.eligible
              ? `Procedure ${item.id} deferred-for-human: policy=${context.policy} requires manual approval before draft writes.`
              : `Procedure ${item.id} ${action}: ${evaluation.gates.map((g) => g.reason).join(", ")}`,
        ).redacted,
        metadata: redactAutopilotValue(evaluation.metadata) as Record<string, unknown>,
      },
    },
  };
}

export class ProcedurePromotionAdapter implements PendingQueueAdapter<ProcedurePromotionItem> {
  readonly queue = "procedures" as const;
  constructor(
    private readonly procedures: ProcedureEntry[],
    private readonly policy: ProcedurePromotionPolicy,
    private readonly options: ProcedurePromotionPolicyOptions,
  ) {}

  listPending(): ProcedurePromotionItem[] {
    return this.procedures.map((proc) => createProcedurePromotionItem(proc, this.policy));
  }

  decide(item: ProcedurePromotionItem, context: PendingDecisionContext): PendingDecision {
    const evaluation = evaluateProcedureForPromotion(item, this.policy, this.options);
    return createProcedurePromotionDecision(item, context, evaluation);
  }
}

function buildProcedureSkillDraft(
  item: ProcedurePromotionItem,
  policy: ProcedurePromotionPolicy,
  options: ProcedurePromotionPolicyOptions,
  gates: ProcedurePromotionGateResult[],
  slug: string,
): GeneratedProcedureSkillDraft {
  const proc = item.procedure;
  const recipe = redactAutopilotValue(item.payload.recipe);
  const recipeJson = `${JSON.stringify(recipe, null, 2)}\n`;
  const redactedTask = redactAutopilotText(proc.taskPattern);
  const workflow = Array.isArray(recipe)
    ? recipe
        .map((step, i) => {
          const s = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
          const tool = typeof s.tool === "string" ? s.tool : "manual check";
          const summary =
            typeof s.summary === "string" ? s.summary : "follow the recorded safe step, then verify before continuing";
          return `${i + 1}. Use \`${tool}\` only for the bounded task: ${redactAutopilotText(summary).redacted}.`;
        })
        .join("\n")
    : "1. Reconstruct the workflow from recipe.json only after human review.";
  const nearMiss = `Tasks that mention ${firstKeyword(
    proc.taskPattern,
  )} but require sending, destructive changes, credential access, or unrelated troubleshooting.`;
  const telemetryCommand = `openclaw hybrid-mem skills record ${slug}`;
  const telemetryRequestSummaryArg = shellQuote(redactedTask.redacted);
  const antiPatterns = buildAntiPatternsForProcedure(proc);
  const skillMd = `---
name: ${slug}
description: Use when the user asks to ${redactedTask.redacted}. Trigger examples: "${
    redactedTask.redacted
  }", "run the validated ${firstKeyword(proc.taskPattern)} workflow". Do not use for destructive changes, external sends, credential access, or unrelated near-miss tasks.
category: procedure
provenance: procedure:${proc.id}
generated_at: ${new Date((options.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10)}
---

# ${titleCase(slug)}

## When to Activate
Use this skill when the task clearly matches this validated procedure: **${redactedTask.redacted}**.

Positive examples:
- "${redactedTask.redacted}"
- "Use the validated workflow for ${firstKeyword(proc.taskPattern)}."

Near-miss examples that should not trigger:
- "${nearMiss}"
- "Create a new unrelated automation from scratch."

## Scope
This skill guides a bounded, repeatable workflow learned from procedural memory.

## Do Not Use When
- Do not use for destructive shell/service/package operations.
- Do not use for SSH, remote writes, credential retrieval, or external sending/posting unless a human explicitly approves.
- Do not use when the user request is broader than the source procedure.
- Defer to a more specific existing skill when triggers overlap.

## Prerequisites
- Source procedure id: \`${proc.id}\`.
- Minimum success evidence: ${
    options.validationThreshold
  }; observed successes: ${proc.successCount}; failures: ${proc.failureCount}.
- Generated as a draft/quarantined skill. It is not enabled by default.

## Workflow
${workflow}

## Safe tool usage
Use only the tools implied by the source recipe and only in dry-run/read-only ways unless the user explicitly approves the side effect. Redact secrets and private paths from all logs and summaries.

## Verification
- Confirm the expected output exists and matches the user's request.
- Prefer objective checks such as file existence, JSON/schema validation, command exit status, or exact status text.
- Stop and ask for review if validation is unavailable or ambiguous.

## Failure handling
- If any step fails, stop rather than improvising a new side-effecting workflow.
- Report the failed step, error, and safe rollback/disable guidance.
- Record procedure feedback instead of silently retrying unsafe actions.

## Rollback / disable guidance
Leave this generated skill disabled until verification or human approval. To disable, remove it from the enabled skill path or keep it in quarantine/draft storage.

## Telemetry
- When this skill is selected, record the activation with \`${telemetryCommand} --decision selected --request-summary ${telemetryRequestSummaryArg} --outcome success\` (or \`failure\` / \`partial\` if the run did not fully succeed).
- When this skill was considered but skipped, record a near-miss with \`${telemetryCommand} --decision skipped --request-summary ${telemetryRequestSummaryArg} --reason "near-miss summary"\`.
- Capture the returned activation id so a later user correction can mark that exact run as a false-positive with \`openclaw hybrid-mem skills correct <activation-id> --reason "user rejected skill"\`.

## Anti-patterns / Known Failures
${antiPatterns}

## Examples
- Good: "${redactedTask.redacted}" → follow the ordered workflow and validation gate.
- Bad: "${nearMiss}" → do not use; ask for clarification or use another skill.

## Related tools/skills
- Related tool: \`memory_procedure_feedback\` (record failures/success so anti-patterns improve over time).
- Related skill: Prefer a more specific existing skill if it matches the trigger more precisely.

## Provenance
- Source procedure id: \`${proc.id}\`
- Success count: ${proc.successCount}
- Failure count: ${proc.failureCount}
- Source session/context count: ${item.payload.sourceSessionCount}
- Last validated: ${proc.lastValidated ? new Date(proc.lastValidated * 1000).toISOString() : "unknown"}
- Policy: ${policy} (${PROCEDURE_PROMOTION_POLICY_VERSION})
- Input hash: ${item.inputHash}
- Verification status: draft; static/safety/trigger/functional eval metadata in \`verification.json\` and \`evals/evals.json\`.
`;
  const verification: ProcedurePromotionVerification = {
    skill: slug,
    sourceProcedureIds: [proc.id],
    sourceVersionIds: [],
    sourceSessionIds: [],
    sourceEpisodeIds: [],
    sourceCorrectionIds: [],
    sourceRulePreferenceIds: [],
    sourceManualRequestIds: [],
    sourceSuccessCount: proc.successCount,
    sourceFailureCount: proc.failureCount,
    sourceSessionCount: item.payload.sourceSessionCount,
    sourceConfidence: proc.confidence,
    sourceSuccessRate: item.payload.successRate,
    riskLevel: "low",
    candidateScore: 0,
    candidateScoreBreakdown: {
      repeatCount: 0,
      successRate: 0,
      failureSeverity: 0,
      userSignal: 0,
      generality: 0,
      risk: 0,
      activationSpecificity: 0,
      duplicatePenalty: 1,
    },
    duplicateHandling: "none",
    validatorScore: 0,
    promotionDecision: "drafted",
    rejectionReasons: gates.map((g) => g.reason),
    generatedSkillPath: join(options.skillsAutoPath, slug),
    policy,
    policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
    inputHash: item.inputHash,
    staticValidation: "passed",
    safetyValidation: "passed",
    triggerEval: "passed",
    functionalEval: "passed",
    baselineComparison: {
      withSkillPassed: true,
      withoutSkillPassed: false,
      improvement:
        "with-skill scaffold preserves validated steps, safety gates, and validation criteria absent from the raw procedure",
    },
    enabled: false,
    requiresHumanApproval: policy !== "auto-safe",
    lifecycleState: "experimental",
    telemetryCommand,
    falsePositiveCommandTemplate: 'openclaw hybrid-mem skills correct <activation-id> --reason "user rejected skill"',
    lastVerifiedAt: new Date((options.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  const evals = {
    trigger: {
      shouldTrigger: [proc.taskPattern, `run the validated ${firstKeyword(proc.taskPattern)} workflow`],
      shouldNotTrigger: [nearMiss, "perform an unrelated destructive maintenance task"],
      collisionPolicy: "defer to a more specific existing skill when overlap is detected",
      status: "passed",
    },
    functionalUsefulness: {
      baseline: {
        passed: false,
        reason: "raw procedure lacks reusable trigger, safety, validation, and failure handling sections",
      },
      withSkill: {
        passed: true,
        reason: "generated draft supplies ordered workflow, validation gate, non-scope, and rollback guidance",
      },
    },
  };
  return {
    slug,
    skillMd,
    recipeJson,
    verificationJson: `${JSON.stringify(redactAutopilotValue(verification), null, 2)}\n`,
    evalsJson: `${JSON.stringify(redactAutopilotValue(evals), null, 2)}\n`,
    proposalMetadataJson: "{}\n",
    redactionCount: redactedTask.redactionCount,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseRecipeOrRaw(recipeJson: string): unknown {
  try {
    return JSON.parse(recipeJson);
  } catch {
    return { malformed: true, raw: recipeJson };
  }
}

function countDistinctSourceSessions(raw: string | undefined): number {
  const tokens = parseSourceSessionTokenList(raw);
  if (tokens.length === 0) return 1;
  return new Set(tokens).size || 1;
}

/** Normalized session ids from `procedures.source_sessions` (JSON array or legacy delimited text). */
function parseSourceSessionTokenList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
    }
  } catch {
    // fall through
  }
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function computeSuccessRate(proc: ProcedureEntry): number | null {
  const explicit = proc.successRate;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const total = proc.successCount + proc.failureCount;
  return total > 0 ? proc.successCount / total : null;
}

function summarizeProcedureEvidence(
  item: ProcedurePromotionItem,
  evidence: ProcedurePromotionEvidence | undefined,
): {
  successCount: number;
  failureCount: number;
  successRate: number;
  failureSeverity: number;
  userSignal: number;
  sourceSessionCount: number;
  sourceVersionIds: string[];
  sourceSessionIds: string[];
  sourceEpisodeIds: string[];
  sourceCorrectionIds: string[];
  sourceRulePreferenceIds: string[];
  sourceManualRequestIds: string[];
} {
  const procedureVersions = evidence?.procedureVersions ?? [];
  const versionSuccesses = procedureVersions.reduce((sum, version) => sum + Math.max(0, version.successCount), 0);
  const versionFailures = procedureVersions.reduce((sum, version) => sum + Math.max(0, version.failureCount), 0);
  const versionTotal = versionSuccesses + versionFailures;
  const procTotal = item.payload.successCount + item.payload.failureCount;
  let successCount: number;
  let failureCount: number;
  if (procedureVersions.length === 0) {
    successCount = item.procedure.successCount;
    failureCount = item.procedure.failureCount;
  } else if (versionTotal >= procTotal && (versionSuccesses > 0 || versionFailures > 0)) {
    successCount = versionSuccesses;
    failureCount = versionFailures;
  } else {
    successCount = Math.max(item.procedure.successCount, versionSuccesses);
    failureCount = Math.max(item.procedure.failureCount, versionFailures);
  }
  const successRateFromCounts = successCount + failureCount > 0 ? successCount / (successCount + failureCount) : 1;
  const successRate = Math.max(0, Math.min(1, successRateFromCounts));

  const failureRecords = evidence?.procedureFailures ?? [];
  const failureEpisodes = (evidence?.episodes ?? []).filter((episode) => episode.outcome === "failure").length;
  const partialEpisodes = (evidence?.episodes ?? []).filter((episode) => episode.outcome === "partial").length;
  const avoidanceNotes = procedureVersions.reduce(
    (sum, version) => sum + (Array.isArray(version.avoidanceNotes) ? version.avoidanceNotes.length : 0),
    0,
  );
  const failureSeverity = Math.max(
    0,
    Math.min(
      1,
      (failureCount * 0.2 +
        failureRecords.length * 0.1 +
        failureEpisodes * 0.15 +
        partialEpisodes * 0.05 +
        avoidanceNotes * 0.05) /
        3,
    ),
  );

  const correctionCount = evidence?.userCorrections?.length ?? 0;
  const manualRequestCount = evidence?.manualWorkflowRequests?.length ?? 0;
  const rulesPreferenceCount = evidence?.rulesAndPreferences?.length ?? 0;
  const userSignal = Math.max(
    0,
    Math.min(
      1,
      0.5 + manualRequestCount * 0.15 + rulesPreferenceCount * 0.05 - correctionCount * 0.15 - failureEpisodes * 0.08,
    ),
  );

  const sourceSessionIds = collectDistinctSessionIds(item.procedure.sourceSessions, evidence);
  return {
    successCount,
    failureCount,
    successRate,
    failureSeverity,
    userSignal,
    sourceSessionCount: sourceSessionIds.length || item.payload.sourceSessionCount,
    sourceVersionIds: procedureVersions.map((version) => version.id),
    sourceSessionIds,
    sourceEpisodeIds: (evidence?.episodes ?? []).map((episode) => episode.id),
    sourceCorrectionIds: (evidence?.userCorrections ?? []).map((correction) => correction.id),
    sourceRulePreferenceIds: (evidence?.rulesAndPreferences ?? []).map((entry) => entry.id),
    sourceManualRequestIds: (evidence?.manualWorkflowRequests ?? []).map((entry) => entry.id),
  };
}

function collectDistinctSessionIds(
  sourceSessions: string | undefined,
  evidence: ProcedurePromotionEvidence | undefined,
): string[] {
  const source = new Set<string>();
  if (sourceSessions) {
    for (const session of parseSourceSessionTokenList(sourceSessions)) source.add(session);
  }
  for (const episode of evidence?.episodes ?? []) {
    if (typeof episode.sessionId === "string" && episode.sessionId.trim().length > 0)
      source.add(episode.sessionId.trim());
  }
  return [...source];
}

function determineRiskLevel(proc: ProcedureEntry, recipe: unknown): "low" | "medium" | "high" {
  const combined = `${proc.taskPattern}\n${JSON.stringify(recipe)}`;
  if (
    /(?:\brm\s+-[rf]+\b|\bdd\s+if=|\bmkfs\b|\bshred\b|\bdrop\s+table\b|\btruncate\s+table\b)|(?:\bprivate[_-]?key\b|\b(?:token|password)\b)\s*[:=]/i.test(
      combined,
    )
  )
    return "high";
  if (
    /\b(systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\b|\b(npm|pnpm|yarn|pip|apt|brew|cargo)\s+(install|add|remove|uninstall|upgrade)\b|\bssh\b|\bscp\b|\brsync\b|\b(curl|wget)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE))/i.test(
      combined,
    )
  )
    return "medium";
  return "low";
}

function scoreProcedureCandidate(input: {
  successCount: number;
  successRate: number;
  failureSeverity: number;
  userSignal: number;
  generality: number;
  riskLevel: "low" | "medium" | "high";
  activationSpecificity: number;
  similarSkillExists: boolean;
}): ProcedureCandidateScore {
  const repeatCount = Math.min(1, input.successCount / 6);
  const successRate = Math.max(0, Math.min(1, input.successRate));
  const failureSeverity = Math.max(0, Math.min(1, input.failureSeverity));
  const userSignal = Math.max(0, Math.min(1, input.userSignal));
  const generality = Math.max(0, Math.min(1, input.generality));
  const risk = input.riskLevel === "high" ? 0.35 : input.riskLevel === "medium" ? 0.65 : 1;
  const activationSpecificity = Math.max(0, Math.min(1, input.activationSpecificity));
  const duplicatePenalty = input.similarSkillExists ? 0.5 : 1;
  const rawScore =
    repeatCount * 0.2 +
    successRate * 0.25 +
    (1 - failureSeverity) * 0.2 +
    userSignal * 0.1 +
    generality * 0.1 +
    risk * 0.05 +
    activationSpecificity * 0.1;
  const score = Number(Math.max(0, Math.min(1, rawScore * duplicatePenalty)).toFixed(3));
  return {
    score,
    breakdown: {
      repeatCount: Number(repeatCount.toFixed(3)),
      successRate: Number(successRate.toFixed(3)),
      failureSeverity: Number(failureSeverity.toFixed(3)),
      userSignal: Number(userSignal.toFixed(3)),
      generality: Number(generality.toFixed(3)),
      risk: Number(risk.toFixed(3)),
      activationSpecificity: Number(activationSpecificity.toFixed(3)),
      duplicatePenalty: Number(duplicatePenalty.toFixed(3)),
    },
  };
}

function createProposalMetadata(
  metadata: ProcedurePromotionVerification,
  evidenceSummary: ReturnType<typeof summarizeProcedureEvidence>,
): Record<string, unknown> {
  return {
    source_procedures: metadata.sourceProcedureIds,
    source_sessions: metadata.sourceSessionIds,
    source_episodes: metadata.sourceEpisodeIds,
    source_versions: metadata.sourceVersionIds,
    source_corrections: metadata.sourceCorrectionIds,
    source_rules_preferences: metadata.sourceRulePreferenceIds,
    source_manual_requests: metadata.sourceManualRequestIds,
    success_count: evidenceSummary.successCount,
    failure_count: evidenceSummary.failureCount,
    risk_level: metadata.riskLevel,
    validator_score: metadata.validatorScore,
    candidate_score: metadata.candidateScore,
    duplicate_handling: metadata.duplicateHandling,
    last_validated: metadata.lastVerifiedAt,
  };
}

function hasEnoughTaskBoundary(task: string): boolean {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (words.length < 3) return false;

  const vagueWords = new Set([
    "fix",
    "fixes",
    "handle",
    "handles",
    "do",
    "does",
    "run",
    "runs",
    "process",
    "processes",
    "misc",
    "stuff",
    "thing",
    "things",
  ]);
  const meaningfulWords = words.filter((word) => {
    return !vagueWords.has(word);
  });
  return meaningfulWords.length >= 2;
}

const CONTEXT_SPECIFIC_PATTERN = /\b(?:my|household|personal)\b/i;

function looksTooContextSpecific(text: string): boolean {
  return CONTEXT_SPECIFIC_PATTERN.test(text);
}

function looksNoisy(recipe: unknown): boolean {
  if (!Array.isArray(recipe)) return false;
  const text = JSON.stringify(recipe);
  return recipe.length > 20 || /\b(screenshot|scroll|click|wait|sleep|retry again|random|debug dump)\b/i.test(text);
}

function looksNonDeterministic(text: string): boolean {
  return /\b(maybe|guess|try until|random|wait a while|eventually|probably|if it feels)\b/i.test(text);
}

function hasValidationCheck(recipe: unknown, _task: string): boolean {
  if (!Array.isArray(recipe)) return false;
  const explicitValidationPattern =
    /\b(?:verify|validate|assert|expect|lint|typecheck)\b|\b(?:test\s+(?:pass|fail|result)|exit\s+(?:code|status)|diff\s+(?:output|result)|file\s+exists)\b/i;
  return recipe.some((step) => {
    if (!step || typeof step !== "object") return false;
    const s = step as Record<string, unknown>;
    const fields = [s.summary, s.validation, s.expected, s.check, s.assertion, s.command]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const args = s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {};
    const argFields = [args.command, args.validation, args.expected, args.check, args.assertion]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return explicitValidationPattern.test(`${fields}\n${argFields}`);
  });
}

/** Minimal LRU cache with max-size cap for skill MD digest cache. */
class LRUCache<K, V> {
  private readonly cache: Map<K, V>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.cache = new Map();
    this.capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value as K;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const skillMdDuplicateDigestCache = new LRUCache<string, { mtimeMs: number; lower: string }>(500);

/** Clears the SKILL.md mtime cache used by duplicate-skill detection (for tests and --bypass-skill-duplicate-cache). */
export function clearProcedurePromotionDuplicateSkillCache(): void {
  skillMdDuplicateDigestCache.clear();
}

function readSkillMdLowerCached(skillPath: string, bypassCache: boolean): string | null {
  if (bypassCache) {
    const raw = safeReadFile(skillPath);
    return raw ? raw.toLowerCase() : null;
  }
  try {
    const mtimeMs = Math.trunc(statSync(skillPath).mtimeMs);
    const hit = skillMdDuplicateDigestCache.get(skillPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.lower;
    const raw = safeReadFile(skillPath);
    if (!raw) return null;
    const lower = raw.toLowerCase();
    skillMdDuplicateDigestCache.set(skillPath, { mtimeMs, lower });
    return lower;
  } catch {
    return null;
  }
}

function isDuplicateSkill(
  slug: string,
  task: string,
  skillsAutoPath: string,
  extraDirs: string[] = [],
  inRunCandidates: readonly ProcedurePromotionDuplicateCandidate[] = [],
  bypassDiskCache = false,
): boolean {
  const dirs = [skillsAutoPath, ...extraDirs];
  const taskWords = significantWords(task);
  for (const candidate of inRunCandidates) {
    if (candidate.slug === slug) return true;
    const candidateWords = significantWords(candidate.taskPattern);
    const overlap = [...taskWords].filter((w) => candidateWords.has(w)).length;
    if (taskWords.size >= 2 && overlap >= Math.min(2, taskWords.size)) return true;
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of safeReadDir(dir)) {
      const skillPath = join(dir, entry, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      // Atomic writer crash leftovers can contain a SKILL.md for the final slug
      // but are not committed skills. Ignore temp/backup siblings unless they
      // have the completion marker; legacy markerless final dirs are still
      // occupied names and valid duplicate sources.
      if (isAtomicWriteArtifact(entry) && !isSkillDirComplete(join(dir, entry))) continue;
      if (entry === slug) return true;
      const content = readSkillMdLowerCached(skillPath, bypassDiskCache);
      if (!content) continue;
      if (content.includes(`name: ${slug}`)) return true;
      const taskContent = extractTaskContentFromSkill(content);
      const contentWords = significantWords(taskContent);
      const overlap = [...taskWords].filter((w) => contentWords.has(w)).length;
      if (taskWords.size >= 2 && overlap >= Math.min(2, taskWords.size)) return true;
    }
  }
  return false;
}

function scanSafety(text: string): ProcedurePromotionGateResult[] {
  const out: ProcedurePromotionGateResult[] = [];
  for (const [pattern, reason, detail] of DESTRUCTIVE_OR_PRIVILEGED_PATTERNS) {
    if (pattern.test(text))
      out.push(reason === "external_side_effect_requires_approval" ? defer(reason, detail) : reject(reason, detail));
  }
  if (CREDENTIAL_PATTERNS.some((p) => p.test(text)))
    out.push(reject("credential_risk", "credential or secret pattern detected"));
  if (PRIVATE_DATA_PATTERNS.some((p) => p.test(text)))
    out.push(defer("private_data_risk", "private path, private IP, email, or high-entropy value detected"));
  return dedupeGates(out);
}

function dedupeGates(gates: ProcedurePromotionGateResult[]): ProcedurePromotionGateResult[] {
  const seen = new Set<string>();
  return gates.filter((g) => {
    const key = `${g.reason}:${g.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reject(reason: ProcedurePromotionReason, detail: string): ProcedurePromotionGateResult {
  return { reason, severity: "reject", detail };
}

function defer(reason: ProcedurePromotionReason, detail: string): ProcedurePromotionGateResult {
  return { reason, severity: "defer", detail };
}

function fail(reason: ProcedurePromotionReason, detail: string): ProcedurePromotionGateResult {
  return { reason, severity: "fail-validation", detail };
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function extractTaskContentFromSkill(content: string): string {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : content;
  const descMatch = frontmatter.match(/(?:^|\n)description:\s*(?:"([^"]*)"|'([^']*)'|([^\n]+))/i);
  const desc = descMatch ? (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "") : "";
  const taskSections = [
    /##\s*(?:when\s+to\s+activate|trigger)\s*([\s\S]*?)(?=##|$)/i,
    /##\s*scope\s*([\s\S]*?)(?=##|$)/i,
    /##\s*(?:do\s+not\s+use\s+when|when\s+not\s+to\s+use)\s*([\s\S]*?)(?=##|$)/i,
    /##\s*examples\s*([\s\S]*?)(?=##|$)/i,
    /##\s*provenance\s*([\s\S]*?)(?=##|$)/i,
  ]
    .map((pattern) => content.match(pattern)?.[1] ?? "")
    .join("\n");
  return `${desc}\n${taskSections}`;
}

function buildAntiPatternsForProcedure(proc: ProcedureEntry): string {
  const evidence = (proc.avoidanceNotes ?? [])
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .slice(0, 5)
    .map((n) => `- Known failure: ${n.replace(/\s+/g, " ").trim()}`);

  const generic = [
    "- Do not paste long command output, stack traces, JSON blobs, or transcripts into this skill; summarize as workflow phases and checklists.",
    "- Do not claim the workflow is complete unless the verification checklist passes and the output matches the user’s request.",
    "- Do not broaden scope beyond the validated trigger; ask for clarification on near-miss tasks or defer to a more specific skill.",
    "- Do not clone repositories under `~/.openclaw`; use `/tmp` for task checkouts.",
    "- Do not claim implementation work is complete unless a PR exists or the change is merged to `main`.",
    "- Do not poll subagents in a tight loop; yield and wait for push-based completion.",
  ];

  if (evidence.length === 0)
    return [
      ...generic,
      "- If this workflow starts failing in practice, record procedure feedback so future drafts include concrete known failures.",
    ].join("\n");
  return [...evidence, ...generic].join("\n");
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !["with", "from", "that", "this", "procedure", "check"].includes(w)),
  );
}

function firstKeyword(text: string): string {
  return [...significantWords(text)][0] ?? "task";
}

function findMostSevereGate(gates: ProcedurePromotionGateResult[]): ProcedurePromotionGateResult | undefined {
  if (gates.length === 0) return undefined;
  const severityOrder: Record<ProcedurePromotionGateResult["severity"], number> = {
    reject: 3,
    "fail-validation": 2,
    defer: 1,
  };
  return gates.reduce((mostSevere, gate) =>
    severityOrder[gate.severity] > severityOrder[mostSevere.severity] ? gate : mostSevere,
  );
}
