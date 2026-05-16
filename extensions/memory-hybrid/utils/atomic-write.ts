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

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Marker file written as the last step inside an atomic skill directory. */
export const SKILL_COMPLETE_MARKER = ".openclaw-skill-complete";

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
 * into a temporary sibling directory `${skillDir}.tmp-${pid}-${rand}`.  A
 * `.openclaw-skill-complete` marker is written as the very last file.  The
 * temp directory is then atomically renamed to `skillDir`.
 *
 * If `skillDir` already exists it is first moved to a backup directory so
 * that the rename always targets a free path.  On success the backup is
 * removed.  On failure the backup is restored (best-effort) and the temp
 * directory is cleaned up, so `skillDir` is never left in a
 * partially-written state.
 *
 * Pass files in the order you want them written.  Convention: put `SKILL.md`
 * last so it is the final content file before the marker.
 */
export function atomicWriteSkillDir(skillDir: string, files: Record<string, string>): { completionMarker: string } {
  const parent = dirname(skillDir);
  const rand = randomBytes(8).toString("hex");
  const tmpDir = `${skillDir}.tmp-${process.pid}-${rand}`;
  const backupDir = existsSync(skillDir) ? join(parent, `.${basename(skillDir)}.bak-${Date.now()}-${rand}`) : null;
  const completionMarker = `${new Date().toISOString()}\nwriteId=${process.pid}-${rand}`;

  try {
    // Write every sidecar into the temp directory.
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(tmpDir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }

    // Stamp the completion marker as the final write inside the temp dir.
    writeFileSync(join(tmpDir, SKILL_COMPLETE_MARKER), completionMarker, "utf-8");


    // Move existing skill dir out of the way so the rename targets a free path.
    if (backupDir) renameSync(skillDir, backupDir);


    // Atomic promotion: temp dir → final skill dir.
    renameSync(tmpDir, skillDir);
    return { completionMarker };
  } catch (err) {
    // Best-effort rollback: restore the backup if we moved it.
    try {
      if (backupDir && existsSync(backupDir) && !existsSync(skillDir)) {
        renameSync(backupDir, skillDir);
      }
    } catch {
      // ignore rollback errors; caller will see original error
    }
    // Clean up temp dir.
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup; swallow to surface original error
    }
    throw err;
  }

  // Clean up the backup on success.
  if (backupDir) {
    try {
      rmSync(backupDir!, { recursive: true, force: true });
    } catch {
      // Non-fatal: the skill is already committed to skillDir.
    }
  }
}

/**
 * Returns `true` when `skillDir` contains the completion marker, indicating
 * that the directory was written atomically and is not an in-progress write.
 */
export function isSkillDirComplete(skillDir: string): boolean {
  return existsSync(join(skillDir, SKILL_COMPLETE_MARKER));
}

/**
 * Returns `true` when the given path appears to be a temporary or backup
 * artifact created by atomic write operations (e.g., `skill.tmp-1234-abc` or
 * `.skill.bak-5678-def`). These directories should be ignored when listing
 * committed skills unless they contain the completion marker.
 */
export function isAtomicWriteArtifact(pathOrEntry: string): boolean {
  const entry = pathOrEntry.split(/[\\/]/).pop() ?? "";
  return /\.tmp-\d+-[a-f0-9]+$/i.test(entry) || /^\..+\.bak-\d+-[a-f0-9]+$/i.test(entry);
}