/**
 * CLI command for health diagnostics and issue detection
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { type WALEntry, WAL_ENTRY_SCHEMA_VERSION, type WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import { getWalCircuitBreakerState } from "../services/wal-helpers.js";
import { detectAvailableProviders } from "../utils/provider-detection.js";
import { formatBytes, WAL_SIZE_WARN_BYTES } from "../utils/format.js";

interface DiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

export function registerDoctorCommand(
  program: Chainable,
  cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  vectorDb: VectorDB,
  wal: WriteAheadLog | null = null,
): void {
  program
    .command("doctor")
    .description("Run health diagnostics and detect common issues (🟢 pass, 🟡 warn, 🔴 fail)")
    .action(async () => {
      console.log("\n🏥 Running Hybrid Memory Diagnostics...\n");

      const checks: DiagnosticCheck[] = [];
      const startTime = Date.now();

      // Check 1: Database connectivity
      try {
        const factCount = factsDb.getCount();
        checks.push({
          name: "SQLite Database",
          status: "pass",
          message: `Connected successfully (${factCount} facts)`,
        });
      } catch (error) {
        checks.push({
          name: "SQLite Database",
          status: "fail",
          message: `Connection failed: ${error}`,
          fix: "Run: openclaw hybrid-mem verify --fix",
        });
      }

      // Check 2: Vector database
      try {
        const vectorIds = await vectorDb.getAllIds();
        const vectorCount = vectorIds.length;
        checks.push({
          name: "Vector Database (LanceDB)",
          status: "pass",
          message: `Connected successfully (${vectorCount} vectors)`,
        });
      } catch (error) {
        checks.push({
          name: "Vector Database (LanceDB)",
          status: "fail",
          message: `Connection failed: ${error}`,
          fix: "Run: openclaw hybrid-mem re-index",
        });
      }

      // Check 3: Embedding provider
      const providers = await detectAvailableProviders(cfg.embedding?.apiKey, cfg.embedding?.googleApiKey);
      const currentProvider = cfg.embedding?.provider;
      const providerStatus = providers.find((p) => p.provider === currentProvider);

      if (providerStatus?.available) {
        checks.push({
          name: "Embedding Provider",
          status: "pass",
          message: `${currentProvider?.toUpperCase()} is available`,
        });
      } else {
        checks.push({
          name: "Embedding Provider",
          status: "fail",
          message: providerStatus?.reason || "Provider not configured",
          fix: "Run: openclaw hybrid-mem providers",
        });
      }

      // Check 4: Configuration validity
      if (cfg.embedding?.provider) {
        checks.push({
          name: "Configuration",
          status: "pass",
          message: "Configuration is valid",
        });
      } else {
        checks.push({
          name: "Configuration",
          status: "warn",
          message: "No embedding provider configured",
          fix: "Run: openclaw hybrid-mem setup --interactive",
        });
      }

      // Check 5: Database synchronization
      try {
        const sqliteCount = factsDb.getCount();
        const vectorIds = await vectorDb.getAllIds();
        const vectorCount = vectorIds.length;
        const diff = Math.abs(sqliteCount - vectorCount);
        const percentDiff = (diff / Math.max(sqliteCount, 1)) * 100;

        if (percentDiff < 5) {
          checks.push({
            name: "Database Sync",
            status: "pass",
            message: `SQLite and LanceDB are synchronized (±${diff} items)`,
          });
        } else {
          checks.push({
            name: "Database Sync",
            status: "warn",
            message: `Databases out of sync: SQLite ${sqliteCount}, LanceDB ${vectorCount}`,
            fix: "Run: openclaw hybrid-mem verify --reconcile --fix",
          });
        }
      } catch (_error) {
        checks.push({
          name: "Database Sync",
          status: "warn",
          message: "Could not check synchronization",
        });
      }

      // Check 6: Disk space for the memory directory/filesystem
      try {
        const memoryDir = cfg.sqlitePath ? dirname(cfg.sqlitePath) : join(homedir(), ".openclaw/plugins/memory-hybrid");
        if (!existsSync(memoryDir)) {
          checks.push({
            name: "Disk Space",
            status: "warn",
            message: `Memory directory not found: ${memoryDir}`,
            fix: "Run: openclaw hybrid-mem install",
          });
        } else {
          const stats = statfsSync(memoryDir);
          const freeBytes = Number(stats.bavail) * Number(stats.bsize);
          const freeMiB = Math.floor(freeBytes / 1024 / 1024);
          checks.push({
            name: "Disk Space",
            status: freeBytes < 100 * 1024 * 1024 ? "warn" : "pass",
            message: `${freeMiB} MiB available at ${memoryDir}`,
            fix:
              freeBytes < 100 * 1024 * 1024 ? "Free disk space before running large imports/reindex jobs" : undefined,
          });
        }
      } catch (_error) {
        checks.push({
          name: "Disk Space",
          status: "warn",
          message: "Could not check disk space",
        });
      }

      // Check 7: WAL circuit-breaker and journal health
      if (!cfg.wal?.enabled) {
        checks.push({
          name: "WAL",
          status: "warn",
          message: "Disabled in config (crash replay unavailable)",
          fix: "Enable with: openclaw hybrid-mem config-set wal.enabled true",
        });
      } else if (!wal) {
        checks.push({
          name: "WAL",
          status: "fail",
          message: "Enabled in config but WAL runtime is unavailable",
          fix: "Run: openclaw hybrid-mem verify --fix",
        });
      } else {
        const breaker = getWalCircuitBreakerState(wal);
        const walPath = breaker.walPath ?? cfg.wal.walPath ?? "unknown";

        if (breaker.persistentDisabled) {
          checks.push({
            name: "WAL Circuit Breaker",
            status: "fail",
            message: `Persistently disabled via ${breaker.sentinelPath ?? walPath}`,
            fix: "Fix filesystem sync/durability issue, then remove the sentinel and restart plugin",
          });
        } else if (breaker.inMemoryDisabled) {
          checks.push({
            name: "WAL Circuit Breaker",
            status: "warn",
            message: "Circuit breaker open in current process",
            fix: "Resolve WAL write errors and restart plugin to re-enable WAL",
          });
        } else {
          checks.push({
            name: "WAL Circuit Breaker",
            status: "pass",
            message: "Circuit breaker closed",
          });
        }

        try {
          const allEntries = await wal.readAll();
          const validEntries = await wal.getValidEntries();
          const staleEntries = Math.max(0, allEntries.length - validEntries.length);
          const walSizeBytes =
            breaker.walPath && existsSync(breaker.walPath) ? Math.max(0, statSync(breaker.walPath).size) : 0;
          const walStatus: "pass" | "warn" = staleEntries > 0 || walSizeBytes > WAL_SIZE_WARN_BYTES ? "warn" : "pass";
          checks.push({
            name: "WAL Journal",
            status: walStatus,
            message: `${validEntries.length} pending, ${staleEntries} stale, ${formatBytes(walSizeBytes)} at ${walPath}`,
            fix:
              walStatus === "warn"
                ? "Investigate replay blockers and run maintenance; clear stale WAL entries after root cause is fixed"
                : undefined,
          });
        } catch (error) {
          checks.push({
            name: "WAL Journal",
            status: "fail",
            message: `Unable to inspect WAL: ${error instanceof Error ? error.message : String(error)}`,
            fix: "Run: openclaw hybrid-mem verify --fix",
          });
        }

        if (!breaker.persistentDisabled) {
          const probeId = randomUUID();
          const probeEntry: WALEntry = {
            id: probeId,
            timestamp: Date.now(),
            schemaVersion: WAL_ENTRY_SCHEMA_VERSION,
            operation: "update",
            data: { probe: "doctor-wal-durability" },
          };
          try {
            await wal.write(probeEntry);
            await wal.remove(probeId);
            checks.push({
              name: "WAL Durability",
              status: "pass",
              message: "Write+sync probe succeeded",
            });
          } catch (error) {
            try {
              await wal.remove(probeId);
            } catch {
              // best effort cleanup
            }
            checks.push({
              name: "WAL Durability",
              status: "fail",
              message: `Write+sync probe failed: ${error instanceof Error ? error.message : String(error)}`,
              fix: "Move memory storage to a filesystem that supports fsync/datasync reliably",
            });
          }
        }
      }

      // Display results
      for (const check of checks) {
        const icon = check.status === "pass" ? "🟢" : check.status === "warn" ? "🟡" : "🔴";
        console.log(`${icon} ${check.name}: ${check.message}`);
        if (check.fix && check.status !== "pass") {
          console.log(`   💡 Fix: ${check.fix}`);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`\n✓ Diagnostics completed in ${duration}ms\n`);

      // Summary
      const passed = checks.filter((c) => c.status === "pass").length;
      const warnings = checks.filter((c) => c.status === "warn").length;
      const failed = checks.filter((c) => c.status === "fail").length;

      console.log(`Summary: ${passed} passed, ${warnings} warnings, ${failed} failed\n`);

      if (failed > 0) {
        console.log("❌ Critical issues detected. Please address the failed checks.\n");
        process.exit(1);
      } else if (warnings > 0) {
        console.log("⚠️  Some issues detected. Consider addressing the warnings.\n");
      } else {
        console.log("✅ All checks passed! Your memory system is healthy.\n");
      }
    });
}
