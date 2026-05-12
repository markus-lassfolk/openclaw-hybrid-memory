import { getEnv } from "../utils/env-manager.js";
/**
 * Procedural memory: generate verified draft SKILL.md + recipe.json from validated procedures.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { GenerateAutoSkillsResult } from "../cli/register.js";
import { slugifyForSkill } from "../utils/text.js";
import { capturePluginError } from "./error-reporter.js";
import {
  PROCEDURE_PROMOTION_POLICY_VERSION,
  createProcedurePromotionDecision,
  createProcedurePromotionItem,
  evaluateProcedureForPromotion,
  parseProcedurePromotionPolicy,
  type ProcedurePromotionPolicy,
} from "./procedure-promotion-policy.js";

const MAX_SKILLS_PER_RUN = 10;

/** Per-procedure result returned by {@link generateAutoSkillForProcedure}. */
export type GenerateAutoSkillResult =
  | { ok: false; reason: "not-found" | "validation-pending" | "write-failed" | "policy-blocked"; error?: string; reasons?: string[] }
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

function ensureUniqueSlug(basePath: string, slug: string): string {
  let candidate = slug;
  let n = 0;
  while (existsSync(join(basePath, candidate))) {
    n++;
    candidate = `${slug}-${n}`;
  }
  return candidate;
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
  const policy = parseProcedurePromotionPolicy(options.policy ?? (options.apply ? "auto-safe" : "draft-only"));
  const basePath = resolveSkillsPath(options.skillsAutoPath);
  const procedures = factsDb.getProceduresReadyForSkill(1, maxPerRun);
  const paths: string[] = [];
  const decisions: NonNullable<GenerateAutoSkillsResult["decisions"]> = [];
  let skipped = 0;
  let eligible = 0;
  let drafted = 0;
  let rejected = 0;
  let deferred = 0;
  let failedValidation = 0;
  let failedEval = 0;

  for (const proc of procedures) {
    const item = createProcedurePromotionItem(proc, policy);
    const context = {
      runId: `procedure-promotion-${Date.now()}`,
      mode: dryRun ? "dry-run" as const : "apply" as const,
      policy,
      policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
      inputHash: item.inputHash,
      actor: { type: "system" as const, id: "generate-auto-skills" },
    };
    const evaluation = evaluateProcedureForPromotion(item, policy, {
      skillsAutoPath: basePath,
      validationThreshold: options.validationThreshold,
    });
    const decision = createProcedurePromotionDecision(item, context, evaluation);
    if (evaluation.eligible) eligible++;
    if (decision.action === "rejected") rejected++;
    if (decision.action === "deferred-for-human") deferred++;
    if (decision.action === "failed-validation") failedValidation++;
    if (evaluation.metadata.functionalEval === "failed") failedEval++;

    decisions.push({
      procedureId: proc.id,
      action: decision.action,
      reasons: evaluation.metadata.rejectionReasons,
      skillPath: evaluation.metadata.generatedSkillPath,
      inputHash: item.inputHash,
      policyVersion: PROCEDURE_PROMOTION_POLICY_VERSION,
      enabled: false,
      humanReviewRequired: decision.humanReviewRequired,
    });

    if (!evaluation.eligible || !evaluation.draft) {
      skipped++;
      logger.info(`procedure-skill-generator: ${proc.id} ${decision.action}: ${evaluation.metadata.rejectionReasons.join(",") || "not eligible"} (${evaluation.gates.map((g) => `${g.reason}:${g.detail}`).join(" | ")})`);
      continue;
    }

    const slug = ensureUniqueSlug(basePath, evaluation.draft.slug);
    const skillDir = join(basePath, slug);
    const skillPath = join(skillDir, "SKILL.md");
    paths.push(skillPath);

    if (dryRun) {
      logger.info(`[dry-run] Would generate draft skill: ${skillPath}`);
      drafted++;
      continue;
    }

    try {
      writeDraftSkill(skillDir, evaluation.draft);
      const relativePath = join(options.skillsAutoPath, slug);
      // #1328: generated skills are draft/quarantine artifacts and are not enabled. The
      // existing promoted marker is used as a churn guard only after all auto-safe gates pass.
      factsDb.markProcedurePromoted(proc.id, relativePath);
      drafted++;
      logger.info(`procedure-skill-generator: drafted ${skillPath} (enabled=false)`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "procedure-skill-generator",
        operation: "write-draft-skill",
      });
      logger.warn(`procedure-skill-generator: write ${skillPath}: ${err}`);
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
  options: GenerateAutoSkillsOptions & { procedureId: string; requireValidation?: boolean },
  logger: { info: (s: string) => void; warn: (s: string) => void },
): GenerateAutoSkillResult {
  const dryRun = options.dryRun ?? options.apply !== true;
  const policy: ProcedurePromotionPolicy = parseProcedurePromotionPolicy(options.policy ?? (options.apply ? "auto-safe" : "draft-only"));
  const proc = factsDb.getProcedureById(options.procedureId);
  if (!proc) return { ok: false, reason: "not-found" };

  const basePath = resolveSkillsPath(options.skillsAutoPath);

  if (proc.skillPath && proc.promotedToSkill) {
    const absoluteExisting = proc.skillPath.startsWith("/") ? proc.skillPath : join(getEnv("OPENCLAW_WORKSPACE") || process.cwd(), proc.skillPath);
    return { ok: true, alreadyPromoted: true, skillPath: join(absoluteExisting, "SKILL.md"), relativePath: proc.skillPath, dryRun, enabled: false };
  }

  if (options.requireValidation !== false && proc.successCount < options.validationThreshold) {
    return { ok: false, reason: "validation-pending" };
  }

  const item = createProcedurePromotionItem(proc, policy);
  const evaluation = evaluateProcedureForPromotion(item, policy, {
    skillsAutoPath: basePath,
    validationThreshold: options.requireValidation === false ? 1 : options.validationThreshold,
  });
  if (!evaluation.eligible || !evaluation.draft) {
    return { ok: false, reason: "policy-blocked", reasons: evaluation.metadata.rejectionReasons };
  }

  const slug = ensureUniqueSlug(basePath, slugifyForSkill(proc.taskPattern, "procedure"));
  const skillDir = join(basePath, slug);
  const skillPath = join(skillDir, "SKILL.md");
  const relativePath = join(options.skillsAutoPath, slug);

  if (dryRun) {
    logger.info(`[dry-run] Would generate draft skill: ${skillPath}`);
    return { ok: true, alreadyPromoted: false, skillPath, relativePath, dryRun: true, enabled: false };
  }

  try {
    writeDraftSkill(skillDir, evaluation.draft);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "procedure-skill-generator",
      operation: "promote-write-draft",
    });
    return { ok: false, reason: "write-failed", error: String(err) };
  }

  factsDb.markProcedurePromoted(proc.id, relativePath);
  logger.info(`procedure-skill-generator: drafted ${proc.id} → ${skillPath} (enabled=false)`);
  return { ok: true, alreadyPromoted: false, skillPath, relativePath, dryRun: false, enabled: false };
}

function resolveSkillsPath(skillsAutoPath: string): string {
  return skillsAutoPath.startsWith("/") ? skillsAutoPath : join(getEnv("OPENCLAW_WORKSPACE") || process.cwd(), skillsAutoPath);
}

function writeDraftSkill(skillDir: string, draft: { skillMd: string; recipeJson: string; verificationJson: string; evalsJson: string }): void {
  mkdirSync(join(skillDir, "evals"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), draft.skillMd, "utf-8");
  writeFileSync(join(skillDir, "recipe.json"), draft.recipeJson, "utf-8");
  writeFileSync(join(skillDir, "verification.json"), draft.verificationJson, "utf-8");
  writeFileSync(join(skillDir, "evals", "evals.json"), draft.evalsJson, "utf-8");
}
