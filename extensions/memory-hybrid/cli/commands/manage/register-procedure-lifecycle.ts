/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { capturePluginError } from "../../../services/error-reporter.js";
import { type Chainable, relativeTime, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

/** Quote a path for use in a crontab line so spaces/special chars do not break the shell. */
function shellQuotePathForCron(path: string): string {
  if (/^[\w@%+./:-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function registerManageProcedureAndLifecycle(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    runExtractProcedures,
    runGenerateAutoSkills,
    ctx,
    cfg,
    runUpgrade,
    runUninstall,
    runBackup,
    runBackupVerify,
    resolvedSqlitePath,
    resolvedLancePath,
  } = b;

  // Procedure feedback loop CLI (#782)
  const procedureCmd = mem
    .command("procedure")
    .description("Show procedure details (versions, failures, avoidance notes)");
  procedureCmd
    .command("show <id>")
    .description("Show all versions and failure history for a procedure")
    .action(
      withExit(async (id: string) => {
        const proc = factsDb.getProcedureById(id);
        if (!proc) {
          console.log(`Procedure not found: ${id}`);
          return;
        }

        const versions = factsDb.getProcedureVersions(id);
        const failures = factsDb.getProcedureFailures(id);
        const totalSuccess = proc.successCount + versions.reduce((s, v) => s + v.successCount, 0);
        const totalFailure = proc.failureCount + versions.reduce((s, v) => s + v.failureCount, 0);
        const total = totalSuccess + totalFailure;
        const rate = total > 0 ? totalSuccess / total : 0;

        console.log(`Procedure: ${proc.taskPattern}`);
        console.log(`  ID:         ${proc.id}`);
        console.log(`  Type:       ${proc.procedureType}`);
        console.log(`  Confidence: ${proc.confidence?.toFixed(3) ?? "n/a"}`);
        console.log(
          `  Success:    ${proc.successCount} (procedure table) + ${versions.reduce((s, v) => s + v.successCount, 0)} (versions) = ${totalSuccess}`,
        );
        console.log(
          `  Failure:   ${proc.failureCount} (procedure table) + ${versions.reduce((s, v) => s + v.failureCount, 0)} (versions) = ${totalFailure}`,
        );
        console.log(`  Rate:      ${(rate * 100).toFixed(1)}%`);
        console.log(`  Outcome:   ${proc.lastOutcome ?? "unknown"}`);
        console.log(
          `  Last Validated: ${proc.lastValidated ? new Date(proc.lastValidated * 1000).toISOString() : "never"}`,
        );
        console.log(`  Last Failed:   ${proc.lastFailed ? new Date(proc.lastFailed * 1000).toISOString() : "never"}`);

        if (proc.avoidanceNotes && proc.avoidanceNotes.length > 0) {
          console.log("\n  Avoidance notes (all versions):");
          for (const note of proc.avoidanceNotes) {
            console.log(`    - ${note}`);
          }
        }

        if (versions.length > 0) {
          console.log(`\n  Versions (${versions.length}):`);
          for (const v of versions) {
            const pct =
              v.successCount + v.failureCount > 0
                ? ` (${((v.successCount / (v.successCount + v.failureCount)) * 100).toFixed(0)}% success)`
                : "";
            console.log(`    v${v.versionNumber}: ${v.successCount} OK, ${v.failureCount} failed${pct}`);
            if (v.avoidanceNotes && v.avoidanceNotes.length > 0) {
              for (const note of v.avoidanceNotes.slice(0, 3)) {
                console.log(`      ⚠ ${note}`);
              }
            }
          }
        }

        if (failures.length > 0) {
          console.log(`\n  Recent failures (${failures.length} total):`);
          for (const f of failures.slice(0, 10)) {
            const when = new Date(f.timestamp * 1000).toISOString();
            const step = f.failedAtStep !== null ? ` step ${f.failedAtStep}` : "";
            console.log(`    [${when}] v${f.versionNumber}${step}: ${f.context ?? "(no context)"}`);
          }
        } else {
          console.log("\n  No failures recorded.");
        }
      }),
    );

  procedureCmd
    .command("list")
    .description("List all procedures (optionally filtered by type)")
    .option("--type <type>", "Filter by type: positive, negative, or all (default: all)")
    .option("--limit <n>", "Maximum number to show (default: 20)")
    .action(
      withExit(async (opts: { type?: string; limit?: number }) => {
        const limit = opts.limit ?? 20;
        const procs = factsDb.listProcedures(limit * 3); // over-fetch then filter
        const filtered = opts.type && opts.type !== "all" ? procs.filter((p) => p.procedureType === opts.type) : procs;
        const shown = filtered.slice(0, limit);

        console.log(`Procedures (showing ${shown.length} of ${filtered.length}):`);
        for (const p of shown) {
          const rate = p.successRate !== undefined ? ` ${(p.successRate * 100).toFixed(0)}%` : "";
          const ver = p.version !== undefined ? ` v${p.version}` : "";
          console.log(
            `  [${p.id.slice(0, 8)}] ${p.procedureType.padEnd(8)} ${rate.padEnd(6)} ${ver} "${p.taskPattern.slice(0, 60)}"`,
          );
        }
      }),
    );

  mem
    .command("version")
    .description("Show installed version and latest available on GitHub and npm")
    .option("--json", "Machine-readable JSON output")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const installed = ctx.versionInfo.pluginVersion;
        const timeoutMs = 3000;
        const fetchWithTimeout = async (url: string): Promise<Response> => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), timeoutMs);
          try {
            const res = await fetch(url, { signal: c.signal });
            clearTimeout(t);
            return res;
          } catch (err) {
            clearTimeout(t);
            if (err instanceof Error && err.name === "AbortError") throw new Error("Request timed out");
            throw err;
          }
        };

        let githubVersion: string | null = null;
        let npmVersion: string | null = null;
        try {
          const ghRes = await fetchWithTimeout(
            "https://api.github.com/repos/markus-lassfolk/openclaw-hybrid-memory/releases/latest",
          );
          if (ghRes.ok) {
            const data = (await ghRes.json()) as { tag_name?: string };
            const tag = data.tag_name;
            githubVersion = typeof tag === "string" ? tag.replace(/^v/, "") : null;
          }
        } catch {
          githubVersion = null;
        }
        try {
          const npmRes = await fetchWithTimeout("https://registry.npmjs.org/openclaw-hybrid-memory/latest");
          if (npmRes.ok) {
            const data = (await npmRes.json()) as { version?: string };
            npmVersion = typeof data.version === "string" ? data.version : null;
          }
        } catch {
          npmVersion = null;
        }

        const compare = (a: string, b: string): number => {
          const parseNum = (s: string): number => {
            const n = Number.parseInt(s, 10);
            return Number.isNaN(n) ? 0 : n;
          };
          const pa = a
            .replace(/[-+].*/, "")
            .split(".")
            .map(parseNum);
          const pb = b
            .replace(/[-+].*/, "")
            .split(".")
            .map(parseNum);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const va = pa[i] ?? 0;
            const vb = pb[i] ?? 0;
            if (va !== vb) return va < vb ? -1 : 1;
          }
          return 0;
        };
        const updateHint = (latest: string | null) => {
          if (latest == null) return "";
          return compare(installed, latest) < 0 ? " ⬆ update available" : " (up to date)";
        };

        if (opts?.json) {
          console.log(
            JSON.stringify(
              {
                name: "openclaw-hybrid-memory",
                installed,
                github: githubVersion ?? "unavailable",
                npm: npmVersion ?? "unavailable",
                updateAvailable:
                  (githubVersion != null && compare(installed, githubVersion) < 0) ||
                  (npmVersion != null && compare(installed, npmVersion) < 0),
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log("openclaw-hybrid-memory");
        console.log(`  Installed:  ${installed}`);
        console.log(
          `  GitHub:     ${githubVersion ?? "unavailable"}${githubVersion != null && compare(installed, githubVersion) > 0 ? " (installed is newer)" : updateHint(githubVersion)}`,
        );
        console.log(
          `  npm:        ${npmVersion ?? "unavailable"}${npmVersion != null && compare(installed, npmVersion) > 0 ? " (installed is newer)" : updateHint(npmVersion)}`,
        );
      }),
    );

  mem
    .command("upgrade [version]")
    .description("Upgrade hybrid-mem to a specific version (or latest). Downloads and installs plugin from GitHub.")
    .action(
      withExit(async (version?: string) => {
        const res = await runUpgrade(version);
        if (res.ok) {
          console.log(`Upgraded to version ${res.version}. Plugin installed at: ${res.pluginDir}`);
          if (res.workspaceSkillPath) {
            console.log(
              `Workspace skill: ${res.workspaceSkillPath}${res.workspaceSkillError ? ` (warning: ${res.workspaceSkillError})` : ""}`,
            );
          }
          if (res.workspaceToolsMdPath) {
            const toolsSuffix = res.workspaceToolsMdError
              ? ` (warning: ${res.workspaceToolsMdError})`
              : res.workspaceToolsMdUpdated === true
                ? " (updated)"
                : res.workspaceToolsMdUpdated === false
                  ? " (unchanged)"
                  : "";
            console.log(`TOOLS.md: ${res.workspaceToolsMdPath}${toolsSuffix}`);
          }
        } else {
          console.error(`Error upgrading: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("uninstall")
    .description("Uninstall hybrid-mem: clean plugin files, optionally remove from OpenClaw config")
    .option("--clean-all", "Remove all plugin data (SQLite, LanceDB, reports, config)")
    .option("--leave-config", "Keep OpenClaw config entry (just clean plugin files)")
    .action(
      withExit(async (opts?: { cleanAll?: boolean; leaveConfig?: boolean }) => {
        let res;
        try {
          res = await runUninstall({
            cleanAll: !!opts?.cleanAll,
            leaveConfig: !!opts?.leaveConfig,
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "uninstall",
          });
          throw err;
        }
        if (res.outcome === "config_updated") {
          console.log(`Uninstalled ${res.pluginId}: config updated, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_not_found") {
          console.log(`Uninstalled ${res.pluginId}: config not found, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_error") {
          console.error(
            `Uninstalled ${res.pluginId}: config error (${res.error}), cleaned ${res.cleaned.length} files.`,
          );
        } else if (res.outcome === "leave_config") {
          console.log(`Uninstalled ${res.pluginId}: config left intact, cleaned ${res.cleaned.length} files.`);
        }
      }),
    );

  // Issue #276 — Backup commands
  const backup = mem
    .command("backup")
    .description(
      `Create a snapshot backup of memory state (SQLite + LanceDB). Default destination: ~/.openclaw/backups/memory/TIMESTAMP/\n\nNOTE: To include memory in scheduled openclaw backups, add these paths to your openclaw.yaml backup config:\n  - ${resolvedSqlitePath ?? "<memoryDir>/memory.db"}\n  - ${resolvedLancePath ?? "<memoryDir>/lance/"}`,
    )
    .option("--dest <dir>", "Override backup destination directory")
    .action(
      withExit(async (opts?: { dest?: string }) => {
        if (!runBackup) {
          console.error("Backup is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        console.log("Creating memory backup…");
        const res = await runBackup({ backupDir: opts?.dest });

        // State file path for heartbeat monitoring (Issue #276, Gap 5)
        const stateDir = join(homedir(), ".openclaw", "state");
        const backupStateFile = join(stateDir, "memory-backup-last.json");

        if (res.ok) {
          const sqliteKb = (res.sqliteSize / 1024).toFixed(1);
          const lanceKb = (res.lancedbSize / 1024).toFixed(1);
          console.log(`✓ Backup complete in ${res.durationMs}ms`);
          console.log(`  Location: ${res.backupDir}`);
          console.log(`  SQLite:   ${sqliteKb} KB${res.integrityOk ? " (integrity OK)" : " ⚠ integrity check failed"}`);
          console.log(`  LanceDB:  ${lanceKb} KB`);
          if (!res.integrityOk) {
            console.warn("⚠ SQLite integrity check failed — backup may be from a corrupt source.");
          }
          // Record successful backup state for heartbeat monitoring
          try {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              backupStateFile,
              `${JSON.stringify(
                {
                  ok: true,
                  timestamp: new Date().toISOString(),
                  backupDir: res.backupDir,
                  sqliteSize: res.sqliteSize,
                  lancedbSize: res.lancedbSize,
                  durationMs: res.durationMs,
                  integrityOk: res.integrityOk,
                },
                null,
                2,
              )}\n`,
            );
          } catch {
            // Non-fatal — state file is advisory only
          }
        } else {
          console.error(`✗ Backup failed: ${res.error}`);
          // Write failure state so heartbeat monitoring can detect and alert (Issue #276, Gap 5)
          try {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              backupStateFile,
              `${JSON.stringify(
                {
                  ok: false,
                  timestamp: new Date().toISOString(),
                  error: res.error,
                },
                null,
                2,
              )}\n`,
            );
            console.error(`  ⚠ Backup failure recorded to: ${backupStateFile}`);
            console.error("  Add to HEARTBEAT.md to get alerted:");
            console.error("    Check ~/.openclaw/state/memory-backup-last.json — if ok=false, alert Markus.");
          } catch {
            // Non-fatal
          }
          process.exitCode = 1;
        }
      }),
    );

  backup
    .command("verify")
    .description("Verify SQLite DB integrity without creating a new backup.")
    .action(
      withExit(async () => {
        if (!runBackupVerify) {
          console.error("Backup verify is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        const res = runBackupVerify();
        if (res.ok) {
          const status = res.integrityOk ? "✓" : "✗";
          console.log(`${status} ${res.message}`);
          if (!res.integrityOk) process.exitCode = 1;
        } else {
          console.error(`✗ Verify failed: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  // Issue #276, Gap 4 — Schedule backup via system cron
  backup
    .command("schedule")
    .description(
      "Print cron setup instructions for automated weekly memory backups.\n\n" +
        "Installs a cron entry (schedule from config, default: weekly Sunday at 04:00) that runs\n" +
        "`hybrid-mem backup` and writes output to ~/.openclaw/logs/backup.log.\n\n" +
        "The backup state is recorded to ~/.openclaw/state/memory-backup-last.json\n" +
        "so HEARTBEAT.md monitoring can detect failures.",
    )
    .option("--dry-run", "Print the cron line without installing it")
    .action(
      withExit(async (opts?: { dryRun?: boolean }) => {
        // Use config-provided cron expression (falls back to the same default as parseCronReliabilityConfig)
        const cronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
        const hybridMemBin = "hybrid-mem"; // resolved by PATH at runtime
        const logDir = join(homedir(), ".openclaw", "logs");
        const logFile = join(logDir, "backup.log");
        const cronLine = `${cronExpr} ${hybridMemBin} backup >> ${shellQuotePathForCron(logFile)} 2>&1`;

        if (opts?.dryRun) {
          console.log("Cron line (dry-run — not installed):");
          console.log(`  ${cronLine}`);
          return;
        }

        // Attempt to install via crontab
        try {
          mkdirSync(logDir, { recursive: true });
        } catch {
          // Non-fatal
        }

        let currentCrontab = "";
        try {
          currentCrontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
        } catch {
          // No existing crontab — that's fine
        }

        if (currentCrontab.includes("hybrid-mem backup")) {
          console.log("✓ A hybrid-mem backup cron entry already exists:");
          const existing = currentCrontab.split("\n").find((l) => l.includes("hybrid-mem backup"));
          if (existing) console.log(`  ${existing}`);
          return;
        }

        const newCrontab = `${(currentCrontab.trimEnd() ? `${currentCrontab.trimEnd()}\n` : "") + cronLine}\n`;
        try {
          const tmpFile = join(tmpdir(), `crontab-hybrid-mem-${Date.now()}.txt`);
          writeFileSync(tmpFile, newCrontab, "utf-8");
          execSync(`crontab ${tmpFile}`);
          try {
            unlinkSync(tmpFile);
          } catch {
            /* ignore */
          }
          console.log(`✓ Weekly backup scheduled (${cronExpr}).`);
          console.log(`  Log: ${logFile}`);
          console.log(`  State: ${join(homedir(), ".openclaw", "state", "memory-backup-last.json")}`);
          console.log("");
          console.log("Add to HEARTBEAT.md to get alerted on failure:");
          console.log("  Check ~/.openclaw/state/memory-backup-last.json — if ok=false, alert Markus.");
        } catch (err) {
          console.error(`✗ Failed to install crontab: ${err}`);
          console.log("");
          console.log("Add manually with: crontab -e");
          console.log(`  ${cronLine}`);
          process.exitCode = 1;
        }
      }),
    );

  // Issue #281 — Maintenance status command
  const maintenance = mem
    .command("maintenance")
    .description("Memory maintenance management and health checks (Issue #281).");

  maintenance
    .command("status")
    .description("Show maintenance cron job health: nightly cycle, weekly backup, and any reliability issues.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const cronStorePath = join(homedir(), ".openclaw", "cron", "jobs.json");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const nightlyCronExpr = cfg.maintenance?.cronReliability?.nightlyCron ?? "0 3 * * *";
        const weeklyBackupCronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";

        /** Job health record */
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

        const jobsOfInterest: Array<{ id: string; label: string; scheduleExpr: string; staleMs: number }> = [
          {
            id: "hybrid-mem:nightly-distill",
            label: "nightly-memory-sweep",
            scheduleExpr: nightlyCronExpr,
            staleMs: staleThresholdMs,
          },
          {
            id: "hybrid-mem:nightly-dream-cycle",
            label: "nightly-dream-cycle",
            scheduleExpr: cfg.nightlyCycle?.schedule ?? "45 2 * * *",
            staleMs: staleThresholdMs,
          },
          {
            id: "hybrid-mem:weekly-reflection",
            label: "weekly-reflection",
            scheduleExpr: "0 3 * * 0",
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:weekly-extract-procedures",
            label: "weekly-extract-procedures",
            scheduleExpr: "0 4 * * 0",
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:weekly-deep-maintenance",
            label: "weekly-deep-maintenance",
            scheduleExpr: weeklyBackupCronExpr,
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:monthly-consolidation",
            label: "monthly-consolidation",
            scheduleExpr: "0 5 1 * *",
            staleMs: 32 * 24 * 60 * 60 * 1000,
          },
        ];

        const results: JobStatus[] = [];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        if (existsSync(cronStorePath)) {
          try {
            cronStore = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
          } catch {
            // corrupt store — treat all as missing
          }
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
            | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string }
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
            issue = `Job is stale — last run was ${hoursSince}h ago (threshold: ${Math.floor(wanted.staleMs / 3600000)}h).`;
          } else if (lastStatus === "error") {
            issue = `Last run failed: ${state?.lastError ?? "unknown error"}`;
          }

          results.push({
            name: wanted.label,
            pluginJobId: wanted.id,
            enabled,
            lastRunAt: lastRunAtMs != null ? new Date(lastRunAtMs).toISOString() : null,
            nextRunAt: nextRunAtMs != null ? new Date(nextRunAtMs).toISOString() : null,
            lastStatus,
            isStale,
            isMissing: false,
            configuredSchedule: wanted.scheduleExpr,
            issue,
          });
        }

        const issues = results.filter((r) => r.issue);

        if (opts?.json) {
          console.log(JSON.stringify({ ok: issues.length === 0, jobs: results, issueCount: issues.length }, null, 2));
          return;
        }

        // Human-readable output
        console.log("Memory Maintenance Status (Issue #281)");
        console.log("========================================");
        console.log(`Cron store: ${cronStorePath}`);
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
        if (issues.length === 0) {
          console.log("✅ All maintenance jobs healthy.");
        } else {
          console.log(`⚠️  ${issues.length} issue(s) detected. Run \`hybrid-mem verify --fix\` to repair.`);
          if (issues.some((r) => r.isMissing)) {
            console.log("   Missing jobs can be registered with: hybrid-mem install");
          }
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
        const cronStorePath = join(homedir(), ".openclaw", "cron", "jobs.json");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const criticalJobs = [
          "hybrid-mem:nightly-distill",
          "hybrid-mem:weekly-reflection",
          "hybrid-mem:weekly-deep-maintenance",
        ];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        if (existsSync(cronStorePath)) {
          try {
            cronStore = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
          } catch {
            console.warn("⚠ Could not read cron store — skipping health check.");
            return;
          }
        } else {
          console.warn("⚠ Cron store not found — maintenance jobs not installed. Run: hybrid-mem install");
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
            continue; // Disabled by user intent — not an error
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
        }
      }),
    );
}
