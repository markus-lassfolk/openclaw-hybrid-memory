import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { extractAuditHealthJsonFromLog } from "./audit-health-json.js";
import { normalizeExitStepName } from "./cron-exit-validator.js";
import { resolveMaintenanceExitPathForSummary } from "./maintenance-artifact-paths.js";
import { parseSemanticTokenFromSummary, semanticOutcomeBlocksOrchestratorGuard } from "./maintenance-job-run/index.js";
import { capturePluginError } from "./error-reporter.js";
import { nowIso, formatTimestampUtc, formatTimestampUtcFromMs } from "../utils/dates.js";
import {
  collectMaintenanceNoiseWarnings,
  isBenignNoiseOnlyMaintenanceStep,
  sanitizeMaintenanceLogText,
  type MaintenanceNoiseWarning,
} from "./maintenance-benign-noise.js";

export type MaintenanceClassification =
  | "env-misconfig"
  | "transient-llm"
  | "transient-network"
  | "provider-auth"
  | "infra"
  | "plugin-bug"
  | "command-crash"
  | "json-parse-failure"
  | "health-warnings"
  | "health-errors"
  | "smoke-only"
  | "orchestration-bug"
  | "unclassified";

export type MaintenanceAction =
  | "retry-once"
  | "escalate-user"
  | "escalate-user-urgent"
  | "glitchtip+digest"
  | "informational"
  | "user-digest";

export interface MaintenanceRule {
  id: string;
  pattern: string;
  classification: MaintenanceClassification;
  defaultAction: MaintenanceAction;
  severity: "critical" | "high" | "medium" | "low" | "info";
  suggestedAction: string;
}

export interface MaintenanceLogStep {
  occurredAt: number;
  iso: string;
  job: string;
  step: string;
  exitCode: number;
  exitPath: string;
  logPath: string;
  logContent: string;
  line: string;
}

export interface MaintenanceFinding {
  id: string;
  occurredAt: number;
  job: string;
  step: string;
  exitCode: number;
  classification: MaintenanceClassification;
  ruleId: string;
  fingerprint: string;
  logExcerpt: string;
  logPath: string;
  pluginVersion: string | null;
  actionTaken:
    | MaintenanceAction
    | "reported"
    | "reported-glitchtip"
    | "auto-fixed-clear-stale-lock"
    | "auto-fixed-retry-once"
    | "auto-fixed-vacuum-on-busy"
    | "auto-fixed-reembed-vectorless";
  suggestedAction: string;
  severity: MaintenanceRule["severity"];
  glitchtipEventId?: string;
  status?: "new" | "still-failing";
  occurrenceCount?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
}

export interface MaintenanceAnalysisReport {
  schemaVersion: 1;
  generatedAt: string;
  root?: string;
  since: string;
  totalSteps: number;
  successfulSteps: number;
  findings: MaintenanceFinding[];
  /** Known benign compatibility/config warnings suppressed from primary failure counts (#1833). */
  noiseWarnings: MaintenanceNoiseWarning[];
  summary: {
    jobsOk: number;
    jobsWithFindings: number;
    newFindings: number;
    stillFailing: number;
    historicalStaleSuppressed: number;
    benignNoiseSuppressed: number;
    byClassification: Record<string, number>;
    byAction: Record<string, number>;
    weekOverWeek?: Array<{ classification: string; currentWeek: number; previousWeek: number; delta: number }>;
  };
  findingsPath?: string;
  digestMd: string;
}

function resolveMaintenanceRulesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "maintenance-rules.json"),
    // Built dist/services/*.js is emitted without JSON assets, but the published package includes source services/.
    join(here, "..", "..", "services", "maintenance-rules.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

type MaintenanceResolvedEntry = { resolvedInVersion: string; note?: string };
type PersistedMaintenanceFindingLedgerEntry = {
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  glitchtipReported: boolean;
};

function resolveMaintenanceResolvedPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "maintenance-resolved.json"),
    // Packaged dist/services/*.js omits JSON; published tarball still ships services/*.json.
    join(here, "..", "..", "services", "maintenance-resolved.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function loadMaintenanceResolvedMap(): Record<string, MaintenanceResolvedEntry> {
  try {
    const p = resolveMaintenanceResolvedPath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { fingerprints?: Record<string, MaintenanceResolvedEntry> };
    return raw.fingerprints ?? {};
  } catch {
    return {};
  }
}

/** @internal Compare YYYY.M.N or semver-like dotted versions for resolved-issue suppression (#1199). */
export function pluginVersionGte(current: string | null, minimum: string): boolean {
  if (!current) return false;
  const pa = current.split(/[.+]/).map((s) => Number.parseInt(s, 10));
  const pb = minimum.split(/[.+]/).map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const a = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const b = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function filterResolvedMaintenanceFindings(
  findings: MaintenanceFinding[],
  resolved: Record<string, MaintenanceResolvedEntry>,
): MaintenanceFinding[] {
  return findings.filter((f) => {
    const entry = resolved[f.fingerprint];
    if (!entry) return true;
    return !pluginVersionGte(f.pluginVersion, entry.resolvedInVersion);
  });
}

function loadMaintenanceRules(): MaintenanceRule[] {
  return JSON.parse(readFileSync(resolveMaintenanceRulesPath(), "utf-8")) as MaintenanceRule[];
}

const RULES = loadMaintenanceRules();
const STRICT_CLASSES = new Set<MaintenanceClassification>([
  "plugin-bug",
  "command-crash",
  "json-parse-failure",
  "orchestration-bug",
  "provider-auth",
  "env-misconfig",
]);
const GLITCHTIP_CLASSES = new Set<MaintenanceClassification>([
  "plugin-bug",
  "command-crash",
  "json-parse-failure",
  "orchestration-bug",
]);

export function maintenanceRules(): MaintenanceRule[] {
  return RULES.slice();
}

export function parseMaintenanceSinceMs(value = "24h"): number {
  const m = value.trim().match(/^(\d+)([mhdw])?$/i);
  if (!m) return 24 * 3600 * 1000;
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? "h").toLowerCase();
  if (unit === "m") return n * 60 * 1000;
  if (unit === "d") return n * 24 * 3600 * 1000;
  if (unit === "w") return n * 7 * 24 * 3600 * 1000;
  return n * 3600 * 1000;
}

export interface CollectMaintenanceStepsOptions {
  /** Flag logs with no mtime/progress updates beyond this duration as stale orchestration anomalies. */
  staleThresholdMs?: number;
}

function extractJobName(file: string): string {
  const withoutExitSuffix = file.replace(/\.exit\.txt$/, "");
  return withoutExitSuffix
    .replace(/-\d{8}T\d{6}Z-\d+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, "")
    .replace(/-\d{8}\.cron$/, "")
    .replace(/-\d{8}T.*$/, "");
}

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function safeStatMtimeMs(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * Subdirectory names that hold auxiliary/helper logs and should not be scanned for
 * missing-exit-ledger anomalies (issue #1685).
 */
const AUXILIARY_DIR_NAMES = new Set(["manual-qa", "tmp", "archive"]);

/**
 * Returns true if filePath is under a known auxiliary subdirectory or a hidden directory
 * (name starts with '.'), relative to root.  Used to skip non-maintenance artifacts.
 */
export function isUnderAuxiliaryDir(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  const segments = rel.split(sep);
  const dirSegments = segments.slice(0, -1);
  return dirSegments.some((seg) => seg.length > 0 && (AUXILIARY_DIR_NAMES.has(seg) || seg.startsWith(".")));
}

/**
 * Canonical maintenance wrapper log names follow one of three patterns:
 *   1. `<jobname>-YYYYMMDDTHHMMSSZ-<pid>.log`  (e.g. `nightly-memory-sweep-20260511T030000Z-555.log`)
 *   2. `<jobname>-YYYY-MM-DDTHH-MM-SS-mmmZ.log` — ISO datetime with colons/dots replaced by dashes,
 *      produced by `runPendingDigestAutopilotCron` (e.g. `weekly-pending-digest-autopilot-2026-05-13T08-20-00-000Z.log`)
 *   3. Files ending with `.cron.log`.
 *
 * Files like `stdout.log`, `stderr.log`, or arbitrary helper logs do NOT match and
 * should not be reported as missing-exit-ledger failures (issue #1685).
 */
/** Compact timestamp with PID: `<job>-YYYYMMDDTHHMMSSz-<pid>.log` */
const CANONICAL_MAINTENANCE_LOG_RE = /-\d{8}T\d{6}Z-\d+\.log$/;
/** ISO-with-dashes timestamp (no PID): `<job>-YYYY-MM-DDTHH-MM-SS-mmmZ.log` (runPendingDigestAutopilotCron) */
const CANONICAL_MAINTENANCE_LOG_ISO_RE = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/;

export function isCanonicalMaintenanceLog(filePath: string): boolean {
  const file = basename(filePath);
  return (
    CANONICAL_MAINTENANCE_LOG_RE.test(file) || CANONICAL_MAINTENANCE_LOG_ISO_RE.test(file) || file.endsWith(".cron.log")
  );
}

function collectFilesRecursive(root: string, suffix: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (entry.endsWith(suffix)) out.push(p);
    }
  }
  return out.sort();
}

function extractJobFromPath(path: string, suffix: string): string {
  const file = basename(path);
  if (file.endsWith(suffix)) return extractJobName(file.replace(/\.log$/, ".exit.txt"));
  return extractJobName(file);
}

// The `maintenance-orchestrator: <step> — start|still running after Ns|complete` alternative matches
// the generic per-step heartbeat the orchestrator emits for every step (#2026), so a live CPU/LLM-bound
// step is recognized as progressing rather than mislabeled as a stale/hung empty-exit run.
const DREAM_CYCLE_PROGRESS_MARKER_RE =
  /(?:\[dream-cycle\].*(?:start|still running after|complete)|memory-hybrid:\s*(?:dream-cycle|reflect-meta(?:-collapse)?|build-languages|backfill-decay|reembed-vectorless|enrich-entities)\s*[—-].*(?:start|still running after|complete|episodic consolidation progress)|maintenance-orchestrator:\s*\S+\s*[—-]\s*(?:start|still running after \d+s|complete)|Dream cycle complete:|Extract-implicit:|Closed-loop analysis:|Cross-agent learning:|Tool effectiveness:|Cost log:)/im;
const DREAM_CYCLE_STILL_RUNNING_RE =
  /(?:\[dream-cycle\].*still running after \d+s|memory-hybrid:\s*(?:dream-cycle|reflect-meta(?:-collapse)?|build-languages|backfill-decay|reembed-vectorless|enrich-entities)\s*[—-].*still running after \d+s|maintenance-orchestrator:\s*\S+\s*[—-]\s*still running after \d+s)/im;

function logHasDreamCycleProgress(logContent: string): boolean {
  if (!logContent) return false;
  return DREAM_CYCLE_PROGRESS_MARKER_RE.test(logContent);
}

function logHasValidateMarker(logContent: string): boolean {
  if (!logContent) return false;
  return /(?:--- validate-cron-exit ---|Maintenance Validation|"maintenanceStatus")/im.test(logContent);
}

function buildOrchestrationSyntheticStep(params: {
  job: string;
  exitPath: string;
  logPath: string;
  logContent: string;
  nowMs: number;
  staleThresholdMs: number;
  latestActivityMs: number;
  kind: "empty-exit" | "missing-exit-ledger";
}): MaintenanceLogStep {
  const { job, exitPath, logPath, logContent, nowMs, staleThresholdMs, latestActivityMs, kind } = params;
  const staleMs = Math.max(0, nowMs - latestActivityMs);
  const stale = staleMs > staleThresholdMs;
  const staleSec = Math.floor(staleMs / 1000);
  const hasProgress = logHasDreamCycleProgress(logContent);
  const hasValidate = logHasValidateMarker(logContent);
  const hasStillRunningHeartbeat = DREAM_CYCLE_STILL_RUNNING_RE.test(logContent);

  let step = "orchestration-empty-exit";
  let line = "orchestration anomaly: exit ledger exists but has no parseable step rows";
  if (kind === "missing-exit-ledger") {
    step = "orchestration-missing-exit-ledger";
    line = "orchestration anomaly: log exists but matching .exit.txt ledger is missing";
  } else if (stale && hasStillRunningHeartbeat) {
    step = "orchestration-stale-running";
    line = `orchestration anomaly: stale live run heartbeat with no completed ledger row (no progress for ${staleSec}s)`;
  } else if (stale) {
    step = "orchestration-stale-empty-exit";
    line = `orchestration anomaly: empty exit ledger appears stale (no mtime/progress updates for ${staleSec}s)`;
  } else if (hasProgress) {
    step = "orchestration-empty-exit-after-progress";
    line = "orchestration anomaly: log shows dream-cycle progress/completions but exit ledger is empty";
  }

  const markerBits: string[] = [];
  markerBits.push(`validate-marker=${hasValidate ? "present" : "missing"}`);
  markerBits.push(`progress-marker=${hasProgress ? "present" : "missing"}`);
  if (kind === "empty-exit") markerBits.push(`stale=${stale ? "yes" : "no"}`);

  const iso = formatTimestampUtcFromMs(latestActivityMs || nowMs);
  return {
    occurredAt: Math.floor((latestActivityMs || nowMs) / 1000),
    iso,
    job,
    step,
    exitCode: 1,
    exitPath,
    logPath,
    logContent,
    line: `${line}; ${markerBits.join("; ")}`,
  };
}

/**
 * A single run recorded in an aggregate `<job>.cron.log` via an `HM_RUN_SUMMARY` line (#2025).
 * Aggregate cron logs accumulate one summary line per run, each referencing that run's own
 * per-run `.exit.txt` ledger — the aggregate file itself has no sibling `.exit.txt`.
 */
interface CronAggregateRun {
  runId: string;
  status: string;
  job: string | null;
  exitPath: string | null;
  occurredAtMs: number;
}

/** Parse the `YYYYMMDDTHHMMSSZ` prefix of an HM run id into epoch ms (0 if unparseable). */
function parseRunIdTimestampMs(runId: string): number {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!m) return 0;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(ms) ? ms : 0;
}

/** Extract `HM_RUN_SUMMARY` run entries from an aggregate cron log (#2025). */
export function parseCronAggregateRuns(logContent: string): CronAggregateRun[] {
  if (!logContent || !logContent.includes("HM_RUN_SUMMARY")) return [];
  const runs: CronAggregateRun[] = [];
  for (const line of logContent.split("\n")) {
    if (!line.includes("HM_RUN_SUMMARY")) continue;
    const get = (k: string): string | null => {
      const m = line.match(new RegExp(`\\b${k}=(\\S+)`));
      return m ? m[1] : null;
    };
    const runId = get("run_id");
    if (!runId) continue;
    runs.push({
      runId,
      status: (get("status") ?? "").toUpperCase(),
      job: get("job"),
      exitPath: get("exit"),
      occurredAtMs: parseRunIdTimestampMs(runId),
    });
  }
  return runs;
}

/**
 * For an aggregate `<job>.cron.log`, validate each in-window run's referenced `.exit.txt` ledger (#2025).
 * Returns `null` when the aggregate is healthy (every in-window run has a resolvable exit ledger, or no
 * run references a missing one) so the caller suppresses the spurious missing-exit-ledger anomaly.
 * Otherwise returns the most-recent run whose referenced ledger is genuinely missing, so the finding is
 * pegged to that exact run id/timestamp rather than the aggregate file's current mtime.
 */
function findCronAggregateMissingLedgerRun(
  logPath: string,
  logContent: string,
  cutoff: number,
): CronAggregateRun | null {
  const runs = parseCronAggregateRuns(logContent);
  if (runs.length === 0) return null;
  const resolveExit = (run: CronAggregateRun): string | null => {
    if (!run.exitPath) return null;
    if (existsSync(run.exitPath)) return run.exitPath;
    // Tolerate relocated/copied log bundles: check for the same basename next to the aggregate log.
    const local = join(dirname(logPath), basename(run.exitPath));
    return existsSync(local) ? local : null;
  };
  const missing = runs
    .filter((r) => r.occurredAtMs >= cutoff)
    // Only runs that reference an exit ledger which does NOT exist are genuine anomalies. Runs whose
    // referenced ledger exists are already analyzed via the per-run .exit.txt files; runs without any
    // exit= reference are left to other detectors rather than flagged from the aggregate.
    .filter((r) => r.exitPath != null && resolveExit(r) === null);
  if (missing.length === 0) return null;
  return missing.sort((a, b) => a.occurredAtMs - b.occurredAtMs).at(-1) ?? null;
}

export function collectMaintenanceSteps(
  root: string,
  since = "24h",
  nowMs = Date.now(),
  opts: CollectMaintenanceStepsOptions = {},
): MaintenanceLogStep[] {
  if (!existsSync(root)) return [];
  const cutoff = nowMs - parseMaintenanceSinceMs(since);
  const staleThresholdMs = opts.staleThresholdMs && opts.staleThresholdMs > 0 ? opts.staleThresholdMs : 45 * 60 * 1000;
  const steps: MaintenanceLogStep[] = [];
  const exitFiles = collectFilesRecursive(root, ".exit.txt");
  const seenExit = new Set(exitFiles);
  const exitPathsFromSummary = new Set<string>();

  const summaryFiles = collectFilesRecursive(root, ".summary.json");
  for (const summaryPath of summaryFiles) {
    if (summaryPath.includes("/job-runs/")) continue;
    try {
      const summary = JSON.parse(safeRead(summaryPath)) as {
        runId?: string;
        tierLabel?: string;
        finishedAt?: string;
        exitCode?: number;
        steps?: Array<{ name: string; status: string; summary: string; semanticOutcome?: string }>;
      };
      if (!Array.isArray(summary.steps)) continue;
      const summaryMtime = safeStatMtimeMs(summaryPath);
      const finishedIso = summary.finishedAt ?? new Date(summaryMtime).toISOString();
      const occurredAt = Math.floor(new Date(finishedIso).getTime() / 1000);
      if (!Number.isFinite(occurredAt) || occurredAt * 1000 < cutoff) continue;
      const job = extractJobFromPath(summaryPath, ".summary.json");
      // Orchestrator summaries live under DAY_DIR while HM_LOG/HM_EXIT stay at log root.
      const dayDirMatch = summaryPath.match(/^(.+)\/(\d{8})\/([^/]+)\.summary\.json$/);
      const logPath = dayDirMatch
        ? `${dayDirMatch[1]}/${dayDirMatch[3]}.log`
        : summaryPath.replace(/\.summary\.json$/, ".log");
      const siblingExitPath = dayDirMatch
        ? `${dayDirMatch[1]}/${dayDirMatch[3]}.exit.txt`
        : summaryPath.replace(/\.summary\.json$/, ".exit.txt");
      const resolvedExitPath = resolveMaintenanceExitPathForSummary(summaryPath);
      exitPathsFromSummary.add(siblingExitPath);
      if (resolvedExitPath) exitPathsFromSummary.add(resolvedExitPath);
      const exitPath = existsSync(siblingExitPath) ? siblingExitPath : (resolvedExitPath ?? siblingExitPath);
      const logContent = safeRead(logPath);
      for (const step of summary.steps) {
        if (step.status === "skipped_guard" || step.status === "skipped_gate" || step.status === "skipped_dep") {
          continue;
        }
        const summarySemantic = parseSemanticTokenFromSummary(String(step.summary ?? ""));
        const semanticBlocksGuard = semanticOutcomeBlocksOrchestratorGuard(step.semanticOutcome ?? summarySemantic);
        const exitCode =
          step.status === "failed" || step.status === "rate_limited" || semanticBlocksGuard
            ? 1
            : step.status === "deferred"
              ? 2
              : 0;
        steps.push({
          occurredAt,
          iso: finishedIso,
          job,
          step: step.name,
          exitCode,
          exitPath,
          logPath,
          logContent,
          line: `summary.json ${step.name} status=${step.status} ${step.summary}`,
        });
      }
    } catch {
      /* skip malformed summary */
    }
  }

  for (const exitPath of exitFiles) {
    if (exitPathsFromSummary.has(exitPath)) continue;
    const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
    const exitMtime = safeStatMtimeMs(exitPath);
    const logMtime = safeStatMtimeMs(logPath);
    const latestActivityMs = Math.max(exitMtime, logMtime);
    if (latestActivityMs < cutoff) continue;

    const logContent = safeRead(logPath);
    const job = extractJobFromPath(exitPath, ".exit.txt");
    const exitLines = safeRead(exitPath).split("\n");
    let parsedRows = 0;
    let sawParseableRow = false;

    for (const line of exitLines) {
      const m = line.match(/^(\S+)\s+(\S+)\s+exit=(-?\d+)\b/);
      if (!m) continue;
      const [, iso, stepRaw, exitRaw] = m;
      const step = normalizeExitStepName(stepRaw);
      const occurredAt = Math.floor(new Date(iso).getTime() / 1000);
      if (!Number.isFinite(occurredAt)) continue;
      sawParseableRow = true;
      // Use the recorded exit timestamp, not the file mtime, so touched/copied historical ledgers
      // do not get re-reported as current failures in later digests.
      if (occurredAt * 1000 < cutoff) continue;
      parsedRows++;
      steps.push({
        occurredAt,
        iso,
        job,
        step,
        exitCode: Number.parseInt(exitRaw, 10),
        exitPath,
        logPath,
        logContent,
        line,
      });
    }

    if (parsedRows === 0 && !sawParseableRow) {
      steps.push(
        buildOrchestrationSyntheticStep({
          job,
          exitPath,
          logPath,
          logContent,
          nowMs,
          staleThresholdMs,
          latestActivityMs: latestActivityMs || nowMs,
          kind: "empty-exit",
        }),
      );
    }
  }

  // Catch orphan logs so analyzer never reports 0/0 OK when recent logs exist but no parseable exit rows.
  // Only consider canonical maintenance wrapper logs; skip auxiliary directories and helper files (issue #1685).
  const logFiles = collectFilesRecursive(root, ".log");
  for (const logPath of logFiles) {
    const logMtime = safeStatMtimeMs(logPath);
    if (logMtime < cutoff) continue;
    // Skip logs under auxiliary dirs (manual-qa, tmp, archive, hidden dirs) and non-canonical filenames.
    // Files like stdout.log, stderr.log, or QA transcripts are not maintenance wrapper artifacts.
    if (isUnderAuxiliaryDir(logPath, root) || !isCanonicalMaintenanceLog(logPath)) continue;
    const exitPath = logPath.replace(/\.log$/, ".exit.txt");
    if (seenExit.has(exitPath) || existsSync(exitPath)) continue;
    const logContent = safeRead(logPath);
    const job = extractJobFromPath(logPath, ".log");
    // Aggregate `<job>.cron.log` files never have a sibling `<job>.cron.exit.txt`; instead each run
    // records an HM_RUN_SUMMARY line pointing at its own per-run `.exit.txt` ledger. Validate those
    // per-run ledgers rather than blindly flagging the aggregate as missing-exit-ledger (#2025).
    if (basename(logPath).endsWith(".cron.log") && logContent.includes("HM_RUN_SUMMARY")) {
      const missingRun = findCronAggregateMissingLedgerRun(logPath, logContent, cutoff);
      if (!missingRun) continue; // Every in-window run has a valid exit ledger — healthy, no anomaly.
      const syntheticStep = buildOrchestrationSyntheticStep({
        job: missingRun.job ?? job,
        exitPath: missingRun.exitPath ?? exitPath,
        logPath,
        logContent,
        nowMs,
        staleThresholdMs,
        // Peg the finding to the specific run's timestamp/id, not the aggregate file's current mtime.
        latestActivityMs: missingRun.occurredAtMs || logMtime,
        kind: "missing-exit-ledger",
      });
      syntheticStep.line += `; run_id=${missingRun.runId}`;
      steps.push(syntheticStep);
      continue;
    }
    steps.push(
      buildOrchestrationSyntheticStep({
        job,
        exitPath,
        logPath,
        logContent,
        nowMs,
        staleThresholdMs,
        latestActivityMs: logMtime,
        kind: "missing-exit-ledger",
      }),
    );
  }

  steps.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
    if (a.job !== b.job) return a.job.localeCompare(b.job);
    return a.step.localeCompare(b.step);
  });
  return steps;
}

export function classifyMaintenanceFailure(input: {
  step?: string;
  exitCode?: number;
  logContent?: string;
  line?: string;
  rules?: MaintenanceRule[];
}): MaintenanceRule {
  const orchestrationRule = classifyOrchestrationAnomaly(input.step, input.line, input.logContent);
  if (orchestrationRule) return orchestrationRule;

  const auditRule = classifyAuditHealthFailure(input.step, input.exitCode, input.logContent);
  if (auditRule) return auditRule;

  const text = sanitizeMaintenanceLogText(
    `${input.step ?? ""}\nexit=${input.exitCode ?? ""}\n${input.line ?? ""}\n${input.logContent ?? ""}`,
  );
  for (const rule of input.rules ?? RULES) {
    if (new RegExp(rule.pattern, "ims").test(text)) return rule;
  }

  if (input.step === "audit-health" && input.exitCode != null && input.exitCode !== 0) {
    return auditHealthCommandCrashRule();
  }

  return {
    id: "unclassified",
    pattern: ".*",
    classification: "unclassified",
    defaultAction: "user-digest",
    severity: "low",
    suggestedAction: "Inspect the raw maintenance log and decide whether this needs a fix or can be deferred.",
  };
}

function classifyOrchestrationAnomaly(
  step: string | undefined,
  line: string | undefined,
  logContent: string | undefined,
): MaintenanceRule | null {
  const stepName = step ?? "";
  if (!/^orchestration-/.test(stepName)) return null;

  const staleHint = /stale=yes|appears stale|still running after/i.test(`${line ?? ""}\n${logContent ?? ""}`);

  if (stepName === "orchestration-missing-exit-ledger") {
    return {
      id: "orchestration-missing-exit-ledger",
      pattern: "",
      classification: "orchestration-bug",
      defaultAction: "glitchtip+digest",
      severity: "high",
      suggestedAction:
        "A maintenance log exists but its matching .exit.txt ledger is missing. Treat as orchestration failure, inspect cron harness/traps, and ensure validate-cron-exit writes status before guard updates.",
    };
  }

  if (stepName === "orchestration-stale-running" || stepName === "orchestration-stale-empty-exit" || staleHint) {
    return {
      id: "orchestration-stale-maintenance-run",
      pattern: "",
      classification: "orchestration-bug",
      defaultAction: "glitchtip+digest",
      severity: "high",
      suggestedAction:
        "Maintenance appears stale with no recent progress updates. Confirm whether a live process still owns the run; if not, treat as hung orchestration, preserve logs, and rerun after fixing cron harness exit/validation handling.",
    };
  }

  if (stepName === "orchestration-empty-exit-after-progress") {
    return {
      id: "orchestration-empty-exit-after-progress",
      pattern: "",
      classification: "orchestration-bug",
      defaultAction: "glitchtip+digest",
      severity: "high",
      suggestedAction:
        "Dream-cycle log shows work completed but HM_EXIT has no parseable rows. Validate trap/ledger writes and missing validate-cron-exit markers; do not treat this run as successful.",
    };
  }

  return {
    id: "orchestration-empty-exit-ledger",
    pattern: "",
    classification: "orchestration-bug",
    defaultAction: "glitchtip+digest",
    severity: "high",
    suggestedAction:
      "Exit ledger exists but is empty or unparsable. This is an orchestration failure; inspect cron harness step recording and validate-cron-exit execution before accepting job success.",
  };
}

function classifyAuditHealthFailure(
  step: string | undefined,
  exitCode: number | undefined,
  logContent: string | undefined,
): MaintenanceRule | null {
  if (!step || step !== "audit-health") return null;
  if (!exitCode || exitCode === 0) return null;
  const content = logContent ?? "";

  const extracted = extractAuditHealthJsonFromLog(content);
  if (extracted.kind === "not_found") return null;
  if (extracted.kind === "parse_error") {
    return {
      id: "audit-health-json-parse-failure",
      pattern: "",
      classification: "json-parse-failure",
      defaultAction: "glitchtip+digest",
      severity: "high",
      suggestedAction:
        "Audit health exited non-zero and a JSON block was present but could not be parsed. Inspect the raw log for mixed stdout/stderr or truncated JSON; rerun with `--json --verbose` and report as a plugin bug if reproducible.",
    };
  }

  const exitReason = typeof extracted.value.exitReason === "string" ? extracted.value.exitReason : "";
  const warningCount = typeof extracted.value.warningCount === "number" ? Math.max(0, extracted.value.warningCount) : 0;
  const errorCount = typeof extracted.value.errorCount === "number" ? Math.max(0, extracted.value.errorCount) : 0;
  const strictFailureReason =
    typeof extracted.value.strictFailureReason === "string" ? extracted.value.strictFailureReason : null;

  if (exitReason === "strict_warnings" || (exitCode === 2 && errorCount === 0 && warningCount > 0)) {
    return {
      id: "audit-health-strict-warnings",
      pattern: "",
      classification: "health-warnings",
      defaultAction: "user-digest",
      severity: "info",
      suggestedAction:
        strictFailureReason ??
        "Audit health strict mode failed due to warnings. Review `warnings[]` and run the suggested remediation commands from the report.",
    };
  }
  if (exitReason === "strict_errors" || (exitCode === 2 && errorCount > 0)) {
    return {
      id: "audit-health-strict-errors",
      pattern: "",
      classification: "health-errors",
      defaultAction: "user-digest",
      severity: "medium",
      suggestedAction:
        strictFailureReason ??
        "Audit health strict mode failed due to report errors. Review `errors[]` in the JSON and rerun the audit to confirm whether this is transient or a persistent health issue.",
    };
  }

  return null;
}

function auditHealthCommandCrashRule(): MaintenanceRule {
  return {
    id: "audit-health-command-crash",
    pattern: "",
    classification: "command-crash",
    defaultAction: "glitchtip+digest",
    severity: "high",
    suggestedAction:
      "Audit health exited non-zero but no report JSON was found in the log and no generic maintenance rule matched. Treat as a command crash: inspect stack traces and rerun `openclaw hybrid-mem audit health --strict --json --verbose`.",
  };
}

function extractPluginVersion(logContent: string): string | null {
  const m = logContent.match(/openclaw(?:-hybrid-memory)?[^\n]*?(\d{4}\.\d+\.\d+|\d+\.\d+\.\d+)/i);
  return m?.[1] ?? null;
}

function excerptFor(logContent: string, line: string): string {
  const failureSignal =
    /error|fail|exception|unauthorized|429|busy|timeout|killed|cannot find module|guard|stopped early|ENOSPC|SQLITE_BUSY|still running after|validate-cron-exit|orchestration anomaly|empty exit ledger/i;
  const benignSignal =
    /\b(no|without|zero)\s+(errors?|failures?)\b|\berrors?\s*[:=]\s*0\b|\bfailures?\s*[:=]\s*0\b|\b0\s+errors?\b|\b0\s+failures?\b|\berrorcount\s*[:=]\s*0\b/gi;
  const hasActionableFailureSignal = (candidate: string): boolean => {
    const sanitized = sanitizeMaintenanceLogText(candidate);
    if (!failureSignal.test(sanitized)) return false;

    // Keep real failures even when the same log line also includes a benign
    // zero-error/zero-failure counter. Suppress only lines whose failure-like
    // text disappears after removing the benign phrases.
    return failureSignal.test(sanitized.replace(benignSignal, " "));
  };
  const sanitizedLog = sanitizeMaintenanceLogText(logContent);
  const sanitizedLine = sanitizeMaintenanceLogText(line);
  const interesting = sanitizedLog.split("\n").filter(hasActionableFailureSignal).slice(-8).join("\n");
  return (interesting || sanitizedLine || sanitizedLog.slice(0, 1000)).slice(0, 1800);
}

function fingerprintFor(step: MaintenanceLogStep, rule: MaintenanceRule): string {
  return createHash("sha256")
    .update(`${rule.classification}\0${rule.id}\0${step.job}\0${step.step}`)
    .digest("hex")
    .slice(0, 16);
}

export function findingFromStep(step: MaintenanceLogStep, rule = classifyMaintenanceFailure(step)): MaintenanceFinding {
  const fingerprint = fingerprintFor(step, rule);
  return {
    id: createHash("sha256")
      .update(`${fingerprint}\0${step.occurredAt}\0${step.exitCode}\0${step.logPath}`)
      .digest("hex"),
    occurredAt: step.occurredAt,
    job: step.job,
    step: step.step,
    exitCode: step.exitCode,
    classification: rule.classification,
    ruleId: rule.id,
    fingerprint,
    logExcerpt: excerptFor(step.logContent, step.line),
    logPath: step.logPath,
    pluginVersion: extractPluginVersion(step.logContent),
    actionTaken: rule.defaultAction,
    suggestedAction: rule.suggestedAction,
    severity: rule.severity,
  };
}

export function analyzeMaintenanceSteps(
  steps: MaintenanceLogStep[],
  opts?: { resolvedFingerprints?: Record<string, MaintenanceResolvedEntry> },
): MaintenanceFinding[] {
  const findings: MaintenanceFinding[] = [];
  const zeroExitHeuristicSeen = new Set<string>();
  for (const step of steps) {
    if (step.exitCode !== 0) {
      if (isBenignNoiseOnlyMaintenanceStep(step)) continue;
      findings.push(findingFromStep(step));
      continue;
    }
    const zeroText = `${step.line}
${step.logContent}`;
    const hasAgentStoppedEarly = /agent stopped early|stopped early/i.test(zeroText);
    const hasGuardAnomaly = /guard not updated|guard.*not.*success|success.*guard.*missing/i.test(zeroText);
    if (!hasAgentStoppedEarly && !hasGuardAnomaly) continue;
    if (hasGuardAnomaly && !/guard/i.test(step.step) && !/guard/i.test(step.line)) continue;
    const key = `${step.logPath}:${hasAgentStoppedEarly ? "agent-stopped-early" : "guard-not-updated"}`;
    if (zeroExitHeuristicSeen.has(key)) continue;
    zeroExitHeuristicSeen.add(key);
    const rule = classifyMaintenanceFailure({
      step: step.step,
      exitCode: step.exitCode,
      line: hasAgentStoppedEarly ? "agent stopped early" : "guard not updated after success",
      logContent: "",
    });
    findings.push(findingFromStep(step, rule));
  }
  const resolved = opts?.resolvedFingerprints ?? loadMaintenanceResolvedMap();
  return filterResolvedMaintenanceFindings(findings, resolved);
}

/** Count persisted rows that look like SQLITE_BUSY / locked DB (for vacuum-on-busy repeat detection, #1199). */
export function countPersistedSqliteBusySince(dbPath: string, sinceSec: number): number {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM maintenance_finding
         WHERE occurred_at >= ?
           AND (
             IFNULL(log_excerpt, '') LIKE '%SQLITE_BUSY%'
             OR LOWER(IFNULL(log_excerpt, '')) LIKE '%database is locked%'
           )`,
      )
      .get(sinceSec) as { c: number };
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

export function persistMaintenanceFindings(dbPath: string, findings: MaintenanceFinding[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_finding (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        job TEXT NOT NULL,
        step TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        classification TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        log_excerpt TEXT,
        log_path TEXT,
        plugin_version TEXT,
        action_taken TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        resolved_at INTEGER,
        resolved_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_occurred ON maintenance_finding(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_class ON maintenance_finding(classification, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_maintenance_finding_fingerprint ON maintenance_finding(fingerprint);
    `);
    try {
      const checkCol = db.prepare(`SELECT occurrence_count FROM maintenance_finding LIMIT 0`);
      checkCol.all();
    } catch {
      db.exec(`ALTER TABLE maintenance_finding ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`);
    }
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO maintenance_finding
       (id, occurred_at, job, step, exit_code, classification, fingerprint, log_excerpt, log_path, plugin_version, action_taken, occurrence_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of findings) {
      stmt.run(
        f.id,
        f.occurredAt,
        f.job,
        f.step,
        f.exitCode,
        f.classification,
        f.fingerprint,
        f.logExcerpt,
        f.logPath,
        f.pluginVersion,
        f.actionTaken,
        f.occurrenceCount ?? 1,
      );
    }
  } finally {
    db.close();
  }
}

function loadPersistedMaintenanceFindingLedger(dbPath: string): Map<string, PersistedMaintenanceFindingLedgerEntry> {
  if (!existsSync(dbPath)) return new Map();
  const db = new DatabaseSync(dbPath);
  try {
    // Ensure occurrence_count column exists before querying it (schema migration for older DBs).
    try {
      const checkCol = db.prepare(`SELECT occurrence_count FROM maintenance_finding LIMIT 0`);
      checkCol.all();
    } catch {
      db.exec(`ALTER TABLE maintenance_finding ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`);
    }
    const rows = db
      .prepare(
        `SELECT fingerprint,
           MIN(occurred_at) AS first_seen_at,
           MAX(occurred_at) AS last_seen_at,
           COUNT(*) AS occurrence_count,
           MAX(CASE WHEN action_taken = 'reported-glitchtip'
                      OR (action_taken = 'reported' AND classification IN ('plugin-bug', 'command-crash', 'json-parse-failure', 'orchestration-bug'))
                THEN 1 ELSE 0 END) AS glitchtip_reported
         FROM maintenance_finding
         GROUP BY fingerprint`,
      )
      .all() as Array<{
      fingerprint: string;
      first_seen_at: number;
      last_seen_at: number;
      occurrence_count: number;
      glitchtip_reported: number;
    }>;
    return new Map(
      rows.map((row) => [
        row.fingerprint,
        {
          firstSeenAt: Number(row.first_seen_at),
          lastSeenAt: Number(row.last_seen_at),
          occurrenceCount: Number(row.occurrence_count),
          glitchtipReported: Number(row.glitchtip_reported) > 0,
        },
      ]),
    );
  } catch {
    // Best-effort history lookup: missing/corrupt local state should not block the analyzer from
    // classifying the current batch, so fall back to an empty ledger.
    return new Map();
  } finally {
    db.close();
  }
}

function actionTakenForSummarizedFinding(
  finding: MaintenanceFinding,
  persisted: PersistedMaintenanceFindingLedgerEntry | undefined,
): MaintenanceFinding["actionTaken"] {
  if (persisted?.glitchtipReported && GLITCHTIP_CLASSES.has(finding.classification)) return "reported";
  return finding.actionTaken;
}

export function summarizeMaintenanceFindings(
  findings: MaintenanceFinding[],
  opts: { dbPath?: string; historicalCutoffSec?: number } = {},
): { findings: MaintenanceFinding[]; historicalStaleSuppressed: number } {
  const ledger =
    typeof opts.dbPath === "string" && opts.dbPath.trim().length > 0
      ? loadPersistedMaintenanceFindingLedger(opts.dbPath)
      : new Map<string, PersistedMaintenanceFindingLedgerEntry>();
  const byFingerprint = new Map<string, MaintenanceFinding[]>();
  for (const finding of findings) {
    const bucket = byFingerprint.get(finding.fingerprint);
    if (bucket) bucket.push(finding);
    else byFingerprint.set(finding.fingerprint, [finding]);
  }

  const summarized: MaintenanceFinding[] = [];
  for (const [fingerprint, bucket] of byFingerprint.entries()) {
    if (bucket.length === 0) continue;
    const sorted = bucket.slice().sort((a, b) => a.occurredAt - b.occurredAt);
    const latest = sorted[sorted.length - 1];
    const earliest = sorted[0];
    if (!latest || !earliest) continue;
    const persisted = ledger.get(fingerprint);
    summarized.push({
      ...latest,
      status: persisted ? "still-failing" : "new",
      occurrenceCount: (persisted?.occurrenceCount ?? 0) + sorted.length,
      firstSeenAt: persisted ? Math.min(persisted.firstSeenAt, earliest.occurredAt) : earliest.occurredAt,
      lastSeenAt: latest.occurredAt,
      actionTaken: actionTakenForSummarizedFinding(latest, persisted),
    });
  }

  const severityRank: Record<MaintenanceRule["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  const statusRank: Record<NonNullable<MaintenanceFinding["status"]>, number> = {
    new: 0,
    "still-failing": 1,
  };
  summarized.sort((a, b) => {
    const statusDelta = statusRank[a.status ?? "new"] - statusRank[b.status ?? "new"];
    if (statusDelta !== 0) return statusDelta;
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.occurredAt - a.occurredAt;
  });

  const currentFingerprints = new Set(byFingerprint.keys());
  const historicalCutoffSec = opts.historicalCutoffSec ?? 0;
  let historicalStaleSuppressed = 0;
  for (const [fingerprint, entry] of ledger.entries()) {
    if (currentFingerprints.has(fingerprint)) continue;
    if (historicalCutoffSec > 0 && entry.lastSeenAt >= historicalCutoffSec) continue;
    historicalStaleSuppressed++;
  }

  return { findings: summarized, historicalStaleSuppressed };
}

export function weekOverWeekTrend(dbPath: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    const curStart = nowSec - 7 * 24 * 3600;
    const prevStart = nowSec - 14 * 24 * 3600;
    const rows = db
      .prepare(
        `SELECT classification,
          SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS currentWeek,
          SUM(CASE WHEN occurred_at >= ? AND occurred_at < ? THEN 1 ELSE 0 END) AS previousWeek
         FROM maintenance_finding
         WHERE occurred_at >= ?
         GROUP BY classification
         ORDER BY classification`,
      )
      .all(curStart, prevStart, curStart, prevStart) as Array<{
      classification: string;
      currentWeek: number;
      previousWeek: number;
    }>;
    return rows.map((r) => ({
      classification: r.classification,
      currentWeek: Number(r.currentWeek ?? 0),
      previousWeek: Number(r.previousWeek ?? 0),
      delta: Number(r.currentWeek ?? 0) - Number(r.previousWeek ?? 0),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function incr(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function reportGlitchTipFindings(
  findings: MaintenanceFinding[],
  opts: { alreadyReportedFingerprints?: Set<string> } = {},
): MaintenanceFinding[] {
  return findings.map((finding) => {
    if (!GLITCHTIP_CLASSES.has(finding.classification)) return finding;
    if (opts.alreadyReportedFingerprints?.has(finding.fingerprint)) {
      return { ...finding, actionTaken: "reported" };
    }
    const eventId = capturePluginError(
      new Error(
        `maintenance-log ${finding.classification}: ${finding.job}/${finding.step} fingerprint=${finding.fingerprint}`,
      ),
      {
        operation: "analyze-maintenance-logs",
        subsystem: "maintenance",
        severity: finding.severity,
        classification: finding.classification,
        fingerprint: [finding.fingerprint],
        job: finding.job,
        step: finding.step,
      },
    );
    return { ...finding, glitchtipEventId: eventId, actionTaken: "reported-glitchtip" };
  });
}

function renderFindingSection(title: string, findings: MaintenanceFinding[]): string[] {
  const lines = ["", `### ${title}`, ""];
  if (findings.length === 0) {
    lines.push("None.");
    return lines;
  }

  for (const f of findings) {
    const icon =
      f.classification === "plugin-bug" || f.classification === "orchestration-bug"
        ? "🐞"
        : f.severity === "critical"
          ? "🚨"
          : "⚠️";
    lines.push(
      `${icon} **${f.job}** — ${f.step} exit=${f.exitCode} at ${formatTimestampUtc(f.occurredAt)}. Class: ${f.classification}. Action: ${f.actionTaken}. Fingerprint: ${f.fingerprint}.`,
    );
    if ((f.occurrenceCount ?? 1) > 1) {
      const firstSeen = typeof f.firstSeenAt === "number" ? formatTimestampUtc(f.firstSeenAt) : "unknown";
      const lastSeen = typeof f.lastSeenAt === "number" ? formatTimestampUtc(f.lastSeenAt) : "unknown";
      lines.push(`Seen ${f.occurrenceCount} times since ${firstSeen}; last seen ${lastSeen}.`);
    }
    lines.push(`Suggested: ${f.suggestedAction}`);
    lines.push(`Log: ${f.logPath}`);
    if (f.logExcerpt) lines.push(`Excerpt: \`${f.logExcerpt.replace(/\s+/g, " ").slice(0, 240)}\``);
    lines.push("");
  }
  return lines;
}

function renderNoiseWarningSection(noiseWarnings: MaintenanceNoiseWarning[]): string[] {
  const lines = ["", "### Benign noise (suppressed from failure counts)", ""];
  if (noiseWarnings.length === 0) {
    lines.push("None.");
    return lines;
  }

  const byPattern = new Map<string, { label: string; count: number; jobs: Set<string> }>();
  for (const warning of noiseWarnings) {
    const bucket = byPattern.get(warning.patternId) ?? {
      label: warning.label,
      count: 0,
      jobs: new Set<string>(),
    };
    bucket.count += warning.occurrenceCount;
    bucket.jobs.add(warning.job);
    byPattern.set(warning.patternId, bucket);
  }

  for (const [patternId, bucket] of [...byPattern.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(
      `- \`${patternId}\` — ${bucket.label}: ${bucket.count} occurrence(s) across ${bucket.jobs.size} job(s).`,
    );
  }
  return lines;
}

export function renderMaintenanceDigestMarkdown(report: Omit<MaintenanceAnalysisReport, "digestMd">): string {
  const okJobs = report.summary.jobsOk;
  const totalJobs = okJobs + report.summary.jobsWithFindings;
  const newFindings = report.findings.filter((f) => f.status !== "still-failing");
  const stillFailing = report.findings.filter((f) => f.status === "still-failing");
  const lines = [
    `## Hybrid-memory maintenance digest (${report.since})`,
    `${report.findings.length === 0 ? "✅" : "⚠️"} ${okJobs}/${totalJobs} jobs OK`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No maintenance failures detected.");
    if (report.summary.historicalStaleSuppressed > 0) {
      lines.push("", "### Historical/stale", "");
      lines.push(
        `Suppressed ${report.summary.historicalStaleSuppressed} older historical fingerprint(s) that are outside the current reporting window.`,
      );
    }
    lines.push(...renderNoiseWarningSection(report.noiseWarnings));
  } else {
    lines.push(...renderFindingSection("New", newFindings.slice(0, 20)));
    lines.push(...renderFindingSection("Still failing", stillFailing.slice(0, 20)));
    lines.push("", "### Historical/stale", "");
    if (report.summary.historicalStaleSuppressed > 0) {
      lines.push(
        `Suppressed ${report.summary.historicalStaleSuppressed} older historical fingerprint(s) that are outside the current reporting window.`,
      );
    } else {
      lines.push("None.");
    }
    const actualShown = Math.min(newFindings.length, 20) + Math.min(stillFailing.length, 20);
    const hiddenCount = Math.max(0, report.findings.length - actualShown);
    if (hiddenCount > 0) lines.push("", `… and ${hiddenCount} more findings.`);
    lines.push(...renderNoiseWarningSection(report.noiseWarnings));
  }
  const trend = report.summary.weekOverWeek ?? [];
  if (trend.length > 0) {
    lines.push("", "### Week-over-week trend", "");
    for (const t of trend) {
      lines.push(
        `- ${t.classification}: ${t.currentWeek} this week vs ${t.previousWeek} previous (${t.delta >= 0 ? "+" : ""}${t.delta})`,
      );
    }
  }
  return lines.join("\n").trimEnd();
}

export function buildMaintenanceAnalysisReport(opts: {
  root?: string;
  since?: string;
  steps: MaintenanceLogStep[];
  findings: MaintenanceFinding[];
  noiseWarnings?: MaintenanceNoiseWarning[];
  findingsPath?: string;
  includeTrend?: boolean;
  historicalStaleSuppressed?: number;
  benignNoiseSuppressed?: number;
}): MaintenanceAnalysisReport {
  const jobs = new Set(opts.steps.map((s) => s.job));
  const failedJobs = new Set(opts.findings.map((f) => f.job));
  const newFindings = opts.findings.filter((f) => f.status !== "still-failing").length;
  const stillFailing = opts.findings.filter((f) => f.status === "still-failing").length;
  const byClassification: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const f of opts.findings) {
    incr(byClassification, f.classification);
    incr(byAction, f.actionTaken);
  }
  const noiseWarnings = opts.noiseWarnings ?? collectMaintenanceNoiseWarnings(opts.steps);
  const base = {
    schemaVersion: 1 as const,
    generatedAt: nowIso(),
    root: opts.root,
    since: opts.since ?? "24h",
    totalSteps: opts.steps.length,
    successfulSteps: opts.steps.filter((s) => s.exitCode === 0).length,
    findings: opts.findings,
    noiseWarnings,
    summary: {
      jobsOk: [...jobs].filter((j) => !failedJobs.has(j)).length,
      jobsWithFindings: failedJobs.size,
      newFindings,
      stillFailing,
      historicalStaleSuppressed: opts.historicalStaleSuppressed ?? 0,
      benignNoiseSuppressed: opts.benignNoiseSuppressed ?? 0,
      byClassification,
      byAction,
      weekOverWeek: opts.includeTrend && opts.findingsPath ? weekOverWeekTrend(opts.findingsPath) : undefined,
    },
    findingsPath: opts.findingsPath,
  };
  return { ...base, digestMd: renderMaintenanceDigestMarkdown(base) };
}

export function shouldMaintenanceStrictFail(findings: MaintenanceFinding[]): boolean {
  return findings.some((f) => STRICT_CLASSES.has(f.classification));
}

/** Build orchestrator/cron step summary from analyzed maintenance log steps. */
export function summarizeMaintenanceLogAnalysis(steps: MaintenanceLogStep[]): {
  summary: string;
  strictFailed: boolean;
  findingsCount: number;
} {
  const findings = analyzeMaintenanceSteps(steps);
  const strictFailed = shouldMaintenanceStrictFail(findings);
  return {
    findingsCount: findings.length,
    strictFailed,
    summary: `steps=${steps.length} findings=${findings.length} strict=${strictFailed ? "fail" : "ok"} semantic=${strictFailed ? "partial" : "success"}`,
  };
}

export function writeMaintenanceAnalysisOutput(report: MaintenanceAnalysisReport, format: string, outPath = "-"): void {
  const content = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${report.digestMd}\n`;
  if (outPath === "-") {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf-8");
}
