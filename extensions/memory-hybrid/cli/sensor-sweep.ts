/**
 * CLI commands for sensor sweep (cron-based data collection, no LLM).
 * Issue #236
 */

import { capturePluginError } from "../services/error-reporter.js";
import { sweepAll, type SweepAllOpts } from "../services/sensor-sweep.js";
import type { EventBus } from "../backends/event-bus.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { withExit, type Chainable } from "./shared.js";

export interface SensorSweepContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
  eventBus: EventBus;
  resolvedSqlitePath: string;
}

export type SensorSweepCliResult = {
  ok: boolean;
  sensors: Array<{ sensor: string; eventsWritten: number; eventsSkipped: number; error?: string }>;
  totalWritten: number;
  totalSkipped: number;
  errors: string[];
  dryRun: boolean;
};

export function registerSensorSweepCommands(mem: Chainable, ctx: SensorSweepContext): void {
  mem
    .command("sensor-sweep")
    .description("Run sensor sweeps — collect raw data and write events to the Event Bus (no LLM)")
    .option("--tier <n>", "Sensor tier to run: 1 (Tier 1 only), 2 (Tier 2 only), all (default: 1)", "1")
    .option("--source <names>", "Comma-separated list of sensor sources to run (e.g. garmin,github)")
    .option("--dry-run", "Preview what would be collected without writing events")
    .option("--json", "Output results as JSON")
    .action(
      withExit(async (opts: { tier?: string; source?: string; dryRun?: boolean; json?: boolean }) => {
        try {
          if (!ctx.cfg.sensorSweep.enabled) {
            if (opts.json) {
              process.stdout.write(JSON.stringify({ ok: false, error: "sensorSweep.enabled is false in config" }) + "\n");
            } else {
              process.stdout.write("Sensor sweep is disabled. Set sensorSweep.enabled: true in your config.\n");
            }
            return;
          }

          const tierRaw = opts.tier ?? "1";
          let tier: SweepAllOpts["tier"] = 1;
          if (tierRaw === "2") tier = 2;
          else if (tierRaw === "all") tier = "all";
          else tier = 1;

          const sources = opts.source
            ? opts.source.split(",").map((s) => s.trim()).filter(Boolean)
            : null;

          const sweepOpts: SweepAllOpts = {
            tier,
            sources: sources ?? undefined,
            dryRun: opts.dryRun === true,
            resolvedSqlitePath: ctx.resolvedSqlitePath,
          };

          const result = await sweepAll(ctx.eventBus, ctx.cfg.sensorSweep, ctx.factsDb, sweepOpts);

          const cliResult: SensorSweepCliResult = {
            ok: result.errors.length === 0,
            sensors: result.sensors,
            totalWritten: result.totalWritten,
            totalSkipped: result.totalSkipped,
            errors: result.errors,
            dryRun: opts.dryRun === true,
          };

          if (opts.json) {
            process.stdout.write(JSON.stringify(cliResult, null, 2) + "\n");
          } else {
            const prefix = opts.dryRun ? "[dry-run] " : "";
            process.stdout.write(`${prefix}Sensor sweep complete:\n`);
            for (const s of result.sensors) {
              const status = s.error ? `ERROR: ${s.error}` : `wrote=${s.eventsWritten} skipped=${s.eventsSkipped}`;
              process.stdout.write(`  ${s.sensor}: ${status}\n`);
            }
            process.stdout.write(`Total: ${result.totalWritten} written, ${result.totalSkipped} skipped\n`);
            if (result.errors.length > 0) {
              process.stdout.write(`Errors:\n`);
              for (const e of result.errors) {
                process.stdout.write(`  - ${e}\n`);
              }
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "sensor-sweep-cli",
            severity: "error",
            subsystem: "sensor-sweep",
          });
          throw err;
        }
      }),
    );

  // Sub-command: query events from the event bus
  mem
    .command("sensor-events")
    .description("Query events in the Event Bus (written by sensor sweeps)")
    .option("--type <type>", "Filter by event type (e.g. sensor.garmin)")
    .option("--status <status>", "Filter by status: raw, processed, surfaced, pushed, archived (default: raw)")
    .option("--limit <n>", "Max events to return (default: 20)", "20")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts: { type?: string; status?: string; limit?: string; json?: boolean }) => {
        try {
          const limit = Math.min(parseInt(opts.limit ?? "20", 10) || 20, 200);
          const events = ctx.eventBus.queryEvents({
            type: opts.type,
            status: (opts.status ?? "raw") as import("../backends/event-bus.js").EventStatus,
            limit,
          });

          if (opts.json) {
            process.stdout.write(JSON.stringify(events, null, 2) + "\n");
          } else {
            if (events.length === 0) {
              process.stdout.write("No events found.\n");
              return;
            }
            process.stdout.write(`${events.length} event(s):\n`);
            for (const e of events) {
              process.stdout.write(
                `  [${e.id}] ${e.event_type} (${e.source}) importance=${e.importance} status=${e.status} at=${e.created_at}\n`,
              );
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "sensor-events-cli",
            severity: "error",
            subsystem: "sensor-sweep",
          });
          throw err;
        }
      }),
    );
}
