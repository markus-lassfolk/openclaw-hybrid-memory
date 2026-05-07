/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER } from "../../cmd-feedback.js";
import { vectorDimsForModel } from "../../../config.js";
import { listDumpTypeAliases, runSqliteTableDump } from "../../../services/cli-sql-dump.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { filterByScope } from "../../../services/merge-results.js";
import type { MemoryEntry, ScopeFilter } from "../../../types/memory.js";
import { getEnv } from "../../../utils/env-manager.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "../../global-verbose.js";
import { approxIntervalMs, type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

/** Apply optional CLI filters to merged hybrid search results (category/entity/key/source/tier). */
function entryMatchesHybridSearchFilters(
  entry: MemoryEntry,
  opts?: {
    category?: string;
    entity?: string;
    key?: string;
    source?: string;
    tier?: string;
  },
): boolean {
  if (!opts) return true;
  if (opts.category && entry.category !== opts.category) return false;
  if (opts.entity != null && opts.entity !== "" && entry.entity !== opts.entity) return false;
  if (opts.key != null && opts.key !== "" && entry.key !== opts.key) return false;
  if (opts.source != null && opts.source !== "" && entry.source !== opts.source) return false;
  if (opts.tier != null && opts.tier !== "" && entry.tier !== opts.tier) return false;
  return true;
}

type AuditHealthReport = {
  activeFacts: number;
  canonicalEmbeddings: number;
  vectorlessApprox: number;
  procedures: { total: number; validated: number; promoted: number; validatedNotPromoted: number };
  tiers: Record<string, number>;
  decay: Record<string, number>;
  categories: { configured: string[]; present: string[]; unknown: string[] };
  sources: Record<string, number>;
  implicitFeedbackTrajectorySignals: number;
  warnings: string[];
};

function countImplicitFeedbackTrajectorySignals(factsDb: ManageBindings["factsDb"]): number {
  const raw = factsDb.getRawDb?.();
  if (!raw) return 0;
  const row = raw
    .prepare(
      `SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback' AND superseded_at IS NULL AND ${SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER}`,
    )
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function buildAuditHealthReport(
  factsDb: ManageBindings["factsDb"],
  getMemoryCategories: () => readonly string[],
): AuditHealthReport {
  const activeFacts = factsDb.getCount();
  const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();
  const procedures = factsDb.proceduresCount();
  const validated = factsDb.proceduresValidatedCount();
  const promoted = factsDb.proceduresPromotedCount();
  const tiers = factsDb.statsBreakdownByTier();
  const decay = factsDb.statsBreakdownByDecayClass();
  const present = factsDb.uniqueMemoryCategories().slice().sort();
  const configured = [...getMemoryCategories()].slice().sort();
  const configuredSet = new Set(configured);
  const unknown = present.filter((category: string) => !configuredSet.has(category));
  const sources = factsDb.statsBySource();
  const implicitFeedbackTrajectorySignals = countImplicitFeedbackTrajectorySignals(factsDb);
  const vectorlessApprox = Math.max(0, activeFacts - canonicalEmbeddings);
  const warnings: string[] = [];
  if ((tiers.hot ?? 0) === 0) warnings.push("No HOT tier facts detected; tiering may not be promoting active memory.");
  if ((tiers.structural ?? 0) === 0)
    warnings.push("No STRUCTURAL tier facts detected; key/value facts may be stuck in warm tier.");
  if (activeFacts > 0 && (decay.stable ?? 0) / activeFacts > 0.5)
    warnings.push("More than half of active facts are stable/no-expiry.");
  if (unknown.length > 0) warnings.push(`Categories present in DB but not configured: ${unknown.join(", ")}`);
  if (vectorlessApprox > 0) warnings.push(`${vectorlessApprox} active fact(s) may be missing canonical embeddings.`);
  if (validated - promoted > 0) warnings.push(`${validated - promoted} validated procedure(s) are not promoted.`);
  return {
    activeFacts,
    canonicalEmbeddings,
    vectorlessApprox,
    procedures: { total: procedures, validated, promoted, validatedNotPromoted: Math.max(0, validated - promoted) },
    tiers,
    decay,
    categories: { configured, present, unknown },
    sources,
    implicitFeedbackTrajectorySignals,
    warnings,
  };
}

function printAuditHealthMarkdown(report: AuditHealthReport): void {
  console.log("# Hybrid-memory audit health");
  console.log("");
  console.log(`Active facts: ${report.activeFacts}`);
  console.log(`Canonical embeddings: ${report.canonicalEmbeddings}`);
  console.log(`Vectorless approximation: ${report.vectorlessApprox}`);
  console.log(
    `Procedures: ${report.procedures.total} (validated: ${report.procedures.validated}, promoted: ${report.procedures.promoted}, validated-not-promoted: ${report.procedures.validatedNotPromoted})`,
  );
  console.log(`Tiers: ${JSON.stringify(report.tiers)}`);
  console.log(`Decay: ${JSON.stringify(report.decay)}`);
  console.log(
    `Unknown categories: ${report.categories.unknown.length ? report.categories.unknown.join(", ") : "none"}`,
  );
  console.log(`Implicit-feedback trajectory signals: ${report.implicitFeedbackTrajectorySignals}`);
  console.log("");
  if (report.warnings.length === 0) {
    console.log("Warnings: none");
    return;
  }
  console.log("Warnings:");
  for (const warning of report.warnings) console.log(`- ${warning}`);
}

export function registerManageStorageAndStats(mem: Chainable, b: ManageBindings): void {
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
  } = b;

  mem
    .command("compact")
    .description("Run tier compaction: completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT")
    .action(
      withExit(async () => {
        let counts;
        try {
          counts = await runCompaction();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "compact",
          });
          throw err;
        }
        console.log(`Tier compaction: hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
      }),
    );

  mem
    .command("vectordb-optimize")
    .description("Compact LanceDB fragments and prune old versions to reclaim disk space and reduce memory usage")
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
    .command("stats")
    .description(
      "Show memory statistics. Rich output includes procedures, rules, patterns, directives, graph, and operational info. Use --efficiency for tiers, sources, and token estimates.",
    )
    .option("--efficiency", "Show tier/source breakdown, estimated tokens, and token-savings note")
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
          const categoriesConfigured = getMemoryCategories();
          const uniqueInMemory = factsDb.uniqueMemoryCategories();
          const credentials = extras.getCredentialsCount();
          const proposalsPending = extras.getProposalsPending();
          const proposalsAvailable = extras.getProposalsAvailable();
          const walPending = await extras.getWalPending();
          const timestamps = extras.getLastRunTimestamps();
          const sizes = await extras.getStorageSizes();

          const { reflectionPatternsCount, reflectionRulesCount } = factsDb.statsReflection();
          const selfCorrectionCount = factsDb.selfCorrectionIncidentsCount();
          const languageKeywordsCount = factsDb.languageKeywordsCount();

          const activeFacts = factsDb.getCount();
          const supersededFacts = factsDb.countSupersededFacts();
          const canonicalEmbeddings = factsDb.countCanonicalEmbeddings();
          const unresolvedContradictions = factsDb.contradictionsCount();
          const verifiedFacts = factsDb.countVerifiedFacts();
          const activity = factsDb.recentActivity();
          const decayBreakdown = factsDb.statsBreakdownByDecayClass();
          const sourceBreakdown = factsDb.statsBySource();
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
          if (lanceDeltaSignificant || canonicalDeltaSignificant) {
            console.log(
              `  Health: SQLite facts ${sqlCount} vs LanceDB vectors ${lanceCount} (Δ=${lanceDelta}); total facts ${totalFacts} vs canonical embedding rows ${canonicalEmbeddings} (Δ=${canonicalDelta}). Run 'openclaw hybrid-mem re-index' if you switched embedding model or after a large backfill.`,
            );
          }
          console.log("");
          const proceduresNote = procedures === 0 ? " (run extract-procedures to populate)" : "";
          console.log(
            `Procedures: ${procedures} (validated: ${proceduresValidated}, promoted: ${proceduresPromoted})${proceduresNote}`,
          );
          console.log(
            `Pending review (proposals/procedures/tools/crystal/verified): ${proposalsPending}/${Math.max(0, proceduresValidated - proceduresPromoted)}/0/0/${verifiedFacts}`,
          );
          console.log(`Rules: ${rules}`);
          console.log(`Patterns: ${patterns}`);
          console.log(`Implicit-feedback signals: ${implicitFeedbackSignals}`);
          console.log(`Meta-patterns: ${metaPatterns}`);
          console.log(`Directives: ${directives}`);
          console.log(`Reflection (patterns/rules): ${reflectionPatternsCount}/${reflectionRulesCount}`);
          console.log(`Self-correction incidents: ${selfCorrectionCount}`);
          console.log(`Language keywords: ${languageKeywordsCount}`);
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
          console.log(
            `Categories configured: ${categoriesConfigured.length} [${categoriesConfigured.slice(0, 3).join(", ")}...]`,
          );
          console.log(`Categories in memory: ${uniqueInMemory.length} [${uniqueInMemory.slice(0, 3).join(", ")}...]`);
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
          console.log("");
          if (sizes.sqliteBytes != null) console.log(`SQLite size: ${(sizes.sqliteBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.lanceBytes != null) console.log(`LanceDB size: ${(sizes.lanceBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.sqliteBytes != null && activeFacts > 0) {
            const bytesPerFact = sizes.sqliteBytes / activeFacts;
            console.log(`SQLite bytes per active fact: ${bytesPerFact.toFixed(0)}`);
          }
          if (sizes.sqliteBytes != null || sizes.lanceBytes != null) console.log("");
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
          const estimatedTokens = factsDb.estimateStoredTokens();
          console.log("=== Memory Efficiency Stats ===");
          console.log(
            `Breakdown: hot=${byTier.hot}, warm=${byTier.warm}, cold=${byTier.cold}, structural=${byTier.structural ?? 0}`,
          );
          console.log(`Sources: ${Object.keys(bySource).length}`);
          for (const [src, count] of Object.entries(bySource).slice(0, 5)) {
            console.log(`  ${src}: ${count}`);
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
    .command("prune")
    .description("Remove expired facts (decayed past threshold)")
    .option("--verbose", "List fact ids that will be removed before pruning")
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
        const pruned = factsDb.prune();
        const after = factsDb.count();
        console.log(`Pruned ${pruned} expired facts. Before: ${before}, After: ${after}`);
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
      "Reset LanceDB vector index and re-embed all facts from SQLite (use after switching embedding model, e.g. to a larger one).",
    )
    .option("--batch-size <n>", "Facts per embed batch (default: 50)", "50")
    .option(
      "--delay-ms-between-batches <n>",
      "Pause between embedding batches in ms (default: 0). On Azure/APIM with tight RPM, try 2000 — see docs/TROUBLESHOOTING.md and issue #940.",
      "0",
    )
    .action(
      withExit(async (opts?: { batchSize?: string; delayMsBetweenBatches?: string }) => {
        const batchSize = Math.max(1, Math.min(500, Number.parseInt(String(opts?.batchSize ?? "50"), 10) || 50));
        const delayMsBetweenBatches = Math.max(
          0,
          Math.min(120_000, Number.parseInt(String(opts?.delayMsBetweenBatches ?? "0"), 10) || 0),
        );
        console.log("Re-index: resetting LanceDB table...");
        await vectorDb.resetTableForReindex();
        console.log("Re-index: re-embedding all facts (this may take a while)...");
        const result = await migrateEmbeddings({
          factsDb,
          vectorDb,
          embeddings,
          batchSize,
          delayMsBetweenBatches,
          onProgress: (completed, total) => {
            if (total > 0 && completed % Math.max(1, Math.floor(total / 10)) === 0) {
              process.stdout.write(`  ${completed}/${total} facts embedded...\r`);
            }
          },
          logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
        });
        console.log(
          `Re-index complete: ${result.migrated} embedded, ${result.skipped} skipped, ${result.errors.length} errors.`,
        );
        if (result.errors.length > 0 && result.errors.length <= 10) {
          for (const e of result.errors) console.warn(`  - ${e}`);
        } else if (result.errors.length > 10) {
          console.warn(`  (${result.errors.length} errors; first 5:)`);
          for (const e of result.errors.slice(0, 5)) console.warn(`  - ${e}`);
        }
      }),
    );

  mem
    .command("backfill-decay")
    .description("Backfill decayAt for facts missing it (one-time migration)")
    .action(
      withExit(async () => {
        const updated = factsDb.backfillDecay();
        const total = Object.values(updated).reduce((a, b) => a + b, 0);
        console.log(`Backfilled decayAt for ${total} facts.`);
      }),
    );

  mem
    .command("test")
    .description("Run memory diagnostics (structured + semantic + hybrid + auto-recall)")
    .action(
      withExit(async () => {
        const result = await runMemoryDiagnostics({
          factsDb,
          vectorDb,
          embeddings,
          aliasDb,
          minScore: cfg.autoRecall?.minScore ?? 0.3,
          autoRecallLimit: cfg.autoRecall?.limit ?? 10,
        });

        const icon = (ok: boolean) => (ok ? "✅" : "❌");
        console.log("=== Memory Diagnostics ===");
        console.log(`Marker: ${result.markerId}`);
        console.log(`Structured search: ${icon(result.structured.ok)} (${result.structured.count} result(s))`);
        console.log(`Semantic search: ${icon(result.semantic.ok)} (${result.semantic.count} result(s))`);
        console.log(`Hybrid search: ${icon(result.hybrid.ok)} (${result.hybrid.count} result(s))`);
        console.log(`Auto-recall: ${icon(result.autoRecall.ok)} (${result.autoRecall.count} candidate(s))`);
      }),
    );

  mem
    .command("model-info [model]")
    .description(
      "Show vector dimensions for a built-in embedding model name, or print current embedding config when [model] is omitted",
    )
    .action(
      withExit(async (modelArg?: string) => {
        const name = typeof modelArg === "string" ? modelArg.trim() : "";
        if (!name) {
          const emb = cfg.embedding;
          console.log("=== Current embedding config ===");
          console.log(`Provider: ${emb.provider}`);
          console.log(`Model: ${emb.model}`);
          if (emb.models && emb.models.length > 0) {
            console.log(`Models (multi): ${emb.models.join(", ")}`);
          }
          console.log(`Dimensions (resolved in config): ${emb.dimensions}`);
          try {
            const catalog = vectorDimsForModel(emb.model);
            if (catalog === emb.dimensions) {
              console.log(`Catalog dimensions for '${emb.model}': ${catalog} (matches config)`);
            } else {
              console.log(
                `Catalog dimensions for '${emb.model}': ${catalog} (config uses ${emb.dimensions} — may be intentional)`,
              );
            }
          } catch {
            console.log(
              `Model '${emb.model}' is not in the built-in catalog; dimensions are taken from config (${emb.dimensions}).`,
            );
            console.log(
              "For custom Ollama/ONNX models, set embedding.dimensions to the vector size your model outputs.",
            );
          }
          return;
        }
        try {
          const dims = vectorDimsForModel(name);
          console.log(`Model: ${name}`);
          console.log(`Vector dimensions: ${dims}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`error: ${msg}`);
          console.error(
            "For models not in the catalog, set embedding.dimensions in plugin config to the vector size your provider returns.",
          );
          process.exitCode = 1;
          return;
        }
      }),
    );

  mem
    .command("context-audit")
    .description("Report token usage per injected context source and recommendations")
    .action(
      withExit(async () => {
        const audit = await runContextAudit({ cfg, factsDb });

        console.log("=== Context Budget Audit ===");
        console.log(
          `Auto-recall: ${audit.autoRecall.enabled ? `${audit.autoRecall.budgetTokens} token budget` : "disabled"} (format: ${audit.autoRecall.injectionFormat}, hot: ${audit.autoRecall.hotTokens})`,
        );
        console.log(
          `Procedures: ${audit.procedures.enabled ? `${audit.procedures.tokens} tokens` : "disabled"} (lines: ${audit.procedures.lines})`,
        );
        console.log(
          `Active tasks: ${audit.activeTasks.enabled ? `${audit.activeTasks.tokens} tokens` : "disabled"} (active: ${audit.activeTasks.count}, stale: ${audit.activeTasks.stale})`,
        );
        console.log(`Workspace files: ${audit.workspaceFiles.totalTokens} tokens`);
        if (audit.workspaceFiles.files.length > 0) {
          for (const file of audit.workspaceFiles.files) {
            console.log(`  - ${file.file}: ${file.tokens} tokens`);
          }
        }
        console.log(`Total injected (est.): ${audit.totalTokens} tokens`);

        if (audit.recommendations.length > 0) {
          console.log("Recommendations:");
          for (const rec of audit.recommendations) {
            console.log(`  - ${rec}`);
          }
        } else {
          console.log("Recommendations: none — context budget is healthy.");
        }
      }),
    );

  mem
    .command("search <query>")
    .description(
      "Hybrid search (vector + SQL). Returns up to 20 results. Optional filters apply to the merged result set.",
    )
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .option("--scope <s>", "Filter by scope (global/user/agent/session)")
    .option("--scope-target <st>", "Scope target (userId/agentId/sessionId)")
    .action(
      withExit(
        async (
          query: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            source?: string;
            tier?: string;
            scope?: string;
            scopeTarget?: string;
          },
        ) => {
          try {
            // Build scope filter from CLI options
            const scopeFilter: ScopeFilter | undefined = opts?.scope
              ? (() => {
                  const filter: ScopeFilter = {};
                  if (opts.scope === "user") filter.userId = opts.scopeTarget || null;
                  else if (opts.scope === "agent") filter.agentId = opts.scopeTarget || null;
                  else if (opts.scope === "session") filter.sessionId = opts.scopeTarget || null;
                  return filter;
                })()
              : undefined;

            const embedding = await embeddings.embed(query);
            const vectorResults = await vectorDb.search(embedding, 50);
            const sqlResults = factsDb.search(query, 50, {
              scopeFilter,
              tierFilter: opts?.tier === "cold" ? "all" : "warm",
              reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
              diversityWeight: cfg.reinforcement?.diversityWeight ?? 1.0,
            });

            // Filter vector results by scope
            let filteredVectorResults = vectorResults;
            if (scopeFilter) {
              filteredVectorResults = filterByScope(
                vectorResults,
                (id, opts) => factsDb.getById(id, opts),
                scopeFilter,
              );
            }

            let combined = merge(filteredVectorResults, sqlResults, 20, factsDb);

            if (opts?.category || opts?.entity || opts?.key || opts?.source || opts?.tier) {
              combined = combined.filter((r) => entryMatchesHybridSearchFilters(r.entry, opts));
            }

            if (tieringEnabled && opts?.tier == null) {
              combined = combined.filter((r) => r.entry.tier !== "cold");
            }

            console.log(`Search results for "${query}": ${combined.length}`);
            for (const r of combined) {
              console.log(
                `  [${r.entry.id}] ${r.entry.text} (score=${r.score.toFixed(3)}, tier=${r.entry.tier}, category=${r.entry.category ?? "none"})`,
              );
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "search",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("lookup <id>")
    .description("Lookup a fact by ID")
    .action(
      withExit(async (id: string) => {
        try {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "lookup",
          });
          throw err;
        }
      }),
    );

  mem
    .command("forget <id>")
    .description("Remove a memory by ID (from SQLite and LanceDB). ID can be full UUID or a short hex prefix.")
    .option("--yes", "Skip confirmation")
    .action(
      withExit(async (id: string, opts?: { yes?: boolean }) => {
        try {
          let resolvedId = id;
          if (id.length < 36 && !id.includes("-")) {
            const prefixResult = factsDb.findByIdPrefix(id);
            if (prefixResult && "ambiguous" in prefixResult) {
              const countText = prefixResult.count >= 3 ? `${prefixResult.count}+` : `${prefixResult.count}`;
              console.error(
                `Prefix "${id}" is ambiguous (matches ${countText} facts). Use the full UUID from search or lookup.`,
              );
              process.exitCode = 1;
              return;
            }
            if (prefixResult && "id" in prefixResult) {
              resolvedId = prefixResult.id;
            }
          }
          const fact = factsDb.get(resolvedId);
          if (!opts?.yes) {
            if (fact) {
              console.log(`About to remove: ${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}`);
            } else {
              console.log(`Memory not found in SQLite (may still exist in LanceDB): ${resolvedId}`);
            }
            console.log("Run with --yes to confirm, or cancel (Ctrl+C).");
            return;
          }
          const sqlDeleted = factsDb.delete(resolvedId);
          let lanceDeleted = false;
          try {
            lanceDeleted = await vectorDb.delete(resolvedId);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "forget",
            });
            console.error(`LanceDB delete failed: ${err}`);
          }
          aliasDb?.deleteByFactId(resolvedId);
          if (!sqlDeleted && !lanceDeleted) {
            console.error(`Memory not found: ${id}`);
            process.exitCode = 1;
            return;
          }
          const note = resolvedId !== id ? ` (resolved from prefix "${id}")` : "";
          console.log(`Forgotten${note}. SQLite: ${sqlDeleted}, LanceDB: ${lanceDeleted}`);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "forget",
          });
          throw err;
        }
      }),
    );

  mem
    .command("audit-health")
    .description("One-shot non-destructive hybrid-memory health report (JSON or markdown)")
    .option("--json", "Emit JSON instead of markdown")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const report = buildAuditHealthReport(factsDb, getMemoryCategories);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printAuditHealthMarkdown(report);
        }
      }),
    );

  mem
    .command("categories")
    .description("List all categories in memory (discovered from facts)")
    .action(
      withExit(async () => {
        try {
          const cats = factsDb.uniqueMemoryCategories();
          console.log(`Categories in memory (${cats.length}):`);
          for (const c of cats) {
            console.log(`  - ${c}`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "categories",
          });
          throw err;
        }
      }),
    );

  mem
    .command("list")
    .description("List recent facts (default 10)")
    .option("--limit <n>", "Max results", "10")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .action(
      withExit(
        async (opts?: {
          limit?: string;
          category?: string;
          entity?: string;
          key?: string;
          source?: string;
          tier?: string;
        }) => {
          try {
            const limitParsed = Number.parseInt(opts?.limit ?? "10", 10);
            if (!Number.isFinite(limitParsed) || limitParsed < 1 || limitParsed > 50_000) {
              console.error("error: --limit must be an integer from 1 to 50000");
              process.exitCode = 1;
              return;
            }
            const limit = limitParsed;
            const filters = {
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              source: opts?.source,
              tier: opts?.tier as "hot" | "warm" | "cold" | "structural" | undefined,
            };
            const facts = factsDb.list(limit, filters);
            console.log(`Recent facts (limit ${limit}):`);
            for (const f of facts) {
              console.log(`  [${f.id}] ${f.text} (tier=${f.tier}, category=${f.category ?? "none"})`);
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "list",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("show <id>")
    .description(
      "Show full detail for a fact by ID. For proposals use: hybrid-mem proposals show <id> (supports --diff, --json)",
    )
    .action(
      withExit(async (id: string) => {
        if (!listCommands?.showItem) {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
          return;
        }
        const item = await listCommands.showItem(id);
        if (!item) {
          console.log(`Item not found: ${id}`);
          return;
        }
        if (item.type === "proposal") {
          console.log(`Proposal ${id}. Use: openclaw hybrid-mem proposals show ${id} (--diff, --json)`);
          return;
        }
        console.log(`Type: ${item.type}`);
        console.log(JSON.stringify(item.data, null, 2));
      }),
    );

  mem
    .command("dump")
    .description(
      "Inspect SQLite table rows (read-only). Use --type fact_entity (PERSON/ORG mentions), organizations, contacts, facts, etc. See --list-types.",
    )
    .option("--type <t>", "Table alias or physical name (required unless --list-types)")
    .option("--limit <n>", "Max rows (1–5000, default 20)", "20")
    .option("--order <dir>", "Sort: last = newest first, first = oldest first", "last")
    .option("--json", "JSON array output (no text truncation)")
    .option("--list-types", "Print allowed --type values and exit")
    .action(
      withExit(
        async (opts?: { type?: string; limit?: string; order?: string; json?: boolean; listTypes?: boolean }) => {
          if (opts?.listTypes) {
            for (const t of listDumpTypeAliases()) console.log(t);
            return;
          }
          const typeRaw = opts?.type?.trim();
          if (!typeRaw) {
            console.error("error: --type is required (or use --list-types for valid names)");
            process.exitCode = 1;
            return;
          }
          const limitParsed = Number.parseInt(opts?.limit ?? "20", 10);
          if (!Number.isFinite(limitParsed) || limitParsed < 1 || limitParsed > 5000) {
            console.error("error: --limit must be an integer from 1 to 5000");
            process.exitCode = 1;
            return;
          }
          const orderRaw = (opts?.order ?? "last").toLowerCase();
          if (orderRaw !== "first" && orderRaw !== "last") {
            console.error('error: --order must be "first" or "last"');
            process.exitCode = 1;
            return;
          }
          const order = orderRaw as "first" | "last";
          try {
            const result = runSqliteTableDump(factsDb.getRawDb(), {
              type: typeRaw,
              limit: limitParsed,
              order,
              json: !!opts?.json,
            });
            if (!result.ok) {
              console.error(result.error);
              process.exitCode = 1;
              return;
            }
            if (opts?.json) {
              console.log(JSON.stringify(result.rows, null, 2));
              return;
            }
            console.log(`Table ${result.table} (${result.rows.length} row(s), order=${order}):`);
            for (let i = 0; i < result.rows.length; i++) {
              console.log(`--- ${i + 1} ---`);
              console.log(JSON.stringify(result.rows[i], null, 2));
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "dump",
            });
            throw err;
          }
        },
      ),
    );
}
