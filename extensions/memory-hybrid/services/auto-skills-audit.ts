/**
 * Audit and quarantine legacy generated auto-skills (issue #1541).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_SKILL_FILE_BYTES } from "../config/skill-size-limits.js";
import { SkillValidator } from "./skill-validator.js";

export type AutoSkillAuditEntry = {
  slug: string;
  skillPath: string;
  skillBytes: number;
  skillLines: number;
  recipeBytes: number | null;
  loadable: boolean;
  transcriptLike: boolean;
  secretLike: boolean;
  injectionLike: boolean;
  validationViolations: string[];
};

export type AutoSkillAuditReport = {
  scanned: number;
  oversized: number;
  suspicious: number;
  entries: AutoSkillAuditEntry[];
};

const TRANSCRIPT_PATTERN = /\*\*\w+\*\*\s*\{|"tool"\s*:|tool_call_id/i;
const INJECTION_PATTERN = /\bignore\s+(?:previous|system|developer)\s+instructions\b/i;

function utf8Bytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function scanSkillDir(skillDir: string, slug: string): AutoSkillAuditEntry | null {
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const skillContent = readFileSync(skillPath, "utf-8");
  const skillBytes = Buffer.byteLength(skillContent, "utf8");
  const skillLines = skillContent.split(/\r?\n/).length;
  const recipePath = join(skillDir, "recipe.json");
  const recipeBytes = existsSync(recipePath) ? utf8Bytes(recipePath) : null;
  const validator = new SkillValidator();
  const validation = validator.validate(skillContent);
  return {
    slug,
    skillPath,
    skillBytes,
    skillLines,
    recipeBytes,
    loadable: skillBytes <= MAX_SKILL_FILE_BYTES,
    transcriptLike: TRANSCRIPT_PATTERN.test(skillContent),
    secretLike: validation.violations.some((v) => /credential|token|private-key/i.test(v)),
    injectionLike: INJECTION_PATTERN.test(skillContent),
    validationViolations: validation.violations,
  };
}

export function auditAutoSkills(skillsAutoPath: string): AutoSkillAuditReport {
  const entries: AutoSkillAuditEntry[] = [];
  if (!existsSync(skillsAutoPath)) {
    return { scanned: 0, oversized: 0, suspicious: 0, entries };
  }
  for (const name of readdirSync(skillsAutoPath)) {
    if (name.startsWith(".")) continue;
    const skillDir = join(skillsAutoPath, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const entry = scanSkillDir(skillDir, name);
    if (entry) entries.push(entry);
  }
  return {
    scanned: entries.length,
    oversized: entries.filter((e) => !e.loadable).length,
    suspicious: entries.filter((e) => e.transcriptLike || e.secretLike || e.injectionLike).length,
    entries,
  };
}

export type QuarantineResult = {
  quarantined: string[];
  errors: string[];
};

/**
 * Move unsafe/oversized skills to skills/auto-quarantine/YYYY-MM-DD/<slug>/.
 */
export function quarantineAutoSkills(
  skillsAutoPath: string,
  entries: AutoSkillAuditEntry[],
  options?: { onlyOversized?: boolean; onlySuspicious?: boolean },
): QuarantineResult {
  const date = new Date().toISOString().slice(0, 10);
  const quarantineRoot = join(skillsAutoPath, "..", "auto-quarantine", date);
  const quarantined: string[] = [];
  const errors: string[] = [];
  mkdirSync(quarantineRoot, { recursive: true });

  for (const entry of entries) {
    const shouldMove =
      (!options?.onlyOversized && !options?.onlySuspicious) ||
      (options.onlyOversized && !entry.loadable) ||
      (options.onlySuspicious && (entry.transcriptLike || entry.secretLike || entry.injectionLike));
    if (!shouldMove) continue;
    const srcDir = join(skillsAutoPath, entry.slug);
    const destDir = join(quarantineRoot, entry.slug);
    try {
      if (existsSync(destDir)) {
        errors.push(`${entry.slug}: destination already exists`);
        continue;
      }
      renameSync(srcDir, destDir);
      quarantined.push(entry.slug);
    } catch (err) {
      errors.push(`${entry.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { quarantined, errors };
}
