/**
 * Sensor sweep CLI — wraps sweepAll service (Issue #236).
 */

import { join, dirname } from "node:path";
import { EventBus } from "../../../backends/event-bus.js";
import { sweepAll } from "../../../services/sensor-sweep.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerSensorSweepCommand(mem: Chainable, b: ManageBindings): void {
  mem
    .command("sensor-sweep")
    .description("Run sensor sweep tiers (structured data collection to event bus; no LLM at sweep time)")
    .option("--tier <n>", "Tier to run: 1, 2, or all", "all")
    .option("--dry-run", "Preview without writing events")
    .action(
      withExit(async (opts?: { tier?: string; dryRun?: boolean }) => {
        if (!b.cfg.sensorSweep?.enabled) {
          console.log("sensor-sweep: skipped (sensorSweep.enabled = false)");
          return;
        }
        const eventBusPath = b.resolvedSqlitePath
          ? join(dirname(b.resolvedSqlitePath), "event-bus.db")
          : null;
        if (!eventBusPath) {
          throw new Error("sensor-sweep requires resolvedSqlitePath to locate event-bus.db");
        }
        const eventBus = new EventBus(eventBusPath);
        try {
          const tierRaw = String(opts?.tier ?? "all").trim().toLowerCase();
          const tier = tierRaw === "all" ? "all" : tierRaw === "2" ? 2 : 1;
          const result = await sweepAll(eventBus, b.cfg.sensorSweep, b.factsDb, {
            tier,
            dryRun: opts?.dryRun,
            resolvedSqlitePath: b.resolvedSqlitePath,
          });
          console.log(
            `sensor-sweep tier=${tier}: written=${result.totalWritten} skipped=${result.totalSkipped} errors=${result.errors.length}`,
          );
          if (result.errors.length > 0) {
            for (const err of result.errors.slice(0, 5)) console.error(`  ${err}`);
            process.exitCode = 1;
          }
        } finally {
          eventBus.close?.();
        }
      }),
    );
}
