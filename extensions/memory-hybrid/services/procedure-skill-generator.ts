/**
 * Procedural memory: generate verified draft SKILL.md + recipe.json from validated procedures.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { GenerateAutoSkillsResult } from "../cli/register.js";
import type { MemoryEntry, MemoryScope, ProcedureEntry, ScopeFilter } from "../types/memory.js";
import { SKILL_COMPLETE_MARKER, atomicWriteSkillDir, isAtomicWriteArtifact } from "../utils/atomic-write.js";
import { resolveWorkspacePath } from "../utils/path.js";
import { titleCase } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import {
  PROCEDURE_PROMOTION_POLICY_VERSION,
  type ProcedurePromotionEvidence,
  type ProcedurePromotionPolicy,
  createProcedurePromotionDecision,
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  parseProcedurePromotionPolicy,
} from "./procedure-promotion-policy.js";

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
  while (reservedSlugs?.has(candidate) || isCommittedSkillDir(join(basePath, candidate))) {
    n++;
    candidate = `${slug}-${n}`;
  }
  return candidate;
}

function isCommittedSkillDir(skillDir: string): boolean {
  if (!existsSync(skillDir)) return false;
  if (isAtomicWriteArtifact(skillDir) && !existsSync(join(skillDir, SKILL_COMPLETE_MARKER))) return false;
  return true;
}

function rebaseDraftSlug(
  draft: {
    skillMd: string;
    recipeJson: string;
    verificationJson: string;
    evalsJson: string;
    proposalMetadataJson: string;
  },
  resolvedSlug: string,
  generatedSkillPath: string,
): {
  skillMd: string;
  recipeJson: string;
  verificationJson: string;
  evalsJson: string;
  proposalMetadataJson: string;
} {
  const verification = JSON.parse(draft.verificationJson) as {
    skill?: unknown;
    generatedSkillPath?: unknown;
  };
  const originalSlug =
    typeof verification.skill === "string" && verification.skill.length > 0 ? verification.skill : resolvedSlug;
  verification.skill = resolvedSlug;
  verification.generatedSkillPath = generatedSkillPath;

  const skillMd = draft.skillMd
    .replace(new RegExp(`^name: ${escapeRegExp(originalSlug)}$`, "m"), `name: ${resolvedSlug}`)
    .replace(new RegExp(`^# ${escapeRegExp(titleCase(originalSlug))}$`, "m"), `# ${titleCase(resolvedSlug)}`);

  return {
    ...draft,
    skillMd,
    verificationJson: `${JSON.stringify(verification, null, 2)}\n`,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type GenerateAutoSkillsOptions = {
  skillsAutoPath: string;
  validationThreshold: number;
  skillTTLDays: number;
  maxPerRun?: number;
  dryRun?: boolean;
  apply?: boolean;
  policy?: string;
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
  const procedures = factsDb.getProceduresReadyForSkill(options.validationThreshold, maxPerRun);
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

  for (const proc of procedures) {
    const item = createProcedurePromotionItem(proc, policy);
    const resolvedSlug = ensureUniqueSlug(basePath, item.payload.skillSlug, reservedSlugs);
    const evidence = collectProcedurePromotionEvidence(factsDb, proc);
    const context = {
      runId,
      mode: dryRun ? ("dry-run" as const) : ("apply" as const),
      policy,
      policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
      inputHash: item.inputHash,
      actor: { type: "system" as const, id: "generate-auto-skills" },
    };
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: basePath,
      validationThreshold: options.validationThreshold,
      resolvedSlug,
      inRunSkillCandidates,
      evidence,
    });
    const decision = createProcedurePromotionDecision(item, context, evaluation);
    const reservedCandidate = {
      slug: resolvedSlug,
      taskPattern: proc.taskPattern,
    };
    if (evaluation.eligible && evaluation.draft) {
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

    try {
      const relativePath = join(options.skillsAutoPath, resolvedSlug);
      const skillDirExistedBefore = existsSync(skillDir);
      writeDraftSkill(skillDir, rebaseDraftSlug(evaluation.draft, resolvedSlug, relativePath));
      // #1328: generated skills are draft/quarantine artifacts and are not enabled. The
      // existing promoted marker is used as a churn guard only after all auto-safe gates pass.
      factsDb.markProcedurePromoted(proc.id, relativePath);
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
      drafted++;
      logger.info(`procedure-skill-generator: drafted ${skillPath} (enabled=false)`);
    } catch (err) {
      rollbackDraftSkill(skillDir, skillDirExistedBefore);
      releaseInRunReservation(reservedSlugs, inRunSkillCandidates, reservedCandidate);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "procedure-skill-generator",
        operation: "write-draft-skill",
      });
      decisions.push({
        procedureId: proc.id,
        action: "failed-validation",
        reasons: ["write_failed"],
        skillPath: evaluation.metadata.generatedSkillPath,
        inputHash: item.inputHash,
        policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
        runId: decision.runId,
        enabled: false,
        humanReviewRequired: decision.humanReviewRequired,
      });
      logger.warn(`procedure-skill-generator: write ${skillPath}: ${err}`);
      failedValidation++;
      skipped++;
    }
  }

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
  const evaluation = evaluateProcedureForPromotion(item, policy, {
    skillsAutoPath: basePath,
    validationThreshold: options.requireValidation === false ? 1 : options.validationThreshold,
    resolvedSlug,
    evidence,
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
  const relativePath = join(options.skillsAutoPath, resolvedSlug);

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

  const skillDirExistedBefore = existsSync(skillDir);
  try {
    writeDraftSkill(skillDir, rebaseDraftSlug(evaluation.draft, resolvedSlug, relativePath));
    factsDb.markProcedurePromoted(proc.id, relativePath);
  } catch (err) {
    rollbackDraftSkill(skillDir, skillDirExistedBefore);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "procedure-skill-generator",
      operation: "promote-write-draft",
    });
    return { ok: false, reason: "write-failed", error: String(err) };
  }

  logger.info(`procedure-skill-generator: drafted ${proc.id} → ${skillPath} (enabled=false)`);
  return {
    ok: true,
    alreadyPromoted: false,
    skillPath,
    relativePath,
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
  },
): void {
  // Write all sidecar files atomically (temp dir → rename). SKILL.md is
  // written last among content files so it is the final content write before
  // the completion marker.
  atomicWriteSkillDir(skillDir, {
    "recipe.json": draft.recipeJson,
    "verification.json": draft.verificationJson,
    "proposal-metadata.json": draft.proposalMetadataJson,
    "evals/evals.json": draft.evalsJson,
    "SKILL.md": draft.skillMd,
  });
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

function rollbackDraftSkill(skillDir: string, skillDirExistedBefore?: boolean): void {
  if (!existsSync(skillDir)) return;
  // Only delete incomplete atomic write artifacts. Do not delete pre-existing
  // committed skill directories (which have the completion marker) to avoid
  // destructive TOCTOU races with concurrent skill writes.
  if (skillDirExistedBefore !== false && isCommittedSkillDir(skillDir)) return;
  try {
    rmSync(skillDir, { recursive: true, force: true });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "procedure-skill-generator",
      operation: "rollback-draft-skill",
    });
  }
}
