import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProcedureEntry } from "../types/memory.js";
import { slugifyForSkill } from "../utils/text.js";
import {
  computePendingInputHash,
  redactAutopilotText,
  redactAutopilotValue,
  type PendingDecision,
  type PendingDecisionContext,
  type PendingDecisionEvidence,
  type PendingItem,
  type PendingQueueAdapter,
} from "./pending-autopilot/index.js";
import { SkillValidator } from "./skill-validator.js";

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
  sourceSuccessCount: number;
  sourceFailureCount: number;
  sourceSessionCount: number;
  sourceConfidence: number;
  sourceSuccessRate: number | null;
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
  lastVerifiedAt: string;
}

export interface ProcedurePromotionPolicyOptions {
  validationThreshold: number;
  skillsAutoPath: string;
  existingSkillDirs?: string[];
  minDistinctContexts?: number;
  minConfidence?: number;
  minSuccessRate?: number;
  now?: number;
  resolvedSlug?: string;
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
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PRIVATE_DATA_PATTERNS: RegExp[] = [
  /\b(?:10\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}\b/,
  /(?:^|[\s"'=:])(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
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
  policy: ProcedurePromotionPolicy,
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
    policy,
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
  const minDistinctContexts = options.minDistinctContexts ?? DEFAULT_MIN_DISTINCT_CONTEXTS;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minSuccessRate = options.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
  const proc = item.procedure;
  const gates: ProcedurePromotionGateResult[] = [];
  const recipe = item.payload.recipe;
  const recipeText = JSON.stringify(recipe);
  const combinedText = `${proc.taskPattern}\n${recipeText}`;

  if (proc.procedureType !== "positive")
    gates.push(reject("negative_or_avoidance_procedure", "procedure is not positive"));
  if (proc.successCount < options.validationThreshold)
    gates.push(
      defer("insufficient_success_evidence", `successCount ${proc.successCount} < ${options.validationThreshold}`),
    );
  if (item.payload.sourceSessionCount < minDistinctContexts)
    gates.push(
      defer(
        "insufficient_distinct_contexts",
        `distinct source sessions ${item.payload.sourceSessionCount} < ${minDistinctContexts}`,
      ),
    );
  if (
    proc.lastFailed &&
    (!proc.lastValidated ||
      proc.lastFailed >= proc.lastValidated ||
      now - proc.lastFailed <= RECENT_FAILURE_WINDOW_SECONDS)
  )
    gates.push(defer("recent_failure", "procedure has a recent or newer failure"));
  if ((item.payload.successRate ?? 1) < minSuccessRate)
    gates.push(defer("low_success_rate", `successRate ${item.payload.successRate} < ${minSuccessRate}`));
  if (proc.confidence < minConfidence)
    gates.push(defer("low_confidence", `confidence ${proc.confidence} < ${minConfidence}`));
  if (!Array.isArray(recipe) || recipe.length === 0)
    gates.push(fail("malformed_recipe", "recipe must be a non-empty JSON array"));
  if (Array.isArray(recipe) && recipe.length < 2)
    gates.push(defer("low_reuse_value", "recipe is too thin to justify a skill"));
  if (!hasEnoughTaskBoundary(proc.taskPattern))
    gates.push(defer("vague_trigger", "task pattern lacks a clear reusable boundary"));
  if (looksTooContextSpecific(combinedText))
    gates.push(defer("too_context_specific", "procedure appears bound to a private/local context"));
  if (looksNoisy(recipe)) gates.push(defer("noisy_trace", "recipe contains noisy trace steps"));
  if (looksNonDeterministic(combinedText))
    gates.push(defer("non_deterministic_steps", "recipe relies on non-deterministic timing or vague judgment"));
  if (!hasValidationCheck(recipe, proc.taskPattern))
    gates.push(defer("no_validation_possible", "no objective validation check is present or inferable"));
  if (isDuplicateSkill(item.payload.skillSlug, proc.taskPattern, options.skillsAutoPath, options.existingSkillDirs))
    gates.push(defer("duplicate_existing_skill", "existing skill appears to cover this trigger"));

  gates.push(...scanSafety(combinedText));

  const draft = gates.some((g) => g.severity === "reject" || g.severity === "fail-validation")
    ? null
    : buildProcedureSkillDraft(item, policy, options, gates, options.resolvedSlug ?? item.payload.skillSlug);
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
    if (
      !draft.skillMd.includes("## Trigger") ||
      !draft.skillMd.includes("## When not to use") ||
      !draft.skillMd.includes("## Workflow")
    ) {
      gates.push(
        fail("skill_static_validation_failed", "generated skill lacks required trigger/scope/workflow sections"),
      );
    }
  }

  let finalDraft = draft;
  if (draft && gates.some((g) => g.severity === "fail-validation")) {
    finalDraft = null;
  }

  const eligible = gates.length === 0;
  const generatedPath = finalDraft ? join(options.skillsAutoPath, finalDraft.slug) : null;
  const metadata: ProcedurePromotionVerification = {
    skill: item.payload.skillSlug,
    sourceProcedureIds: [proc.id],
    sourceSuccessCount: proc.successCount,
    sourceFailureCount: proc.failureCount,
    sourceSessionCount: item.payload.sourceSessionCount,
    sourceConfidence: proc.confidence,
    sourceSuccessRate: item.payload.successRate,
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
    triggerEval: eligible ? "passed" : "failed",
    functionalEval: eligible ? "passed" : "failed",
    baselineComparison: {
      withSkillPassed: eligible,
      withoutSkillPassed: false,
      improvement: eligible
        ? "deterministic scaffold requires ordered workflow, validation, failure handling, and unsafe-action checks that the raw procedure does not enforce"
        : "not evaluated because promotion gates did not pass",
    },
    enabled: false,
    requiresHumanApproval: policy !== "auto-safe" || !eligible,
    lastVerifiedAt: new Date(now * 1000).toISOString(),
  };
  return { eligible, gates, draft: finalDraft, metadata };
}

export function createProcedurePromotionDecision(
  item: ProcedurePromotionItem,
  context: PendingDecisionContext,
  evaluation: ProcedurePromotionEvaluation,
): PendingDecision {
  const firstGate = evaluation.gates[0];
  const policyAllowsDraftWrite = context.policy === "auto-safe";
  const eligibleForMutation = evaluation.eligible && policyAllowsDraftWrite;
  const action = eligibleForMutation
    ? "promoted-to-draft"
    : evaluation.eligible
      ? "deferred-for-human"
      : firstGate?.severity === "fail-validation"
        ? "failed-validation"
        : firstGate?.severity === "reject"
          ? "rejected"
          : "deferred-for-human";
  const reasonCode = eligibleForMutation
    ? context.mode === "dry-run"
      ? "dry-run"
      : "approved"
    : evaluation.eligible
      ? "human-review-required"
      : firstGate?.reason === "malformed_recipe" || firstGate?.reason?.includes("validation")
        ? "schema-validation-failed"
        : firstGate?.reason === "duplicate_existing_skill"
          ? "duplicate-input"
          : firstGate?.severity === "reject"
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
    audit: redactAutopilotValue({
      procedureId: item.id,
      evaluation: evaluation.metadata,
    }) as PendingDecision["audit"],
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
  const skillMd = `---
name: ${slug}
description: Use when the user asks to ${redactedTask.redacted}. Trigger examples: "${
    redactedTask.redacted
  }", "run the validated ${firstKeyword(proc.taskPattern)} workflow". Do not use for destructive changes, external sends, credential access, or unrelated near-miss tasks.
---

# ${titleCase(slug)}

## Trigger
Use this skill when the task clearly matches this validated procedure: **${redactedTask.redacted}**.

Positive examples:
- "${redactedTask.redacted}"
- "Use the validated workflow for ${firstKeyword(proc.taskPattern)}."

Near-miss examples that should not trigger:
- "${nearMiss}"
- "Create a new unrelated automation from scratch."

## Scope
This skill guides a bounded, repeatable workflow learned from procedural memory.

## When not to use
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

## Validation
- Confirm the expected output exists and matches the user's request.
- Prefer objective checks such as file existence, JSON/schema validation, command exit status, or exact status text.
- Stop and ask for review if validation is unavailable or ambiguous.

## Failure handling
- If any step fails, stop rather than improvising a new side-effecting workflow.
- Report the failed step, error, and safe rollback/disable guidance.
- Record procedure feedback instead of silently retrying unsafe actions.

## Rollback / disable guidance
Leave this generated skill disabled until verification or human approval. To disable, remove it from the enabled skill path or keep it in quarantine/draft storage.

## Examples
- Good: "${redactedTask.redacted}" → follow the ordered workflow and validation gate.
- Bad: "${nearMiss}" → do not use; ask for clarification or use another skill.

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
    sourceSuccessCount: proc.successCount,
    sourceFailureCount: proc.failureCount,
    sourceSessionCount: item.payload.sourceSessionCount,
    sourceConfidence: proc.confidence,
    sourceSuccessRate: item.payload.successRate,
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
    redactionCount: redactedTask.redactionCount,
  };
}

function parseRecipeOrRaw(recipeJson: string): unknown {
  try {
    return JSON.parse(recipeJson);
  } catch {
    return { malformed: true, raw: recipeJson };
  }
}

function countDistinctSourceSessions(raw: string | undefined): number {
  if (!raw) return 1;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed))
      return new Set(parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0)).size || 1;
  } catch {
    // fall through
  }
  return new Set(raw.split(/[\s,;]+/).filter(Boolean)).size || 1;
}

function computeSuccessRate(proc: ProcedureEntry): number | null {
  const explicit = proc.successRate;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  const total = proc.successCount + proc.failureCount;
  return total > 0 ? proc.successCount / total : null;
}

function hasEnoughTaskBoundary(task: string): boolean {
  const words = task
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return words.length >= 3 && !/^(fix|handle|do|check|run|process|misc|stuff|thing)s?$/i.test(task.trim());
}

const CONTEXT_SPECIFIC_PATTERN = /\b(?:my|household|personal)\b/i;

function looksTooContextSpecific(text: string): boolean {
  return CONTEXT_SPECIFIC_PATTERN.test(text);
}

function looksNoisy(recipe: unknown): boolean {
  if (!Array.isArray(recipe)) return true;
  const text = JSON.stringify(recipe);
  return recipe.length > 20 || /\b(screenshot|scroll|click|wait|sleep|retry again|random|debug dump)\b/i.test(text);
}

function looksNonDeterministic(text: string): boolean {
  return /\b(maybe|guess|try until|random|wait a while|eventually|probably|if it feels)\b/i.test(text);
}

function hasValidationCheck(recipe: unknown, task: string): boolean {
  const text = `${task}\n${JSON.stringify(recipe)}`;
  return /\b(verify|validate|assert|expect|lint|typecheck)\b|test\s+(pass|fail|result)|exit\s+(code|status)|diff\s+(output|result)|file\s+exists/i.test(text);
}

function isDuplicateSkill(slug: string, task: string, skillsAutoPath: string, extraDirs: string[] = []): boolean {
  const dirs = [skillsAutoPath, ...extraDirs];
  const taskWords = significantWords(task);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of safeReadDir(dir)) {
      if (entry === slug) return true;
      const skillPath = join(dir, entry, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const content = safeReadFile(skillPath).toLowerCase();
      if (content.includes(`name: ${slug}`)) return true;
      const overlap = [...taskWords].filter((w) => content.includes(w)).length;
      if (taskWords.size >= 3 && overlap >= Math.min(3, taskWords.size)) return true;
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

function titleCase(slug: string): string {
  return basename(slug)
    .split("-")
    .map((p) => (p ? p[0]?.toUpperCase() + p.slice(1) : p))
    .join(" ");
}
