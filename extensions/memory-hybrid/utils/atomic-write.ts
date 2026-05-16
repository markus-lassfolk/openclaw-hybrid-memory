/**
 * Atomic file and skill-directory write helpers (Issue #1405).
 *
 * Partial skill directories created by a process crash between individual
 * `writeFileSync` calls can be mistaken for valid installed skills.  These
 * helpers prevent that by:
 *
 *  • `atomicWriteFile`    – write to a temp file then rename (one file).
 *  • `atomicWriteSkillDir` – write all sidecar files into a temp directory,
 *                            stamp `.openclaw-skill-complete`, then rename the
 *                            temp directory to the final location (multi-file).
 *  • `isSkillDirComplete` – returns true only when the marker is present.
 *
 * The marker name is exported so loaders can skip in-progress directories.
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Marker file written as the last step inside an atomic skill directory. */
export const SKILL_COMPLETE_MARKER = ".openclaw-skill-complete";

/** Prefix used for hidden sibling directories that are still being written. */
export const SKILL_ATOMIC_TEMP_PREFIX = ".openclaw-skill-tmp-";

/**
 * Returns `true` when `dir` exists and contains no entries (empty directory).
 */
function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * Atomically write a single file.
 *
 * Writes content to `${targetPath}.tmp-${pid}-${rand}` then renames it to
 * `targetPath`.  If any step fails the temp file is removed and the error is
 * re-thrown, so `targetPath` is never left in a partially-written state.
 */
export function atomicWriteFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const rand = randomBytes(8).toString("hex");
  const tmpPath = `${targetPath}.tmp-${process.pid}-${rand}`;

  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort temp cleanup; swallow to surface original error
    }
    throw err;
  }
}

/**
 * Atomically write a multi-file skill directory.
 *
 * All files in `files` (keyed by path relative to `skillDir`) are written
 * into a temporary sibling directory `${SKILL_ATOMIC_TEMP_PREFIX}${pid}-${rand}`.  A
 * `.openclaw-skill-complete` marker is written as the very last file.  The
 * temp directory is then atomically renamed to `skillDir`.
 *
 * If `skillDir` already exists and is non-empty, this helper fails instead of
 * moving the existing directory aside. That keeps replacement crash-atomic: a
 * process crash can leave only a hidden temp sibling, never a missing final
 * directory. Empty directories (e.g. from `allocateDraftSkillDir` reservation
 * locks) are allowed and will be atomically replaced by the rename, preserving
 * the allocation lock throughout the write operation.
 *
 * Pass files in the order you want them written.  Convention: put `SKILL.md`
 * last so it is the final content file before the marker.
 */
export function atomicWriteSkillDir(skillDir: string, files: Record<string, string>): void {
  const parent = dirname(skillDir);
  const rand = randomBytes(8).toString("hex");
  const tmpDir = join(parent, `${SKILL_ATOMIC_TEMP_PREFIX}${process.pid}-${rand}`);

  try {
    if (existsSync(skillDir) && !isEmptyDir(skillDir)) {
      throw new Error(`Atomic skill directory target already exists: ${skillDir}`);
    }

    // Write every sidecar into the temp directory.
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(tmpDir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }

    // Stamp the completion marker as the final write inside the temp dir.
    writeFileSync(join(tmpDir, SKILL_COMPLETE_MARKER), new Date().toISOString(), "utf-8");

    // Atomic promotion: temp dir → final skill dir. On POSIX, renameSync
    // atomically replaces empty directories, preserving the allocation lock.
    // On Windows, renameSync fails if the target exists (even when empty), so
    // we remove the empty reservation directory first.
    if (process.platform === "win32" && existsSync(skillDir) && isEmptyDir(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
    }
    renameSync(tmpDir, skillDir);
  } catch (err) {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup; swallow to surface original error
    }
    throw err;
  }
}

/**
 * Returns `true` when `skillDir` contains the completion marker, indicating
 * that the directory was written atomically and is not an in-progress write.
 */
export function isSkillDirComplete(skillDir: string): boolean {
  return existsSync(join(skillDir, SKILL_COMPLETE_MARKER));
}
