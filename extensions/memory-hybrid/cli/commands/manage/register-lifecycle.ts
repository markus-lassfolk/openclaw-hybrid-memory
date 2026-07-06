/**
 * Entity lifecycle CLIs (Issue #1196 Phase 1 + Phase 2).
 */

import type { DecayClass } from "../../../config.js";
import { syncLifecycleFromGitHub } from "../../../services/lifecycle/github-adapter.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import { runMaintenanceHeartbeat } from "./maintenance-heartbeat.js";

export function registerEntityLifecycleCommands(entitiesCommand: Chainable, b: ManageBindings): void {
  const { factsDb } = b;

  const lifecycleCmd = entitiesCommand
    .command("lifecycle")
    .description("Entity lifecycle reports (TTL / decay hygiene backed by facts DB)");

  lifecycleCmd
    .command("report")
    .description("Summarize entity rows for lifecycle review (calls factsDb.lifecycleEntityReport)")
    .option("--limit <n>", "Max entities in report", "100")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { limit?: string; json?: boolean }) => {
        const limit = Number.parseInt(opts?.limit ?? "100", 10);
        if (!Number.isFinite(limit) || limit < 1) {
          console.error("error: --limit must be a positive integer");
          process.exitCode = 1;
          return;
        }
        const report = factsDb.lifecycleEntityReport(limit);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Lifecycle entity report (limit=${limit})`);
        console.log(JSON.stringify(report, null, 2));
      }),
    );
}

/** Phase 2 GitHub lifecycle sync — `openclaw hybrid-mem lifecycle sync github` (#1196). */
export function registerLifecycleSyncCommands(mem: Chainable, b: ManageBindings): void {
  const { factsDb, cfg } = b;
  const lifecycleCmd = mem.command("lifecycle").description("Lifecycle adapters (#1196 Phase 2)");
  const syncCmd = lifecycleCmd.command("sync").description("Sync lifecycle state from external sources");
  syncCmd
    .command("github")
    .description("Sync from GitHub: PR/Issue state → fact expires_at/decay_class")
    .option("--dry-run", "Do not apply changes; report counts only")
    .option("--json", "Emit JSON report")
    .option("-v, --verbose", "Emit periodic progress heartbeat and per-row sync progress")
    .action(
      withExit(async (opts?: { dryRun?: boolean; json?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const logger = {
          info: (msg: string) => console.log(msg),
          warn: (msg: string) => console.warn(msg),
        };
        try {
          let progress = { scanned: 0, total: 0, matched: 0 };
          const report = await runMaintenanceHeartbeat(
            "lifecycle-sync-github",
            verbose,
            (heartbeat) =>
              syncLifecycleFromGitHub(factsDb, {
                config: cfg.lifecycle.adapters.github,
                apply: opts?.dryRun !== true,
                logger,
                reportEvery: 25,
                onProgress: (next) => {
                  progress = next;
                  heartbeat.heartbeat();
                },
              }),
            {
              progressSupplier: () => `scanned=${progress.scanned}/${progress.total}; matched=${progress.matched}`,
              jsonMode: opts?.json === true,
            },
          );
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(
            `lifecycle sync github ${opts?.dryRun ? "(dry-run)" : ""}: scanned=${report.scanned} matched=${report.matched} expiredNow=${report.expiredNow} expiredSoon=${report.expiredSoon} keptStable=${report.keptStable}${report.errors.length > 0 ? ` errors=${report.errors.length}` : ""}`,
          );
          const syncErrors = report.errors.length;
          const summary = `lifecycle-sync matched=${report.matched} sync_errors=${syncErrors} semantic=${syncErrors > 0 ? "partial" : "success"}`;
          console.log(summary);
          if (syncErrors > 0) {
            process.exitCode = 2;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`lifecycle sync github: ${message}`);
          process.exitCode = 1;
        }
      }),
    );
}

/** Matches the `entity` column via SQL LIKE glob (same as factsDb.expireBySourcePattern). */
export function registerExpireBySourceCommands(mem: Chainable, b: ManageBindings): void {
  const { factsDb } = b;

  mem
    .command("expire-by-source")
    .description(
      "Set decay_class + expires_at on facts whose entity matches a glob pattern (SQL LIKE on entity column; Issue #1196)",
    )
    .requiredOption("--pattern <glob>", "Glob pattern for entity column, e.g. 'temp/*' or 'session-*'")
    .requiredOption("--days <n>", "TTL in days from now for matched rows")
    .option("--apply", "Apply updates (default dry-run)")
    .option("--decay-class <c>", "Decay class to assign", "short")
    .option("--json", "Emit JSON report only")
    .action(
      withExit(
        async (opts: { pattern: string; days: string; apply?: boolean; decayClass?: string; json?: boolean }) => {
          const ttlDays = Number.parseInt(opts.days, 10);
          if (!Number.isFinite(ttlDays) || ttlDays < 1) {
            console.error("error: --days must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const report = factsDb.expireBySourcePattern({
            pattern: opts.pattern,
            ttlDays,
            decayClass: (opts.decayClass ?? "short") as DecayClass,
            apply: opts.apply === true,
          });
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(
            `expire-by-source ${report.apply ? "APPLY" : "dry-run"}: pattern=${report.pattern} matched=${report.matched} changed=${report.changed} decayClass=${report.decayClass} ttlDays=${report.ttlDays}`,
          );
        },
      ),
    );
}
