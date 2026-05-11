/**
 * CLI command for quick health status with traffic-light indicators
 */

import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { detectAvailableProviders } from "../utils/provider-detection.js";

interface HealthIndicator {
  name: string;
  status: "good" | "warn" | "error";
  detail: string;
}

export function registerHealthCommand(
  program: Chainable,
  cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  vectorDb: VectorDB,
): void {
  program
    .command("health")
    .description("Show quick health status with traffic-light indicators (🟢 good, 🟡 warn, 🔴 error)")
    .option("--json", "Output health status as JSON")
    .action(async (opts: { json?: boolean }) => {
      const indicators: HealthIndicator[] = [];

      // Check embedding provider
      try {
        const providers = await detectAvailableProviders(cfg.embedding?.apiKey);
        const current = providers.find((p) => p.provider === cfg.embedding?.provider);
        if (current?.available) {
          indicators.push({
            name: "Embedding Provider",
            status: "good",
            detail: `${cfg.embedding?.provider} connected`,
          });
        } else {
          indicators.push({
            name: "Embedding Provider",
            status: "error",
            detail: current?.reason || "Not configured",
          });
        }
      } catch (_error) {
        indicators.push({
          name: "Embedding Provider",
          status: "error",
          detail: "Failed to check",
        });
      }

      let factCount: number | null = null;
      let vectorCount: number | null = null;

      // Check database health
      try {
        factCount = factsDb.getCount();
        indicators.push({
          name: "Database",
          status: "good",
          detail: `${factCount} facts`,
        });
      } catch (_error) {
        indicators.push({
          name: "Database",
          status: "error",
          detail: "Connection failed",
        });
      }

      try {
        vectorCount = (await vectorDb.getAllIds()).length;
      } catch {
        vectorCount = null;
      }

      // Check memory size
      try {
        if (factCount === null || vectorCount === null) throw new Error("count unavailable");

        if (factCount === 0) {
          indicators.push({
            name: "Memory Size",
            status: "warn",
            detail: "No facts stored yet",
          });
        } else if (factCount < 100) {
          indicators.push({
            name: "Memory Size",
            status: "good",
            detail: `${factCount} facts, ${vectorCount} vectors`,
          });
        } else {
          indicators.push({
            name: "Memory Size",
            status: "good",
            detail: `${factCount} facts, ${vectorCount} vectors`,
          });
        }
      } catch (_error) {
        indicators.push({
          name: "Memory Size",
          status: "error",
          detail: "Failed to check",
        });
      }

      // Check database sync
      try {
        if (factCount === null || vectorCount === null) throw new Error("count unavailable");
        const diff = Math.abs(factCount - vectorCount);
        const percentDiff = (diff / Math.max(factCount, 1)) * 100;

        if (percentDiff < 5) {
          indicators.push({
            name: "Database Sync",
            status: "good",
            detail: `Synchronized (±${diff})`,
          });
        } else if (percentDiff < 20) {
          indicators.push({
            name: "Database Sync",
            status: "warn",
            detail: `Out of sync by ${diff} items`,
          });
        } else {
          indicators.push({
            name: "Database Sync",
            status: "error",
            detail: `Severely out of sync (${diff} items)`,
          });
        }
      } catch (_error) {
        indicators.push({
          name: "Database Sync",
          status: "warn",
          detail: "Could not verify",
        });
      }

      // JSON output
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              overall: indicators.every((i) => i.status === "good")
                ? "healthy"
                : indicators.some((i) => i.status === "error")
                  ? "unhealthy"
                  : "degraded",
              indicators,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        return;
      }

      // Human-readable output
      console.log("\n🏥 Hybrid Memory Health Status\n");

      for (const indicator of indicators) {
        const icon = indicator.status === "good" ? "🟢" : indicator.status === "warn" ? "🟡" : "🔴";
        console.log(`${icon} ${indicator.name}: ${indicator.detail}`);
      }

      console.log();

      // Overall status
      const hasErrors = indicators.some((i) => i.status === "error");
      const hasWarnings = indicators.some((i) => i.status === "warn");

      if (hasErrors) {
        console.log("❌ System is unhealthy. Run: openclaw hybrid-mem doctor\n");
        process.exit(1);
      } else if (hasWarnings) {
        console.log("⚠️  System is degraded. Consider running: openclaw hybrid-mem doctor\n");
      } else {
        console.log("✅ System is healthy!\n");
      }
    });
}
