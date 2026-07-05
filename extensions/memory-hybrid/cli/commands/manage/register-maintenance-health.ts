/**
 * Maintenance inventory, status, and cron-health subcommands (Issue #281).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HybridMemoryConfig } from "../../../config.js";
import { formatStepLockDetail, listActiveStepLocks } from "../../../services/cron-guard.js";
import {
  collectMaintenanceInventory,
  renderMaintenanceInventoryMarkdown,
  renderMaintenanceInventoryText,
} from "../../../services/maintenance-inventory.js";
import {
  collectMaintenanceSteps,
  summarizeMaintenanceLogAnalysis,
} from "../../../services/maintenance-log-analyzer.js";
import { describeCronStoreLocation, readOpenClawCronStore } from "../../../services/openclaw-cron-store.js";
import { formatTimestampUtcFromMs } from "../../../utils/dates.js";
import { type Chainable, relativeTime, withExit } from "../../shared.js";

/** Lookback window for the log-health check folded into `maintenance status` (#2033). */
const STATUS_LOG_HEALTH_SINCE = "24h";

export function registerMaintenanceHealthCommands(maintenance: Chainable, cfg: HybridMemoryConfig): void {
  maintenance
    .command("inventory")
    .description("List host-crontab and gateway-cron maintenance jobs in one report.")
    .option("--json", "Output as JSON")
    .option("--format <format>", "Output format: text, markdown, json", "text")
    .action(
      withExit(async (opts?: { json?: boolean; format?: string }) => {
        const requestedFormat = (opts?.format ?? "text").toLowerCase();
        if (opts?.json && requestedFormat === "markdown") {
          throw new Error("Use either --json or --format markdown, not both.");
        }
        const format = opts?.json ? "json" : requestedFormat;
        if (!["text", "markdown", "json"].includes(format)) {
          throw new Error(`Unsupported inventory format: ${opts?.format ?? ""}`);
        }

        const report = collectMaintenanceInventory(join(homedir(), ".openclaw"));
        if (format === "json") {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (format === "markdown") {
          console.log(renderMaintenanceInventoryMarkdown(report));
          return;
        }
        console.log(renderMaintenanceInventoryText(report));
      }),
    );

  maintenance
    .command("status")
    .description("Show maintenance cron job health: nightly cycle, weekly backup, and any reliability issues.")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Also show per-finding log-health detail and active/stale maintenance locks")
    .action(
      withExit(async (opts?: { json?: boolean; verbose?: boolean }) => {
        const openclawDir = join(homedir(), ".openclaw");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const nightlyCronExpr = cfg.maintenance?.cronReliability?.nightlyCron ?? "0 3 * * *";
        const weeklyBackupCronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
        const useConsolidatedCron = cfg.maintenance?.orchestrator?.consolidatedCronJobs !== false;

        type JobStatus = {
          name: string;
          pluginJobId: string;
          enabled: boolean;
          lastRunAt: string | null;
          nextRunAt: string | null;
          lastStatus: string | null;
          isStale: boolean;
          isMissing: boolean;
          configuredSchedule: string;
          issue?: string;
        };

        const jobsOfInterest: Array<{
          id: string;
          label: string;
          scheduleExpr: string;
          staleMs: number;
        }> = useConsolidatedCron
          ? [
              {
                id: "hybrid-mem:maintenance-nightly",
                label: "maintenance-nightly",
                scheduleExpr: nightlyCronExpr,
                staleMs: staleThresholdMs,
              },
            ]
          : [
              {
                id: "hybrid-mem:nightly-distill",
                label: "nightly-memory-sweep (legacy)",
                scheduleExpr: nightlyCronExpr,
                staleMs: staleThresholdMs,
              },
            ];

        const results: JobStatus[] = [];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        try {
          cronStore = readOpenClawCronStore(openclawDir).store;
        } catch {
          // corrupt store — treat all as missing
        }

        const jobs = Array.isArray(cronStore.jobs) ? (cronStore.jobs as Array<Record<string, unknown>>) : [];

        for (const wanted of jobsOfInterest) {
          const found = jobs.find((j) => j && (j.pluginJobId === wanted.id || String(j.name ?? "") === wanted.label));

          if (!found) {
            results.push({
              name: wanted.label,
              pluginJobId: wanted.id,
              enabled: false,
              lastRunAt: null,
              nextRunAt: null,
              lastStatus: null,
              isStale: false,
              isMissing: true,
              configuredSchedule: wanted.scheduleExpr,
              issue: "Job not found in cron store — run `hybrid-mem verify --fix` to install.",
            });
            continue;
          }

          const enabled = found.enabled !== false;
          const state = found.state as
            | {
                nextRunAtMs?: number;
                lastRunAtMs?: number;
                lastStatus?: string;
                lastError?: string;
              }
            | undefined;
          const lastRunAtMs = state?.lastRunAtMs;
          const nextRunAtMs = state?.nextRunAtMs;
          const lastStatus = state?.lastStatus ?? null;

          const isStale = enabled && lastRunAtMs != null && Date.now() - lastRunAtMs > wanted.staleMs;
          const neverRan = enabled && lastRunAtMs == null;

          let issue: string | undefined;
          if (!enabled) {
            issue = "Job is disabled.";
          } else if (neverRan) {
            issue = "Job has never run — check cron daemon is running.";
          } else if (isStale) {
            const hoursSince = Math.floor((Date.now() - (lastRunAtMs ?? 0)) / 3600000);
            issue = `Job is stale — last run was ${hoursSince}h ago (threshold: ${Math.floor(
              wanted.staleMs / 3600000,
            )}h).`;
          } else if (lastStatus === "error") {
            issue = `Last run failed: ${state?.lastError ?? "unknown error"}`;
          }

          results.push({
            name: wanted.label,
            pluginJobId: wanted.id,
            enabled,
            lastRunAt: lastRunAtMs != null ? formatTimestampUtcFromMs(lastRunAtMs) : null,
            nextRunAt: nextRunAtMs != null ? formatTimestampUtcFromMs(nextRunAtMs) : null,
            lastStatus,
            isStale,
            isMissing: false,
            configuredSchedule: wanted.scheduleExpr,
            issue,
          });
        }

        const issues = results.filter((r) => r.issue);

        // Log health (#2033): scheduler cadence looking healthy must not imply the maintenance
        // logs are clean — analyze-maintenance-logs can report strict findings for the same window
        // even when cron cadence looks fine, and an operator who stops at `status` would miss it.
        const logRoot = join(openclawDir, "logs", "cron-hybrid-mem");
        let logHealth: { summary: string; strictFailed: boolean; findingsCount: number } | null = null;
        if (existsSync(logRoot)) {
          try {
            const steps = collectMaintenanceSteps(logRoot, STATUS_LOG_HEALTH_SINCE);
            logHealth = summarizeMaintenanceLogAnalysis(steps);
          } catch {
            // Best-effort — a log-analysis failure must not break the cron-freshness check below.
            logHealth = null;
          }
        }

        // Active/stale step locks (#2031): surfaces what `maintenance step <name> --force` would
        // report as "locked by a concurrent maintenance run" instead of only discovering it there.
        const locks = listActiveStepLocks(openclawDir);

        const schedulerHealthy = issues.length === 0;
        const logHealthy = !logHealth?.strictFailed;

        if (issues.length > 0 || logHealth?.strictFailed) {
          process.exitCode = 1;
        }

        if (opts?.json) {
          console.log(
            JSON.stringify(
              {
                ok: schedulerHealthy && logHealthy,
                jobs: results,
                issueCount: issues.length,
                logHealth: logHealth ? { ...logHealth, since: STATUS_LOG_HEALTH_SINCE } : null,
                locks,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log("Memory Maintenance Status (Issue #281)");
        console.log("========================================");
        console.log(`Cron store: ${describeCronStoreLocation(openclawDir)}`);
        console.log(`Stale threshold (daily): ${cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28}h`);
        console.log("");

        for (const r of results) {
          const icon = r.isMissing ? "❌" : !r.enabled ? "⏸ " : r.issue ? "⚠️ " : "✅";
          const lastRun = r.lastRunAt
            ? `last: ${relativeTime(new Date(r.lastRunAt).getTime())} (${r.lastStatus ?? "unknown"})`
            : "last: never";
          const nextRun = r.nextRunAt ? `next: ${relativeTime(new Date(r.nextRunAt).getTime())}` : "";
          const timing = [lastRun, nextRun].filter(Boolean).join("  ");
          console.log(
            `${icon} ${r.name.padEnd(32)} ${r.isMissing ? "MISSING" : r.enabled ? "enabled " : "disabled"} ${timing}`,
          );
          if (r.issue) {
            console.log(`   └─ ${r.issue}`);
          }
        }

        console.log("");
        if (schedulerHealthy) {
          console.log("✅ Scheduler freshness: all maintenance jobs healthy (cron cadence only).");
        } else {
          console.log(`⚠️  ${issues.length} scheduler issue(s) detected. Run \`hybrid-mem verify --fix\` to repair.`);
          if (issues.some((r) => r.isMissing)) {
            console.log("   Missing jobs can be registered with: hybrid-mem install");
          }
        }

        if (logHealth?.strictFailed) {
          console.log(
            `⚠️  Log health: analyze-maintenance-logs reports strict findings in the last ${STATUS_LOG_HEALTH_SINCE} ` +
              `(${logHealth.summary}). Run \`hybrid-mem maintenance step analyze-maintenance-logs --force --verbose\` for detail.`,
          );
        } else if (opts?.verbose) {
          console.log(
            logHealth
              ? `✅ Log health: no strict findings in the last ${STATUS_LOG_HEALTH_SINCE} (${logHealth.summary}).`
              : `ℹ️  Log health: unchecked (no logs found under ${logRoot}).`,
          );
        }

        if (locks.length > 0) {
          console.log("");
          console.log(`🔒 Active/stale maintenance step locks (${locks.length}):`);
          for (const lock of locks) {
            console.log(`   step--${lock.stepName}  ${formatStepLockDetail(lock)}`);
          }
          console.log(
            "   A lock here will make `maintenance step <name> --force` report skipped_guard until it clears.",
          );
        }
      }),
    );

  maintenance
    .command("cron-health")
    .description(
      "Check if expected cron jobs exist and have fired recently. " +
        "Logs warnings for missing or stale jobs. Useful in heartbeat checks.",
    )
    .action(
      withExit(async () => {
        const openclawDir = join(homedir(), ".openclaw");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const useConsolidatedCron = cfg.maintenance?.orchestrator?.consolidatedCronJobs !== false;
        const criticalJobs = useConsolidatedCron ? ["hybrid-mem:maintenance-nightly"] : ["hybrid-mem:nightly-distill"];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        try {
          const snapshot = readOpenClawCronStore(openclawDir);
          cronStore = snapshot.store;
        } catch {
          console.warn("⚠ Could not read cron store — skipping health check.");
          process.exitCode = 1;
          return;
        }

        const jobs = Array.isArray(cronStore.jobs) ? (cronStore.jobs as Array<Record<string, unknown>>) : [];
        let healthy = true;

        for (const id of criticalJobs) {
          const job = jobs.find((j) => j && j.pluginJobId === id);
          if (!job) {
            console.warn(`⚠ Maintenance job missing: ${id}. Run: hybrid-mem install`);
            healthy = false;
            continue;
          }
          if (job.enabled === false) {
            continue;
          }
          const state = job.state as { lastRunAtMs?: number; lastStatus?: string } | undefined;
          if (state?.lastRunAtMs != null && Date.now() - state.lastRunAtMs > staleThresholdMs) {
            const h = Math.floor((Date.now() - state.lastRunAtMs) / 3600000);
            console.warn(`⚠ Stale maintenance job: ${id} (last run ${h}h ago). Check cron daemon.`);
            healthy = false;
          }
        }

        if (healthy) {
          console.log("✓ Maintenance cron jobs healthy.");
        } else {
          process.exitCode = 1;
        }
      }),
    );
}
