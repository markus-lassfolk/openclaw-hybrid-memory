/**
 * On-disk hygiene for crystallized workflow skills (quarantine / install rollback / restore).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatDateUtc, nowSec } from "../utils/dates.js";

const QUARANTINE_DIR_NAME = "crystallization-quarantine";

function quarantineRootForOutputDir(activeOutputDir: string): string {
  return join(activeOutputDir, "..", QUARANTINE_DIR_NAME);
}

/**
 * Move an installed skill directory out of the active crystallization output tree.
 * Layout: `{outputDir}/../crystallization-quarantine/YYYY-MM-DD/{skillName}/`
 */
export function quarantineCrystallizedSkillOnDisk(
  outputPath: string,
  activeOutputDir: string,
): { movedTo?: string; error?: string } {
  const normalizedPath = outputPath?.trim();
  if (!normalizedPath || !existsSync(normalizedPath)) {
    return { error: "skill file not found" };
  }

  const skillDir = dirname(normalizedPath);
  const skillName = basename(skillDir);
  const date = formatDateUtc(nowSec());
  const quarantineRoot = join(quarantineRootForOutputDir(activeOutputDir), date);
  mkdirSync(quarantineRoot, { recursive: true });
  const destDir = join(quarantineRoot, skillName);

  if (existsSync(destDir)) {
    return { error: `quarantine destination already exists: ${destDir}` };
  }

  try {
    renameSync(skillDir, destDir);
    return { movedTo: destDir };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Locate a quarantined skill directory by name (newest date folder first). */
export function findQuarantinedSkillDir(skillName: string, activeOutputDir: string): string | null {
  const root = quarantineRootForOutputDir(activeOutputDir);
  if (!existsSync(root)) return null;
  let dateDirs: string[];
  try {
    dateDirs = readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return null;
  }
  for (const date of dateDirs) {
    const candidate = join(root, date, skillName);
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, "SKILL.md"))) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Move a quarantined skill directory back into the active output tree.
 * Returns the new SKILL.md path on success.
 */
export function restoreCrystallizedSkillOnDisk(
  quarantineSkillDir: string,
  activeOutputDir: string,
  skillName: string,
): { outputPath?: string; error?: string } {
  const destDir = join(activeOutputDir, skillName);
  if (existsSync(destDir)) {
    return { error: `active skill directory already exists: ${destDir}` };
  }
  if (!existsSync(join(quarantineSkillDir, "SKILL.md"))) {
    return { error: `quarantined SKILL.md not found under ${quarantineSkillDir}` };
  }
  try {
    mkdirSync(activeOutputDir, { recursive: true });
    renameSync(quarantineSkillDir, destDir);
    return { outputPath: join(destDir, "SKILL.md") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best-effort removal of a freshly written skill directory (install rollback). */
export function removeCrystallizedSkillDir(outputPath: string): void {
  if (!outputPath?.trim()) return;
  try {
    const skillDir = dirname(outputPath);
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** @deprecated Use removeCrystallizedSkillDir — removes entire skill directory. */
export function removeCrystallizedSkillFile(outputPath: string): void {
  removeCrystallizedSkillDir(outputPath);
}
