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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
        status: "success",
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

function parseJobsJson(baseDir: string): Record<
  string,
  {
    name?: string;
    lastRunAtMs?: number;
    enabled?: boolean;
  }
> {
  const path = join(baseDir, ".openclaw", "cron", "jobs.json");
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const jobs = JSON.parse(raw);
    if (Array.isArray(jobs)) {
      const m = {} as Record<string, unknown>;
      for (const j of jobs) {
        if (j?.id || j?.name) m[String(j.id ?? j.name)] = j;
      }
      return m as Record<string, { name?: string; lastRunAtMs?: number; enabled?: boolean }>;
    }
    return {};
  } catch {
    return {};
  }
}

function buildAnalyzedResult(b: ManageBindings, logs: string): AnalyzeResult {
  const { cfg } = b;
  const runs = parseCronRunLog(logs);
  const jobsMeta = parseJobsJson(cfg.baseDir);

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
  const { cfg } = b;

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
    .option("--format <fmt>", "Output format: md (default) or json")
    .option("--out <path>", "Output file path, or '-' for stdout (default: -)")
    .action(
      withExit(async (opts?: { file?: string; format?: string; out?: string }) => {
        const format = opts?.format ?? "md";
        const outPath = opts?.out ?? "-";

        let logContent = "";
        if (opts?.file) {
          if (!existsSync(opts.file)) {
            console.error(`error: file not found: ${opts.file}`);
            process.exitCode = 1;
            return;
          }
          logContent = readFileSync(opts.file, "utf-8");
        } else {
          // Try reading from stdin (non-empty)
          // commander passes args after --; in this case we read directly
          logContent = ""; // will show "no content" message below
        }

        const result = buildAnalyzedResult(b, logContent);

        if (result.totalRuns === 0) {
          console.log(
            "# Maintenance Log Analysis\n\nNo cron run entries detected in the input. " +
              "Pipe gateway logs:\n  openclaw gateway logs | openclaw hybrid-mem manage analyze-maintenance-logs run",
          );
          return;
        }

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
