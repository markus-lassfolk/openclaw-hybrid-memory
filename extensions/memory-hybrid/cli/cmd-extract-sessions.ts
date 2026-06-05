/**
 * Session file helpers for extract CLI (split from cmd-extract.ts).
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { capturePluginError } from "../services/error-reporter.js";

/** Session JSONL basenames eligible for procedure/directive extraction scans. */
export function isSessionTranscriptCandidate(name: string): boolean {
  return (
    name.endsWith(".jsonl") &&
    !name.startsWith(".deleted") &&
    !name.includes(".checkpoint.") &&
    !name.includes(".trajectory.")
  );
}

/**
 * Resolve a session transcript path after OpenClaw rollover/archival moves the file.
 * Falls back to `sessionDir/archive/<basename>` when the original path is missing.
 */
export function resolveSessionTranscriptPath(sessionDir: string, filePath: string): string {
  if (existsSync(filePath)) {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }
  const base = basename(filePath);
  const direct = join(sessionDir, base);
  if (existsSync(direct)) return direct;
  const archived = join(sessionDir, "archive", base);
  if (existsSync(archived)) return archived;
  return filePath;
}

/**
 * Returns session .jsonl file paths modified within the last `days` days,
 * or — when `sinceTimestamp` is provided — modified strictly after that epoch-ms.
 * Shared by procedure/directive/reinforcement extraction.
 */
export function getSessionFilePathsSince(sessionDir: string, days: number, sinceTimestamp?: number): string[] {
  if (!existsSync(sessionDir)) return [];
  const cutoff = sinceTimestamp !== undefined ? sinceTimestamp : Date.now() - days * 24 * 60 * 60 * 1000;

  const collectFromDir = (dir: string, propagateErrors = false): string[] => {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => isSessionTranscriptCandidate(f))
        .map((f) => join(dir, f))
        .filter((p) => {
          try {
            return statSync(p).mtimeMs > cutoff;
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "stat-check",
              severity: "info",
              subsystem: "cli",
            });
            return false;
          }
        });
    } catch (err) {
      if (propagateErrors) throw err;
      return [];
    }
  };

  try {
    return [
      ...collectFromDir(sessionDir, true),
      ...collectFromDir(join(sessionDir, "archive"), false),
    ];
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "getSessionFilePathsSince",
    });
    console.warn(
      "[memory-hybrid] getSessionFilePathsSince: could not list session directory",
      sessionDir,
      (err as Error)?.message ?? String(err),
    );
    return [];
  }
}

/**
 * Returns the maximum mtime (in epoch-ms) of the given file paths, or undefined if none exist.
 * Used to track the newest session timestamp for scan cursors.
 */
export function getMaxMtime(filePaths: string[]): number | undefined {
  let maxMtime: number | undefined;
  for (const p of filePaths) {
    try {
      const mtime = statSync(p).mtimeMs;
      if (maxMtime === undefined || mtime > maxMtime) {
        maxMtime = mtime;
      }
    } catch {
      // Ignore files that can't be stat'd
    }
  }
  return maxMtime;
}
