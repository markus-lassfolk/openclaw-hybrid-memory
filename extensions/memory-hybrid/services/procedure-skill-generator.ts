/**
 * Procedural memory: generate verified draft SKILL.md + recipe.json from validated procedures.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { GenerateAutoSkillsResult } from "../cli/register.js";
import { MAX_SKILL_FILE_BYTES, utf8ByteLength } from "../config/skill-size-limits.js";
import type { MemoryEntry, MemoryScope, ProcedureEntry, ScopeFilter } from "../types/memory.js";
import { atomicWriteSkillDir, SKILL_COMPLETE_MARKER } from "../utils/atomic-write.js";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "../utils/path.js";
import { stripLeadingHtmlComments, titleCase } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import { redactAutopilotText } from "./pending-autopilot/redaction.js";
import { buildClusterDeferMap, clusterProcedureItems, type ProcedureClusterResult } from "./procedure-cluster.js";
import {
  createProcedurePromotionDecision,
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  PROCEDURE_PROMOTION_POLICY_VERSION,
  type ProcedurePromotionDuplicateCandidate,
  type ProcedurePromotionEvidence,
  type ProcedurePromotionPolicy,
  parseProcedurePromotionPolicy,
} from "./procedure-promotion-policy.js";
import { parseSkillFrontmatterKeys } from "./skill-frontmatter.js";
import { toGerundSkillName } from "./skill-name-validator.js";

const MAX_SKILLS_PER_RUN = 10;
const EVIDENCE_STOP_WORDS = new Set(["with", "from", "that", "this", "workflow", "procedure", "report"]);

function normalizeProcedureScope(proc: ProcedureEntry): MemoryScope {
  const raw = (proc.scope ?? "global").toString().toLowerCase().trim();
  if (raw === "user" || raw === "agent" || raw === "session" || raw === "global") return raw;
  return "global";
}

function entryMatchesProcedureScope(proc: ProcedureEntry, entry: MemoryEntry): boolean {
  const procScope = normalizeProcedureScope(proc);
  const entryScope = entry.scope ?? "global";
  if (procScope === "global") return entryScope === "global";
  if (procScope !== entryScope) return false;
  const pt = proc.scopeTarget?.trim() || null;
  const et = entry.scopeTarget?.trim() || null;
  if (!pt) return !et;
  return et === pt;
}

function scopeFilterForProcedure(proc: ProcedureEntry): ScopeFilter | null {
  const s = normalizeProcedureScope(proc);
  const t = proc.scopeTarget?.trim();
  if (s === "global" || !t) return null;
  if (s === "user") return { userId: t };
  if (s === "agent") return { agentId: t };
  if (s === "session") return { sessionId: t };
  return null;
}

/** Per-procedure result returned by {@link generateAutoSkillForProcedure}. */
export type GenerateAutoSkillResult =
  | {
      ok: false;
      reason: "not-found" | "validation-pending" | "write-failed" | "policy-blocked";
      error?: string;
      reasons?: string[];
    }
  | {
      ok: true;
      /** True when the procedure was already promoted before this call (no-op). */
      alreadyPromoted: boolean;
      /** Absolute path to the generated SKILL.md (existing path on idempotent calls). */
      skillPath: string;
      /** Skill path stored on the procedure row (relative to workspace). */
      relativePath: string;
      /** Whether the writes were skipped because dryRun=true. */
      dryRun: boolean;
      /** Generated skills are draft/quarantined and not enabled by default. */
      enabled: false;
    };

function ensureUniqueSlug(basePath: string, slug: string, reservedSlugs?: ReadonlySet<string>): string {
  let candidate = slug;
  let n = 0;
  // Legacy skill directories created before the atomic completion marker rollout
  // do not contain `.openclaw-skill-complete`. They are still occupied names and
  // must not be overwritten. Only incomplete atomic drafts are reusable.
  while (reservedSlugs?.has(candidate) || isOccupiedSkillDir(join(basePath, candidate))) {
    n++;
    candidate = `${slug}-${n}`;
  }
  return candidate;
}

function isOccupiedSkillDir(skillDir: string): boolean {
  return existsSync(join(skillDir, SKILL_COMPLETE_MARKER)) || existsSync(join(skillDir, "SKILL.md"));
}

type AllocatedSkillDir = {
  slug: string;
  skillDir: string;
  relativePath: string;
};

/**
 * Atomically reserve a draft skill directory. `ensureUniqueSlug` is only a preview
 * used for policy evaluation; this function is the write-time source of truth so
 * concurrent generators cannot select and overwrite the same path.
 */
function allocateDraftSkillDir(basePath: string, skillsAutoPath: string, slug: string): AllocatedSkillDir {
  mkdirSync(basePath, { recursive: true });
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const skillDir = join(basePath, candidate);
    try {
      mkdirSync(skillDir, { recursive: false });
      return {
        slug: candidate,
        skillDir,
        relativePath: toWorkspaceRelativePath(join(skillsAutoPath, candidate)),
      };
    } catch (err) {
      if (isPathExistsError(err)) {
        n++;
        continue;
      }
      throw err;
    }
  }
}

function isPathExistsError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/**
 * Rebase all slug-identity and path-identity fields in a generated draft after
 * {@link ensureUniqueSlug} resolves a different slug than the base slug.
 *
 * **Invariant**: generated sidecars must not preserve pre-collision slug/path
 * identity after rebasing. Regression tests scan the full serialized
 * `recipeJson`, `evalsJson`, and `proposalMetadataJson` artifacts for stale
 * identity strings and recursive identity keys.
 */
function rebaseDraftSlug(
  draft: {
    skillMd: string;
    recipeJson: string;
    verificationJson: string;
    evalsJson: string;
    proposalMetadataJson: string;
    triggerEvalJson?: string;
    referenceTelemetryMd?: string | null;
  },
  resolvedSlug: string,
  generatedSkillPath: string,
): {
  skillMd: string;
  recipeJson: string;
  verificationJson: string;
  evalsJson: string;
  proposalMetadataJson: string;
  triggerEvalJson?: string;
  referenceTelemetryMd?: string | null;
} {
  const verification = JSON.parse(draft.verificationJson) as {
    skill?: unknown;
    generatedSkillPath?: unknown;
    telemetryCommand?: unknown;
  };
  const proposalMetadata = JSON.parse(draft.proposalMetadataJson) as {
    generated_skill_path?: unknown;
  };
  const originalGerundName =
    typeof verification.skill === "string" && verification.skill.length > 0
      ? verification.skill
      : toGerundSkillName(resolvedSlug);
  const resolvedSkillName = toGerundSkillName(resolvedSlug);
  const originalTelemetryCommand =
    typeof verification.telemetryCommand === "string" && verification.telemetryCommand.length > 0
      ? verification.telemetryCommand
      : `openclaw hybrid-mem skills record ${resolvedSlug}`;
  const newTelemetryCommand = `openclaw hybrid-mem skills record ${resolvedSlug}`;
  verification.skill = resolvedSkillName;
  verification.generatedSkillPath = generatedSkillPath;
  proposalMetadata.generated_skill_path = generatedSkillPath;
  verification.telemetryCommand = newTelemetryCommand;

  // Match the H1 heading in either its title-cased form (e.g. "# My Skill") or
  // its raw slug form (e.g. "# my-skill") so that non-standard headings are also
  // rebased correctly after a slug collision.
  const h1Pattern = new RegExp(
    `^# (?:${escapeRegExp(titleCase(originalGerundName))}|${escapeRegExp(originalGerundName.replace(/-/g, " "))})$`,
    "m",
  );
  const skillMd = draft.skillMd
    .replace(
      new RegExp(`^name: (?:"${escapeRegExp(originalGerundName)}"|${escapeRegExp(originalGerundName)})$`, "m"),
      `name: "${resolvedSkillName}"`,
    )
    .replace(h1Pattern, `# ${titleCase(resolvedSkillName)}`)
    .replace(new RegExp(escapeRegExp(originalTelemetryCommand), "g"), newTelemetryCommand);

  let triggerEvalJson = draft.triggerEvalJson;
  if (triggerEvalJson && originalGerundName !== resolvedSkillName) {
    const triggerEval = JSON.parse(triggerEvalJson) as { skill_name?: unknown };
    if (triggerEval.skill_name === originalGerundName) {
      triggerEval.skill_name = resolvedSkillName;
      triggerEvalJson = `${JSON.stringify(triggerEval, null, 2)}\n`;
    }
  }

  let referenceTelemetryMd = draft.referenceTelemetryMd;
  if (referenceTelemetryMd && originalTelemetryCommand !== newTelemetryCommand) {
    referenceTelemetryMd = referenceTelemetryMd.replace(
      new RegExp(escapeRegExp(originalTelemetryCommand), "g"),
      newTelemetryCommand,
    );
  }

  return {
    ...draft,
    skillMd,
    verificationJson: `${JSON.stringify(verification, null, 2)}\n`,
    proposalMetadataJson: `${JSON.stringify(proposalMetadata, null, 2)}\n`,
    triggerEvalJson,
    referenceTelemetryMd,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promotionWriteFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/OpenClaw limit|exceeds OpenClaw loader byte limit|refusing to write oversized/i.test(message)) {
    return "skill_exceeds_openclaw_limit";
  }
  return "write_failed";
}

type GenerateAutoSkillsOptions = {
  skillsAutoPath: string;
  validationThreshold: number;
  skillTTLDays: number;
  maxPerRun?: number;
  dryRun?: boolean;
  apply?: boolean;
  policy?: string;
  /** Extra regex sources for `too_context_specific` deferrals (merged with defaults; #1421). */
  promotionContextSpecificPatterns?: readonly string[];
  /** Same-run draft slugs/task patterns for duplicate detection (single-procedure promote / custom orchestration). */
  inRunSkillCandidates?: readonly ProcedurePromotionDuplicateCandidate[];
  /** When true, duplicate-skill detection re-reads every SKILL.md (bypass mtime cache). */
  bypassDuplicateSkillCache?: boolean;
};

/**
 * Generate quarantined draft skills for procedures that pass #1328 promotion gates.
 * Dry-run is non-mutating: it does not write skills and does not mark procedures promoted.
 */
export function generateAutoSkills(
  factsDb: FactsDB,
  options: GenerateAutoSkillsOptions,
  logger: { info: (s: string) => void; warn: (s: string) => void },
): GenerateAutoSkillsResult {
  const maxPerRun = options.maxPerRun ?? MAX_SKILLS_PER_RUN;
  const dryRun = options.dryRun ?? options.apply !== true;
  const policy = parseProcedurePromotionPolicy(resolveBatchPromotionPolicy(options.policy, options.apply));
  const basePath = resolveSkillsPath(options.skillsAutoPath);
  const runId = `procedure-promotion-${Date.now()}`;
  const procedures = factsDb.getProceduresReadyForSkill(options.validationThreshold, maxPerRun, options.skillTTLDays);
  const paths: string[] = [];
  const decisions: NonNullable<GenerateAutoSkillsResult["decisions"]> = [];
  let skipped = 0;
  let eligible = 0;
  let drafted = 0;
  let rejected = 0;
  let deferred = 0;
  let failedValidation = 0;
  let failedEval = 0;
  const reservedSlugs = new Set<string>();
  const inRunSkillCandidates: Array<{ slug: string; taskPattern: string }> = [];
  const promotionItems = procedures.map((proc) => createProcedurePromotionItem(proc, policy));
  const clusters = clusterProcedureItems(promotionItems);
  const clusterDeferMap = buildClusterDeferMap(clusters);
  const relatedByRepresentative = new Map<string, string[]>();
  for (const c of clusters) {
    if (c.relatedProcedureIds.length > 0) {
      relatedByRepresentative.set(c.representative.procedure.id, c.relatedProcedureIds);
    }
  }
  const baselineDescriptions = loadExistingSkillDescriptions(basePath);
  const clusterEligibilityOptions = {
    skillsAutoPath: basePath,
    validationThreshold: options.validationThreshold,
    contextSpecificTaskPatterns: options.promotionContextSpecificPatterns,
    bypassDuplicateSkillCache: options.bypassDuplicateSkillCache,
    baselineDescriptions,
  };

  for (const proc of procedures) {
    const item = createProcedurePromotionItem(proc, policy);
    const resolvedSlug = ensureUniqueSlug(basePath, item.payload.skillSlug, reservedSlugs);
    const evidence = collectProcedurePromotionEvidence(factsDb, proc);
    const historicalPrompts = collectHistoricalSessionPrompts(factsDb, proc, evidence);
    const context = {
      runId,
      mode: dryRun ? ("dry-run" as const) : ("apply" as const),
      policy,
      policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
      inputHash: item.inputHash,
      actor: { type: "system" as const, id: "generate-auto-skills" },
    };
    const clusterMerge = clusterDeferMap.get(proc.id);
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: basePath,
      validationThreshold: options.validationThreshold,
      resolvedSlug,
      inRunSkillCandidates: [...(options.inRunSkillCandidates ?? []), ...inRunSkillCandidates],
      evidence,
      contextSpecificTaskPatterns: options.promotionContextSpecificPatterns,
      bypassDuplicateSkillCache: options.bypassDuplicateSkillCache,
      clusterDeferMap,
      clusterRepresentativeEligible: clusterMerge
        ? evaluateClusterRepresentativeEligible(
            factsDb,
            clusterMerge.representativeId,
            procedures,
            policy,
            clusterEligibilityOptions,
            [...(options.inRunSkillCandidates ?? []), ...inRunSkillCandidates],
          )
        : undefined,
      relatedProcedureIds: relatedByRepresentative.get(proc.id),
      historicalPrompts,
      baselineDescriptions,
    });
    const decision = createProcedurePromotionDecision(item, context, evaluation);
    const reservedCandidate = {
      slug: resolvedSlug,
      taskPattern: proc.taskPattern,
    };
    // Only reserve the slug when a draft write will actually occur (or is simulated
    // to occur under the same policy path as apply). Deferred-for-human procedures
    // must NOT consume reservations: doing so causes later same-batch procedures to
    // receive spurious -N suffixed slugs even though nothing was written.
    if (evaluation.eligible && evaluation.draft && !evaluation.metadata.requiresHumanApproval) {
      reservedSlugs.add(resolvedSlug);
      inRunSkillCandidates.push(reservedCandidate);
    }
    if (evaluation.eligible) eligible++;
    if (decision.action === "rejected") rejected++;
    if (decision.action === "deferred-for-human") deferred++;
    if (decision.action === "failed-validation") failedValidation++;
    if (evaluation.metadata.rejectionReasons.includes("functional_eval_failed")) failedEval++;

    if (!evaluation.eligible || !evaluation.draft || evaluation.metadata.requiresHumanApproval) {
      decisions.push({
        procedureId: proc.id,
        action: decision.action,
        reasons: evaluation.metadata.rejectionReasons,
        skillPath: evaluation.metadata.generatedSkillPath,
        inputHash: item.inputHash,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        runId: decision.runId,
        enabled: false,
        humanReviewRequired: decision.humanReviewRequired,
      });
      if (!evaluation.eligible || !evaluation.draft) {
        skipped++;
      }
      logger.info(
        `procedure-skill-generator: ${proc.id} ${decision.action}: ${
          evaluation.metadata.rejectionReasons.join(",") || "not eligible"
        } (${evaluation.gates.map((g) => `${g.reason}:${g.detail}`).join(" | ")})`,
      );
      continue;
    }

    const skillDir = join(basePath, resolvedSlug);
    const skillPath = join(skillDir, "SKILL.md");

    if (dryRun) {
      decisions.push({
        procedureId: proc.id,
        action: decision.action,
        reasons: evaluation.metadata.rejectionReasons,
        skillPath: evaluation.metadata.generatedSkillPath,
        inputHash: item.inputHash,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        runId: decision.runId,
        enabled: false,
        humanReviewRequired: decision.humanReviewRequired,
      });
      paths.push(skillPath);
      logger.info(`[dry-run] Would generate draft skill: ${skillPath}`);
      drafted++;
      continue;
    }

    let allocated: AllocatedSkillDir | null = null;
    try {
      allocated = allocateDraftSkillDir(basePath, options.skillsAutoPath, item.payload.skillSlug);
      // Update reservation tracking if allocation resolved to a different slug
      if (allocated.slug !== resolvedSlug) {
        reservedSlugs.delete(resolvedSlug);
        reservedSlugs.add(allocated.slug);
        const candidateIndex = inRunSkillCandidates.findIndex(
          (c) => c.slug === resolvedSlug && c.taskPattern === proc.taskPattern,
        );
        if (candidateIndex >= 0) {
          inRunSkillCandidates[candidateIndex] = { slug: allocated.slug, taskPattern: proc.taskPattern };
        }
        reservedCandidate.slug = allocated.slug;
      }
      writeDraftSkill(allocated.skillDir, rebaseDraftSlug(evaluation.draft, allocated.slug, allocated.relativePath));
      // #1328: generated skills are draft/quarantine artifacts and are not enabled. The
      // existing promoted marker is used as a churn guard only after all auto-safe gates pass.
      factsDb.markProcedurePromoted(proc.id, allocated.relativePath);
      const allocatedSkillPath = join(allocated.skillDir, "SKILL.md");
      decisions.push({
        procedureId: proc.id,
        action: decision.action,
        reasons: evaluation.metadata.rejectionReasons,
        skillPath: allocated.relativePath,
        inputHash: item.inputHash,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        runId: decision.runId,
        enabled: false,
        humanReviewRequired: decision.humanReviewRequired,
      });
      paths.push(allocatedSkillPath);
      drafted++;
      logger.info(`procedure-skill-generator: drafted ${allocatedSkillPath} (enabled=false)`);
    } catch (err) {
      rollbackDraftSkill(allocated?.skillDir ?? skillDir);
      releaseInRunReservation(reservedSlugs, inRunSkillCandidates, reservedCandidate);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "procedure-skill-generator",
        operation: "write-draft-skill",
      });
      decisions.push({
        procedureId: proc.id,
        action: "failed-validation",
        reasons: [promotionWriteFailureReason(err)],
        skillPath: evaluation.metadata.generatedSkillPath,
        inputHash: item.inputHash,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        runId: decision.runId,
        enabled: false,
        humanReviewRequired: decision.humanReviewRequired,
      });
      logger.warn(
        `procedure-skill-generator: write ${allocated ? join(allocated.skillDir, "SKILL.md") : skillPath}: ${err}`,
      );
      failedValidation++;
      skipped++;
    }
  }

  const defersByReason: Record<string, number> = {};
  for (const d of decisions) {
    if (d.action === "deferred-for-human" || d.action === "failed-validation") {
      for (const r of d.reasons ?? []) {
        defersByReason[r] = (defersByReason[r] ?? 0) + 1;
      }
    }
  }
  const clustersMerged = clusters.reduce((acc, c) => acc + c.relatedProcedureIds.length, 0);

  return {
    generated: paths.length,
    skipped,
    dryRun,
    paths,
    summary: {
      candidates: procedures.length,
      eligible,
      drafted,
      promoted: 0,
      rejected,
      deferred,
      failedValidation,
      failedEval,
      clustersMerged,
      defersByReason,
    },
    decisions,
  };
}

/**
 * Promote/draft a single procedure by id (#1191/#1328). Operator-driven --force still
 * cannot bypass safety gates; it only skips the legacy success-count threshold.
 */
export function generateAutoSkillForProcedure(
  factsDb: FactsDB,
  options: GenerateAutoSkillsOptions & {
    procedureId: string;
    requireValidation?: boolean;
  },
  logger: { info: (s: string) => void; warn: (s: string) => void },
): GenerateAutoSkillResult {
  const dryRun = options.dryRun ?? options.apply !== true;
  const policy: ProcedurePromotionPolicy = parseProcedurePromotionPolicy(
    resolveBatchPromotionPolicy(options.policy, options.apply),
  );
  const proc = factsDb.getProcedureById(options.procedureId);
  if (!proc) return { ok: false, reason: "not-found" };

  const basePath = resolveSkillsPath(options.skillsAutoPath);

  if (proc.skillPath && proc.promotedToSkill) {
    const absoluteExisting = resolveWorkspacePath(proc.skillPath);
    return {
      ok: true,
      alreadyPromoted: true,
      skillPath: join(absoluteExisting, "SKILL.md"),
      relativePath: proc.skillPath,
      dryRun,
      enabled: false,
    };
  }

  if (options.requireValidation !== false && proc.successCount < options.validationThreshold) {
    return { ok: false, reason: "validation-pending" };
  }

  const item = createProcedurePromotionItem(proc, policy);
  const resolvedSlug = ensureUniqueSlug(basePath, item.payload.skillSlug);
  const evidence = collectProcedurePromotionEvidence(factsDb, proc);
  const baselineDescriptions = loadExistingSkillDescriptions(basePath);
  const readyProcedures = factsDb.getProceduresReadyForSkill(options.validationThreshold, 200, options.skillTTLDays);
  const promotionItems = readyProcedures.map((p) => createProcedurePromotionItem(p, policy));
  const clusters = clusterProcedureItems(promotionItems);
  const clusterDeferMap = buildClusterDeferMap(clusters);
  const clusterMerge = clusterDeferMap.get(proc.id);
  const evaluation = evaluateProcedureForPromotion(item, policy, {
    skillsAutoPath: basePath,
    validationThreshold: options.requireValidation === false ? 1 : options.validationThreshold,
    resolvedSlug,
    evidence,
    contextSpecificTaskPatterns: options.promotionContextSpecificPatterns,
    inRunSkillCandidates: options.inRunSkillCandidates ?? [],
    bypassDuplicateSkillCache: options.bypassDuplicateSkillCache,
    clusterDeferMap,
    clusterRepresentativeEligible: clusterMerge
      ? evaluateClusterRepresentativeEligible(
          factsDb,
          clusterMerge.representativeId,
          readyProcedures,
          policy,
          {
            skillsAutoPath: basePath,
            validationThreshold: options.requireValidation === false ? 1 : options.validationThreshold,
            contextSpecificTaskPatterns: options.promotionContextSpecificPatterns,
            bypassDuplicateSkillCache: options.bypassDuplicateSkillCache,
            baselineDescriptions,
          },
          options.inRunSkillCandidates ?? [],
        )
      : undefined,
    historicalPrompts: collectHistoricalSessionPrompts(factsDb, proc, evidence),
    baselineDescriptions,
  });
  if (!evaluation.eligible || !evaluation.draft || evaluation.metadata.requiresHumanApproval) {
    const reasons =
      evaluation.eligible &&
      evaluation.draft &&
      evaluation.metadata.requiresHumanApproval &&
      evaluation.metadata.rejectionReasons.length === 0
        ? ["policy_requires_human_approval"]
        : evaluation.metadata.rejectionReasons;
    return {
      ok: false,
      reason: "policy-blocked",
      reasons,
    };
  }

  const skillDir = join(basePath, resolvedSlug);
  const skillPath = join(skillDir, "SKILL.md");
  const relativePath = toWorkspaceRelativePath(join(options.skillsAutoPath, resolvedSlug));

  if (dryRun) {
    logger.info(`[dry-run] Would generate draft skill: ${skillPath}`);
    return {
      ok: true,
      alreadyPromoted: false,
      skillPath,
      relativePath,
      dryRun: true,
      enabled: false,
    };
  }

  let allocated: AllocatedSkillDir | null = null;
  try {
    allocated = allocateDraftSkillDir(basePath, options.skillsAutoPath, item.payload.skillSlug);
    writeDraftSkill(allocated.skillDir, rebaseDraftSlug(evaluation.draft, allocated.slug, allocated.relativePath));
    factsDb.markProcedurePromoted(proc.id, allocated.relativePath);
  } catch (err) {
    rollbackDraftSkill(allocated?.skillDir ?? skillDir);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "procedure-skill-generator",
      operation: "promote-write-draft",
    });
    return {
      ok: false,
      reason: "write-failed",
      error: String(err),
      reasons: [promotionWriteFailureReason(err)],
    };
  }

  const allocatedSkillPath = join(allocated.skillDir, "SKILL.md");
  logger.info(`procedure-skill-generator: drafted ${proc.id} → ${allocatedSkillPath} (enabled=false)`);
  return {
    ok: true,
    alreadyPromoted: false,
    skillPath: allocatedSkillPath,
    relativePath: allocated.relativePath,
    dryRun: false,
    enabled: false,
  };
}

function collectProcedurePromotionEvidence(factsDb: FactsDB, proc: ProcedureEntry): ProcedurePromotionEvidence {
  const relatedWords = significantWords(proc.taskPattern);
  const matchesProcedure = (text: string): boolean => {
    const words = significantWords(text);
    const overlap = [...relatedWords].filter((word) => words.has(word)).length;
    return relatedWords.size < 2 ? overlap >= 1 : overlap >= 2;
  };
  const corrections = factsDb
    .list(250, { source: "self-correction" })
    .filter((entry) => entryMatchesProcedureScope(proc, entry) && matchesProcedure(entry.text));
  const manualWorkflowRequests = factsDb
    .list(250, { source: "user" })
    .filter(
      (entry) =>
        entryMatchesProcedureScope(proc, entry) &&
        /\bremember\b[^\n]{0,80}\bworkflow\b/i.test(entry.text) &&
        (matchesProcedure(entry.text) || (entry.why ? matchesProcedure(entry.why) : false)),
    );
  const rulesAndPreferences = [
    ...factsDb.getByCategory("rule"),
    ...factsDb.getByCategory("preference"),
    ...factsDb.getByCategory("pattern"),
  ].filter(
    (entry) =>
      entryMatchesProcedureScope(proc, entry) &&
      (matchesProcedure(entry.text) || (entry.why ? matchesProcedure(entry.why) : false)),
  );
  const episodes = factsDb.searchEpisodes({
    procedureId: proc.id,
    limit: 50,
    scopeFilter: scopeFilterForProcedure(proc),
  });

  return {
    procedureVersions: factsDb.getProcedureVersions(proc.id),
    procedureFailures: factsDb.getProcedureFailures(proc.id),
    episodes: episodes.map((episode) => ({
      id: episode.id,
      outcome: episode.outcome,
      sessionId: episode.sessionId ?? undefined,
    })),
    userCorrections: corrections.map(toEvidenceFactRef),
    rulesAndPreferences: rulesAndPreferences.map(toEvidenceFactRef),
    manualWorkflowRequests: manualWorkflowRequests.map(toEvidenceFactRef),
  };
}

function toEvidenceFactRef(entry: MemoryEntry): {
  id: string;
  sourceSession?: string | null;
} {
  return { id: entry.id, sourceSession: entry.provenanceSession ?? null };
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 4 && !EVIDENCE_STOP_WORDS.has(word)),
  );
}

function resolveBatchPromotionPolicy(policy: string | undefined, apply: boolean | undefined): string | undefined {
  // Backward compatibility: older maintenance callers selected mutation with apply=true
  // before the explicit --policy flag existed. Keep those apply=true calls drafting under
  // auto-safe gates, while read-only/default invocations remain draft-only for review.
  // When --apply --dry-run is passed together (to preview what apply would do), the policy
  // should still default to "auto-safe" to accurately reflect what --apply alone would do.
  return policy ?? (apply === true ? "auto-safe" : undefined);
}

function resolveSkillsPath(skillsAutoPath: string): string {
  return resolveWorkspacePath(skillsAutoPath);
}

function writeDraftSkill(
  skillDir: string,
  draft: {
    skillMd: string;
    recipeJson: string;
    verificationJson: string;
    evalsJson: string;
    proposalMetadataJson: string;
    referenceWorkflowMd?: string | null;
    referenceTelemetryMd?: string | null;
    triggerEvalJson?: string;
    replayScript?: string | null;
    evalsResultsJson?: string;
  },
): void {
  if (utf8ByteLength(draft.skillMd) > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `Refusing to write SKILL.md over OpenClaw limit (${utf8ByteLength(draft.skillMd)} > ${MAX_SKILL_FILE_BYTES} bytes)`,
    );
  }
  const files: Record<string, string> = {
    "recipe.json": draft.recipeJson,
    "verification.json": draft.verificationJson,
    "proposal-metadata.json": draft.proposalMetadataJson,
    "evals/evals.json": draft.evalsJson,
    "SKILL.md": draft.skillMd,
  };
  if (draft.evalsResultsJson) {
    files["evals/results.json"] = draft.evalsResultsJson;
  }
  if (draft.referenceWorkflowMd) {
    files["references/workflow.md"] = draft.referenceWorkflowMd;
  }
  if (draft.referenceTelemetryMd) {
    files["references/telemetry.md"] = draft.referenceTelemetryMd;
  }
  if (draft.triggerEvalJson) {
    files["evals/trigger-eval.json"] = draft.triggerEvalJson;
  }
  const executableRelativePaths: string[] = [];
  if (draft.replayScript) {
    files["scripts/replay.sh"] = draft.replayScript;
    executableRelativePaths.push("scripts/replay.sh");
  }
  atomicWriteSkillDir(skillDir, files, { executableRelativePaths });
}

function isActiveFactForReplay(fact: MemoryEntry | null): fact is MemoryEntry {
  if (!fact?.text?.trim()) return false;
  if (fact.supersededAt != null) return false;
  const now = Math.floor(Date.now() / 1000);
  if (fact.expiresAt != null && fact.expiresAt <= now) return false;
  return true;
}

/** Re-evaluate representative eligibility with the current in-run duplicate set. */
function evaluateClusterRepresentativeEligible(
  factsDb: FactsDB,
  representativeId: string,
  procedures: ProcedureEntry[],
  policy: ProcedurePromotionPolicy,
  options: {
    skillsAutoPath: string;
    validationThreshold: number;
    contextSpecificTaskPatterns?: readonly string[];
    bypassDuplicateSkillCache?: boolean;
    baselineDescriptions: string[];
  },
  inRunSkillCandidates: Array<{ slug: string; taskPattern: string }>,
): boolean | undefined {
  const repProc = procedures.find((p) => p.id === representativeId);
  if (!repProc) return undefined;
  const item = createProcedurePromotionItem(repProc, policy);
  const evidence = collectProcedurePromotionEvidence(factsDb, repProc);
  const evaluation = evaluateProcedureForPromotion(item, policy, {
    skillsAutoPath: options.skillsAutoPath,
    validationThreshold: options.validationThreshold,
    resolvedSlug: item.payload.skillSlug,
    evidence,
    contextSpecificTaskPatterns: options.contextSpecificTaskPatterns,
    bypassDuplicateSkillCache: options.bypassDuplicateSkillCache,
    inRunSkillCandidates,
    historicalPrompts: collectHistoricalSessionPrompts(factsDb, repProc, evidence),
    baselineDescriptions: options.baselineDescriptions,
  });
  return evaluation.eligible;
}

function loadExistingSkillDescriptions(skillsBasePath: string): string[] {
  const descriptions: string[] = [];
  if (!existsSync(skillsBasePath)) return descriptions;
  try {
    for (const entry of readdirSync(skillsBasePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(skillsBasePath, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const raw = readFileSync(skillMdPath, "utf8");
      const stripped = stripLeadingHtmlComments(raw);
      const fm = stripped.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const keys = parseSkillFrontmatterKeys(fm[1]);
      const desc = keys.get("description");
      if (desc) descriptions.push(desc);
    }
  } catch {
    return descriptions;
  }
  return descriptions;
}

function redactHistoricalPromptForEval(text: string): string {
  const { redacted } = redactAutopilotText(text.trim());
  return redacted;
}

function collectHistoricalSessionPrompts(
  factsDb: FactsDB,
  proc: ProcedureEntry,
  evidence: ProcedurePromotionEvidence,
): string[] {
  const prompts = new Set<string>();
  prompts.add(proc.taskPattern);
  for (const req of evidence.manualWorkflowRequests ?? []) {
    const fact = factsDb.getById(req.id);
    if (isActiveFactForReplay(fact)) {
      prompts.add(redactHistoricalPromptForEval(fact.text));
    }
  }
  const episodes = factsDb.searchEpisodes({
    procedureId: proc.id,
    limit: 20,
    scopeFilter: scopeFilterForProcedure(proc),
  });
  for (const ep of episodes) {
    if (ep.event?.trim()) prompts.add(redactHistoricalPromptForEval(ep.event));
    else if (ep.context?.trim()) prompts.add(redactHistoricalPromptForEval(ep.context.slice(0, 200)));
  }
  return [...prompts].filter((p) => p.length > 0).slice(0, 20);
}

function releaseInRunReservation(
  reservedSlugs: Set<string>,
  inRunSkillCandidates: Array<{ slug: string; taskPattern: string }>,
  candidate: { slug: string; taskPattern: string },
): void {
  reservedSlugs.delete(candidate.slug);
  const index = inRunSkillCandidates.findIndex(
    (entry) => entry.slug === candidate.slug && entry.taskPattern === candidate.taskPattern,
  );
  if (index >= 0) inRunSkillCandidates.splice(index, 1);
}

function rollbackDraftSkill(skillDir: string): void {
  if (!existsSync(skillDir)) return;
  try {
    rmSync(skillDir, { recursive: true, force: true });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "procedure-skill-generator",
      operation: "rollback-draft-skill",
    });
  }
}
