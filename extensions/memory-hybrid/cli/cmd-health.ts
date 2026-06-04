/**
 * CLI command for quick health status with traffic-light indicators
 */

import { existsSync, statSync } from "node:fs";
import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import { getWalCircuitBreakerState } from "../services/wal-helpers.js";
import { detectAvailableProviders } from "../utils/provider-detection.js";
import { formatBytes, WAL_SIZE_WARN_BYTES } from "../utils/format.js";

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
  wal: WriteAheadLog | null = null,
): void {
  program
    .command("health")
    .description("Show quick health status with traffic-light indicators (🟢 good, 🟡 warn, 🔴 error)")
    .option("--json", "Output health status as JSON")
    .action(async (opts: { json?: boolean }) => {
      const indicators: HealthIndicator[] = [];

      // Check embedding provider
      try {
        const providers = await detectAvailableProviders(cfg.embedding?.apiKey, cfg.embedding?.googleApiKey);
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

      // Check WAL health
      if (!cfg.wal?.enabled) {
        indicators.push({
          name: "WAL",
          status: "warn",
          detail: "Disabled in config (crash replay unavailable)",
        });
      } else if (!wal) {
        indicators.push({
          name: "WAL",
          status: "error",
          detail: "Enabled in config but WAL runtime is unavailable",
        });
      } else {
        try {
          const breaker = getWalCircuitBreakerState(wal);
          const walPath = breaker.walPath ?? cfg.wal.walPath ?? "unknown";
          const walSizeBytes =
            breaker.walPath && existsSync(breaker.walPath) ? Math.max(0, statSync(breaker.walPath).size) : 0;
          const { entries: allEntries, hadCorruption } = await wal.readAllRecoverable();
          const validEntries = await wal.getValidEntries();
          const staleEntries = Math.max(0, allEntries.length - validEntries.length);

          if (breaker.persistentDisabled) {
            indicators.push({
              name: "WAL",
              status: "error",
              detail: `Persistently disabled via circuit breaker (${breaker.sentinelPath ?? walPath})`,
            });
          } else if (breaker.inMemoryDisabled) {
            indicators.push({
              name: "WAL",
              status: "warn",
              detail: "Circuit breaker open in current process",
            });
          } else if (hadCorruption || walSizeBytes > WAL_SIZE_WARN_BYTES || staleEntries > 0) {
            const corruptionNote = hadCorruption ? ", corruption detected (run verify --fix)" : "";
            indicators.push({
              name: "WAL",
              status: "warn",
              detail: `${validEntries.length} pending, ${staleEntries} stale${corruptionNote}, ${formatBytes(walSizeBytes)} at ${walPath}`,
            });
          } else {
            indicators.push({
              name: "WAL",
              status: "good",
              detail: `${validEntries.length} pending, ${formatBytes(walSizeBytes)} at ${walPath}`,
            });
          }
        } catch (error) {
          indicators.push({
            name: "WAL",
            status: "error",
            detail: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Decay profile guidance (Issue #1582).
      try {
        const decayBreakdown =
          typeof (factsDb as { statsBreakdownByDecayClass?: unknown }).statsBreakdownByDecayClass === "function"
            ? (
                factsDb as {
                  statsBreakdownByDecayClass: () => Record<string, number>;
                }
              ).statsBreakdownByDecayClass()
            : null;
        if (decayBreakdown) {
          const total = Object.values(decayBreakdown).reduce((sum, count) => sum + count, 0);
          const stablePermanent = (decayBreakdown.stable ?? 0) + (decayBreakdown.permanent ?? 0);
          const ratio = total > 0 ? stablePermanent / total : 0;
          if (ratio > 0.6) {
            indicators.push({
              name: "Decay Profile",
              status: "warn",
              detail: `stable+permanent ${(ratio * 100).toFixed(1)}% — run: openclaw hybrid-mem decay reclassify --dry-run --stable-only`,
            });
          } else {
            indicators.push({
              name: "Decay Profile",
              status: "good",
              detail: `stable+permanent ${(ratio * 100).toFixed(1)}%`,
            });
          }
        }
      } catch (_error) {
        indicators.push({
          name: "Decay Profile",
          status: "warn",
          detail: "Could not inspect decay distribution",
        });
      }

      // Vector bounds visibility (Issue #1554).
      try {
        const bounds =
          typeof (vectorDb as { getRuntimeBounds?: unknown }).getRuntimeBounds === "function"
            ? (
                vectorDb as {
                  getRuntimeBounds: () => {
                    vectorSearchMaxResults: number;
                    semanticCacheMaxRowsPerFilterKey: number;
                    semanticCacheCandidateLimitMax: number;
                  };
                }
              ).getRuntimeBounds()
            : null;
        if (bounds) {
          indicators.push({
            name: "Vector Bounds",
            status: "good",
            detail: `search<=${bounds.vectorSearchMaxResults}, cacheRows<=${bounds.semanticCacheMaxRowsPerFilterKey}, cacheCandidates<=${bounds.semanticCacheCandidateLimitMax}`,
          });
        } else {
          indicators.push({
            name: "Vector Bounds",
            status: "warn",
            detail: "Runtime bounds unavailable",
          });
        }
      } catch (_error) {
        indicators.push({
          name: "Vector Bounds",
          status: "warn",
          detail: "Could not inspect vector bounds",
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
