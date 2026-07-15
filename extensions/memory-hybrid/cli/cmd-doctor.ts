/**
 * CLI command for health diagnostics and issue detection
 */

import { randomUUID } from "node:crypto";
import { existsSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import type { VectorDB } from "../backends/vector-db.js";
import { WAL_ENTRY_SCHEMA_VERSION, type WALEntry, type WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { isErrorReporterActive, resolvePendingErrorReportCount } from "../services/error-reporter.js";
import { countPinnedFacts } from "../services/fact-lifecycle-verbs.js";
import { listQuarantinedGoalIds, repairAllQuarantinedGoals, resolveGoalsDir } from "../services/goal-registry.js";
import { getStaleMaintenanceJobs } from "../services/maintenance-audit-journal.js";
import { getRecallSignalsSnapshot } from "../services/recall-signals.js";
import { getRecallStatsSnapshot } from "../services/recall-timing-stats.js";
import { runStorageRepairPipeline, runStorageStructuralRepair } from "../services/storage-repair-pipeline.js";
import {
  collectStorageSyncSnapshot,
  formatStorageSyncSummary,
  STORAGE_OPTIMIZE_REMEDIATION,
  STORAGE_REBUILD_ALIASES_REMEDIATION,
  STORAGE_REPAIR_REMEDIATION,
} from "../services/storage-sync-diagnostics.js";
import { getWalCircuitBreakerState } from "../services/wal-helpers.js";
import { PLUGIN_ID } from "../utils/constants.js";
import { nowIso } from "../utils/dates.js";
import { formatBytes, WAL_SIZE_WARN_BYTES } from "../utils/format.js";
import { resolveOpenclawHomeDir } from "../utils/openclaw-workspace.js";
import { detectAvailableProviders } from "../utils/provider-detection.js";
import { withTimeout } from "../utils/timeout.js";
import { workspaceRootForCli } from "./config-feature-summaries.js";
import {
  comparePluginVersions,
  detectKnownStaleInstallRoots,
  quarantineKnownStaleInstallRoots,
  removeRedundantExtensionsTreeWhenNpmProjectCanonical,
  removeRedundantNpmProjectTreeWhenExtensionsCanonical,
  resolveCanonicalLivePluginPathForInstallIndex,
} from "./install/install-index-reconcile.js";
import { readPluginPackageVersion, resolveKnownNpmProjectPluginDir } from "./install/workspace.js";
import { type Chainable, withExit } from "./shared.js";

/**
 * Bound for each LanceDB/WAL-touching check below (#2051). Those calls are genuinely async and can
 * hang indefinitely if a maintenance run left LanceDB wedged with a stale lock (the exact scenario
 * `doctor` is supposed to help diagnose) — without a bound, `doctor` itself hangs behind that same
 * lock instead of reporting it, which is worse than useless during an incident.
 *
 * Note this cannot bound the *synchronous* `node:sqlite` calls this file also makes (e.g. Check 1's
 * `factsDb.getCount()`, and the SQLite side of Check 5's `collectStorageSyncSnapshot`) — those block
 * the single JS thread until they return, so `withTimeout`'s `Promise.race` never gets a chance to
 * "win" while one is running. Those calls are instead bounded by SQLite's own busy-handler
 * (`SQLITE_BUSY_TIMEOUT_MS` = 30s, in utils/constants.ts), which is a real bound, just a longer and
 * separate one from this constant — not a regression this fix introduces, but worth knowing when
 * reading the 15s figure below.
 */
const DOCTOR_CHECK_TIMEOUT_MS = 15_000;
const DOCTOR_CHECK_TIMED_OUT = Symbol("doctor-check-timed-out");

/**
 * Bound for `--fix`'s own repair calls (structural repair, orphan reconcile, alias rebuild, goal
 * repair), which can touch the same wedged-LanceDB-lock scenario `DOCTOR_CHECK_TIMEOUT_MS` exists
 * for — but 15s is far too short here: a legitimate repair re-embeds up to `maxFixes` (aggressive:
 * up to 2000) facts against a real embedding API, which can genuinely take minutes. This bound only
 * needs to catch a *hung* repair (a lock that never releases), not a *slow* one, so it's set high
 * enough to never false-positive on real work — this matters more now that `--fix --reconcile` runs
 * unattended every night via the `hybrid-mem:nightly-doctor-repair` cron job, where a hang would
 * otherwise block that isolated session indefinitely with no operator present to notice.
 */
const DOCTOR_REPAIR_TIMEOUT_MS = 10 * 60_000;
const doctorTimeoutFix =
  "Check for a stuck `openclaw hybrid-mem maintenance`/distill process (ps/top) holding a SQLite/LanceDB lock; stop it, then retry.";

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
  resolvedSqlitePath?: string,
  aliasDb: import("../services/retrieval-aliases.js").AliasDB | null = null,
  embeddings: EmbeddingProvider | null = null,
  runBackup?: (opts?: { backupDir?: string }) => Promise<import("./backup.js").BackupCliResult>,
): void {
  program
    .command("doctor")
    .description("Run health diagnostics and detect common issues (🟢 pass, 🟡 warn, 🔴 fail)")
    .option("--deep", "Run a deep FTS trigger probe (savepointed insert/update/delete round-trip)")
    .option(
      "--fix",
      "Repair detected issues: FTS drift, storage structural drift, alias Lance mismatch, and quarantined goal files. Combine with --reconcile to also remove vector-side orphans.",
    )
    .option(
      "--reconcile",
      "Check SQLite ↔ LanceDB consistency (orphans; issue #904). Use --fix to remove vector-side orphans.",
    )
    .option(
      "--reconcile-policy <policy>",
      "Self-heal policy with --fix --reconcile: conservative|balanced|aggressive (default: balanced)",
      "balanced",
    )
    .option(
      "--reconcile-max-fixes <n>",
      "Max vectors to rebuild for SQLite orphan gaps (records missing vectors) when --fix is set (default: 200; " +
        "--reconcile-policy aggressive raises this to 2000 unless you pass this flag explicitly, which is always honored as a hard cap)",
    )
    .option("--json", "Output the full check list and summary as JSON to stdout instead of human-readable text")
    .action(
      // withExit (not a bare process.exit()): the SQLite/LanceDB/WAL checks below are now
      // withTimeout()-bounded, but withTimeout can't cancel a hung native call — the loser keeps
      // running and would otherwise keep Node's event loop alive even after doctor prints a correct,
      // bounded report (#2051 review finding). withExit only calls process.exit() when running as
      // the standalone CLI, so it terminates a real `openclaw hybrid-mem doctor` invocation without
      // killing the test process when this handler is invoked directly in-process by tests.
      withExit(
        async (opts?: {
          deep?: boolean;
          fix?: boolean;
          reconcile?: boolean;
          reconcilePolicy?: string;
          reconcileMaxFixes?: string;
          json?: boolean;
        }) => {
          if (!opts?.json) console.log("\n🏥 Running Hybrid Memory Diagnostics...\n");

          // Mirrors cli/verify.ts's parsing exactly: keep reconcileMaxFixes undefined when the flag
          // is omitted so resolveStorageRepairBudget can distinguish "use the policy default" from
          // "user pinned this cap".
          const reconcilePolicyRaw = String(opts?.reconcilePolicy ?? "balanced")
            .trim()
            .toLowerCase();
          const reconcilePolicy: "conservative" | "balanced" | "aggressive" =
            reconcilePolicyRaw === "conservative" || reconcilePolicyRaw === "aggressive"
              ? reconcilePolicyRaw
              : "balanced";
          let reconcileMaxFixes: number | undefined;
          if (opts?.reconcileMaxFixes !== undefined) {
            const parsedReconcileMaxFixes = Number.parseInt(opts.reconcileMaxFixes, 10);
            reconcileMaxFixes = Math.max(
              0,
              Math.min(5000, Number.isFinite(parsedReconcileMaxFixes) ? parsedReconcileMaxFixes : 200),
            );
          }

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
            const vectorIds = await withTimeout(
              DOCTOR_CHECK_TIMEOUT_MS,
              () => vectorDb.getAllIds(),
              DOCTOR_CHECK_TIMED_OUT,
            );
            if (vectorIds === DOCTOR_CHECK_TIMED_OUT) {
              checks.push({
                name: "Vector Database (LanceDB)",
                status: "fail",
                message: `Timed out after ${DOCTOR_CHECK_TIMEOUT_MS / 1000}s waiting for LanceDB`,
                fix: doctorTimeoutFix,
              });
            } else {
              const vectorCount = vectorIds.length;
              checks.push({
                name: "Vector Database (LanceDB)",
                status: "pass",
                message: `Connected successfully (${vectorCount} vectors)`,
              });
            }
          } catch (error) {
            checks.push({
              name: "Vector Database (LanceDB)",
              status: "fail",
              message: `Connection failed: ${error}`,
              fix: "Run: openclaw hybrid-mem storage re-index",
            });
          }

          // Check 3: Embedding provider
          try {
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
          } catch (error) {
            checks.push({
              name: "Embedding Provider",
              status: "fail",
              message: `Provider detection failed: ${error instanceof Error ? error.message : String(error)}`,
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

          // Check 4b: Duplicate plugin install (#2117)
          // Both ~/.openclaw/extensions/<id> and the managed npm-project copy can be left on
          // disk after a migration, so the gateway logs "duplicate plugin id detected" and may
          // read stale metadata from the losing copy. Report both paths, both versions, and the
          // winning (canonical) source; under --fix, quarantine the stale copy.
          try {
            const openclawHome = resolveOpenclawHomeDir();
            const extensionsPluginDir = join(openclawHome, "extensions", PLUGIN_ID);
            const npmProjectPluginDir = resolveKnownNpmProjectPluginDir();
            const extInstalled = existsSync(join(extensionsPluginDir, "openclaw.plugin.json"));
            const npmInstalled = !!npmProjectPluginDir && existsSync(join(npmProjectPluginDir, "openclaw.plugin.json"));

            if (extInstalled && npmInstalled && npmProjectPluginDir) {
              const extVer = readPluginPackageVersion(extensionsPluginDir) ?? "<unknown>";
              const npmVer = readPluginPackageVersion(npmProjectPluginDir) ?? "<unknown>";
              // OpenClaw's managed npm-project copy wins when it is strictly newer; otherwise the
              // extensions copy is canonical (mirrors the reconcile guards).
              const npmNewer =
                extVer !== "<unknown>" && npmVer !== "<unknown>" && comparePluginVersions(npmVer, extVer) > 0;
              const winner = npmNewer ? npmProjectPluginDir : extensionsPluginDir;
              const winnerVer = npmNewer ? npmVer : extVer;
              const staleDir = npmNewer ? extensionsPluginDir : npmProjectPluginDir;
              const staleVer = npmNewer ? extVer : npmVer;
              const baseMessage =
                `Two discoverable copies of ${PLUGIN_ID}:\n` +
                `    extensions:  ${extensionsPluginDir} (${extVer})\n` +
                `    npm-project: ${npmProjectPluginDir} (${npmVer})\n` +
                `    winning (canonical) source: ${winner} (${winnerVer})`;

              if (opts?.fix) {
                const result = npmNewer
                  ? removeRedundantExtensionsTreeWhenNpmProjectCanonical({ extensionsPluginDir, npmProjectPluginDir })
                  : removeRedundantNpmProjectTreeWhenExtensionsCanonical({ extensionsPluginDir, npmProjectPluginDir });
                const done = npmNewer
                  ? (result as { quarantined?: boolean }).quarantined
                  : (result as { removed?: boolean }).removed;
                if (done) {
                  const movedTo = npmNewer
                    ? (result as { destinationPath?: string }).destinationPath
                    : `${(result as { removedPath?: string }).removedPath}.redundant-*`;
                  checks.push({
                    name: "Plugin install (duplicate id)",
                    status: "pass",
                    message: `${baseMessage}\n    → Quarantined stale copy at ${staleDir} (${staleVer}) to ${movedTo}. Restart the gateway to clear the duplicate warning.`,
                  });
                } else {
                  const reason =
                    (result as { error?: string; skippedReason?: string }).error ??
                    (result as { skippedReason?: string }).skippedReason ??
                    "skipped";
                  checks.push({
                    name: "Plugin install (duplicate id)",
                    status: "warn",
                    message: `${baseMessage}\n    → Could not auto-quarantine the stale copy (${reason}).`,
                    fix: `Manually move ${staleDir} to ${join(openclawHome, ".cache")} and restart the gateway.`,
                  });
                }
              } else {
                checks.push({
                  name: "Plugin install (duplicate id)",
                  status: "warn",
                  message: baseMessage,
                  fix: "Run: openclaw hybrid-mem doctor --fix (quarantines the stale copy), then restart the gateway.",
                });
              }
            }
          } catch (error) {
            checks.push({
              name: "Plugin install (duplicate id)",
              status: "warn",
              message: `Could not check for duplicate plugin installs: ${error instanceof Error ? error.message : String(error)}`,
            });
          }

          // Check 4c: Stale install roots beyond extensions/npm-project (#2125)
          // A live host can retain a root `~/.openclaw/node_modules/<id>` copy or an accidental
          // nested `~/.openclaw/.openclaw/...` state dir. The gateway's own plugin loader never
          // reads these, but plain Node `require.resolve('<id>/package.json')` from
          // $OPENCLAW_STATE_DIR/workspace-adjacent code can still pick up a stale version. Check
          // 4b above only ever compares extensions vs. npm-project, so it never sees these.
          try {
            const canonicalLivePath = resolveCanonicalLivePluginPathForInstallIndex(PLUGIN_ID);
            if (!opts?.fix) {
              const detections = detectKnownStaleInstallRoots({ canonicalLivePath, pluginId: PLUGIN_ID });
              const present = detections.filter((d) => d.present);
              if (present.length > 0) {
                checks.push({
                  name: "Plugin install (stale roots)",
                  status: "warn",
                  message:
                    `Found ${present.length} additional discoverable ${PLUGIN_ID} copy(ies) beyond extensions/npm-project:\n` +
                    present.map((d) => `    ${d.id}: ${d.path} (${d.version ?? "<unknown>"})`).join("\n"),
                  fix: "Run: openclaw hybrid-mem doctor --fix (quarantines the stale copies).",
                });
              }
            } else {
              const results = quarantineKnownStaleInstallRoots({ canonicalLivePath, pluginId: PLUGIN_ID });
              const acted = results.filter((r) => r.attempted);
              if (acted.length > 0) {
                const quarantined = acted.filter((r) => r.quarantined);
                const failed = acted.filter((r) => !r.quarantined);
                if (quarantined.length > 0) {
                  checks.push({
                    name: "Plugin install (stale roots)",
                    status: failed.length > 0 ? "warn" : "pass",
                    message:
                      `Quarantined ${quarantined.length} stale install root(s):\n` +
                      quarantined
                        .map((r) => `    ${r.id}: ${r.path} (${r.version ?? "<unknown>"}) → ${r.destinationPath}`)
                        .join("\n") +
                      (failed.length > 0
                        ? `\n    Could not quarantine: ${failed.map((r) => `${r.id} (${r.error ?? "unknown error"})`).join(", ")}`
                        : ""),
                  });
                } else if (failed.length > 0) {
                  checks.push({
                    name: "Plugin install (stale roots)",
                    status: "warn",
                    message: `Could not quarantine stale install root(s): ${failed.map((r) => `${r.id} (${r.error ?? "unknown error"})`).join(", ")}`,
                  });
                }
              }
            }
          } catch (error) {
            checks.push({
              name: "Plugin install (stale roots)",
              status: "warn",
              message: `Could not check for stale install roots: ${error instanceof Error ? error.message : String(error)}`,
            });
          }

          // Check 5: Database synchronization (unified metrics)
          try {
            let snapshot = await withTimeout(
              DOCTOR_CHECK_TIMEOUT_MS,
              () => collectStorageSyncSnapshot(factsDb, vectorDb),
              DOCTOR_CHECK_TIMED_OUT,
            );
            if (snapshot === DOCTOR_CHECK_TIMED_OUT) {
              checks.push({
                name: "Database Sync",
                status: "fail",
                message: `Timed out after ${DOCTOR_CHECK_TIMEOUT_MS / 1000}s collecting Lance/SQLite sync metrics`,
                fix: doctorTimeoutFix,
              });
            } else if (!snapshot) {
              checks.push({
                name: "Database Sync",
                status: "warn",
                message: "Could not collect Lance/SQLite sync metrics (LanceDB unavailable)",
                fix: `Run: ${STORAGE_REPAIR_REMEDIATION}`,
              });
            } else {
              // hasIdSetDrift/hasRowCountDrift are already scoped to the expected-vector population
              // (active, unstructured facts) — do not add a raw sqliteActiveFacts-vs-lanceRowCount
              // ratio check here, that comparison mixes populations that are not comparable (#2080).
              const syncOk = !snapshot.hasIdSetDrift && !snapshot.hasRowCountDrift;

              if (syncOk) {
                checks.push({
                  name: "Database Sync",
                  status: "pass",
                  message: `Storage aligned (${formatStorageSyncSummary(snapshot)})`,
                });
              } else if (opts?.fix && embeddings && snapshot.hasStructuralDrift) {
                // Structural-only drift (no ID-set orphans, by hasStructuralDrift's own definition —
                // see storage-sync-diagnostics.ts) is safe/idempotent to repair unconditionally under
                // plain --fix, mirroring verify's applyStorageStructuralFixIfNeeded.
                try {
                  const structuralResult = await withTimeout(
                    DOCTOR_REPAIR_TIMEOUT_MS,
                    () =>
                      runStorageStructuralRepair({
                        factsDb,
                        vectorDb,
                        embeddings,
                        resolvedSqlitePath,
                        policy: reconcilePolicy,
                        maxFixes: reconcileMaxFixes,
                      }),
                    DOCTOR_CHECK_TIMED_OUT,
                  );
                  if (structuralResult === DOCTOR_CHECK_TIMED_OUT) {
                    checks.push({
                      name: "Database Sync",
                      status: "fail",
                      message: `Structural repair timed out after ${DOCTOR_REPAIR_TIMEOUT_MS / 60_000}m`,
                      fix: doctorTimeoutFix,
                    });
                  } else {
                    const { optimize, repair, errors } = structuralResult;
                    const refreshed = await withTimeout(
                      DOCTOR_CHECK_TIMEOUT_MS,
                      () => collectStorageSyncSnapshot(factsDb, vectorDb),
                      DOCTOR_CHECK_TIMED_OUT,
                    );
                    if (refreshed !== DOCTOR_CHECK_TIMED_OUT && refreshed) snapshot = refreshed;
                    const stillDrifting = snapshot.hasIdSetDrift || snapshot.hasRowCountDrift;
                    if (errors.length === 0 && !stillDrifting) {
                      checks.push({
                        name: "Database Sync",
                        status: "pass",
                        message: `Structural drift repaired (compacted=${optimize.compacted}, removedFragments=${optimize.removedFragments}, deduplicated=${repair?.dedupe.deduplicated ?? 0}); ${formatStorageSyncSummary(snapshot)}`,
                      });
                    } else {
                      checks.push({
                        name: "Database Sync",
                        status: "warn",
                        message: `Structural repair ${errors.length > 0 ? `hit ${errors.length} error(s)` : "left drift"} — ${formatStorageSyncSummary(snapshot)}`,
                        fix: `Run: ${STORAGE_OPTIMIZE_REMEDIATION} then ${STORAGE_REPAIR_REMEDIATION}`,
                      });
                    }
                  }
                } catch (error) {
                  checks.push({
                    name: "Database Sync",
                    status: "warn",
                    message: `Structural repair failed: ${error instanceof Error ? error.message : String(error)}`,
                    fix: `Run: ${STORAGE_OPTIMIZE_REMEDIATION} then ${STORAGE_REPAIR_REMEDIATION}`,
                  });
                }
              } else if (opts?.fix && opts?.reconcile && embeddings && runBackup && snapshot.hasIdSetDrift) {
                // ID-set (orphan) drift repair deletes vector-side orphans — destructive, so it stays
                // gated behind the explicit --reconcile opt-in (matches `verify --reconcile --fix`),
                // and only proceeds after a checkpoint backup so a bad reconcile pass is recoverable.
                const backupOutcome = await withTimeout(
                  DOCTOR_REPAIR_TIMEOUT_MS,
                  () =>
                    runBackup({}).catch((err) => ({
                      ok: false as const,
                      error: err instanceof Error ? err.message : String(err),
                    })),
                  DOCTOR_CHECK_TIMED_OUT,
                );
                const backupResult =
                  backupOutcome === DOCTOR_CHECK_TIMED_OUT
                    ? { ok: false as const, error: `backup timed out after ${DOCTOR_REPAIR_TIMEOUT_MS / 60_000}m` }
                    : backupOutcome;
                // A backup that "succeeded" against an already-corrupt source (VACUUM INTO doesn't
                // fail just because PRAGMA integrity_check did) is not a real safety net — it's a
                // snapshot of the corruption. Treat that the same as a failed backup: abort the
                // destructive delete rather than proceed on a false sense of having a restore point.
                const backupIntegrityFailed = backupResult.ok && backupResult.integrityOk === false;
                if (!backupResult.ok || backupIntegrityFailed) {
                  const reason = backupResult.ok
                    ? "source SQLite failed PRAGMA integrity_check — the backup is a snapshot of the corruption, not a valid restore point"
                    : backupResult.error;
                  checks.push({
                    name: "Database Sync",
                    status: "warn",
                    message: `Storage drift — ID-set drift: vectorOrphans=${snapshot.vectorOrphans.length} sqliteOrphans=${snapshot.sqliteOrphans.length} (${formatStorageSyncSummary(snapshot)}); auto-backup before reconcile failed, repair aborted: ${reason}`,
                    fix: "Run: openclaw hybrid-mem backup verify, restore/repair the database, then openclaw hybrid-mem verify --reconcile --fix",
                  });
                } else {
                  try {
                    const reconcileResult = await withTimeout(
                      DOCTOR_REPAIR_TIMEOUT_MS,
                      () =>
                        runStorageRepairPipeline({
                          factsDb,
                          vectorDb,
                          embeddings,
                          resolvedSqlitePath,
                          policy: reconcilePolicy,
                          maxFixes: reconcileMaxFixes,
                          operation: "doctor-reconcile",
                          skipReembed: true,
                        }),
                      DOCTOR_CHECK_TIMED_OUT,
                    );
                    if (reconcileResult === DOCTOR_CHECK_TIMED_OUT) {
                      checks.push({
                        name: "Database Sync",
                        status: "fail",
                        message: `Orphan reconcile timed out after ${DOCTOR_REPAIR_TIMEOUT_MS / 60_000}m`,
                        fix: doctorTimeoutFix,
                      });
                    } else {
                      const report = reconcileResult;
                      const refreshed = await withTimeout(
                        DOCTOR_CHECK_TIMEOUT_MS,
                        () => collectStorageSyncSnapshot(factsDb, vectorDb),
                        DOCTOR_CHECK_TIMED_OUT,
                      );
                      if (refreshed !== DOCTOR_CHECK_TIMED_OUT && refreshed) snapshot = refreshed;
                      const stillDrifting = snapshot.hasIdSetDrift || snapshot.hasRowCountDrift;
                      if (report.errors.length === 0 && !stillDrifting) {
                        checks.push({
                          name: "Database Sync",
                          status: "pass",
                          message: `Orphan drift reconciled (deleted=${report.reconcile.vectorOrphansDeleted}, rebuilt=${report.reconcile.sqliteOrphansRebuilt}); ${formatStorageSyncSummary(snapshot)}`,
                        });
                      } else {
                        checks.push({
                          name: "Database Sync",
                          status: "warn",
                          message: `Reconcile ${report.errors.length > 0 ? `hit ${report.errors.length} error(s)` : "left drift"} (deleted=${report.reconcile.vectorOrphansDeleted}, rebuilt=${report.reconcile.sqliteOrphansRebuilt}); ${formatStorageSyncSummary(snapshot)}`,
                          fix: "Re-run: openclaw hybrid-mem doctor --fix --reconcile --reconcile-policy aggressive",
                        });
                      }
                    }
                  } catch (error) {
                    checks.push({
                      name: "Database Sync",
                      status: "warn",
                      message: `Reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
                      fix: "Run: openclaw hybrid-mem verify --reconcile --fix",
                    });
                  }
                }
              } else {
                const fixParts = ["openclaw hybrid-mem verify --reconcile --fix"];
                if (snapshot.hasStructuralDrift) {
                  fixParts.push(STORAGE_OPTIMIZE_REMEDIATION, STORAGE_REPAIR_REMEDIATION);
                }
                const invariant = snapshot.hasIdSetDrift
                  ? `ID-set drift: vectorOrphans=${snapshot.vectorOrphans.length} sqliteOrphans=${snapshot.sqliteOrphans.length}`
                  : "structural drift (duplicate/fragmented Lance rows)";
                checks.push({
                  name: "Database Sync",
                  status: "warn",
                  message: `Storage drift — ${invariant} (${formatStorageSyncSummary(snapshot)})`,
                  fix: `Run: ${fixParts.join(" then ")}`,
                });
              }
            }
          } catch (_error) {
            checks.push({
              name: "Database Sync",
              status: "warn",
              message: "Could not check synchronization",
            });
          }

          if (cfg.aliases?.enabled && aliasDb) {
            try {
              let aliasDiag = await withTimeout(
                DOCTOR_CHECK_TIMEOUT_MS,
                () => aliasDb.getLanceDiagnostics(),
                DOCTOR_CHECK_TIMED_OUT,
              );
              if (aliasDiag === DOCTOR_CHECK_TIMED_OUT) {
                checks.push({
                  name: "Alias Lance Index",
                  status: "fail",
                  message: `Timed out after ${DOCTOR_CHECK_TIMEOUT_MS / 1000}s inspecting alias Lance index`,
                  fix: doctorTimeoutFix,
                });
              } else if (aliasDiag.schemaValid && aliasDiag.lanceDim === aliasDiag.configuredDim) {
                checks.push({
                  name: "Alias Lance Index",
                  status: "pass",
                  message: `Alias Lance valid (dim=${aliasDiag.configuredDim}, rows=${aliasDiag.sqliteAliasRows})`,
                });
              } else if (opts?.fix && embeddings) {
                try {
                  // Narrow into a const before capturing in the withTimeout closure below — TS
                  // control-flow narrowing on a `let` (excluding the timeout sentinel) doesn't
                  // survive into a nested closure.
                  const currentAliasDiag = aliasDiag;
                  const rebuildResult = await withTimeout(
                    DOCTOR_REPAIR_TIMEOUT_MS,
                    () =>
                      aliasDb.rebuildLanceFromSqlite(embeddings, {
                        reEmbed:
                          currentAliasDiag.lanceDim != null &&
                          currentAliasDiag.lanceDim !== currentAliasDiag.configuredDim,
                      }),
                    DOCTOR_CHECK_TIMED_OUT,
                  );
                  if (rebuildResult === DOCTOR_CHECK_TIMED_OUT) {
                    checks.push({
                      name: "Alias Lance Index",
                      status: "fail",
                      message: `Alias Lance rebuild timed out after ${DOCTOR_REPAIR_TIMEOUT_MS / 60_000}m`,
                      fix: doctorTimeoutFix,
                    });
                  } else {
                    const result = rebuildResult;
                    const refreshedDiag = await withTimeout(
                      DOCTOR_CHECK_TIMEOUT_MS,
                      () => aliasDb.getLanceDiagnostics(),
                      DOCTOR_CHECK_TIMED_OUT,
                    );
                    if (refreshedDiag !== DOCTOR_CHECK_TIMED_OUT) aliasDiag = refreshedDiag;
                    if (aliasDiag.schemaValid && aliasDiag.lanceDim === aliasDiag.configuredDim) {
                      checks.push({
                        name: "Alias Lance Index",
                        status: "pass",
                        message: `Alias Lance rebuilt (stored=${result.stored}, reEmbedded=${result.reEmbedded}); dim=${aliasDiag.configuredDim}, rows=${aliasDiag.sqliteAliasRows}`,
                      });
                    } else {
                      const lanceDim = aliasDiag.lanceDim == null ? "unknown" : String(aliasDiag.lanceDim);
                      checks.push({
                        name: "Alias Lance Index",
                        status: "warn",
                        message: `Alias Lance mismatch persists after rebuild (configured=${aliasDiag.configuredDim}, lance=${lanceDim}, sqliteRows=${aliasDiag.sqliteAliasRows})`,
                        fix: `Run: ${STORAGE_REBUILD_ALIASES_REMEDIATION} --re-embed`,
                      });
                    }
                  }
                } catch (error) {
                  const lanceDim = aliasDiag.lanceDim == null ? "unknown" : String(aliasDiag.lanceDim);
                  checks.push({
                    name: "Alias Lance Index",
                    status: "warn",
                    message: `Alias Lance rebuild failed: ${error instanceof Error ? error.message : String(error)} (configured=${aliasDiag.configuredDim}, lance=${lanceDim})`,
                    fix: `Run: ${STORAGE_REBUILD_ALIASES_REMEDIATION} (--re-embed after embedding model change)`,
                  });
                }
              } else {
                const lanceDim = aliasDiag.lanceDim == null ? "unknown" : String(aliasDiag.lanceDim);
                checks.push({
                  name: "Alias Lance Index",
                  status: "warn",
                  message: `Alias Lance mismatch (configured=${aliasDiag.configuredDim}, lance=${lanceDim}, sqliteRows=${aliasDiag.sqliteAliasRows})`,
                  fix: `Run: ${STORAGE_REBUILD_ALIASES_REMEDIATION} (--re-embed after embedding model change)`,
                });
              }
            } catch (error) {
              checks.push({
                name: "Alias Lance Index",
                status: "warn",
                message: `Could not inspect alias Lance index: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }

          // Check 6: Disk space for the memory directory/filesystem
          try {
            const memoryDir = cfg.sqlitePath
              ? dirname(cfg.sqlitePath)
              : join(homedir(), ".openclaw/plugins/memory-hybrid");
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
                  freeBytes < 100 * 1024 * 1024
                    ? "Free disk space before running large imports/reindex jobs"
                    : undefined,
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

            let walTimedOut = false;
            try {
              const walRead = await withTimeout(
                DOCTOR_CHECK_TIMEOUT_MS,
                async () => {
                  const { entries: allEntries, hadCorruption } = await wal.readAllRecoverable();
                  const validEntries = await wal.getValidEntries();
                  return { allEntries, hadCorruption, validEntries };
                },
                DOCTOR_CHECK_TIMED_OUT,
              );
              if (walRead === DOCTOR_CHECK_TIMED_OUT) {
                walTimedOut = true;
                checks.push({
                  name: "WAL Journal",
                  status: "fail",
                  message: `Timed out after ${DOCTOR_CHECK_TIMEOUT_MS / 1000}s inspecting WAL`,
                  fix: doctorTimeoutFix,
                });
              } else {
                const { allEntries, hadCorruption, validEntries } = walRead;
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
              }
            } catch (error) {
              checks.push({
                name: "WAL Journal",
                status: "fail",
                message: `Unable to inspect WAL: ${error instanceof Error ? error.message : String(error)}`,
                fix: "Run: openclaw hybrid-mem verify --fix",
              });
            }

            if (!breaker.persistentDisabled && !walTimedOut) {
              const probeId = randomUUID();
              const probeEntry: WALEntry = {
                id: probeId,
                timestamp: Date.now(),
                schemaVersion: WAL_ENTRY_SCHEMA_VERSION,
                operation: "update",
                data: { text: "doctor-wal-durability-probe", probe: "doctor-wal-durability" },
              };
              try {
                const wrote = await withTimeout(
                  DOCTOR_CHECK_TIMEOUT_MS,
                  async () => {
                    await wal.write(probeEntry);
                    await wal.remove(probeId);
                    return true;
                  },
                  DOCTOR_CHECK_TIMED_OUT,
                );
                if (wrote === DOCTOR_CHECK_TIMED_OUT) {
                  checks.push({
                    name: "WAL Durability",
                    status: "fail",
                    message: `Timed out after ${DOCTOR_CHECK_TIMEOUT_MS / 1000}s on WAL write/remove probe`,
                    fix: doctorTimeoutFix,
                  });
                } else {
                  checks.push({
                    name: "WAL Durability",
                    status: "pass",
                    message: "WAL write/remove round-trip verified",
                  });
                }
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
              const missingCols = [
                !snapshot.hasTagsColumn ? "tags" : null,
                !snapshot.hasWhyColumn ? "why" : null,
              ].filter(Boolean);
              structuralProblems.push(`facts_fts schema missing column(s): ${missingCols.join(", ")}`);
            }
            if (snapshot.missingTriggers.length > 0) {
              structuralProblems.push(`missing trigger(s): ${snapshot.missingTriggers.join(", ")}`);
            }
            const populationDrift =
              snapshot.factsCount !== snapshot.ftsCount || snapshot.missingFactsInFts > 0 || snapshot.extraFtsRows > 0;

            if (structuralProblems.length > 0) {
              if (opts?.fix) {
                // runFactsMigrations (backends/migrations/facts-migrations.ts) is the same idempotent
                // migration FactsDB's own constructor already runs on every open — safe to call again
                // here. It recreates a missing facts_fts table/columns/triggers from scratch.
                try {
                  runFactsMigrations(factsDb.getRawDb());
                  snapshot = factsDb.getFtsConsistencySnapshot();
                  const stillStructural =
                    !snapshot.ftsTableExists ||
                    !snapshot.hasTagsColumn ||
                    !snapshot.hasWhyColumn ||
                    snapshot.missingTriggers.length > 0;
                  if (stillStructural) {
                    checks.push({
                      name: "FTS Index/Triggers",
                      status: "fail",
                      message: `${structuralProblems.join("; ")} (live migration repair did not resolve it)`,
                      fix: "Restart gateway to re-run migrations. If unresolved, rebuild facts_fts from SQLite facts.",
                    });
                  } else {
                    // A freshly recreated facts_fts starts empty/out of sync — chain straight into
                    // the population-drift repair so one --fix pass fully self-heals.
                    try {
                      const rebuilt = factsDb.rebuildFtsIndex();
                      snapshot = factsDb.getFtsConsistencySnapshot();
                      const driftAfterFix =
                        snapshot.factsCount !== snapshot.ftsCount ||
                        snapshot.missingFactsInFts > 0 ||
                        snapshot.extraFtsRows > 0;
                      checks.push({
                        name: "FTS Index/Triggers",
                        status: driftAfterFix ? "warn" : "pass",
                        message: driftAfterFix
                          ? `Rebuilt facts_fts structure via migration, but population drift persists after reindex (facts=${snapshot.factsCount}, facts_fts=${snapshot.ftsCount})`
                          : `Rebuilt facts_fts table/triggers via migration and reindexed ${rebuilt} fact(s). If a gateway is currently running, restart it so its connection picks up the corrected schema.`,
                        fix: driftAfterFix
                          ? "Run with --deep for trigger probe; if still drifting, inspect DB integrity and restore from backup."
                          : undefined,
                      });
                    } catch (error) {
                      // "fail", not "warn" — matches the pre-existing population-drift-only branch's
                      // own rebuildFtsIndex() catch below, which reports the identical failure mode
                      // (the reindex call itself throwing) as "fail".
                      checks.push({
                        name: "FTS Index/Triggers",
                        status: "fail",
                        message: `Recreated facts_fts structure via migration, but reindex failed: ${error instanceof Error ? error.message : String(error)}`,
                        fix: "Run: openclaw hybrid-mem doctor --fix (retry), or rebuild facts_fts from SQLite facts.",
                      });
                    }
                  }
                } catch (error) {
                  checks.push({
                    name: "FTS Index/Triggers",
                    status: "fail",
                    message: `${structuralProblems.join("; ")} — live migration repair failed: ${error instanceof Error ? error.message : String(error)}`,
                    fix: "Restart gateway to re-run migrations. If unresolved, rebuild facts_fts from SQLite facts.",
                  });
                }
              } else {
                checks.push({
                  name: "FTS Index/Triggers",
                  status: "fail",
                  message: structuralProblems.join("; "),
                  fix: "Run: openclaw hybrid-mem doctor --fix (recreates facts_fts via migration), or restart gateway to re-run migrations.",
                });
              }
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

          try {
            const recallStats = getRecallStatsSnapshot();
            const intentKeys = Object.keys(recallStats.intentDistribution);
            const bypassPct = (recallStats.bypassRate * 100).toFixed(1);
            const intentP95 = recallStats.stages.intent?.p95 ?? 0;
            checks.push({
              name: "Retrieval health",
              status: "pass",
              message: `intent samples=${intentKeys.length} bypass=${bypassPct}% intent_p95=${intentP95}ms`,
            });
          } catch (err) {
            checks.push({
              name: "Retrieval health",
              status: "warn",
              message: `Stats unavailable: ${String(err)}`,
            });
          }

          try {
            const signals = getRecallSignalsSnapshot(factsDb.getRawDb(), 7);
            const status = signals.autoSnoozeCandidates > 0 || signals.neverReferencedSurfaced > 0 ? "warn" : "pass";
            checks.push({
              name: "Recall feedback",
              status,
              message: `snooze_candidates=${signals.autoSnoozeCandidates} never_referenced=${signals.neverReferencedSurfaced} cross_domain_hubs=${signals.crossDomainHubs}`,
            });
          } catch (err) {
            checks.push({
              name: "Recall feedback",
              status: "warn",
              message: `Signals unavailable: ${String(err)}`,
            });
          }

          try {
            // #2108: compares each job against its own guard cadence (not a flat cutoff), so this
            // agrees with `maintenance status`'s cadence-based health model instead of contradicting it.
            const stale = getStaleMaintenanceJobs(factsDb.getRawDb());
            if (stale.length > 0) {
              checks.push({
                name: "Maintenance health",
                status: "warn",
                message: `Stale jobs (overdue vs. their own cadence): ${stale.join(", ")}`,
                fix: "Run maintenance orchestrator or check cron schedule",
              });
            } else {
              checks.push({
                name: "Maintenance health",
                status: "pass",
                message: "No stale maintenance jobs in audit journal",
              });
            }
          } catch (err) {
            checks.push({
              name: "Maintenance health",
              status: "warn",
              message: `Audit journal unavailable: ${String(err)}`,
            });
          }

          try {
            const pinned = countPinnedFacts(factsDb);
            checks.push({
              name: "Pin/snooze totals",
              status: "pass",
              message: `${pinned} pinned facts`,
            });
          } catch (err) {
            checks.push({
              name: "Pin/snooze totals",
              status: "warn",
              message: `Pin/snooze totals unavailable: ${String(err)}`,
            });
          }

          if (cfg.errorReporting?.enabled !== false && cfg.errorReporting?.consent !== false) {
            const pending = resolvePendingErrorReportCount(resolvedSqlitePath);
            if (pending > 0) {
              checks.push({
                name: "Error reporter queue",
                status: "warn",
                message: `${pending} pending telemetry report(s) on disk`,
                fix: "Restart gateway to drain queue, or run hybrid-mem verify",
              });
            } else {
              checks.push({
                name: "Error reporter queue",
                status: isErrorReporterActive() ? "pass" : "warn",
                message: isErrorReporterActive() ? "Pending queue empty" : "Reporter not active in this CLI process",
              });
            }
          }

          if (cfg.goalStewardship?.enabled) {
            const goalsDir = resolveGoalsDir(workspaceRootForCli(), cfg.goalStewardship.goalsDir);
            let quarantined = listQuarantinedGoalIds(goalsDir);
            if (quarantined.length === 0) {
              checks.push({
                name: "Goal registry quarantine",
                status: "pass",
                message: "No quarantined corrupt goal files",
              });
            } else if (opts?.fix) {
              try {
                const repairResult = await withTimeout(
                  DOCTOR_REPAIR_TIMEOUT_MS,
                  () => repairAllQuarantinedGoals(goalsDir, { dryRun: false }),
                  DOCTOR_CHECK_TIMED_OUT,
                );
                if (repairResult === DOCTOR_CHECK_TIMED_OUT) {
                  checks.push({
                    name: "Goal registry quarantine",
                    status: "fail",
                    message: `Goal repair timed out after ${DOCTOR_REPAIR_TIMEOUT_MS / 60_000}m`,
                    fix: doctorTimeoutFix,
                  });
                } else {
                  const results = repairResult;
                  const restored = results.filter((r) => r.action === "restored").length;
                  const failed = results.filter((r) => r.action === "failed");
                  quarantined = listQuarantinedGoalIds(goalsDir);
                  if (quarantined.length === 0) {
                    checks.push({
                      name: "Goal registry quarantine",
                      status: "pass",
                      message: `Restored ${restored} quarantined goal file(s)`,
                    });
                  } else {
                    checks.push({
                      name: "Goal registry quarantine",
                      status: "warn",
                      message: `Restored ${restored}, ${quarantined.length} still quarantined (invalid JSON)${failed.length > 0 ? `: ${failed.map((f) => f.goalId).join(", ")}` : ""}`,
                      fix: "Inspect and manually repair the remaining .json.corrupt file(s); invalid schema cannot be auto-restored.",
                    });
                  }
                }
              } catch (error) {
                checks.push({
                  name: "Goal registry quarantine",
                  status: "warn",
                  message: `Goal repair failed: ${error instanceof Error ? error.message : String(error)}`,
                  fix: "Run: openclaw hybrid-mem goals doctor --repair-corrupt",
                });
              }
            } else {
              checks.push({
                name: "Goal registry quarantine",
                status: "warn",
                message: `${quarantined.length} quarantined corrupt goal file(s): ${quarantined.slice(0, 5).join(", ")}${quarantined.length > 5 ? "…" : ""}`,
                fix: "Run: openclaw hybrid-mem goals doctor --repair-corrupt",
              });
            }
          }

          const duration = Date.now() - startTime;
          const passed = checks.filter((c) => c.status === "pass").length;
          const warnings = checks.filter((c) => c.status === "warn").length;
          const failed = checks.filter((c) => c.status === "fail").length;

          if (opts?.json) {
            // JSON output contract (docs/CLI-REFERENCE.md): stdout gets JSON only when --json is
            // set — no banner/icons/summary text alongside it, matching cmd-health.ts's --json.
            console.log(
              JSON.stringify(
                {
                  overall: failed > 0 ? "unhealthy" : warnings > 0 ? "degraded" : "healthy",
                  checks,
                  summary: { passed, warnings, failed },
                  durationMs: duration,
                  timestamp: nowIso(),
                },
                null,
                2,
              ),
            );
            if (failed > 0) process.exitCode = 1;
            return;
          }

          // Display results
          for (const check of checks) {
            const icon = check.status === "pass" ? "🟢" : check.status === "warn" ? "🟡" : "🔴";
            console.log(`${icon} ${check.name}: ${check.message}`);
            if (check.fix && check.status !== "pass") {
              console.log(`   💡 Fix: ${check.fix}`);
            }
          }

          console.log(`\n✓ Diagnostics completed in ${duration}ms\n`);
          console.log(`Summary: ${passed} passed, ${warnings} warnings, ${failed} failed\n`);

          if (failed > 0) {
            console.log("❌ Critical issues detected. Please address the failed checks.\n");
            process.exitCode = 1;
          } else if (warnings > 0) {
            console.log("⚠️  Some issues detected. Consider addressing the warnings.\n");
          } else {
            console.log("✅ All checks passed! Your memory system is healthy.\n");
          }
        },
      ),
    );
}
