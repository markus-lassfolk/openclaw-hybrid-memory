/**
 * Procedural memory (issue #23): generate SKILL.md + recipe.json from validated procedures.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { ProcedureEntry } from "../types/memory.js";
import type { GenerateAutoSkillsResult } from "../cli/register.js";

const MAX_SKILLS_PER_RUN = 10;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "procedure";
}

function ensureUniqueSlug(basePath: string, slug: string): string {
  let candidate = slug;
  let n = 0;
  while (existsSync(join(basePath, candidate))) {
    n++;
    candidate = `${slug}-${n}`;
  }
  return candidate;
}

export type GenerateAutoSkillsOptions = {
  skillsAutoPath: string;
  validationThreshold: number;
  skillTTLDays: number;
  maxPerRun?: number;
  dryRun?: boolean;
};

/**
 * Generate workspace/skills/auto/{slug}/SKILL.md and recipe.json for procedures
 * that have been validated at least validationThreshold times.
 */
export function generateAutoSkills(
  factsDb: FactsDB,
  options: GenerateAutoSkillsOptions,
  logger: { info: (s: string) => void; warn: (s: string) => void },
): GenerateAutoSkillsResult {
  const maxPerRun = options.maxPerRun ?? MAX_SKILLS_PER_RUN;
  const dryRun = options.dryRun ?? false;
  const basePath = options.skillsAutoPath.startsWith("/")
    ? options.skillsAutoPath
    : join(process.env.OPENCLAW_WORKSPACE || process.cwd(), options.skillsAutoPath);

  const procedures = factsDb.getProceduresReadyForSkill(options.validationThreshold, maxPerRun);
  const paths: string[] = [];
  let skipped = 0;

  for (const proc of procedures) {
    const slug = ensureUniqueSlug(basePath, slugify(proc.taskPattern));
    const skillDir = join(basePath, slug);
    const skillPath = join(skillDir, "SKILL.md");
    const recipePath = join(skillDir, "recipe.json");

    if (dryRun) {
      logger.info(`[dry-run] Would generate skill: ${skillPath}`);
      paths.push(skillPath);
      continue;
    }

    try {
      mkdirSync(skillDir, { recursive: true });
    } catch (err) {
      logger.warn(`procedure-skill-generator: mkdir ${skillDir}: ${err}`);
      skipped++;
      continue;
    }

    let recipe: unknown;
    try {
      recipe = JSON.parse(proc.recipeJson);
    } catch {
      recipe = [];
    }
    const steps = Array.isArray(recipe) ? recipe : [];

    const lastValidatedStr = proc.lastValidated
      ? new Date(proc.lastValidated * 1000).toISOString().slice(0, 10)
      : "never";
    const stepsMd = Array.isArray(steps)
      ? (steps as Array<{ tool?: string; args?: Record<string, unknown>; summary?: string }>)
          .map((s, i) => {
            const args = s.args && Object.keys(s.args).length > 0 ? ` ${JSON.stringify(s.args)}` : "";
            return `${i + 1}. **${s.tool || "step"}**${args}${s.summary ? ` — ${s.summary}` : ""}`;
          })
          .join("\n")
      : "See recipe.json";

    const skillMd = `# ${slug.replace(/-/g, " ")}

Auto-generated procedure (procedural memory). Last validated: ${lastValidatedStr}. Confidence: ${(proc.confidence * 100).toFixed(0)}%.

## Task
${proc.taskPattern}

## Steps (last time this worked)
${stepsMd}

## Metadata
- Source procedure id: \`${proc.id}\`
- Success count: ${proc.successCount}
- Do not store secrets in procedures; use credential references only.
`;

    try {
      writeFileSync(skillPath, skillMd, "utf-8");
      writeFileSync(recipePath, JSON.stringify(steps, null, 2), "utf-8");
    } catch (err) {
      logger.warn(`procedure-skill-generator: write ${skillPath}: ${err}`);
      skipped++;
      continue;
    }

    const relativePath = join(options.skillsAutoPath, slug);
    factsDb.markProcedurePromoted(proc.id, relativePath);
    paths.push(skillPath);
    logger.info(`procedure-skill-generator: generated ${skillPath}`);
  }

  return {
    generated: paths.length,
    skipped,
    dryRun,
    paths,
  };
}
