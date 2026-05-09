/**
 * Cron maintenance reconciler: repairs false-OK run ledger entries by validating
 * maintenance execution artifacts (HM_EXIT, HM_LOG) and updating cron run status.
 *
 * Issue: Maintenance cron runs can be recorded as status:"ok" even when validation
 * shows missing required steps or failures.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ExitValidationResult, validateMaintenanceExecution } from "./cron-exit-validator.js";

export interface CronRunLedgerEntry {
  ts: number;
  jobId: string;
  action: "started" | "finished";
  status?: "ok" | "error";
  summary?: string;
  [key: string]: unknown;
}

export interface ReconciliationResult {
  /** Total runs examined */
  examined: number;
  /** Runs that were false-OK (status:ok but validation failed) */
  falseOk: number;
  /** Runs that were corrected */
  corrected: number;
  /** Details of corrected runs */
  corrections: CronRunCorrection[];
}

export interface CronRunCorrection {
  jobId: string;
  timestamp: number;
  originalStatus: string;
  newStatus: string;
  validationResult: ExitValidationResult;
  ledgerPath: string;
}

/**
 * Parse a JSONL ledger file and return all entries.
 */
export function parseCronRunLedger(ledgerPath: string): CronRunLedgerEntry[] {
  if (!existsSync(ledgerPath)) {
    return [];
  }

  try {
    const content = readFileSync(ledgerPath, "utf-8");
    const out: CronRunLedgerEntry[] = [];
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as CronRunLedgerEntry);
      } catch {
        // Skip malformed lines; keep the rest of the ledger usable.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Write ledger entries back to a JSONL file.
 */
export function writeCronRunLedger(ledgerPath: string, entries: CronRunLedgerEntry[]): void {
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(ledgerPath, content, "utf-8");
}

/** Ledger "finished" ts is often near run end; run-id time is start — allow long jobs and small clock skew. */
const LEDGER_FINISH_SKEW_BEFORE_START_MS = 120_000;
const MAX_MAINTENANCE_RUN_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Parse run ID timestamp (format: YYYYMMDDTHHMMSSz) to milliseconds since epoch.
 */
function parseRunIdTimestamp(runIdPrefix: string): number {
  const match = runIdPrefix.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return 0;

  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );
}

/**
 * Pick the maintenance artifact pair most likely tied to a finished ledger row.
 * Prefer the latest run start that still plausibly completed by ledgerFinishTs.
 */
function pickMaintenanceArtifactForFinishedEntry(
  artifacts: Array<{ exitPath: string; logPath: string; runId: string }>,
  ledgerFinishTs: number,
): { exitPath: string; logPath: string; runId: string } | undefined {
  const scored = artifacts
    .map((a) => {
      const runIdMatch = a.runId.match(/^(\d{8}T\d{6}Z)/);
      if (!runIdMatch) return null;
      const runTs = parseRunIdTimestamp(runIdMatch[1]);
      const delta = ledgerFinishTs - runTs;
      if (delta < -LEDGER_FINISH_SKEW_BEFORE_START_MS || delta > MAX_MAINTENANCE_RUN_DURATION_MS) {
        return null;
      }
      return { ...a, runTs };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (scored.length === 0) return undefined;

  scored.sort((a, b) => b.runTs - a.runTs);
  const best = scored[0];
  return { exitPath: best.exitPath, logPath: best.logPath, runId: best.runId };
}

/**
 * Extract log paths from a cron run ledger entry's summary text.
 * Looks for patterns like: HM_EXIT: /path/to/file.exit.txt
 */
export function extractArtifactPathsFromSummary(summary: string): {
  exitPath?: string;
  logPath?: string;
} {
  const exitMatch = summary.match(/(?:HM_EXIT|exitPath|exit.?path):\s*([^\s,;]+\.exit\.txt)/i);
  const logMatch = summary.match(/(?:HM_LOG|logPath|log.?path):\s*([^\s,;]+\.log)/i);

  return {
    exitPath: exitMatch?.[1],
    logPath: logMatch?.[1],
  };
}

/**
 * Find maintenance artifact files (*.exit.txt, *.log) in a directory.
 * Returns pairs of (exitPath, logPath) for each run ID.
 */
export function findMaintenanceArtifacts(
  logDir: string,
  jobSlug?: string,
): Array<{ exitPath: string; logPath: string; runId: string }> {
  if (!existsSync(logDir)) {
    return [];
  }

  try {
    const files = readdirSync(logDir);
    const exitFiles = files.filter((f) => f.endsWith(".exit.txt"));

    const artifacts: Array<{ exitPath: string; logPath: string; runId: string }> = [];

    for (const exitFile of exitFiles) {
      // exitFile format: {jobSlug}-{runId}.exit.txt
      // logFile format: {jobSlug}-{runId}.log
      const match = exitFile.match(/^(.+)-(\d{8}T\d{6}Z-\d+)\.exit\.txt$/);
      if (!match) continue;

      const [, slug, runId] = match;
      if (jobSlug && slug !== jobSlug) continue;

      const logFile = `${slug}-${runId}.log`;
      const exitPath = join(logDir, exitFile);
      const logPath = join(logDir, logFile);

      // Only include if log file exists too
      if (existsSync(logPath)) {
        artifacts.push({ exitPath, logPath, runId });
      }
    }

    return artifacts;
  } catch {
    return [];
  }
}

/**
 * Reconcile a single cron run ledger file by validating maintenance artifacts
 * and correcting false-OK entries.
 *
 * @param ledgerPath - Path to cron run ledger (*.jsonl)
 * @param logDir - Directory containing HM_EXIT and HM_LOG files
 * @param requiredSteps - Required maintenance steps (job-specific)
 * @param dryRun - If true, don't modify the ledger file
 * @returns Reconciliation result with corrections made
 */
export function reconcileCronRunLedger(
  ledgerPath: string,
  logDir: string,
  requiredSteps: string[],
  dryRun = false,
): ReconciliationResult {
  const result: ReconciliationResult = {
    examined: 0,
    falseOk: 0,
    corrected: 0,
    corrections: [],
  };

  // Parse existing ledger
  const entries = parseCronRunLedger(ledgerPath);
  let modified = false;

  for (const entry of entries) {
    // Only check "finished" entries with status "ok"
    if (entry.action !== "finished" || entry.status !== "ok") {
      continue;
    }

    result.examined++;

    // Try to find artifact paths from summary
    const paths = entry.summary ? extractArtifactPathsFromSummary(entry.summary) : {};

    let exitPath = paths.exitPath;
    let logPath = paths.logPath;

    // If paths not found in summary, try to find matching artifacts by job ID and timestamp
    if (!exitPath || !logPath || !existsSync(exitPath)) {
      // Look for artifacts that match this job and timestamp
      const jobSlug = entry.jobId.replace(/^hybrid-mem:/, "");
      const artifacts = findMaintenanceArtifacts(logDir, jobSlug);

      const closestArtifact = pickMaintenanceArtifactForFinishedEntry(artifacts, entry.ts);

      if (closestArtifact) {
        exitPath = closestArtifact.exitPath;
        logPath = closestArtifact.logPath;
      }
    }

    // Skip if we can't find artifacts
    if (!exitPath || !logPath || !existsSync(exitPath)) {
      continue;
    }

    // Validate the maintenance execution
    const validation = validateMaintenanceExecution(exitPath, logPath, requiredSteps, true);

    // Check if this is a false-OK (status:ok but validation failed/partial)
    if (validation.maintenanceStatus === "failed" || validation.maintenanceStatus === "partial") {
      result.falseOk++;

      // Correct the entry
      if (!dryRun) {
        entry.status = "error";
        // Optionally append reconciliation note to summary
        if (entry.summary) {
          entry.summary += `\n\n[RECONCILED] Maintenance validation: ${validation.maintenanceStatus}. ${validation.error || ""}`;
        }
        modified = true;
        result.corrected++;
      }

      result.corrections.push({
        jobId: entry.jobId,
        timestamp: entry.ts,
        originalStatus: "ok",
        newStatus: "error",
        validationResult: validation,
        ledgerPath,
      });
    }
  }

  // Write back if modified
  if (modified && !dryRun) {
    writeCronRunLedger(ledgerPath, entries);
  }

  return result;
}

/**
 * Reconcile all cron run ledgers in a directory.
 *
 * @param cronRunsDir - Directory containing *.jsonl ledger files (e.g., ~/.openclaw/cron/runs)
 * @param logDir - Directory containing HM_EXIT and HM_LOG files (e.g., ~/.openclaw/logs/cron-hybrid-mem)
 * @param jobStepMap - Map of jobId to required steps (e.g., {"hybrid-mem:nightly-distill": ["prune", "distill"]})
 * @param dryRun - If true, don't modify any files
 * @returns Combined reconciliation results
 */
export function reconcileAllCronRunLedgers(
  cronRunsDir: string,
  logDir: string,
  jobStepMap: Record<string, string[]>,
  dryRun = false,
): ReconciliationResult {
  const combinedResult: ReconciliationResult = {
    examined: 0,
    falseOk: 0,
    corrected: 0,
    corrections: [],
  };

  if (!existsSync(cronRunsDir)) {
    return combinedResult;
  }

  try {
    const files = readdirSync(cronRunsDir).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      // Extract job ID from filename (e.g., "hybrid-mem:nightly-distill.jsonl")
      const jobId = basename(file, ".jsonl");
      const requiredSteps = jobStepMap[jobId];

      // Skip if we don't have required steps for this job
      if (!requiredSteps || requiredSteps.length === 0) {
        continue;
      }

      const ledgerPath = join(cronRunsDir, file);
      const result = reconcileCronRunLedger(ledgerPath, logDir, requiredSteps, dryRun);

      // Merge results
      combinedResult.examined += result.examined;
      combinedResult.falseOk += result.falseOk;
      combinedResult.corrected += result.corrected;
      combinedResult.corrections.push(...result.corrections);
    }

    return combinedResult;
  } catch {
    return combinedResult;
  }
}
