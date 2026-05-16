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
 *                            temp directory to a new final location (multi-file).
 *  • `isSkillDirComplete` – returns true only when the marker is present.
 *
 * The marker name is exported so loaders can skip in-progress directories.
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, posix, win32 } from "node:path";

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
 * `skillDir` must not already exist. Replacing a non-empty directory cannot be
 * made crash-atomic with only rename operations: moving the committed directory
 * aside can make the skill disappear if the process crashes before promotion.
 * Callers should choose a fresh slug or remove known-safe temp artifacts before
 * calling this helper.
 *
 * Each key in `files` must be a safe relative path contained by the temporary
 * skill directory. Pass files in the order you want them written. Convention:
 * put `SKILL.md` last so it is the final content file before the marker.
 */
export function atomicWriteSkillDir(skillDir: string, files: Record<string, string>): { completionMarker: string } {
  const rand = randomBytes(8).toString("hex");
  const tmpDir = `${skillDir}.tmp-${process.pid}-${rand}`;
  const completionMarker = `${new Date().toISOString()}\nwriteId=${process.pid}-${rand}`;

  try {
    if (existsSync(skillDir)) {
      throw new Error(`Refusing to overwrite existing skill directory: ${skillDir}`);
    }

    // Write every sidecar into the temp directory.
    for (const [relPath, content] of Object.entries(files)) {
      assertSafeRelativeSkillPath(relPath);
      const fullPath = join(tmpDir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }

    // Stamp the completion marker as the final write inside the temp dir.
    writeFileSync(join(tmpDir, SKILL_COMPLETE_MARKER), completionMarker, "utf-8");

    // Atomic promotion: temp dir → final skill dir.
    renameSync(tmpDir, skillDir);
    return { completionMarker };
  } catch (err) {
    // Clean up temp dir.
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup; swallow to surface original error
    }
    throw err;
  }
}

function assertSafeRelativeSkillPath(relPath: string): void {
  if (!relPath || relPath.includes("\0")) {
    throw new Error(`Unsafe skill file path: ${relPath}`);
  }
  if (relPath === SKILL_COMPLETE_MARKER || posix.isAbsolute(relPath) || win32.isAbsolute(relPath)) {
    throw new Error(`Unsafe skill file path: ${relPath}`);
  }

  const normalized = posix.normalize(relPath.replace(/\\/g, "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === SKILL_COMPLETE_MARKER
  ) {
    throw new Error(`Unsafe skill file path: ${relPath}`);
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
