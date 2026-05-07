/**
 * CLI registration for `manage analyze-maintenance-logs` command (Issue #1199).
 *
 * Reads OpenClaw cron job run logs and classifies failures.
 * Outputs structured report to stdout or file.
 *
 * Classification categories:
 *   network       — DNS/connection/timeout failures
 *   auth          — credential/token expiry
 *   rate_limit    — API throttling
 *   disk_full     — ENOSPC / disk space issues
 *   config_error  — missing/wrong config keys
 *   dependency    — module/plugin not loaded
 *   oom           — out-of-memory
 *   unknown       — unclassified
 *
 * Each failure is tagged with: severity (critical/high/medium/low/info),
 * first_seen, last_seen, count, suggested_fix.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stdin } from "node:process";

import { capturePluginError } from "../../../services/error-reporter.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

interface FailureGroup {
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  jobName: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  messages: string[];
  suggestedFix: string;
}

interface AnalyzedRun {
  jobName: string;
  step?: string;
  exitCode?: number;
  logPath?: string;
  status: "success" | "failure" | "skipped";
  finishedAt: number;
  durationMs: number;
  error?: string;
}

interface AnalyzeResult {
  generatedAt: string;
  totalRuns: number;
  success: number;
  failure: number;
  skipped: number;
  failureGroups: FailureGroup[];
  findingsPath?: string;
  summaryMd: string;
}

function classifyError(
  errorMsg: string,
  jobName: string,
): {
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  suggestedFix: string;
} {
  const lower = errorMsg.toLowerCase();

  if (/dns|getaddrinfo|ename or service not known|connection refused|etimedout|ECONNREFUSED|ENOTFOUND/i.test(lower)) {
    return {
      category: "network",
      severity: "high",
      suggestedFix: "Check network connectivity and DNS resolution for the affected service.",
    };
  }
  if (/401|403|unauthorized|forbidden|token.*expired|credential.*invalid|auth.*fail/i.test(lower)) {
    return {
      category: "auth",
      severity: "high",
      suggestedFix: "Refresh credentials or re-authenticate the affected service.",
    };
  }
  if (/429|rate.limit|throttl|RateLimit|too many requests/i.test(lower)) {
    return {
      category: "rate_limit",
      severity: "medium",
      suggestedFix: "Reduce cron frequency or add exponential backoff to the job.",
    };
  }
  if (/enospc|disk.full|no space left|disk space/i.test(lower)) {
    return {
      category: "disk_full",
      severity: "critical",
      suggestedFix: "Free up disk space or increase storage allocation.",
    };
  }
  if (/config|configuration|missing.*key|cannot.*read.*config|envalid/i.test(lower)) {
    return {
      category: "config_error",
      severity: "high",
      suggestedFix: "Review and fix the configuration for this job.",
    };
  }
  if (/cannot find module|modulenotfounderror|plugin.*not.*found|extension.*not.*loaded/i.test(lower)) {
    return {
      category: "dependency",
      severity: "high",
      suggestedFix: "Ensure the required plugin/module is installed and loaded before this job runs.",
    };
  }
  if (/heap|out of memory|oom|fatal error.*memory/i.test(lower)) {
    return {
      category: "oom",
      severity: "critical",
      suggestedFix: "Increase memory limits or reduce job scope/data size.",
    };
  }
  if (/gateway.*timeout|504|504 gateway timeout|upstream.*timeout/i.test(lower)) {
    return {
      category: "network",
      severity: "high",
      suggestedFix: "The upstream service timed out. Check if the service is healthy and responsive.",
    };
  }
  if (/health|unhealthy|failed health/i.test(lower) && jobName.toLowerCase().includes("health")) {
    return {
      category: "health_check",
      severity: "info",
      suggestedFix: "Run 'openclaw health' to inspect the full health report.",
    };
  }
  return {
    category: "unknown",
    severity: "low",
    suggestedFix: "Inspect the job logs for details. Consider escalating to the maintainer.",
  };
}


function parseSinceMs(value?: string): number {
  if (!value) return 24 * 3600 * 1000;
  const m = value.trim().match(/^(\d+)([dhw])?$/i);
  if (!m) return 24 * 3600 * 1000;
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? "h").toLowerCase();
  if (unit === "d") return n * 24 * 3600 * 1000;
  if (unit === "w") return n * 7 * 24 * 3600 * 1000;
  return n * 3600 * 1000;
}

function collectExitLogs(root: string, since?: string): string {
  if (!existsSync(root)) return "";
  const cutoff = Date.now() - parseSinceMs(since);
  const chunks: string[] = [];
  for (const day of readdirSync(root)) {
    const dayPath = join(root, day);
    if (!existsSync(dayPath) || !statSync(dayPath).isDirectory()) continue;
    for (const file of readdirSync(dayPath)) {
      if (!file.endsWith(".exit.txt")) continue;
      const exitPath = join(dayPath, file);
      if (statSync(exitPath).mtimeMs < cutoff) continue;
      const logPath = exitPath.replace(/\.exit\.txt$/, ".log");
      const exitContent = readFileSync(exitPath, "utf-8");
      const logContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      const job = file.replace(/-[0-9]{8}T.*$/, "").replace(/\.exit\.txt$/, "");
      for (const line of exitContent.split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+exit=(\d+)/);
        if (!m) continue;
        const [, iso, step, exitRaw] = m;
        const exitCode = Number.parseInt(exitRaw, 10);
        const status = exitCode === 0 ? "completed" : "failed";
        const excerpt = logContent.split("\n").filter((l) => /error|fail|exception|unauthorized|429|busy|timeout|killed|cannot find module/i.test(l)).slice(-5).join("; ");
        chunks.push(`${iso} ${job}/${step} ${status} exit=${exitCode} ${excerpt}`.trim());
      }
    }
  }
  return chunks.join("\n");
}

function parseCronRunLog(content: string): AnalyzedRun[] {
  const runs: AnalyzedRun[] = [];
  // Each run is a JSON object on a single line, or a structured block.
  // We look for lines that contain run metadata.
  const lines = content.split("\n");

  let currentRun: Partial<AnalyzedRun> | null = null;
  for (const line of lines) {
    // Detect run boundaries (timestamped start lines)
    const startMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+(.+)/);
    if (startMatch && !line.includes("RUNNING") && !line.includes("running")) {
      if (currentRun?.jobName && currentRun?.finishedAt) {
        runs.push(currentRun as AnalyzedRun);
      }
      currentRun = {
        jobName: startMatch[2].trim(),
        finishedAt: new Date(startMatch[1]).getTime() / 1000,
        status: /exit=(?!0\b)\d+|failed/i.test(line) ? "failure" : "success",
        step: startMatch[2].includes("/") ? startMatch[2].split("/").pop()?.split(/\s+/)[0] : undefined,
        exitCode: Number(line.match(/exit=(\d+)/)?.[1] ?? 0),
        durationMs: 0,
      };
    }
    if (currentRun) {
      if (/\[ERROR\]|\[FATAL\]|\[FAILURE\]|✗|failed|error/i.test(line)) {
        currentRun.status = "failure";
        currentRun.error = (currentRun.error ? currentRun.error + "; " : "") + line.trim().slice(0, 200);
      }
      if (/success|✓|completed|done/i.test(line) && !currentRun.error) {
        currentRun.status = "success";
      }
      if (/skipped|skipp/i.test(line)) {
        currentRun.status = "skipped";
      }
    }
  }
  if (currentRun?.jobName) {
    runs.push(currentRun as AnalyzedRun);
  }
  return runs;
}

async function readStdinIfPiped(): Promise<string> {
  if (stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}


function persistMaintenanceFindings(dbPath: string, result: AnalyzeResult): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_finding (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        job TEXT NOT NULL,
        step TEXT,
        exit_code INTEGER,
        classification TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        log_excerpt TEXT,
        action_taken TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO maintenance_finding
       (id, occurred_at, job, step, exit_code, classification, fingerprint, log_excerpt, action_taken, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const group of result.failureGroups) {
      const fingerprint = `${group.category}:${group.jobName}:${group.messages[0] ?? ""}`.slice(0, 180);
      const id = Buffer.from(fingerprint).toString("base64url").slice(0, 64);
      stmt.run(id, group.lastSeen, group.jobName, null, null, group.category, fingerprint, group.messages[0] ?? null, "reported", now);
    }
  } finally {
    db.close();
  }
}

function buildAnalyzedResult(logs: string): AnalyzeResult {
  const runs = parseCronRunLog(logs);

  const failures = runs.filter((r) => r.status === "failure");
  const success = runs.filter((r) => r.status === "success").length;
  const skipped = runs.filter((r) => r.status === "skipped").length;

  // Group failures
  const groups = new Map<string, FailureGroup>();

  for (const run of failures) {
    const errMsg = run.error ?? "unknown error";
    const { category, severity, suggestedFix } = classifyError(errMsg, run.jobName);
    const key = `${category}::${run.jobName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        category,
        severity,
        jobName: run.jobName,
        count: 0,
        firstSeen: run.finishedAt,
        lastSeen: run.finishedAt,
        messages: [],
        suggestedFix,
      });
    }
    const g = groups.get(key)!;
    g.count++;
    g.firstSeen = Math.min(g.firstSeen, run.finishedAt);
    g.lastSeen = Math.max(g.lastSeen, run.finishedAt);
    if (!g.messages.includes(errMsg)) g.messages.push(errMsg);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return sevOrder[a.severity] - sevOrder[b.severity] || b.count - a.count;
  });

  const summaryMd = [
    `# Maintenance Log Analysis — ${new Date().toISOString().split("T")[0]}`,
    "",
    `Total runs: ${runs.length} | Success: ${success} | Failures: ${failures.length} | Skipped: ${skipped}`,
    "",
    ...sortedGroups.flatMap((g) => [
      `## ${g.category.toUpperCase()} — ${g.jobName} (${g.count}x, ${g.severity})`,
      "",
      `First seen: ${new Date(g.firstSeen * 1000).toISOString()}`,
      `Last seen:  ${new Date(g.lastSeen * 1000).toISOString()}`,
      "",
      `**Suggested fix:** ${g.suggestedFix}`,
      "",
      `Errors (${g.messages.length} unique):`,
      ...g.messages.slice(0, 5).map((m) => `> \`${m}\``),
      g.messages.length > 5 ? `> … and ${g.messages.length - 5} more` : null,
      "",
    ]),
    failures.length === 0 ? "_No failures detected._" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    generatedAt: new Date().toISOString(),
    totalRuns: runs.length,
    success,
    failure: failures.length,
    skipped,
    failureGroups: sortedGroups,
    summaryMd,
  };
}

export function registerManageAnalyzeMaintenanceLogs(mem: Chainable, b: ManageBindings): void {
  const cmd = mem
    .command("analyze-maintenance-logs")
    .description(
      "Classify and report on cron-job failures from stdin or a log file (Issue #1199). " +
        "Reads from --file <path> or pipes content from 'openclaw gateway logs'.",
    );

  cmd
    .command("run")
    .description("Analyze log output and print a failure report")
    .option("--file <path>", "Path to a log file to analyze (default: read from stdin)")
    .option("--root <path>", "Root cron-hybrid-mem log directory containing YYYYMMDD/*.exit.txt")
    .option("--since <duration>", "Lookback for --root scans, e.g. 24h, 7d (default: 24h)")
    .option("--digest <fmt>", "Alias for --format, md or json")
    .option("--strict", "Exit non-zero when failures are found")
    .option("--auto-fix", "Reserved for safe idempotent remediation; currently report-only")
    .option("--dry-run", "Show intended actions without mutating state (default behavior)")
    .option("--persist <path>", "SQLite path for persisted maintenance findings (default: <memory-dir>/maintenance-findings.db)")
    .option("--glitchtip", "Report plugin/orchestration-like findings via existing error reporter")
    .option("--format <fmt>", "Output format: md (default) or json")
    .option("--out <path>", "Output file path, or '-' for stdout (default: -)")
    .action(
      withExit(async (opts?: { file?: string; root?: string; since?: string; digest?: string; strict?: boolean; autoFix?: boolean; dryRun?: boolean; format?: string; out?: string }) => {
        const format = opts?.digest ?? opts?.format ?? "md";
        const outPath = opts?.out ?? "-";

        let logContent = "";
        if (opts?.file) {
          if (!existsSync(opts.file)) {
            console.error(`error: file not found: ${opts.file}`);
            process.exitCode = 1;
            return;
          }
          logContent = readFileSync(opts.file, "utf-8");
        } else if (opts?.root) {
          logContent = collectExitLogs(opts.root, opts.since);
        } else {
          logContent = await readStdinIfPiped();
        }

        const result = buildAnalyzedResult(logContent);

        if (result.totalRuns === 0) {
          console.log(
            "# Maintenance Log Analysis\n\nNo cron run entries detected in the input. " +
              "Pipe gateway logs:\n  openclaw gateway logs | openclaw hybrid-mem manage analyze-maintenance-logs run",
          );
          if (opts?.strict) process.exitCode = 1;
          return;
        }

        const persistPath = opts?.persist ?? join(dirname(b.cfg.sqlitePath), "maintenance-findings.db");
        if (result.failureGroups.length > 0) {
          persistMaintenanceFindings(persistPath, result);
          result.findingsPath = persistPath;
        }

        if (opts?.glitchtip) {
          for (const group of result.failureGroups) {
            if (group.category === "dependency" || group.category === "unknown") {
              capturePluginError(new Error(`maintenance-log ${group.category}: ${group.jobName}`), {
                operation: "analyze-maintenance-logs",
                subsystem: "maintenance",
                severity: group.severity,
              });
            }
          }
        }

        if (opts?.autoFix) {
          result.summaryMd += "\n\n_Auto-fix requested; no unsafe remediation was executed in this pass._";
        }

        if (opts?.strict && result.failure > 0) process.exitCode = 1;

        if (format === "json") {
          const out = JSON.stringify(result, null, 2);
          if (outPath === "-") {
            process.stdout.write(out + "\n");
          } else {
            writeFileSync(outPath, out, "utf-8");
            console.log(`Written: ${outPath}`);
          }
        } else {
          if (outPath === "-") {
            process.stdout.write(result.summaryMd + "\n");
          } else {
            writeFileSync(outPath, result.summaryMd, "utf-8");
            console.log(`Written: ${outPath}`);
          }
        }
      }),
    );
}
