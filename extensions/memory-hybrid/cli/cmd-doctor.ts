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
    .option("--deep", "Run a deep FTS trigger probe (savepointed insert/update/delete round-trip)")
    .option("--fix", "Repair detected FTS population drift by rebuilding the FTS index")
    .action(async (opts?: { deep?: boolean; fix?: boolean }) => {
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
          fix: "Run: openclaw hybrid-mem storage re-index",
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
          const { entries: allEntries, hadCorruption } = await wal.readAllRecoverable();
          const validEntries = await wal.getValidEntries();
          const staleEntries = Math.max(0, allEntries.length - validEntries.length);
          const walSizeBytes =
            breaker.walPath && existsSync(breaker.walPath) ? Math.max(0, statSync(breaker.walPath).size) : 0;
          const walStatus: "pass" | "warn" =
            hadCorruption || staleEntries > 0 || walSizeBytes > WAL_SIZE_WARN_BYTES ? "warn" : "pass";
          const corruptionNote = hadCorruption ? ", corruption detected" : "";
          checks.push({
            name: "WAL Journal",
            status: walStatus,
            message: `${validEntries.length} pending, ${staleEntries} stale${corruptionNote}, ${formatBytes(walSizeBytes)} at ${walPath}`,
            fix:
              walStatus === "warn"
                ? hadCorruption
                  ? "Run: openclaw hybrid-mem verify --fix"
                  : "Investigate replay blockers and run maintenance; clear stale WAL entries after root cause is fixed"
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
            data: { text: "doctor-wal-durability-probe", probe: "doctor-wal-durability" },
          };
          try {
            await wal.write(probeEntry);
            await wal.remove(probeId);
            checks.push({
              name: "WAL Durability",
              status: "pass",
              message: "WAL write/remove round-trip verified",
            });
          } catch (error) {
            checks.push({
              name: "WAL Durability",
              status: "fail",
              message: `WAL write/remove probe failed: ${error instanceof Error ? error.message : String(error)}`,
              fix: "Check disk I/O and filesystem durability; restart gateway to re-enable WAL",
            });
          }
        }
      }

      // Check 8: FTS trigger/index consistency
      try {
        let snapshot = factsDb.getFtsConsistencySnapshot();
        const structuralProblems: string[] = [];
        if (!snapshot.ftsTableExists) structuralProblems.push("facts_fts table missing");
        if (!snapshot.hasTagsColumn || !snapshot.hasWhyColumn) {
          const missingCols = [!snapshot.hasTagsColumn ? "tags" : null, !snapshot.hasWhyColumn ? "why" : null].filter(
            Boolean,
          );
          structuralProblems.push(`facts_fts schema missing column(s): ${missingCols.join(", ")}`);
        }
        if (snapshot.missingTriggers.length > 0) {
          structuralProblems.push(`missing trigger(s): ${snapshot.missingTriggers.join(", ")}`);
        }
        const populationDrift =
          snapshot.factsCount !== snapshot.ftsCount || snapshot.missingFactsInFts > 0 || snapshot.extraFtsRows > 0;

        if (structuralProblems.length > 0) {
          checks.push({
            name: "FTS Index/Triggers",
            status: "fail",
            message: structuralProblems.join("; "),
            fix: "Restart gateway to re-run migrations. If unresolved, rebuild facts_fts from SQLite facts.",
          });
        } else if (populationDrift) {
          if (opts?.fix) {
            try {
              const rebuilt = factsDb.rebuildFtsIndex();
              snapshot = factsDb.getFtsConsistencySnapshot();
              const driftAfterFix =
                snapshot.factsCount !== snapshot.ftsCount ||
                snapshot.missingFactsInFts > 0 ||
                snapshot.extraFtsRows > 0;
              if (!driftAfterFix) {
                checks.push({
                  name: "FTS Index/Triggers",
                  status: "pass",
                  message: `Rebuilt FTS index for ${rebuilt} fact(s) and verified consistency`,
                });
              } else {
                checks.push({
                  name: "FTS Index/Triggers",
                  status: "warn",
                  message:
                    `FTS drift persists after rebuild (facts=${snapshot.factsCount}, facts_fts=${snapshot.ftsCount}, ` +
                    `missing=${snapshot.missingFactsInFts}, extra=${snapshot.extraFtsRows})`,
                  fix: "Run with --deep for trigger probe; if still drifting, inspect DB integrity and restore from backup.",
                });
              }
            } catch (error) {
              checks.push({
                name: "FTS Index/Triggers",
                status: "fail",
                message: `FTS rebuild failed: ${error}`,
                fix: "Run with --deep to probe triggers, then rebuild facts_fts from SQLite facts.",
              });
            }
          } else {
            const sampleMissing =
              snapshot.missingFactIdsSample.length > 0
                ? ` missingFactIds=${snapshot.missingFactIdsSample.join(", ")}`
                : "";
            const sampleExtra =
              snapshot.extraFtsRowidsSample.length > 0
                ? ` extraFtsRowids=${snapshot.extraFtsRowidsSample.join(", ")}`
                : "";
            checks.push({
              name: "FTS Index/Triggers",
              status: "warn",
              message:
                `FTS drift detected (facts=${snapshot.factsCount}, facts_fts=${snapshot.ftsCount}, ` +
                `missing=${snapshot.missingFactsInFts}, extra=${snapshot.extraFtsRows})${sampleMissing}${sampleExtra}`,
              fix: "Run: openclaw hybrid-mem doctor --fix (then --deep to validate trigger round-trip).",
            });
          }
        } else {
          checks.push({
            name: "FTS Index/Triggers",
            status: "pass",
            message: `FTS table/triggers healthy (${snapshot.factsCount} facts, ${snapshot.ftsCount} indexed rows)`,
          });
        }

        if (opts?.deep) {
          const probe = factsDb.runFtsTriggerProbe();
          if (probe.ok) {
            checks.push({
              name: "FTS Trigger Probe (Deep)",
              status: "pass",
              message: "Insert/update/delete trigger round-trip verified",
            });
          } else {
            checks.push({
              name: "FTS Trigger Probe (Deep)",
              status: "fail",
              message:
                `Trigger probe failed (insertVisible=${probe.insertVisible}, ` +
                `updateVisible=${probe.updateVisible}, deleteVisibleAfterDelete=${probe.deleteVisibleAfterDelete})` +
                (probe.error ? `: ${probe.error}` : ""),
              fix: "Repair/recreate facts_fts triggers and rebuild the FTS index from facts.",
            });
          }
        }
      } catch (error) {
        checks.push({
          name: "FTS Index/Triggers",
          status: "warn",
          message: `Could not run FTS consistency check: ${error}`,
        });
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
