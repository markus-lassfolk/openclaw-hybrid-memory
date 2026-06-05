import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Resolve orchestrator summary.json for an HM_EXIT ledger file.
 * Summaries live in `YYYYMMDD/` day subdirs; legacy layouts may be siblings of exit.
 */
export function resolveMaintenanceSummaryPath(exitPath: string): string | null {
  const sibling = exitPath.replace(/\.exit\.txt$/, ".summary.json");
  if (existsSync(sibling)) return sibling;

  const stem = basename(exitPath, ".exit.txt");
  const dayMatch = stem.match(/-(\d{8})T\d{6}Z-\d+$/);
  if (!dayMatch) return null;

  const dayDirSummary = join(dirname(exitPath), dayMatch[1], `${stem}.summary.json`);
  if (existsSync(dayDirSummary)) return dayDirSummary;

  return null;
}

/** Resolve HM_EXIT path for an orchestrator summary.json (day-dir or sibling layout). */
export function resolveMaintenanceExitPathForSummary(summaryPath: string): string | null {
  const stem = basename(summaryPath, ".summary.json");
  const parent = dirname(summaryPath);
  const dayDirMatch = basename(parent).match(/^\d{8}$/);
  if (dayDirMatch) {
    return join(dirname(parent), `${stem}.exit.txt`);
  }
  return join(parent, `${stem}.exit.txt`);
}

/** Candidate summary paths (existing first) for diagnostics. */
export function listMaintenanceSummaryCandidates(exitPath: string): string[] {
  const sibling = exitPath.replace(/\.exit\.txt$/, ".summary.json");
  const stem = basename(exitPath, ".exit.txt");
  const dayMatch = stem.match(/-(\d{8})T\d{6}Z-\d+$/);
  const candidates = [sibling];
  if (dayMatch) {
    candidates.push(join(dirname(exitPath), dayMatch[1], `${stem}.summary.json`));
  }
  return candidates;
}
