/**
 * Entity lifecycle CLIs (Issue #1196 Phase 1).
 */

import type { DecayClass } from "../../../config.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

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
        async (opts: {
          pattern: string;
          days: string;
          apply?: boolean;
          decayClass?: string;
          json?: boolean;
        }) => {
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
