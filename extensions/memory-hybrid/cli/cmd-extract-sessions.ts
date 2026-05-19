/**
 * Session file helpers for extract CLI (split from cmd-extract.ts).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { capturePluginError } from "../services/error-reporter.js";

/**
 * Returns session .jsonl file paths modified within the last `days` days,
 * or — when `sinceTimestamp` is provided — modified strictly after that epoch-ms.
 * Shared by procedure/directive/reinforcement extraction.
 */
export function getSessionFilePathsSince(sessionDir: string, days: number, sinceTimestamp?: number): string[] {
  if (!existsSync(sessionDir)) return [];
  const cutoff = sinceTimestamp !== undefined ? sinceTimestamp : Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(sessionDir);
    return files
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith(".deleted"))
      .map((f) => join(sessionDir, f))
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
