import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProcedureEntry } from "../types/memory.js";
import { toWorkspaceRelativePath } from "../utils/path.js";
import { determineRiskLevel, parseRecipeOrRaw } from "../utils/procedure-risk.js";
import { slugifyForSkill, stripLeadingHtmlComments, titleCase } from "../utils/text.js";
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
import { isAtomicSkillWriteScratchDir } from "../utils/skill-discovery.js";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_BYTES_AGGRESSIVE_TARGET,
  MAX_SKILL_FILE_BYTES_SAFE,
  utf8ByteLength,
} from "../config/skill-size-limits.js";
import { formatEvalResultsJson, runProcedureSkillEval } from "./procedure-skill-eval.js";
import { summarizeRecipeForSidecar } from "./procedure-skill-recipe.js";
import { quickValidateSkillMarkdown } from "./skill-creator-validator.js";
import { applyProgressiveDisclosure } from "./procedure-skill-shrink.js";
import { formatProcedureSkillFrontmatter, validateSkillCreatorFrontmatterKeys } from "./skill-frontmatter.js";
import { extractAllowedTools, renderAllowedToolsYaml } from "./skill-allowed-tools.js";
import {
  buildActionableWorkflow,
  extractWorkflowSection,
  lintWorkflowActionability,
} from "./procedure-skill-workflow.js";
import { PEM_PRIVATE_KEY_PATTERN, PRIVATE_IP_PATTERN, SkillValidator } from "./skill-validator.js";
import {
  isLowConcreteness,
  isProcedureTooObvious,
  measureConcreteness,
  reusabilityFromSessions,
} from "./procedure-selection-metrics.js";
import { toGerundSkillName, validateSkillName } from "./skill-name-validator.js";
import { buildPushySkillDescription } from "./skill-description-builder.js";
import { buildLegacyEvalsJson, synthesizeTriggerEvalSet } from "./skill-eval-synthesizer.js";
import { buildSkillExamplesSection } from "./skill-examples-builder.js";
import { maybeBundleReplayScript } from "./skill-script-bundler.js";
import {
  addTableOfContentsIfLong,
  buildTelemetryReferenceMd,
  lintNestedReferences,
} from "./skill-reference-sidecar.js";
import { sanitizeRecipePromptInjection, scanForPromptInjection } from "./skill-prompt-injection.js";

export const PROCEDURE_PROMOTION_POLICY_VERSION = "procedure-promotion-policy-v3";

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
  "insufficient_actionable_workflow",
  "unsafe_trace_content",
  "skill_exceeds_openclaw_limit",
  "recipe_too_large",
  "skill_creator_validation_failed",
  "unverified_skill_not_enabled",
  "policy_requires_human_approval",
  "procedure_too_obvious",
  "low_concreteness",
  "cluster_merged_into",
  "insufficient_auto_safe_evidence",
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
  sanitizedRecipe?: unknown;
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
  concreteness: number;
  reusability: number;
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
  /** Optional progressive-disclosure sidecar. */
  referenceWorkflowMd?: string | null;
  referenceTelemetryMd?: string | null;
  triggerEvalJson?: string;
  replayScript?: string | null;
  evalsResultsJson?: string;
  generationDiagnostics?: Record<string, unknown>;
  historicalPrompts?: string[];
  baselineDescriptions?: string[];
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
  relatedProcedures?: string[];
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
  /** Workspace-relative skill directory when known; otherwise null. */
  generatedSkillPath: string | null;
  policy: ProcedurePromotionPolicy;
  policyVersion: string;
  inputHash: string;
  /** `failed` only when static SKILL.md / recipe structure validation failed; unrelated promotion gates do not flip this. */
  staticValidation: "passed" | "failed";
  safetyValidation: "passed" | "failed";
  triggerEval: "passed" | "failed" | "skipped";
  functionalEval: "passed" | "failed" | "skipped";
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
  /** Extra `RegExp` sources (strings) matched against the task pattern for `too_context_specific` deferrals (#1421). */
  contextSpecificTaskPatterns?: readonly string[];
  /** When true, re-read every SKILL.md from disk for duplicate detection (ignore mtime cache). */
  bypassDuplicateSkillCache?: boolean;
  /** Procedure ids deferred because a cluster representative was chosen. */
  clusterDeferMap?: ReadonlyMap<string, { representativeId: string; slug: string }>;
  /** When false, cluster sibling can promote independently because the representative was not eligible. */
  clusterRepresentativeEligible?: boolean;
  /** Merged cluster members recorded in verification.json. */
  relatedProcedureIds?: string[];
  /** Historical user prompts for replay functional eval. */
  historicalPrompts?: string[];
  /** Existing skill descriptions for baseline comparison. */
  baselineDescriptions?: string[];
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
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|private[_-]?key)\s*[:=]\s*[^\s,;}{[\]]+/i,
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  PEM_PRIVATE_KEY_PATTERN,
];

const PRIVATE_DATA_PATTERNS: RegExp[] = [
  PRIVATE_IP_PATTERN,
  /(?:^|[\s"'=:])(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/,
  /\b[A-Za-z0-9._%+-]+@(?!(?:example\.com|localhost|test\.com|example\.org)(?![A-Za-z0-9.-]))[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
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
  const sanitizedRecipe = sanitizeRecipePromptInjection(recipe);
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
    sanitizedRecipe,
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
  const sanitizedRecipeForPolicy = item.payload.sanitizedRecipe ?? sanitizeRecipePromptInjection(item.payload.recipe);
  const riskLevel = determineRiskLevel(item.procedure, sanitizedRecipeForPolicy);
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
  const recipe = sanitizedRecipeForPolicy;
  const recipeText = JSON.stringify(recipe);
  const combinedText = `${proc.taskPattern}\n${recipeText}`;

  const clusterMerge = options.clusterDeferMap?.get(proc.id);
  if (clusterMerge && options.clusterRepresentativeEligible === true) {
    gates.push(
      defer(
        "cluster_merged_into",
        `near-duplicate procedure merged into ${clusterMerge.slug} (${clusterMerge.representativeId})`,
      ),
    );
  }

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
  const hasTaskBoundary = hasEnoughTaskBoundary(proc.taskPattern);
  const contextSpecific = looksTooContextSpecific(proc.taskPattern, options.contextSpecificTaskPatterns);
  if (!hasTaskBoundary) gates.push(defer("vague_trigger", "task pattern lacks a clear reusable boundary"));
  if (contextSpecific)
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

  if (isProcedureTooObvious(recipe))
    gates.push(defer("procedure_too_obvious", "recipe is a single obvious command Claude already knows"));
  if (isLowConcreteness(proc.taskPattern, recipe))
    gates.push(defer("low_concreteness", "task/recipe lacks domain nouns or tool diversity"));

  const manualRequestCount = evidenceSummary.sourceManualRequestIds.length;
  if (policy === "auto-safe" && manualRequestCount < 1 && evidenceSummary.sourceSessionCount < 3) {
    gates.push(
      defer("insufficient_auto_safe_evidence", "auto-safe requires ≥1 manual workflow request or ≥3 distinct sessions"),
    );
  }

  const concreteness = measureConcreteness(proc.taskPattern, recipe);
  const reusability = reusabilityFromSessions(evidenceSummary.sourceSessionCount);
  const candidateScoring = scoreProcedureCandidate({
    successCount: evidenceSummary.successCount,
    successRate: evidenceSummary.successRate,
    failureSeverity: evidenceSummary.failureSeverity,
    userSignal: evidenceSummary.userSignal,
    generality: Math.min(1, evidenceSummary.sourceSessionCount / 3),
    concreteness: concreteness.score,
    reusability,
    riskLevel,
    activationSpecificity: hasTaskBoundary && !contextSpecific ? 1 : 0.4,
    similarSkillExists,
  });

  gates.push(...scanSafety(combinedText));

  const initialGates = gates.length;
  let draft = initialGates > 0 ? null : buildProcedureSkillDraft(item, policy, options, gates, resolvedSkillSlug);
  let evalsWereRun = false;
  if (draft && gates.length === initialGates) {
    const finalized = finalizeProcedureSkillDraft(draft, item, gates, now, sanitizedRecipeForPolicy);
    draft = finalized.draft;
    evalsWereRun = finalized.evalsWereRun;
  }

  const eligible = gates.length === 0;
  const finalDraft = eligible ? draft : null;
  const generatedPath =
    eligible && finalDraft ? toWorkspaceRelativePath(join(options.skillsAutoPath, resolvedSkillSlug)) : null;
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
  const relatedIds = options.relatedProcedureIds ?? [];
  const metadata: ProcedurePromotionVerification = {
    skill: finalDraft ? toGerundSkillName(finalDraft.slug) : toGerundSkillName(resolvedSkillSlug),
    sourceProcedureIds: relatedIds.length > 0 ? [proc.id, ...relatedIds] : [proc.id],
    relatedProcedures: relatedIds,
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
    duplicateHandling: relatedIds.length > 0 ? "merge" : similarSkillExists ? "merge" : "none",
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
    // Static validation runs only after an initial draft exists; do not mark "failed" for unrelated defer/reject gates.
    staticValidation: gates.some(
      (g) => g.reason === "skill_static_validation_failed" || g.reason === "malformed_recipe",
    )
      ? "failed"
      : "passed",
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
    triggerEval: gates.some((g) => g.reason === "trigger_eval_failed") ? "failed" : evalsWereRun ? "passed" : "skipped",
    functionalEval: gates.some((g) => g.reason === "functional_eval_failed")
      ? "failed"
      : evalsWereRun
        ? "passed"
        : "skipped",
    baselineComparison: {
      withSkillPassed:
        eligible && !gates.some((g) => g.reason === "functional_eval_failed" || g.reason === "trigger_eval_failed"),
      withoutSkillPassed: false,
      improvement: eligible
        ? "deterministic evals in evals/results.json; scaffold adds workflow, validation, and safety gates"
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
    const proposalMeta = createProposalMetadata(metadata, evidenceSummary);
    if (finalDraft.generationDiagnostics) {
      proposalMeta.generation = finalDraft.generationDiagnostics;
    }
    finalDraft.proposalMetadataJson = `${JSON.stringify(redactAutopilotValue(proposalMeta), null, 2)}\n`;
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

function finalizeProcedureSkillDraft(
  draft: GeneratedProcedureSkillDraft,
  item: ProcedurePromotionItem,
  gates: ProcedurePromotionGateResult[],
  now: number,
  fullSanitizedRecipe: unknown,
): { draft: GeneratedProcedureSkillDraft; evalsWereRun: boolean } {
  const proc = item.procedure;
  const riskLevel = determineRiskLevel(item.procedure, fullSanitizedRecipe);

  let skillMd = draft.skillMd;
  const originalBytes = utf8ByteLength(skillMd);
  // Trigger progressive disclosure aggressively (target 64-96 KB per #1539)
  // so SKILL.md is genuinely compact, not merely "under the 256 KB loader cap".
  const disclosureTarget = Math.min(MAX_SKILL_FILE_BYTES_AGGRESSIVE_TARGET, MAX_SKILL_FILE_BYTES_SAFE);
  const disclosure = applyProgressiveDisclosure(
    skillMd,
    fullSanitizedRecipe,
    proc.taskPattern,
    disclosureTarget,
    riskLevel,
  );
  skillMd = disclosure.skillMd;
  draft.referenceWorkflowMd = disclosure.referenceWorkflowMd
    ? addTableOfContentsIfLong(disclosure.referenceWorkflowMd)
    : disclosure.referenceWorkflowMd;
  if (draft.referenceTelemetryMd) {
    draft.referenceTelemetryMd = addTableOfContentsIfLong(draft.referenceTelemetryMd);
  }
  const nestedRefViolations = lintNestedReferences(skillMd);
  if (nestedRefViolations.length > 0) {
    gates.push(fail("skill_static_validation_failed", nestedRefViolations.join("; ")));
  }
  draft.generationDiagnostics = {
    originalBytes,
    finalBytes: disclosure.diagnostics.finalBytes,
    shrinkStages: disclosure.diagnostics.shrinkStages,
    omittedSections: disclosure.diagnostics.omittedSections,
  };

  if (utf8ByteLength(skillMd) > MAX_SKILL_FILE_BYTES) {
    gates.push(
      fail("skill_exceeds_openclaw_limit", `SKILL.md ${utf8ByteLength(skillMd)} bytes > ${MAX_SKILL_FILE_BYTES}`),
    );
  } else if (utf8ByteLength(skillMd) > MAX_SKILL_FILE_BYTES_SAFE) {
    gates.push(
      defer("skill_exceeds_openclaw_limit", `SKILL.md exceeds safe write target ${MAX_SKILL_FILE_BYTES_SAFE}`),
    );
  }
  draft.skillMd = skillMd;

  const workflow = extractWorkflowSection(draft.skillMd);
  const actionability = lintWorkflowActionability(workflow, proc.taskPattern);
  if (!actionability.actionable) {
    gates.push(
      defer("insufficient_actionable_workflow", actionability.reasons.join("; ") || "workflow not actionable"),
    );
    return { draft, evalsWereRun: false };
  }

  const evalsPayload = JSON.parse(draft.evalsJson) as {
    trigger?: { shouldTrigger?: string[]; shouldNotTrigger?: string[] };
  };
  const evalResult = runProcedureSkillEval({
    now,
    skillMd: draft.skillMd,
    recipeJson: draft.recipeJson,
    taskPattern: proc.taskPattern,
    shouldTrigger: evalsPayload.trigger?.shouldTrigger ?? [proc.taskPattern],
    shouldNotTrigger: evalsPayload.trigger?.shouldNotTrigger ?? [],
    historicalPrompts: draft.historicalPrompts,
    baselineDescriptions: draft.baselineDescriptions,
  });
  draft.evalsResultsJson = formatEvalResultsJson(evalResult);
  if (evalResult.triggerEval === "failed") {
    gates.push(defer("trigger_eval_failed", "trigger precision eval failed"));
  }
  if (evalResult.functionalEval === "failed") {
    gates.push(defer("functional_eval_failed", "functional usefulness eval failed"));
  }

  const validator = new SkillValidator();
  // Procedure skills use the procedure category section taxonomy (from metadata.category)
  // so they are not rejected for generic Trigger/Scope/Provenance sections.
  const staticResult = validator.validate(draft.skillMd);
  if (!staticResult.valid) {
    gates.push(fail("skill_static_validation_failed", staticResult.violations.join("; ")));
  }
  const draftSafety = scanSafety(`${draft.skillMd}\n${draft.recipeJson}`);
  if (draftSafety.length > 0) {
    gates.push(
      ...draftSafety.map((g) => ({
        ...g,
        reason:
          g.reason === "credential_risk"
            ? "credential_risk"
            : g.reason === "unsafe_side_effect"
              ? "unsafe_trace_content"
              : ("skill_safety_validation_failed" as ProcedurePromotionReason),
      })),
    );
  }

  const strippedSkillMd = stripLeadingHtmlComments(draft.skillMd);
  const fmMatch = strippedSkillMd.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const creatorViolations = validateSkillCreatorFrontmatterKeys(fmMatch[1]);
    if (creatorViolations.length > 0) {
      gates.push(fail("skill_creator_validation_failed", creatorViolations.join("; ")));
    }
  }

  // Full Skill Creator quick_validate equivalent — name/description rules,
  // top-level key allow-list, body length, Windows-style paths (#1545).
  const skillCreatorResult = quickValidateSkillMarkdown(draft.skillMd);
  if (!skillCreatorResult.valid) {
    gates.push(
      fail(
        "skill_creator_validation_failed",
        skillCreatorResult.violations.map((v) => `${v.rule}: ${v.message}`).join("; "),
      ),
    );
  }

  return { draft, evalsWereRun: true };
}

function buildProcedureSkillDraft(
  item: ProcedurePromotionItem,
  policy: ProcedurePromotionPolicy,
  options: ProcedurePromotionPolicyOptions,
  gates: ProcedurePromotionGateResult[],
  slug: string,
): GeneratedProcedureSkillDraft {
  const proc = item.procedure;
  const summarized = summarizeRecipeForSidecar(item.payload.recipe);
  if (!summarized.withinCap) {
    gates.push(defer("recipe_too_large", `recipe.json ${summarized.byteLength} bytes exceeds cap`));
  }
  // Hard prompt-injection markers in the source recipe must never reach disk.
  // Detection is done on the *original* recipe before sanitization, so we
  // know if untrusted instructions tried to escape into a durable skill.
  if (summarized.hasHardInjection) {
    const names = summarized.injectionHits
      .filter((h) => h.severity === "hard")
      .map((h) => h.name)
      .join(",");
    gates.push(
      fail(
        "unsafe_trace_content",
        `Prompt-injection markers detected in source recipe (${names}); refusing to promote.`,
      ),
    );
  }
  const recipeJson = summarized.recipeJson;
  // All downstream generation uses the sanitized recipe returned by summarizeRecipeForSidecar.
  // The original payload may contain prompt-injection markers or unsanitized values and must
  // not be laundered into SKILL.md workflow text or replay scripts.
  const workflowRecipe = summarized.sanitizedSteps;
  // Scan the task pattern for prompt-injection markers to prevent bypass of #1538.
  // Detection is done on the *original* task pattern before redaction, so we
  // know if untrusted instructions tried to escape into a durable skill.
  const taskInjectionScan = scanForPromptInjection(proc.taskPattern);
  if (taskInjectionScan.hasHardInjection) {
    const names = taskInjectionScan.hits
      .filter((h) => h.severity === "hard")
      .map((h) => h.name)
      .join(",");
    gates.push(
      fail(
        "unsafe_trace_content",
        `Prompt-injection markers detected in task pattern (${names}); refusing to promote.`,
      ),
    );
  }
  const redactedTask = redactAutopilotText(proc.taskPattern);
  const riskLevel = determineRiskLevel(item.procedure, workflowRecipe);
  const workflow = buildActionableWorkflow(workflowRecipe, proc.taskPattern, riskLevel);
  const keyword = firstKeyword(proc.taskPattern);
  const skillName = toGerundSkillName(slug);
  const nameViolations = validateSkillName(skillName);
  if (nameViolations.length > 0) {
    gates.push(fail("skill_creator_validation_failed", nameViolations.join("; ")));
    return {
      slug,
      skillMd: "",
      recipeJson,
      verificationJson: `${JSON.stringify({ skill: skillName, promotionDecision: "failed-validation" }, null, 2)}\n`,
      evalsJson: "{}",
      proposalMetadataJson: "{}",
      redactionCount: redactedTask.redactionCount,
      historicalPrompts: options.historicalPrompts,
      baselineDescriptions: options.baselineDescriptions,
    };
  }
  const nearMiss = `Tasks that mention ${keyword} but require sending, destructive changes, credential access, or unrelated troubleshooting.`;
  const telemetryCommand = `openclaw hybrid-mem skills record ${slug}`;
  const telemetryRequestSummaryArg = shellQuote(redactedTask.redacted);
  const antiPatterns = buildAntiPatternsForProcedure(proc);
  const generatedAt = new Date((options.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10);
  const description = buildPushySkillDescription({
    taskPattern: redactedTask.redacted,
    keyword,
    recipe: workflowRecipe,
  });
  const allowedTools = extractAllowedTools(workflowRecipe);
  const frontmatter = formatProcedureSkillFrontmatter({
    name: skillName,
    description,
    category: "procedure",
    provenance: `procedure:${proc.id}`,
    generatedAt,
    allowedToolsYaml: renderAllowedToolsYaml(allowedTools),
  });
  const examplesSection = buildSkillExamplesSection({
    taskPattern: redactedTask.redacted,
    nearMiss,
    recipe: workflowRecipe,
  });
  const replayScript = maybeBundleReplayScript(workflowRecipe);
  const scriptHint = replayScript
    ? "\nRun `scripts/replay.sh` to execute the validated workflow (deterministic replay).\n"
    : "";
  const antiPatternsBlock =
    antiPatterns.trim() && !antiPatterns.includes("No recorded anti-patterns")
      ? `\n## Anti-patterns\n${antiPatterns}\n`
      : "";
  const skillMd = `${frontmatter}

# ${titleCase(skillName)}

## Do Not Use When
- Destructive shell/service/package operations without explicit approval.
- SSH, remote writes, credential retrieval, or external sending/posting.
- Requests broader than the validated workflow in \`recipe.json\`.
- Near-miss tasks (see Examples).

## Workflow
${workflow}
${scriptHint}

## Verification
- Confirm output matches the user request using objective checks (exit status, file exists, schema, status text).
- If a step fails, stop and report the failed step; do not improvise side effects.
- Operator telemetry: see \`references/telemetry.md\`.

${examplesSection}${antiPatternsBlock}
`;
  const relatedIds = options.relatedProcedureIds ?? [];
  const triggerEval = synthesizeTriggerEvalSet({
    skillName,
    taskPattern: proc.taskPattern,
    keyword,
  });
  const verification: ProcedurePromotionVerification = {
    skill: skillName,
    sourceProcedureIds: [proc.id, ...relatedIds],
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
    riskLevel,
    candidateScore: 0,
    candidateScoreBreakdown: {
      repeatCount: 0,
      successRate: 0,
      failureSeverity: 0,
      userSignal: 0,
      generality: 0,
      concreteness: 0,
      reusability: 0,
      risk: 0,
      activationSpecificity: 0,
      duplicatePenalty: 1,
    },
    duplicateHandling: relatedIds.length > 0 ? "merge" : "none",
    validatorScore: 0,
    promotionDecision: "drafted",
    rejectionReasons: gates.map((g) => g.reason),
    generatedSkillPath: toWorkspaceRelativePath(join(options.skillsAutoPath, item.payload.skillSlug)),
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
      improvement: "pending replay eval in evals/results.json",
    },
    enabled: false,
    requiresHumanApproval: policy !== "auto-safe",
    lifecycleState: "experimental",
    telemetryCommand,
    falsePositiveCommandTemplate: 'openclaw hybrid-mem skills correct <activation-id> --reason "user rejected skill"',
    lastVerifiedAt: new Date((options.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  const evalsJson = buildLegacyEvalsJson({
    shouldTrigger: triggerEval.shouldTrigger,
    shouldNotTrigger: triggerEval.shouldNotTrigger,
  });
  const referenceTelemetryMd = buildTelemetryReferenceMd({
    slug,
    telemetryCommand,
    telemetryRequestSummaryArg,
  });
  const verificationPayload = {
    ...verification,
    relatedProcedures: relatedIds,
    sourceProcedureIds: [proc.id, ...relatedIds],
    riskLevel,
    policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
    inputHash: item.inputHash,
    sourceProcedureId: proc.id,
    successCount: proc.successCount,
    failureCount: proc.failureCount,
    lastValidated: proc.lastValidated ? new Date(proc.lastValidated * 1000).toISOString() : null,
  };
  return {
    slug,
    skillMd,
    recipeJson,
    verificationJson: `${JSON.stringify(redactAutopilotValue(verificationPayload), null, 2)}\n`,
    evalsJson,
    triggerEvalJson: triggerEval.triggerEvalJson,
    referenceTelemetryMd,
    replayScript,
    proposalMetadataJson: `${JSON.stringify(
      redactAutopilotValue({
        rollback: "Leave disabled until verification; remove from enabled path or keep in quarantine.",
        telemetry_sidecar: "references/telemetry.md",
      }),
      null,
      2,
    )}\n`,
    redactionCount: redactedTask.redactionCount,
    historicalPrompts: options.historicalPrompts,
    baselineDescriptions: options.baselineDescriptions,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  /**
   * User-signal score (documented in docs/PROCEDURAL-MEMORY.md):
   * - Baseline **0** in raw space: absence of evidence is not treated as a positive prior.
   * - Manual workflow requests **+0.28** each; corrections **−0.32** each (asymmetric so “one request + one correction”
   *   nets slightly negative and never ties “no signal”, which stays at 0 raw).
   * - Rules/preferences: **+0.1** per signal, **capped at 5** signals so repeated rules cannot dominate.
   * - Failure episodes (user-signal slice): **−0.15** each (distinct from failureSeverity in the main score).
   * Raw is clamped to **[-1, 1]**, then remapped to **[0, 1]** via `(raw + 1) / 2` for the additive candidate term.
   */
  const cappedRulesForSignal = Math.min(rulesPreferenceCount, 5);
  const userSignalRaw = Math.max(
    -1,
    Math.min(
      1,
      manualRequestCount * 0.28 + cappedRulesForSignal * 0.1 - correctionCount * 0.32 - failureEpisodes * 0.15,
    ),
  );
  const userSignal = (userSignalRaw + 1) / 2;

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

/**
 * Procedure candidate score: evidence terms form a **base** in [0, ~1]; **risk is a multiplier** on that base
 * (high ≈ 0.35×, medium ≈ 0.65×, low 1×) so materially different risk at the same evidence changes ordering.
 * Weights are documented in docs/PROCEDURAL-MEMORY.md.
 */
function scoreProcedureCandidate(input: {
  successCount: number;
  successRate: number;
  failureSeverity: number;
  userSignal: number;
  generality: number;
  concreteness: number;
  reusability: number;
  riskLevel: "low" | "medium" | "high";
  activationSpecificity: number;
  similarSkillExists: boolean;
}): ProcedureCandidateScore {
  const repeatCount = Math.min(1, input.successCount / 6);
  const successRate = Math.max(0, Math.min(1, input.successRate));
  const failureSeverity = Math.max(0, Math.min(1, input.failureSeverity));
  const userSignal = Math.max(0, Math.min(1, input.userSignal));
  const generality = Math.max(0, Math.min(1, input.generality));
  const concreteness = Math.max(0, Math.min(1, input.concreteness));
  const reusability = Math.max(0, Math.min(1, input.reusability));
  const riskMultiplier = input.riskLevel === "high" ? 0.35 : input.riskLevel === "medium" ? 0.65 : 1;
  const activationSpecificity = Math.max(0, Math.min(1, input.activationSpecificity));
  const duplicatePenalty = input.similarSkillExists ? 0.5 : 1;
  const baseScore =
    repeatCount * 0.2 +
    successRate * 0.25 +
    (1 - failureSeverity) * 0.15 +
    userSignal * 0.12 +
    generality * 0.08 +
    concreteness * 0.1 +
    reusability * 0.05 +
    activationSpecificity * 0.05;
  const rawScore = baseScore * riskMultiplier * duplicatePenalty;
  const score = Number(Math.max(0, Math.min(1, rawScore)).toFixed(3));
  return {
    score,
    breakdown: {
      repeatCount: Number(repeatCount.toFixed(3)),
      successRate: Number(successRate.toFixed(3)),
      failureSeverity: Number(failureSeverity.toFixed(3)),
      userSignal: Number(userSignal.toFixed(3)),
      generality: Number(generality.toFixed(3)),
      concreteness: Number(concreteness.toFixed(3)),
      reusability: Number(reusability.toFixed(3)),
      risk: Number(riskMultiplier.toFixed(3)),
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
    ...(metadata.generatedSkillPath != null ? { generated_skill_path: metadata.generatedSkillPath } : {}),
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

const DEFAULT_CONTEXT_SPECIFIC_PATTERNS: RegExp[] = [
  /\b(?:our|my)\s+team\b/i,
  /\b(?:customer|tenant|org|account)[-_ ]?id\b/i,
  /\b(?:internal(?:-only)?|staging|production|prod)\b/i,
  /\b(?:bastion|cluster)\b/i,
  /\barn:aws:[^\s]+\b/i,
  /\b(?:slack|discord)\s+[#@]/i,
  /[#@][a-z0-9][a-z0-9_-]{1,79}\b.{0,80}\b(?:slack|discord)\b/i,
  /\b(?:slack|discord)\b.{0,80}[#@][a-z0-9][a-z0-9_-]{1,79}\b/i,
];

const MAX_CONTEXT_SPECIFIC_REGEX_LENGTH = 256;
const UNSAFE_OPERATOR_REGEX_PATTERN =
  /\((?:[^()\\]|\\.)*[+*?](?:[^()\\]|\\.)*\)[+*?]|\[[^\]]*\][+*?][+*?]|\{\d+,?\d*\}[+*]|\.[+*?].*[+*?]|\([^)]*\|[^)]*\)[+*]/;

function compileContextSpecificPattern(raw: string): RegExp | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CONTEXT_SPECIFIC_REGEX_LENGTH) return null;
  if (UNSAFE_OPERATOR_REGEX_PATTERN.test(trimmed)) return null;
  try {
    return new RegExp(trimmed, "i");
  } catch {
    return null;
  }
}

function looksTooContextSpecific(text: string, extraPatterns?: readonly string[]): boolean {
  if (/\b(?:my|household|personal)\b/i.test(text)) return true;
  for (const p of DEFAULT_CONTEXT_SPECIFIC_PATTERNS) {
    if (p.test(text)) return true;
  }
  if (extraPatterns) {
    for (const raw of extraPatterns) {
      const pattern = compileContextSpecificPattern(raw);
      if (pattern?.test(text)) return true;
    }
  }
  const hostish = text.match(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/gi) ?? [];
  const longish = hostish.filter((m) => m.length >= 12);
  if (longish.length >= 2) return true;
  return false;
}

function looksNoisy(recipe: unknown): boolean {
  if (!Array.isArray(recipe)) return false;
  const text = JSON.stringify(recipe);
  return recipe.length > 20 || /\b(screenshot|scroll|click|wait|sleep|retry again|random|debug dump)\b/i.test(text);
}

function looksNonDeterministic(text: string): boolean {
  return /\b(maybe|guess|try until|random|wait a while|eventually|probably|if it feels)\b/i.test(text);
}

const EXPLICIT_VALIDATION_PATTERN =
  /\b(?:verify|validate|assert|expect|expected|lint|typecheck)\b|\b(?:test\s+(?:pass|fail|result)|exit\s+(?:code|status|0)|diff\s+(?:output|result)|file\s+exists)\b/i;

const MAX_VALIDATION_TEXT_PER_STEP = 8192;

function collectStringsForValidation(value: unknown, depth: number, maxDepth: number, budget: { n: number }): string[] {
  if (budget.n <= 0 || depth > maxDepth) return [];
  if (typeof value === "string") {
    const slice = value.slice(0, Math.min(value.length, budget.n));
    budget.n -= slice.length;
    return slice.length > 0 ? [slice] : [];
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const el of value) {
      out.push(...collectStringsForValidation(el, depth + 1, maxDepth, budget));
      if (budget.n <= 0) break;
    }
    return out;
  }
  const out: string[] = [];
  for (const v of Object.values(value as Record<string, unknown>)) {
    out.push(...collectStringsForValidation(v, depth + 1, maxDepth, budget));
    if (budget.n <= 0) break;
  }
  return out;
}

function hasValidationCheck(recipe: unknown, _task: string): boolean {
  if (!Array.isArray(recipe)) return false;
  return recipe.some((step) => {
    if (!step || typeof step !== "object") return false;
    const s = step as Record<string, unknown>;
    const budget = { n: MAX_VALIDATION_TEXT_PER_STEP };
    const chunks: string[] = [];
    for (const key of ["summary", "validation", "expected", "check", "assertion", "command", "args"] as const) {
      chunks.push(...collectStringsForValidation(s[key], 0, 4, budget));
      if (budget.n <= 0) break;
    }
    return EXPLICIT_VALIDATION_PATTERN.test(chunks.join("\n"));
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
  const gerundName = toGerundSkillName(slug);
  for (const candidate of inRunCandidates) {
    if (candidate.slug === slug) return true;
    const candidateWords = significantWords(candidate.taskPattern);
    const overlap = [...taskWords].filter((w) => candidateWords.has(w)).length;
    if (taskWords.size >= 2 && overlap >= Math.min(2, taskWords.size)) return true;
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of safeReadDir(dir)) {
      if (isAtomicSkillWriteScratchDir(entry)) continue;
      const skillPath = join(dir, entry, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      // Legacy skill directories may not have the atomic completion marker. If
      // they contain SKILL.md, treat them as valid duplicates so marker rollout
      // never overwrites or re-promotes existing skills.
      if (entry === slug || entry === gerundName) return true;
      const content = readSkillMdLowerCached(skillPath, bypassDiskCache);
      if (!content) continue;
      if (content.includes(`name: ${gerundName}`) || content.includes(`name: "${gerundName}"`)) return true;
      // Pre-v3 generated skills may use the slug (e.g., "check-foo") instead of the gerund form ("checking-foo").
      if (content.includes(`name: ${slug}`) || content.includes(`name: "${slug}"`)) return true;
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
  let desc = "";
  // Match folded YAML description first (v3 format with >- or | indicators)
  const foldedMatch = frontmatter.match(/(?:^|\n)description:\s*[|>]-?\s*\n((?:[ \t]+.+(?:\n|$))+)/i);
  if (foldedMatch) {
    desc = foldedMatch[1]
      .replace(/^[ \t]+/gm, "")
      .replace(/\n(?!\n)/g, " ")
      .trim();
  } else {
    // Match single-line description
    const descMatch = frontmatter.match(/(?:^|\n)description:\s*(?:"([^"]*)"|'([^']*)'|([^\n]+))/i);
    desc = descMatch ? (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "") : "";
  }
  const taskSections = [
    /##\s*(?:when\s+to\s+activate|trigger)\s*([\s\S]*?)(?=##|$)/i,
    /##\s*workflow\s*([\s\S]*?)(?=##|$)/i,
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
