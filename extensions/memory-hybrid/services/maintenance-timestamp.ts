import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capturePluginError } from "./error-reporter.js";

/**
 * Record a maintenance command run timestamp next to the SQLite DB (same directory as `.distill_last_run`).
 */
export function recordMaintenanceTimestamp(resolvedSqlitePath: string, filename: string): void {
  const memoryDir = dirname(resolvedSqlitePath);
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, filename);
  const ts = new Date().toISOString();
  try {
    writeFileSync(path, `${ts}\n`, "utf-8");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "recordMaintenanceTimestamp",
      severity: "info",
    });
  }
}
