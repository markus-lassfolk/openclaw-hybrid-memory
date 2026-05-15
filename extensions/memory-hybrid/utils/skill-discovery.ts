import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ATOMIC_TEMP_PREFIX, isSkillDirComplete } from "./atomic-write.js";

export interface DiscoveredSkillDir {
  /** Directory name under the scanned skills root. */
  name: string;
  /** Absolute path to the completed skill directory. */
  dirPath: string;
  /** Absolute path to the directory's SKILL.md file. */
  skillPath: string;
}

/**
 * Returns true for hidden scratch directories left behind by interrupted
 * atomic skill writes. These are never valid loader candidates.
 */
export function isAtomicSkillWriteScratchDir(name: string): boolean {
  return name.startsWith(SKILL_ATOMIC_TEMP_PREFIX) || /^.+\.tmp-\d+-[a-f0-9]+$/i.test(name) || /^\..+\.bak-/.test(name);
}

/**
 * Discover skill directories that are safe for loader-style consumption.
 *
 * Auto-generated skill directories must contain `.openclaw-skill-complete`;
 * markerless directories are treated as in-progress writes and skipped even if
 * they already contain `SKILL.md`. Legacy compatibility belongs in migration or
 * duplicate-detection paths, not in active loader discovery.
 */
export function discoverCompletedSkillDirs(skillsDir: string): DiscoveredSkillDir[] {
  const out: DiscoveredSkillDir[] = [];
  if (!existsSync(skillsDir)) return out;

  for (const entry of safeReadSkillDir(skillsDir)) {
    if (isAtomicSkillWriteScratchDir(entry.name)) continue;
    if (!entry.isDirectory) continue;

    const dirPath = join(skillsDir, entry.name);
    if (!isSkillDirComplete(dirPath)) continue;

    const skillPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    out.push({ name: entry.name, dirPath, skillPath });
  }

  return out;
}

function safeReadSkillDir(dir: string): Array<{ name: string; isDirectory: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}
