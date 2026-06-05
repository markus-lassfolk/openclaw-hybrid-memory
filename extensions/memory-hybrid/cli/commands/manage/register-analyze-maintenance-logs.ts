/**
 * CLI registration for maintenance log analyzer (Issue #1199).
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin } from "node:process";

import { applyHeavyMaintenanceAutoFixes, applyMaintenanceAutoFix } from "../../../services/maintenance-auto-fix.js";
import {
  analyzeMaintenanceSteps,
  buildMaintenanceAnalysisReport,
  collectMaintenanceSteps,
  parseMaintenanceSinceMs,
  persistMaintenanceFindings,
  reportGlitchTipFindings,
  shouldMaintenanceStrictFail,
  summarizeMaintenanceFindings,
  writeMaintenanceAnalysisOutput,
  type MaintenanceLogStep,
} from "../../../services/maintenance-log-analyzer.js";
import { isBenignNoiseOnlyMaintenanceStep } from "../../../services/maintenance-benign-noise.js";
import { formatTimestampUtc } from "../../../utils/dates.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

interface AnalyzeMaintenanceLogOpts {
  root?: string;
  since?: string;
  staleThreshold?: string;
  autoFix?: boolean;
  autoFixAll?: boolean;
  glitchtip?: boolean;
  digest?: string;
  format?: string;
  out?: string;
  strict?: boolean;
  persist?: string;
  noPersist?: boolean;
  trend?: boolean;
}

async function readStdinIfPiped(): Promise<string> {
  if (stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function stepsFromPipedExitLog(content: string): MaintenanceLogStep[] {
  const now = Math.floor(Date.now() / 1000);
  const logContent = content;
  return content
    .split("\n")
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => /\bexit=\d+\b/.test(line))
    .map(({ line, idx }) => {
      const m = line.match(/^(\S+)\s+(?:(\S+)\/)?(\S+)\s+(?:completed|failed)?\s*exit=(\d+)\b/);
      const iso = m?.[1] ?? formatTimestampUtc(now);
      const occurredAt = Math.floor(new Date(iso).getTime() / 1000);
      return {
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : now + idx,
        iso,
        job: m?.[2] ?? "stdin",
        step: m?.[3] ?? `line-${idx + 1}`,
        exitCode: Number.parseInt(m?.[4] ?? "1", 10),
        exitPath: "stdin",
        logPath: "stdin",
        logContent,
        line,
      };
    });
}

export async function runAnalyzeMaintenanceLogs(
  opts: AnalyzeMaintenanceLogOpts | undefined,
  b: ManageBindings,
): Promise<{ summary: string; strictFailed: boolean }> {
  const since = opts?.since ?? "24h";
  const format = opts?.digest ?? opts?.format ?? "md";
  const outPath = opts?.out ?? "-";
  const root = opts?.root ?? join(homedir(), ".openclaw", "logs", "cron-hybrid-mem");
  const staleThreshold = opts?.staleThreshold ?? "45m";
  const staleThresholdMs = parseMaintenanceSinceMs(staleThreshold);
  const defaultFindingsPath =
    typeof b.cfg.sqlitePath === "string" && b.cfg.sqlitePath.trim().length > 0
      ? join(dirname(b.cfg.sqlitePath), "maintenance-findings.db")
      : join(homedir(), ".openclaw", "memory", "maintenance-findings.db");
  const findingsPath =
    typeof opts?.persist === "string" && opts.persist.trim().length > 0 ? opts.persist : defaultFindingsPath;

  let steps: MaintenanceLogStep[] = [];
  if (opts?.root || existsSync(root)) {
    steps = collectMaintenanceSteps(root, since, Date.now(), { staleThresholdMs });
  }
  if (steps.length === 0) {
    const piped = await readStdinIfPiped();
    if (piped.trim()) steps = stepsFromPipedExitLog(piped);
  }
  let findings = analyzeMaintenanceSteps(steps);

  if (opts?.autoFix) {
    findings = findings.map((f) => applyMaintenanceAutoFix(f));
    if (opts.autoFixAll) {
      findings = applyHeavyMaintenanceAutoFixes({
        findings,
        findingsDbPath: findingsPath,
        factsDb: b.factsDb,
      });
    }
  }

  const historicalCutoffSec = Math.floor((Date.now() - parseMaintenanceSinceMs(since)) / 1000);
  const summarized = summarizeMaintenanceFindings(findings, {
    dbPath: findingsPath,
    historicalCutoffSec,
  });
  let reportFindings = summarized.findings;

  if (opts?.glitchtip) {
    const alreadyReportedFingerprints = new Set(
      reportFindings.filter((f) => f.actionTaken === "reported").map((f) => f.fingerprint),
    );
    reportFindings = reportGlitchTipFindings(reportFindings, { alreadyReportedFingerprints });
  }

  const reportedByFingerprint = new Map(reportFindings.map((finding) => [finding.fingerprint, finding] as const));
  const persistedFindings = findings.map((finding) => {
    const reported = reportedByFingerprint.get(finding.fingerprint);
    if (!reported) return finding;
    return {
      ...finding,
      actionTaken: reported.actionTaken,
      glitchtipEventId: reported.glitchtipEventId,
    };
  });

  if (persistedFindings.length > 0 && opts?.noPersist !== true) {
    mkdirSync(dirname(findingsPath), { recursive: true });
    persistMaintenanceFindings(findingsPath, persistedFindings);
  }

  const report = buildMaintenanceAnalysisReport({
    root,
    since,
    steps,
    findings: reportFindings,
    findingsPath: persistedFindings.length > 0 && opts?.noPersist !== true ? findingsPath : undefined,
    historicalStaleSuppressed: summarized.historicalStaleSuppressed,
    benignNoiseSuppressed: steps.filter((step) => step.exitCode !== 0 && isBenignNoiseOnlyMaintenanceStep(step)).length,
    includeTrend: opts?.trend === true || since.endsWith("d") || since.endsWith("w"),
  });
  writeMaintenanceAnalysisOutput(report, format, outPath);

  const strictFailed = shouldMaintenanceStrictFail(reportFindings);
  const summary = `steps=${steps.length} findings=${reportFindings.length} strict=${strictFailed ? "fail" : "ok"} semantic=${strictFailed ? "partial" : "success"}`;
  if (opts?.strict && strictFailed) process.exitCode = 2;
  return { summary, strictFailed };
}

function addAnalyzeOptions(cmd: Chainable): Chainable {
  return cmd
    .option("--root <path>", "Root cron-hybrid-mem log directory (scans recursively for .exit.txt/.log)")
    .option("--since <duration>", "Lookback for --root scans, e.g. 24h, 7d (default: 24h)")
    .option(
      "--stale-threshold <duration>",
      "Flag stale/no-progress orchestration runs after this age (e.g. 45m, 2h; default: 45m)",
    )
    .option(
      "--auto-fix",
      "Apply whitelisted safe fixes (clear stale .lock with dead PID; mark retry-once). No shell exec for unsafe actions.",
    )
    .option(
      "--auto-fix-all",
      "With --auto-fix: also run VACUUM + vectordb-optimize after repeated SQLITE_BUSY in the persistence window, and reembed-vectorless --limit 200 --apply when embedding-auth findings are present.",
    )
    .option("--glitchtip", "Report plugin-bug/orchestration-bug findings via existing error reporter")
    .option("--digest <fmt>", "Alias for --format, md or json")
    .option("--format <fmt>", "Output format: md (default) or json")
    .option("--out <path>", "Output file path, or '-' for stdout (default: -)")
    .option("--strict", "Exit non-zero for plugin-bug, orchestration-bug, provider-auth, or env-misconfig findings")
    .option(
      "--persist <path>",
      "SQLite path for maintenance_finding rows (default: <memory-dir>/maintenance-findings.db)",
    )
    .option("--no-persist", "Do not write maintenance_finding rows")
    .option("--trend", "Include week-over-week trend from persisted findings");
}

export function registerAnalyzeMaintenanceLogsCommand(mem: Chainable, b: ManageBindings): void {
  const parent = mem
    .command("analyze-maintenance-logs")
    .description("Classify hybrid-memory maintenance cron logs (Issue #1199).");
  addAnalyzeOptions(parent).action(
    withExit(async (opts?: AnalyzeMaintenanceLogOpts) => runAnalyzeMaintenanceLogs(opts, b)),
  );
  addAnalyzeOptions(
    parent.command("run").description("Compatibility subcommand: analyze logs and emit a digest/report"),
  ).action(withExit(async (opts?: AnalyzeMaintenanceLogOpts) => runAnalyzeMaintenanceLogs(opts, b)));
}
