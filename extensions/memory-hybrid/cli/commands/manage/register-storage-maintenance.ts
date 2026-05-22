/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, unlinkSync } from "node:fs";
import { isPromptArtifactOrReasoningTrace } from "../../../services/capture-utils.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { recordMaintenanceTimestamp } from "../../../services/maintenance-timestamp.js";
import { countPendingReviewBacklogs } from "../../../services/pending-review-digest.js";
import { deleteVectorsForFactIds } from "../../../services/vector-maintenance.js";
import { appendVectorLifecycleAuditEvent } from "../../../services/vector-lifecycle-audit.js";
import { getEnv } from "../../../utils/env-manager.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { type Chainable, approxIntervalMs, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";
import {
  countImplicitFeedbackTrajectorySignals,
  defaultReindexCheckpointPath,
  parseBoundedFloatOption,
  parseBoundedIntOption,
  readReindexCheckpoint,
  recordStorageGrowthSample,
  writeReindexCheckpoint,
} from "./storage-stats-helpers.js";

type FactsDbWithBatch = {
  getBatch: (
    offset: number,
    limit: number,
    opts: { includeSuperseded: boolean },
  ) => Array<{ id: string; text: string }>;
};

type FactsDbWithRawDb = {
  getRawDb: () => {
    prepare: (sql: string) => { get: (id: string) => unknown };
  };
};

function hasGetBatch(db: object): db is object & {
  getBatch: FactsDbWithBatch["getBatch"];
} {
  return "getBatch" in db && typeof (db as { getBatch?: unknown }).getBatch === "function";
}

function hasGetRawDb(db: object): db is object & {
  getRawDb: FactsDbWithRawDb["getRawDb"];
} {
  return "getRawDb" in db && typeof (db as { getRawDb?: unknown }).getRawDb === "function";
}

export function registerManageStorageMaintenance(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    getMemoryCategories,
    cfg,
    runCompaction,
    tieringEnabled,
    ctx,
    listCommands,
    auditStore,
    runExport,
  } = b;

  const tierCompactCmd = mem
    .command("tier-compact")
    .description(
      "Tier compaction: move facts between hot/warm/cold/structural (does NOT shrink LanceDB — see vectordb-optimize)",
    )
    .option("--dry-run", "Preview tier changes without mutating facts");
  // Keep the legacy `compact` name working as a deprecated alias so existing
  // cron jobs and operator muscle memory don't break (#1249).
  tierCompactCmd.alias?.("compact");
  tierCompactCmd.action(
    withExit(async (opts?: { dryRun?: boolean }) => {
      let counts;
      try {
        counts = await runCompaction({ apply: opts?.dryRun !== true });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "compact",
        });
        throw err;
      }
      // Record timestamp after successful compaction (not for dry-run)
      if (opts?.dryRun !== true && ctx.resolvedSqlitePath) {
        recordMaintenanceTimestamp(ctx.resolvedSqlitePath, ".compact_last_run");
      }
      const mode = opts?.dryRun ? "dry-run" : "apply";
      const changed = counts.changed == null ? "" : ` changed=${counts.changed}/${counts.examined ?? "?"}`;
      console.log(
        `Tier compaction (${mode}): hot=${counts.hot} warm=${counts.warm} cold=${counts.cold} structural=${counts.structural}${changed}`,
      );
    }),
  );

  mem
    .command("retier")
    .description("Preview or apply memory tier migration using current tiering rules")
    .option("--apply", "Apply mutations. Omit for dry-run")
    .action(
      withExit(async (opts?: { apply?: boolean }) => {
        const report = await runCompaction({ apply: opts?.apply === true });
        const mode = opts?.apply ? "apply" : "dry-run";
        console.log(
          `Retier (${mode}): examined=${report.examined ?? "?"} changed=${report.changed ?? "?"} hot=${report.hot} warm=${report.warm} cold=${report.cold} structural=${report.structural}`,
        );
        if (!opts?.apply) console.log("Dry-run only. Re-run with --apply to mutate fact tiers.");
      }),
    );

  mem
    .command("vectordb-optimize")
    .description(
      "Compact LanceDB fragments and prune old versions (stats.freedBytes may be 0 while layout still improves). " +
        "Disk size in `stats` is the whole Lance directory — remove stray `memories_reindex_*` / `memories_old_*` folders after a failed re-index swap if present.",
    )
    .option("--older-than-days <days>", "Remove versions older than this many days (default: 7)", "7")
    .action(
      withExit(async (opts?: { olderThanDays?: string }) => {
        const parsedDays = Number.parseInt(opts?.olderThanDays ?? "7", 10);
        if (!Number.isFinite(parsedDays) || parsedDays < 0) {
          console.error("error: --older-than-days must be a finite number ≥ 0");
          process.exitCode = 1;
          return;
        }
        const olderThanMs = parsedDays * 24 * 60 * 60 * 1000;
        try {
          const stats = await vectorDb.optimize(olderThanMs);
          // Record timestamp after successful optimization
          if (ctx.resolvedSqlitePath) {
            recordMaintenanceTimestamp(ctx.resolvedSqlitePath, ".vectordb_optimize_last_run");
          }
          console.log(
            `LanceDB: compacted ${stats.compacted} fragments, pruned ${stats.removedFragments} fragment(s), freed ${stats.freedBytes} bytes`,
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "vectordb-optimize",
          });
          throw err;
        }
      }),
    );

  mem
    .command("record-storage-sample")
    .description(
      "Record one storage_growth_history row per UTC day (SQLite + Lance sizes). Use with daily cron so audit-health can compute 7d deltas.",
    )
    .action(
      withExit(async () => {
        let lanceBytes: number | null = null;
        try {
          const sizes = await Promise.resolve(ctx.richStatsExtras?.getStorageSizes());
          if (sizes && typeof sizes.lanceBytes === "number") lanceBytes = sizes.lanceBytes;
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "record-storage-sample-lance",
            severity: "info",
            subsystem: "cli",
          });
        }
        const r = recordStorageGrowthSample(factsDb, lanceBytes);
        console.log(
          r.inserted
            ? `record-storage-sample: inserted row (unix=${r.recordedAt})`
            : `record-storage-sample: skipped (already sampled today UTC; unix=${r.recordedAt})`,
        );
      }),
    );

  mem
    .command("stats")
    .description(
      "Show memory statistics. Rich output includes procedures, rules, patterns, directives, graph, and operational info. Use --efficiency for tiers, sources, and token estimates.",
    )
    .option(
      "--efficiency",
      "Add estimated stored tokens and a short note (rich mode); without rich stats, prints a compact efficiency-only report",
    )
    .option("--brief", "Show only storage and decay counts (legacy-style)")
    .action(
      withExit(async (opts?: { efficiency?: boolean; brief?: boolean }) => {
        const efficiency = opts?.efficiency ?? false;
        const brief = opts?.brief ?? false;
        const sqlCount = factsDb.count();
        let lanceCount = 0;
        try {
          lanceCount = await vectorDb.count();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "vector-count",
            severity: "info",
            subsystem: "cli",
          });
          // vectorDb may be unavailable
        }
        const breakdown = factsDb.statsBreakdownByTier();
        const expired = factsDb.countExpired();

        const extras = ctx.richStatsExtras;
        const useRich = !brief && extras;

        if (useRich) {
          const byCategory = factsDb.statsBreakdownByCategory();
          const procedures = factsDb.proceduresCount();
          const proceduresValidated = factsDb.proceduresValidatedCount();
          const proceduresPromoted = factsDb.proceduresPromotedCount();
          const directives = factsDb.directivesCount();
          const rules = byCategory.rule ?? 0;
          const patterns = byCategory.pattern ?? 0;
          const metaPatterns = factsDb.metaPatternsCount();
          const links = factsDb.linksCount();
          const entities = factsDb.entityCount();
          const topEntitiesFiltered = factsDb.topEntitiesFiltered(5, ctx.cfg.entityExtraction.stopWords);
          const categoriesConfigured = getMemoryCategories();
          const uniqueInMemory = factsDb.uniqueMemoryCategories();
          const credentials = extras.getCredentialsCount();
          const proposalsPending = extras.getProposalsPending();
          const proposalsAvailable = extras.getProposalsAvailable();
          const pendingReview = countPendingReviewBacklogs(ctx.cfg, factsDb);
          const walPending = await extras.getWalPending();
          const timestamps = extras.getLastRunTimestamps();
          const sizes = await extras.getStorageSizes();

          const { reflectionPatternsCount, reflectionRulesCount } = factsDb.statsReflection();
          const selfCorrectionCount = factsDb.selfCorrectionIncidentsCount();
          const languageKeywordsCount = factsDb.languageKeywordsCount();

          const activeFacts = factsDb.getCount();
          const supersededFacts = factsDb.countSupersededFacts();
          const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();
          const vectorless = factsDb.countVectorlessActiveFacts();
          const vectorlessBySource = factsDb.vectorlessActiveFactsBySource(5);
          const procedureTriage = factsDb.triageProcedures({ status: "validated", notPromoted: true, limit: 10_000 });
          const unresolvedContradictions = factsDb.contradictionsCount();
          const verifiedFacts = factsDb.countVerifiedFacts();
          const activity = factsDb.recentActivity();
          const decayBreakdown = factsDb.statsBreakdownByDecayClass();
          const sourceBreakdown = factsDb.statsBySource();
          const dailyWrites = factsDb.statsDailyWrites().slice(0, 10);
          const implicitFeedbackSignals = countImplicitFeedbackTrajectorySignals(factsDb);
          const cronJobs = extras.getCronJobsStatus?.() ?? [];

          const lanceDelta = sqlCount - lanceCount;
          const lanceAbs = Math.abs(lanceDelta);
          const lanceDen = Math.max(sqlCount, lanceCount, 1);
          const lanceDeltaSignificant = lanceAbs > 100 && lanceAbs / lanceDen > 0.05;
          const totalFacts = sqlCount;
          const canonicalDelta = totalFacts - canonicalEmbeddings;
          const canonicalAbs = Math.abs(canonicalDelta);
          const canonicalDen = Math.max(totalFacts, canonicalEmbeddings, 1);
          const canonicalDeltaSignificant = canonicalAbs > 100 && canonicalAbs / canonicalDen > 0.05;

          console.log("=== Memory Statistics (rich) ===");
          console.log(`Schema version: ${versionInfo.schemaVersion}`);
          console.log(`Plugin version: ${versionInfo.pluginVersion}`);
          console.log(`Memory Manager: ${versionInfo.memoryManagerVersion}`);
          console.log("");
          console.log(`Total facts (SQLite): ${sqlCount}`);
          console.log(
            `Active facts: ${activeFacts}; superseded: ${supersededFacts}; expired pending prune: ${expired}`,
          );
          console.log(
            `Total vectors (LanceDB): ${lanceCount} (canonical embeddings in SQLite: ${canonicalEmbeddings})`,
          );
          console.log(`Vectorless active non-kv facts: ${vectorless}`);
          if (vectorlessBySource.length > 0) {
            console.log(`Vectorless by source: ${vectorlessBySource.map((r) => `${r.source}=${r.count}`).join(", ")}`);
          }
          if (lanceDeltaSignificant || canonicalDeltaSignificant) {
            console.log(
              `  Health: SQLite facts ${sqlCount} vs LanceDB vectors ${lanceCount} (Δ=${lanceDelta}); total facts ${totalFacts} vs canonical embedding rows ${canonicalEmbeddings} (Δ=${canonicalDelta}). Run 'openclaw hybrid-mem re-index' if you switched embedding model or after a large backfill.`,
            );
          }
          console.log("");
          const proceduresNote = procedures === 0 ? " (run extract-procedures to populate)" : "";
          console.log(
            `Procedures: ${procedures} (validated: ${proceduresValidated}, promoted: ${proceduresPromoted}, blocked: ${procedureTriage.summary.total}${procedureTriage.summary.topReason ? ` by ${procedureTriage.summary.topReason}` : ""})${proceduresNote}`,
          );
          console.log(
            `Pending review (proposals/procedures/tools/crystal/verified): ${pendingReview.persona}/${pendingReview.procedures}/${pendingReview.tools}/${pendingReview.crystallization}/${pendingReview.verified}`,
          );
          console.log(`Rules: ${rules}`);
          console.log(`Patterns: ${patterns}`);
          console.log(`Implicit-feedback signals: ${implicitFeedbackSignals}`);
          console.log(`Meta-patterns: ${metaPatterns}`);
          console.log(`Directives: ${directives}`);
          console.log(`Reflection (patterns/rules): ${reflectionPatternsCount}/${reflectionRulesCount}`);
          console.log(`Self-correction incidents: ${selfCorrectionCount}`);
          console.log(`Language keywords: ${languageKeywordsCount}`);
          if (dailyWrites.length > 0) {
            console.log("Per-source writes/day (latest):");
            for (const row of dailyWrites) {
              const dropped = row.dropped > 0 ? `, dropped=${row.dropped}` : "";
              const evicted = row.evicted > 0 ? `, evicted=${row.evicted}` : "";
              console.log(`  ${row.day} ${row.source}: count=${row.count}${dropped}${evicted}`);
            }
          }
          if (unresolvedContradictions > 0) {
            console.log(
              `Contradictions (unresolved): ${unresolvedContradictions} — run 'openclaw hybrid-mem resolve-contradictions'`,
            );
          } else {
            console.log("Contradictions (unresolved): 0");
          }
          if (ctx.cfg.verification?.enabled) {
            console.log(`Verified facts: ${verifiedFacts}`);
          }
          console.log("");
          console.log(`Graph (links/entities): ${links}/${entities}`);
          if (topEntitiesFiltered.length > 0) {
            const formatted = topEntitiesFiltered.map((row) => `${row.entity}=${row.count}`).join(", ");
            console.log(`Top entities (filtered): ${formatted}`);
          }
          console.log(
            `Credentials (vaulted): ${credentials}${
              credentials === 0 && !ctx.cfg.credentials.enabled ? " (vault off in effective config; counts stay 0)" : ""
            }`,
          );
          const proposalsLine = proposalsAvailable
            ? `Proposals (pending): ${proposalsPending}${proposalsPending === 0 ? " (run generate-proposals to create)" : ""}`
            : ctx.cfg.personaProposals.enabled
              ? "Proposals (pending): — (proposals store unavailable)"
              : "Proposals (pending): — (persona proposals off in effective config; see hybrid-mem config if file still shows enabled)";
          console.log(proposalsLine);
          console.log(`WAL (pending distill): ${walPending}`);
          console.log("");
          const configuredSet = new Set(categoriesConfigured);
          const inMemorySet = new Set(uniqueInMemory);
          const unknownCategories = uniqueInMemory.filter((category: string) => !configuredSet.has(category));
          const configuredOnlyCategories = categoriesConfigured.filter(
            (category: string) => !inMemorySet.has(category),
          );
          console.log(
            `Categories configured: ${categoriesConfigured.length} [${categoriesConfigured.slice(0, 3).join(", ")}...]`,
          );
          console.log(`Categories in memory: ${uniqueInMemory.length} [${uniqueInMemory.slice(0, 3).join(", ")}...]`);
          if (unknownCategories.length > 0) {
            console.log(
              `Discovered/unknown categories: ${unknownCategories.length} [${unknownCategories.join(", ")}] — run 'openclaw hybrid-mem categories audit' and remap or promote them.`,
            );
          } else {
            console.log("Discovered/unknown categories: 0");
          }
          if (configuredOnlyCategories.length > 0) {
            console.log(
              `Configured categories with no active facts: ${configuredOnlyCategories.length} [${configuredOnlyCategories.join(", ")}]`,
            );
          }
          console.log("");
          console.log(
            `Breakdown by tier: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural ?? 0}`,
          );
          const decayParts = Object.entries(decayBreakdown)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          if (decayParts) console.log(`Breakdown by decay: ${decayParts}`);
          const topSources = Object.entries(sourceBreakdown)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          if (topSources.length > 0) {
            console.log(
              `Top sources (active): ${topSources.map(([s, c]) => `${s}=${c}`).join(", ")} (of ${
                Object.keys(sourceBreakdown).length
              } sources)`,
            );
          }
          console.log("");
          const oldestDays =
            activity.oldestActiveCreatedAtSec != null
              ? Math.max(0, Math.floor((Date.now() / 1000 - activity.oldestActiveCreatedAtSec) / 86400))
              : null;
          const newestAgeMin =
            activity.newestCreatedAtSec != null
              ? Math.max(0, Math.floor((Date.now() / 1000 - activity.newestCreatedAtSec) / 60))
              : null;
          console.log(
            `Recent activity: ${activity.last24h} new in 24h, ${activity.last7d} in 7d, ${activity.last30d} in 30d`,
          );
          if (newestAgeMin != null && oldestDays != null) {
            console.log(`  Newest fact: ${newestAgeMin} min ago. Oldest active: ${oldestDays} days old.`);
          }
          console.log("");
          console.log(`Last distill: ${timestamps.distill ?? "(never)"}`);
          console.log(`Last reflect: ${timestamps.reflect ?? "(never)"}`);
          console.log(`Last compact: ${timestamps.compact ?? "(never)"}`);
          console.log(`Last vectordb-optimize: ${timestamps.vectordbOptimize ?? "(never)"}`);
          console.log("");
          if (sizes.sqliteBytes != null) console.log(`SQLite size: ${(sizes.sqliteBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.lanceBytes != null) console.log(`LanceDB size: ${(sizes.lanceBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.sqliteBytes != null && activeFacts > 0) {
            const bytesPerFact = sizes.sqliteBytes / activeFacts;
            console.log(`SQLite bytes per active fact: ${bytesPerFact.toFixed(0)}`);
          }
          if (sizes.sqliteBytes != null || sizes.lanceBytes != null) console.log("");
          if (efficiency) {
            const estimatedTokens = factsDb.estimateStoredTokens();
            console.log("--- Efficiency (token estimate) ---");
            console.log(`Estimated stored tokens (all active tiers): ~${estimatedTokens}`);
            console.log("Note: Tiering and context scoping reduce tokens in the LLM vs raw store size.");
            console.log("");
          }
          if (cronJobs.length > 0) {
            const nowMs = Date.now();
            const dayMs = 86_400_000;
            const hourMs = 3_600_000;
            const noEmojiCron = getEnv("HYBRID_MEM_NO_EMOJI") === "1";
            const staleLabel = noEmojiCron ? "[WARN] stale" : "⚠ stale";
            const fmtStaleWindow = (ms: number) =>
              ms >= dayMs ? `${Math.max(1, Math.round(ms / dayMs))}d` : `${Math.max(1, Math.round(ms / hourMs))}h`;
            console.log(`Cron jobs (hybrid-mem:*): ${cronJobs.length}`);
            for (const j of cronJobs) {
              const status = j.enabled ? "enabled " : "disabled";
              const sched = j.scheduleExpr ?? "(no schedule)";
              const last =
                j.lastRunAtMs != null ? `last ${Math.floor((nowMs - j.lastRunAtMs) / 3600000)}h ago` : "last (never)";
              const interval = approxIntervalMs(j.scheduleExpr);
              const stale = j.enabled && interval && (j.lastRunAtMs == null || nowMs - j.lastRunAtMs > interval * 1.5);
              const staleNote =
                stale && interval != null
                  ? ` overdue (no run in >${fmtStaleWindow(interval * 1.5)} vs ~${fmtStaleWindow(interval)} schedule)`
                  : "";
              const tail = stale ? ` ${staleLabel}${staleNote}` : "";
              console.log(`  ${status} ${j.name.padEnd(30)} ${sched.padEnd(14)} ${last}${tail}`);
            }
            console.log("");
          }
        } else if (efficiency) {
          const byTier = breakdown;
          const bySource = factsDb.statsBySource();
          const dailyWrites = factsDb.statsDailyWrites().slice(0, 10);
          const estimatedTokens = factsDb.estimateStoredTokens();
          console.log("=== Memory Efficiency Stats ===");
          console.log(
            `Breakdown: hot=${byTier.hot}, warm=${byTier.warm}, cold=${byTier.cold}, structural=${byTier.structural ?? 0}`,
          );
          console.log(`Sources: ${Object.keys(bySource).length}`);
          for (const [src, count] of Object.entries(bySource).slice(0, 5)) {
            console.log(`  ${src}: ${count}`);
          }
          if (dailyWrites.length > 0) {
            console.log("Per-source writes/day (latest):");
            for (const row of dailyWrites) {
              const dropped = row.dropped > 0 ? `, dropped=${row.dropped}` : "";
              const evicted = row.evicted > 0 ? `, evicted=${row.evicted}` : "";
              console.log(`  ${row.day} ${row.source}: count=${row.count}${dropped}${evicted}`);
            }
          }
          console.log(`Estimated tokens (all tiers): ~${estimatedTokens}`);
          console.log("");
          console.log("Note: Tiering and scoping can significantly reduce token usage in LLM context.");
        } else {
          console.log(`Total facts (SQLite): ${sqlCount}`);
          console.log(`Total vectors (LanceDB): ${lanceCount}`);
          console.log(`Expired (prunable): ${expired}`);
          console.log(
            `Breakdown: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural ?? 0}`,
          );
        }
      }),
    );

  mem
    .command("reembed-vectorless")
    .description("Embed active non-kv facts that lack canonical embeddings (dry-run by default)")
    .option("--limit <n>", "Maximum vectorless facts to process", "100")
    .option("--source <s>", "Only process facts from this source")
    .option("--apply", "Actually embed and write LanceDB/fact_embeddings rows; default is dry-run")
    .option("--batch-size <n>", "Embedding batch size", "40")
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (opts?: { limit?: string; source?: string; apply?: boolean; batchSize?: string; json?: boolean }) => {
          const limit = Number.parseInt(opts?.limit ?? "100", 10);
          const batchSize = Number.parseInt(opts?.batchSize ?? "40", 10);
          if (!Number.isFinite(limit) || limit < 1) {
            console.error("error: --limit must be a positive integer");
            process.exitCode = 1;
            return;
          }
          if (!Number.isFinite(batchSize) || batchSize < 1) {
            console.error("error: --batch-size must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const before = factsDb.countVectorlessActiveFacts(opts?.source);
          const candidates = factsDb.listVectorlessActiveFacts({ limit, source: opts?.source });
          const errors: string[] = [];
          let embedded = 0;
          let skipped = 0;
          let storeFailures = 0;
          let embedFailures = 0;
          if (opts?.apply) {
            await vectorDb.runWithAutoOptimizePaused(async () => {
              for (let offset = 0; offset < candidates.length; offset += batchSize) {
                const batch = candidates.slice(offset, offset + batchSize);
                let vectors: (number[] | null)[];
                try {
                  vectors = await embeddings.embedBatch(batch.map((fact) => fact.text));
                } catch (_err) {
                  vectors = [];
                  for (const fact of batch) {
                    try {
                      vectors.push(await embeddings.embed(fact.text));
                    } catch (singleErr) {
                      errors.push(`fact ${fact.id}: embed failed — ${String(singleErr)}`);
                      embedFailures++;
                      vectors.push(null);
                    }
                  }
                }
                for (let i = 0; i < batch.length; i++) {
                  const fact = batch[i];
                  const vec = vectors[i];
                  if (!vec || vec.length === 0) {
                    skipped++;
                    continue;
                  }
                  try {
                    try {
                      await vectorDb.delete(fact.id);
                    } catch {
                      // Missing Lance row is the normal case for vectorless repair.
                    }
                    await vectorDb.store({
                      id: fact.id,
                      text: fact.text,
                      vector: vec,
                      importance: 0.5,
                      category: fact.category,
                    });
                    factsDb.storeEmbedding(
                      fact.id,
                      embeddings.modelName,
                      "canonical",
                      new Float32Array(vec),
                      vec.length,
                    );
                    factsDb.setEmbeddingModel(fact.id, embeddings.modelName);
                    embedded++;
                  } catch (err) {
                    errors.push(`fact ${fact.id}: store failed — ${String(err)}`);
                    storeFailures++;
                    skipped++;
                  }
                }
              }
            });
          }
          const after = opts?.apply ? factsDb.countVectorlessActiveFacts(opts?.source) : before;
          const report = {
            apply: opts?.apply === true,
            source: opts?.source ?? null,
            before,
            considered: candidates.length,
            embedded,
            skipped,
            embedFailures,
            storeFailures,
            errors,
            after,
          };
          if (opts?.apply && storeFailures > 0) {
            process.exitCode = 2;
          }
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(
            `Reembed vectorless ${report.apply ? "applied" : "dry-run"}: before ${before}, candidates ${candidates.length}, embedded ${embedded}, skipped ${skipped}, storeFailures ${storeFailures}, after ${after}`,
          );
          if (candidates.length > 0 && !opts?.apply) {
            console.log("Examples:");
            for (const fact of candidates.slice(0, 10)) {
              console.log(`  ${fact.id}  ${fact.source}  ${fact.text.slice(0, 80).replace(/\s+/g, " ")}`);
            }
            console.log("Dry-run only. Re-run with --apply to write embeddings.");
          }
          if (errors.length > 0) {
            console.warn(`Errors: ${errors.length}`);
            for (const err of errors.slice(0, 10)) console.warn(`  - ${err}`);
          }
          if (opts?.apply && storeFailures > 0) {
            console.warn(
              `Partial success: ${storeFailures} write failure(s) occurred during vector re-embedding; retryable LanceDB conflicts were retried where applicable (exit=2).`,
            );
          }
        },
      ),
    );

  mem
    .command("prune")
    .description("Remove expired facts (decayed past threshold)")
    .option("-v, --verbose", "List fact ids that will be removed before pruning")
    .action(
      withExit(async (opts?: { verbose?: boolean }, cmd?: CommanderOptsParent) => {
        const verbose = !!opts?.verbose || readHybridMemVerbose(cmd);
        const before = factsDb.count();
        if (verbose) {
          const pending = factsDb.listExpiredFactIdsPendingPrune();
          if (pending.length > 0) {
            console.log("Fact ids to prune (--verbose):");
            for (const id of pending) console.log(`  ${id}`);
          } else {
            console.log("No expired facts pending prune (--verbose).");
          }
        }
        const pendingVectorDeletes = factsDb.listExpiredFactIdsPendingPrune();
        const pruned = factsDb.prune();
        const vectorCleanup = await deleteVectorsForFactIds(vectorDb, pendingVectorDeletes, {
          operation: "cli-prune-expired",
          logger: {
            warn: (msg) => console.warn(msg),
          },
        });
        const after = factsDb.count();
        console.log(
          `Pruned ${pruned} expired facts. Before: ${before}, After: ${after}. Vector cleanup: ${vectorCleanup.deleted}/${vectorCleanup.attempted} deleted${vectorCleanup.failed > 0 ? ` (${vectorCleanup.failed} failed)` : ""}.`,
        );
      }),
    );

  mem
    .command("checkpoint")
    .description("Checkpoint vector DB to disk (LanceDB optimization)")
    .action(
      withExit(async () => {
        await vectorDb.checkpoint?.();
        console.log("Vector DB checkpoint complete.");
      }),
    );

  mem
    .command("re-index")
    .description(
      "Re-embed all facts into a shadow table, validate, and atomically swap into place. Non-destructive: aborted runs preserve the live vector store (use after switching embedding model, e.g. to a larger one).",
    )
    .option("--batch-size <n>", "Facts per embed batch (default: 50)", "50")
    .option(
      "--delay-ms-between-batches <n>",
      "Pause between embedding batches in ms (default: 0). On Azure/APIM with tight RPM, try 2000 — see docs/TROUBLESHOOTING.md and issue #940.",
      "0",
    )
    .option(
      "--min-fraction-success <n>",
      "Minimum fraction of facts that must be successfully embedded (0.0-1.0, default: 0.95). Re-index aborts without swapping if fewer facts are migrated.",
      "0.95",
    )
    .option("--resume", "Resume from saved checkpoint file when available")
    .option("--checkpoint-file <path>", "Checkpoint file path for resumable re-index")
    .action(
      withExit(
        async (opts?: {
          batchSize?: string;
          delayMsBetweenBatches?: string;
          minFractionSuccess?: string;
          resume?: boolean;
          checkpointFile?: string;
        }) => {
          const batchSize = parseBoundedIntOption(opts?.batchSize, 50, 1, 500);
          const delayMsBetweenBatches = parseBoundedIntOption(opts?.delayMsBetweenBatches, 0, 0, 120_000);
          const minFractionSuccess = parseBoundedFloatOption(opts?.minFractionSuccess, 0.95, 0.0, 1.0);
          const checkpointPath =
            opts?.checkpointFile?.trim() ||
            (ctx.resolvedSqlitePath ? defaultReindexCheckpointPath(ctx.resolvedSqlitePath) : "");
          let resumeCheckpoint = opts?.resume === true && checkpointPath ? readReindexCheckpoint(checkpointPath) : null;

          // Get total facts for validation
          const totalFacts =
            typeof (factsDb as { getCount?: unknown }).getCount === "function"
              ? (factsDb as { getCount: (opts: { includeSuperseded: boolean }) => number }).getCount({
                  includeSuperseded: false,
                })
              : factsDb.getAll({ includeSuperseded: false }).length;

          const runReindex = async () => {
            console.log(`Re-index: starting non-destructive re-index of ${totalFacts} facts...`);
            if (resumeCheckpoint) {
              console.log(
                `Re-index: resume enabled — checkpoint offset ${resumeCheckpoint.offset}/${resumeCheckpoint.total}`,
              );
              if (resumeCheckpoint.total !== totalFacts) {
                console.warn(
                  `Re-index: checkpoint total (${resumeCheckpoint.total}) differs from current fact count (${totalFacts}); checkpoint will be ignored for safety.`,
                );
                resumeCheckpoint = null;
              } else if (resumeCheckpoint.offset > 0) {
                console.warn(
                  "Re-index: checkpoint offsets cannot be resumed with a newly-created shadow table; restarting from offset 0 for safety.",
                );
                resumeCheckpoint = null;
              }
            }
            console.log("Re-index: creating shadow table for safe rebuild...");

            let shadowTableName: string;
            try {
              shadowTableName = await vectorDb.createShadowTable();
            } catch (err) {
              console.error(`Re-index failed: unable to create shadow table: ${err}`);
              process.exit(1);
            }
            if (ctx.resolvedSqlitePath) {
              appendVectorLifecycleAuditEvent(ctx.resolvedSqlitePath, {
                event: "reindex_started",
                ts: new Date().toISOString(),
                details: { totalFacts, batchSize, delayMsBetweenBatches, minFractionSuccess, shadowTableName },
              });
            }

            console.log("Re-index: embedding all facts into shadow table (this may take a while)...");
            const result = await migrateEmbeddings({
              factsDb,
              vectorDb,
              embeddings,
              batchSize,
              delayMsBetweenBatches,
              targetTableName: shadowTableName,
              checkpoint:
                checkpointPath.length > 0
                  ? {
                      load: () => (resumeCheckpoint ? { offset: resumeCheckpoint.offset } : null),
                      save: (state) => writeReindexCheckpoint(checkpointPath, state),
                      clear: () => {
                        if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
                      },
                    }
                  : undefined,
              onProgress: (completed, total) => {
                if (total > 0 && completed % Math.max(1, Math.floor(total / 10)) === 0) {
                  process.stdout.write(`  ${completed}/${total} facts embedded...\r`);
                  if (ctx.resolvedSqlitePath) {
                    appendVectorLifecycleAuditEvent(ctx.resolvedSqlitePath, {
                      event: "reindex_progress",
                      ts: new Date().toISOString(),
                      details: { completed, total },
                    });
                  }
                }
              },
              logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
            });

            console.log(
              `\nRe-index: migration complete — ${result.migrated} embedded, ${result.skipped} skipped, ${result.errors.length} errors.`,
            );

            if (result.errors.length > 0 && result.errors.length <= 10) {
              for (const e of result.errors) console.warn(`  - ${e}`);
            } else if (result.errors.length > 10) {
              console.warn(`  (${result.errors.length} errors; first 5:)`);
              for (const e of result.errors.slice(0, 5)) console.warn(`  - ${e}`);
            }

            // Hard abort (e.g. VectorDB closed mid-run, see #1247): never swap a
            // partial shadow table into place.
            if (result.aborted) {
              if (ctx.resolvedSqlitePath) {
                appendVectorLifecycleAuditEvent(ctx.resolvedSqlitePath, {
                  event: "reindex_aborted",
                  ts: new Date().toISOString(),
                  details: {
                    migrated: result.migrated,
                    skipped: result.skipped,
                    errors: result.errors.length,
                    processed: result.processed,
                    total: result.total,
                    abortReason: result.abortReason ?? null,
                    shadowTableName,
                  },
                });
              }
              console.error(
                `\nRe-index FAILED: ${result.migrated} embedded, ${result.skipped} skipped, ${result.errors.length} errors ` +
                  `(processed ${result.processed}/${result.total}) — migration aborted before completion.`,
              );
              console.error(`Reason: ${result.abortReason ?? "unknown"}`);
              console.error("Live vector store was NOT modified.");
              console.error(`Shadow table preserved for inspection: ${shadowTableName}`);
              console.error("Recommendation: Re-run 'openclaw hybrid-mem re-index --resume' to continue.");
              process.exit(1);
            }

            // Validate row count before swapping
            const minRequired = Math.ceil(totalFacts * minFractionSuccess);
            if (result.migrated < minRequired) {
              console.error(
                `\nRe-index validation failed: ${result.migrated} migrated < required minimum ${minRequired} ` +
                  `(${(minFractionSuccess * 100).toFixed(1)}% of ${totalFacts} facts).`,
              );
              console.error("Aborting swap to preserve live vector store.");
              console.error(`Shadow table preserved for inspection: ${shadowTableName}`);
              console.error("To retry, clean up shadow table and run re-index again.");
              process.exit(1);
            }

            console.log(
              `Re-index: validation passed — ${result.migrated} >= ${minRequired} required (${(minFractionSuccess * 100).toFixed(1)}% of ${totalFacts})`,
            );
            console.log("Re-index: swapping shadow table into place...");

            try {
              await vectorDb.swapShadowTable(shadowTableName, minFractionSuccess, totalFacts);
            } catch (err) {
              console.error(`\nRe-index failed: shadow table swap failed: ${err}`);
              console.error("Live vector store was NOT modified.");
              console.error(`Shadow table preserved for inspection: ${shadowTableName}`);
              process.exit(1);
            }

            // Update embedding metadata in SQLite (batch update for all facts)
            console.log("Re-index: updating embedding metadata in SQLite...");
            const allFacts = hasGetBatch(factsDb)
              ? (() => {
                  const facts: Array<{ id: string }> = [];
                  let offset = 0;
                  const batchSize = 500;
                  while (true) {
                    const batch = factsDb.getBatch(offset, batchSize, { includeSuperseded: false });
                    if (batch.length === 0) break;
                    facts.push(...batch);
                    offset += batch.length;
                  }
                  return facts;
                })()
              : factsDb.getAll({ includeSuperseded: false });

            for (const fact of allFacts) {
              try {
                factsDb.setEmbeddingModel(fact.id, embeddings.modelName);
              } catch {
                // ignore per-fact metadata update errors (non-fatal)
              }
            }

            if (ctx.resolvedSqlitePath) {
              appendVectorLifecycleAuditEvent(ctx.resolvedSqlitePath, {
                event: "reindex_completed",
                ts: new Date().toISOString(),
                details: {
                  migrated: result.migrated,
                  skipped: result.skipped,
                  errors: result.errors.length,
                  total: result.total,
                  shadowTableName,
                },
              });
            }

            console.log(`\nRe-index complete: ${result.migrated} facts successfully re-indexed.`);
            console.log("Live vector store updated atomically. Semantic search is fully operational.");
          };

          if (typeof (vectorDb as { runWithReindexLock?: unknown }).runWithReindexLock === "function") {
            await (
              vectorDb as {
                runWithReindexLock: <T>(fn: () => Promise<T>) => Promise<T>;
              }
            ).runWithReindexLock(runReindex);
          } else {
            await runReindex();
          }
        },
      ),
    );

  mem
    .command("repair-vectors")
    .description(
      "Run an orchestrated vector lifecycle repair pipeline: reembed-vectorless, vectordb-optimize, reconcile orphans, and print a single report.",
    )
    .option(
      "--reconcile-policy <policy>",
      "Self-heal policy for SQLite-orphan vectors: conservative|balanced|aggressive",
      "balanced",
    )
    .option("--max-fixes <n>", "Max SQLite-orphan vectors to auto-rebuild (default: 200)", "200")
    .option("--json", "Emit JSON report")
    .action(
      withExit(async (opts?: { reconcilePolicy?: string; maxFixes?: string; json?: boolean }) => {
        const resolveRepairBudget = (policy: "conservative" | "balanced" | "aggressive", maxFixes: number): number => {
          if (policy === "conservative") return 0;
          if (policy === "balanced") return maxFixes;
          return Math.max(maxFixes, 2000);
        };
        const policyRaw = String(opts?.reconcilePolicy ?? "balanced")
          .trim()
          .toLowerCase();
        const policy = policyRaw === "conservative" || policyRaw === "aggressive" ? policyRaw : "balanced";
        const maxFixes = parseBoundedIntOption(opts?.maxFixes, 200, 0, 5000);
        const report = {
          policy,
          maxFixes,
          startedAt: new Date().toISOString(),
          vectorlessBefore: factsDb.countVectorlessActiveFacts(),
          reembedded: 0,
          optimize: { compacted: 0, removedFragments: 0, freedBytes: 0 },
          reconcile: {
            vectorOrphans: 0,
            vectorOrphansDeleted: 0,
            sqliteOrphans: 0,
            sqliteOrphansRebuilt: 0,
            sqliteOrphansSkipped: 0,
          },
          vectorlessAfter: 0,
          errors: [] as string[],
        };

        // Step 1: reembed vectorless facts
        const candidates = factsDb.listVectorlessActiveFacts({ limit: Math.max(200, maxFixes) });
        const allowedRebuilds = resolveRepairBudget(policy, maxFixes);
        for (const fact of candidates.slice(0, allowedRebuilds)) {
          try {
            const vec = await embeddings.embed(fact.text);
            await vectorDb.store({
              id: fact.id,
              text: fact.text,
              vector: vec,
              importance: 0.5,
              category: fact.category,
            });
            report.reembedded++;
          } catch (err) {
            report.errors.push(`reembed ${fact.id}: ${String(err)}`);
          }
        }

        // Step 2: optimize
        try {
          report.optimize = await vectorDb.optimize();
        } catch (err) {
          report.errors.push(`optimize: ${String(err)}`);
        }

        // Step 3: reconcile and policy-based self-heal
        try {
          const sqliteIds = new Set(factsDb.getAllIds());
          const vectorIds = await vectorDb.getAllIds();
          const vectorIdSet = new Set(vectorIds);
          const vectorOrphans = vectorIds.filter((id) => !sqliteIds.has(id));
          const sqliteOrphans = Array.from(sqliteIds).filter((id) => !vectorIdSet.has(id));
          report.reconcile.vectorOrphans = vectorOrphans.length;
          report.reconcile.sqliteOrphans = sqliteOrphans.length;

          for (const id of vectorOrphans) {
            try {
              await vectorDb.delete(id);
              report.reconcile.vectorOrphansDeleted++;
            } catch (err) {
              report.errors.push(`delete orphan vector ${id}: ${String(err)}`);
            }
          }

          const rebuildLimit = Math.min(resolveRepairBudget(policy, maxFixes), sqliteOrphans.length);
          for (const id of sqliteOrphans.slice(0, rebuildLimit)) {
            try {
              const fact = factsDb.getById(id);
              if (!fact) {
                report.reconcile.sqliteOrphansSkipped++;
                continue;
              }
              const vec = await embeddings.embed(fact.text);
              await vectorDb.store({
                id: fact.id,
                text: fact.text,
                vector: vec,
                importance: fact.importance ?? 0.5,
                category: fact.category,
              });
              report.reconcile.sqliteOrphansRebuilt++;
            } catch (err) {
              report.errors.push(`rebuild sqlite orphan ${id}: ${String(err)}`);
            }
          }
          report.reconcile.sqliteOrphansSkipped += Math.max(0, sqliteOrphans.length - rebuildLimit);
        } catch (err) {
          report.errors.push(`reconcile: ${String(err)}`);
        }

        report.vectorlessAfter = factsDb.countVectorlessActiveFacts();
        const finishedAt = new Date().toISOString();
        if (ctx.resolvedSqlitePath) {
          appendVectorLifecycleAuditEvent(ctx.resolvedSqlitePath, {
            event: "repair_vectors_completed",
            ts: finishedAt,
            details: report as unknown as Record<string, unknown>,
          });
        }
        if (opts?.json) {
          console.log(JSON.stringify({ ...report, finishedAt }, null, 2));
          return;
        }
        console.log("Repair vectors report:");
        console.log(`  policy=${report.policy} maxFixes=${report.maxFixes}`);
        console.log(`  vectorless: before=${report.vectorlessBefore} after=${report.vectorlessAfter}`);
        console.log(
          `  optimize: compacted=${report.optimize.compacted} removedFragments=${report.optimize.removedFragments} freedBytes=${report.optimize.freedBytes}`,
        );
        console.log(
          `  reconcile: vectorOrphans=${report.reconcile.vectorOrphans} deleted=${report.reconcile.vectorOrphansDeleted}; sqliteOrphans=${report.reconcile.sqliteOrphans} rebuilt=${report.reconcile.sqliteOrphansRebuilt} skipped=${report.reconcile.sqliteOrphansSkipped}`,
        );
        if (report.errors.length > 0) {
          console.log(`  errors=${report.errors.length}`);
          for (const err of report.errors.slice(0, 10)) console.log(`    - ${err}`);
          process.exitCode = 2;
        }
      }),
    );

  mem
    .command("classification-artifacts")
    .description(
      "Supersede existing NOOP/classification-artifact facts and remove their LanceDB vectors (issue #1561). " +
        "Dry-run by default; use --apply to mutate.",
    )
    .option("--apply", "Actually supersede facts and delete vectors. Omit for dry-run.")
    .option("--json", "Emit JSON report")
    .action(
      withExit(async (opts?: { apply?: boolean; json?: boolean }) => {
        const apply = opts?.apply === true;
        const supersededIds: string[] = [];
        const verifiedSkippedIds: string[] = [];
        const vectorDeleteErrors: string[] = [];
        let vectorDeleteCount = 0;
        const verifiedLookup = (() => {
          try {
            return hasGetRawDb(factsDb)
              ? factsDb.getRawDb().prepare("SELECT 1 FROM verified_facts WHERE fact_id = ? LIMIT 1")
              : null;
          } catch {
            return null;
          }
        })();
        const processFactBatch = async (facts: Array<{ id: string; text: string }>): Promise<void> => {
          for (const fact of facts) {
            if (!isPromptArtifactOrReasoningTrace(fact.text)) continue;
            if (verifiedLookup?.get(fact.id)) {
              verifiedSkippedIds.push(fact.id);
              continue;
            }
            supersededIds.push(fact.id);
            if (!apply) continue;
            try {
              factsDb.supersede(fact.id, null);
            } catch (err) {
              vectorDeleteErrors.push(`supersede ${fact.id}: ${String(err)}`);
              continue;
            }
            try {
              await vectorDb.delete(fact.id);
              vectorDeleteCount++;
            } catch (err) {
              vectorDeleteErrors.push(`vector delete ${fact.id}: ${String(err)}`);
            }
          }
        };
        if (hasGetBatch(factsDb)) {
          let offset = 0;
          const batchSize = 500;
          while (true) {
            const batch = factsDb.getBatch(offset, batchSize, { includeSuperseded: false });
            if (batch.length === 0) break;
            await processFactBatch(batch);
            offset += batch.length;
          }
        } else {
          await processFactBatch(factsDb.getAll({ includeSuperseded: false }));
        }

        if (apply && ctx.resolvedSqlitePath) {
          recordMaintenanceTimestamp(ctx.resolvedSqlitePath, ".classification_artifacts_last_run");
        }

        const report = {
          apply,
          superseded: supersededIds.length,
          supersededIds,
          verifiedSkipped: verifiedSkippedIds.length,
          verifiedSkippedIds,
          vectorDeletes: apply ? vectorDeleteCount : 0,
          vectorDeleteErrors,
        };

        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        if (supersededIds.length === 0) {
          console.log("classification-artifacts: no artifact facts found");
          return;
        }

        console.log(
          `classification-artifacts ${apply ? "applied" : "dry-run"}: ${supersededIds.length} artifact fact(s) identified`,
        );
        if (verifiedSkippedIds.length > 0) {
          console.log(`Skipped verified facts: ${verifiedSkippedIds.length}`);
        }
        if (!apply) {
          console.log("Dry-run only. Re-run with --apply to supersede and delete vectors.");
          console.log("Fact IDs:");
          for (const id of supersededIds) console.log(`  ${id}`);
          if (verifiedSkippedIds.length > 0) {
            console.log("Verified fact IDs left untouched:");
            for (const id of verifiedSkippedIds) console.log(`  ${id}`);
          }
        } else {
          console.log(`Vectors deleted: ${vectorDeleteCount}`);
          if (vectorDeleteErrors.length > 0) {
            console.warn(`Errors: ${vectorDeleteErrors.length}`);
            for (const e of vectorDeleteErrors.slice(0, 10)) console.warn(`  - ${e}`);
            process.exitCode = 2;
          }
        }
      }),
    );
}
