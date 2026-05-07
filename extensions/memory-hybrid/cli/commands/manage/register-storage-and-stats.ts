/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { SQL_IMPLICIT_TRAJECTORY_LESSON_FILTER } from "../../cmd-feedback.js";
import { isValidCategory, vectorDimsForModel } from "../../../config.js";
import { listDumpTypeAliases, runSqliteTableDump } from "../../../services/cli-sql-dump.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { repairEventHubs } from "../../../services/event-hub-repair.js";
import { countPendingReviewBacklogs } from "../../../services/pending-review-digest.js";
import { filterByScope } from "../../../services/merge-results.js";
import type { MemoryEntry, ScopeFilter } from "../../../types/memory.js";
import { getEnv } from "../../../utils/env-manager.js";
import { isEntityStopWord } from "../../../utils/entity-stopwords.js";
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
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  activeFacts: number;
  canonicalEmbeddings: number;
  vectorless: number;
  vectorlessBySource: Array<{ source: string; count: number }>;
  procedures: {
    total: number;
    validated: number;
    promoted: number;
    validatedNotPromoted: number;
    blocked: number;
    topBlockReason: string | null;
  };
  graphHubs: Array<{ id: string; outDegree: number; textPreview: string | null; overCap: boolean }>;
  structuralEligibleWarmFacts: number;
  patternBloat: { implicitFeedbackPatterns: number };
  entityStopwordMatches: Array<{ entity: string; count: number }>;
  storage: { sqliteBytes: number | null; walBytes: number | null; shmBytes: number | null };
  tiers: Record<string, number>;
  decay: Record<string, number>;
  categories: { configured: string[]; present: string[]; unknown: string[] };
  sources: Record<string, number>;
  implicitFeedbackTrajectorySignals: number;
  warnings: string[];
  remediation: string[];
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
  entityStopWords: readonly string[] = [],
  graphHubDegreeCap = 500,
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
  const vectorless = factsDb.countVectorlessActiveFacts();
  const vectorlessBySource = factsDb.vectorlessActiveFactsBySource(10);
  const procedureTriage = factsDb.triageProcedures({ status: "validated", notPromoted: true, limit: 10_000 });
  const raw = factsDb.getRawDb?.();
  const graphHubs = raw
    ? (
        raw
          .prepare(
            `SELECT ml.source_fact_id AS id, COUNT(*) AS cnt, SUBSTR(f.text, 1, 120) AS text_preview
             FROM memory_links ml
             LEFT JOIN facts f ON f.id = ml.source_fact_id
            WHERE ml.link_type != 'CONTRADICTS'
            GROUP BY ml.source_fact_id
            ORDER BY cnt DESC
            LIMIT 10`,
          )
          .all() as Array<{ id: string; cnt: number; text_preview: string | null }>
      ).map((row) => ({
        id: row.id,
        outDegree: Number(row.cnt ?? 0),
        textPreview: row.text_preview ?? null,
        overCap: Number(row.cnt ?? 0) > graphHubDegreeCap,
      }))
    : [];
  const structuralEligibleWarmFacts = raw
    ? Number(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS cnt FROM facts
              WHERE superseded_at IS NULL
                AND (expires_at IS NULL OR expires_at > ?)
                AND COALESCE(key, '') != ''
                AND COALESCE(tier, 'warm') = 'warm'`,
            )
            .get(Math.floor(Date.now() / 1000)) as { cnt: number } | undefined
        )?.cnt ?? 0,
      )
    : 0;
  const implicitFeedbackPatterns = raw
    ? Number(
        (
          raw
            .prepare(
              `SELECT COUNT(*) AS cnt FROM facts
              WHERE superseded_at IS NULL
                AND category = 'pattern'
                AND source = 'implicit-feedback'`,
            )
            .get() as { cnt: number } | undefined
        )?.cnt ?? 0,
      )
    : 0;
  const entityStopwordMatches = factsDb
    .topEntities(50)
    .filter((row) => isEntityStopWord(row.entity, entityStopWords))
    .slice(0, 10);
  const storageBytes = factsDb.estimateStorageBytes?.();
  const warnings: string[] = [];
  if ((tiers.hot ?? 0) === 0) warnings.push("No HOT tier facts detected; tiering may not be promoting active memory.");
  if ((tiers.structural ?? 0) === 0)
    warnings.push("No STRUCTURAL tier facts detected; key/value facts may be stuck in warm tier.");
  if (activeFacts > 0 && (decay.stable ?? 0) / activeFacts > 0.5)
    warnings.push("More than half of active facts are stable/no-expiry.");
  if (unknown.length > 0) warnings.push(`Categories present in DB but not configured: ${unknown.join(", ")}`);
  if (graphHubs.some((hub) => hub.overCap))
    warnings.push(
      `${graphHubs.filter((hub) => hub.overCap).length} graph hub(s) exceed degree cap ${graphHubDegreeCap}.`,
    );
  if (structuralEligibleWarmFacts > 100)
    warnings.push(`${structuralEligibleWarmFacts} key-bearing fact(s) are still warm instead of structural.`);
  if (implicitFeedbackPatterns > 1000)
    warnings.push(`${implicitFeedbackPatterns} implicit-feedback pattern fact(s) may indicate pattern bloat.`);
  if (entityStopwordMatches.length > 0)
    warnings.push(
      `Top entities include stop-word-like labels: ${entityStopwordMatches.map((row) => row.entity).join(", ")}.`,
    );
  if (vectorless > 0) warnings.push(`${vectorless} active non-kv fact(s) are missing canonical embeddings.`);
  if (procedureTriage.summary.total > 0)
    warnings.push(
      `${procedureTriage.summary.total} validated procedure(s) are not promoted (top reason: ${procedureTriage.summary.topReason ?? "unknown"}).`,
    );
  const remediation: string[] = [];
  if ((tiers.hot ?? 0) === 0 || (tiers.structural ?? 0) === 0 || structuralEligibleWarmFacts > 0)
    remediation.push("Run `openclaw hybrid-mem retier --apply`.");
  if (graphHubs.some((hub) => hub.overCap))
    remediation.push(
      "Run `openclaw hybrid-mem graph repair --collapse-event-hubs --apply` and keep graph hub guards enabled.",
    );
  if (unknown.length > 0)
    remediation.push("Run `openclaw hybrid-mem categories audit`, then `categories remap --apply` where appropriate.");
  if (vectorless > 0) remediation.push("Run `openclaw hybrid-mem reembed-vectorless --apply`.");
  if (procedureTriage.summary.total > 0)
    remediation.push(
      "Run `openclaw hybrid-mem procedures triage --not-promoted` and `generate-auto-skills` where appropriate.",
    );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: warnings.length === 0,
    activeFacts,
    canonicalEmbeddings,
    vectorless,
    vectorlessBySource,
    procedures: {
      total: procedures,
      validated,
      promoted,
      validatedNotPromoted: Math.max(0, validated - promoted),
      blocked: procedureTriage.summary.total,
      topBlockReason: procedureTriage.summary.topReason,
    },
    graphHubs,
    structuralEligibleWarmFacts,
    patternBloat: { implicitFeedbackPatterns },
    entityStopwordMatches,
    storage: {
      sqliteBytes: storageBytes?.sqliteBytes ?? null,
      walBytes: storageBytes?.walBytes ?? null,
      shmBytes: storageBytes?.shmBytes ?? null,
    },
    tiers,
    decay,
    categories: { configured, present, unknown },
    sources,
    implicitFeedbackTrajectorySignals,
    warnings,
    remediation,
  };
}

function printAuditHealthMarkdown(report: AuditHealthReport): void {
  console.log("# Hybrid-memory audit health");
  console.log("");
  console.log(`Status: ${report.ok ? "ok" : "warning"}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Schema version: ${report.schemaVersion}`);
  console.log(`Active facts: ${report.activeFacts}`);
  console.log(`Canonical embeddings: ${report.canonicalEmbeddings}`);
  console.log(`Vectorless active non-kv facts: ${report.vectorless}`);
  if (report.vectorlessBySource.length > 0) {
    console.log(`Vectorless by source: ${report.vectorlessBySource.map((r) => `${r.source}=${r.count}`).join(", ")}`);
  }
  console.log(
    `Procedures: ${report.procedures.total} (validated: ${report.procedures.validated}, promoted: ${report.procedures.promoted}, blocked: ${report.procedures.blocked}${report.procedures.topBlockReason ? ` by ${report.procedures.topBlockReason}` : ""})`,
  );
  console.log(`Tiers: ${JSON.stringify(report.tiers)}`);
  console.log(`Decay: ${JSON.stringify(report.decay)}`);
  console.log(
    `Unknown categories: ${report.categories.unknown.length ? report.categories.unknown.join(", ") : "none"}`,
  );
  console.log(`Graph hubs over cap: ${report.graphHubs.filter((hub) => hub.overCap).length}`);
  if (report.graphHubs.length > 0) {
    console.log(
      `Top graph hubs: ${report.graphHubs
        .slice(0, 3)
        .map((hub) => `${hub.id.slice(0, 8)}=${hub.outDegree}`)
        .join(", ")}`,
    );
  }
  console.log(`Structural-eligible warm facts: ${report.structuralEligibleWarmFacts}`);
  console.log(`Implicit-feedback pattern facts: ${report.patternBloat.implicitFeedbackPatterns}`);
  if (report.entityStopwordMatches.length > 0) {
    console.log(
      `Entity stop-word matches: ${report.entityStopwordMatches.map((row) => `${row.entity}=${row.count}`).join(", ")}`,
    );
  }
  if (report.storage.sqliteBytes != null) console.log(`SQLite bytes: ${report.storage.sqliteBytes}`);
  console.log(`Implicit-feedback trajectory signals: ${report.implicitFeedbackTrajectorySignals}`);
  console.log("");
  if (report.warnings.length === 0) {
    console.log("Warnings: none");
  } else {
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (report.remediation.length > 0) {
    console.log("");
    console.log("Remediation:");
    for (const hint of report.remediation) console.log(`- ${hint}`);
  }
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
    .description("Retier facts by structural shape, salience, and inactivity")
    .option("--dry-run", "Preview tier changes without mutating facts")
    .action(
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
              console.log(`  ${row.day} ${row.source}: count=${row.count}${dropped}`);
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
              console.log(`  ${row.day} ${row.source}: count=${row.count}${dropped}`);
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
          if (opts?.apply) {
            for (let offset = 0; offset < candidates.length; offset += batchSize) {
              const batch = candidates.slice(offset, offset + batchSize);
              let vectors: (number[] | null)[];
              try {
                vectors = await embeddings.embedBatch(batch.map((fact) => fact.text));
              } catch (err) {
                vectors = [];
                for (const fact of batch) {
                  try {
                    vectors.push(await embeddings.embed(fact.text));
                  } catch (singleErr) {
                    errors.push(`fact ${fact.id}: embed failed — ${String(singleErr)}`);
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
                  factsDb.storeEmbedding(fact.id, embeddings.modelName, "canonical", new Float32Array(vec), vec.length);
                  factsDb.setEmbeddingModel(fact.id, embeddings.modelName);
                  embedded++;
                } catch (err) {
                  errors.push(`fact ${fact.id}: store failed — ${String(err)}`);
                  skipped++;
                }
              }
            }
          }
          const after = opts?.apply ? factsDb.countVectorlessActiveFacts(opts?.source) : before;
          const report = {
            apply: opts?.apply === true,
            source: opts?.source ?? null,
            before,
            considered: candidates.length,
            embedded,
            skipped,
            errors,
            after,
          };
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(
            `Reembed vectorless ${report.apply ? "applied" : "dry-run"}: before ${before}, candidates ${candidates.length}, embedded ${embedded}, skipped ${skipped}, after ${after}`,
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
        },
      ),
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

  const entitiesCommand = mem.command("entities").description("Inspect and clean entity labels");

  entitiesCommand
    .command("clean")
    .description("Null common-noun stopword entities on existing facts (dry-run by default)")
    .option("--stopwords", "Use default and configured entity stopword list")
    .option("--apply", "Apply changes; default is dry-run")
    .option("--examples <n>", "Number of example rows to show", "10")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { stopwords?: boolean; apply?: boolean; examples?: string; json?: boolean }) => {
        const exampleLimit = Number.parseInt(opts?.examples ?? "10", 10);
        if (!Number.isFinite(exampleLimit) || exampleLimit < 0) {
          console.error("error: --examples must be a non-negative integer");
          process.exitCode = 1;
          return;
        }
        const stopWords = opts?.stopwords === false ? [] : ctx.cfg.entityExtraction.stopWords;
        const report = factsDb.cleanEntityStopwords({
          apply: opts?.apply === true,
          stopWords,
          exampleLimit,
        });
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(
          `Entity stopword cleanup ${report.apply ? "applied" : "dry-run"}: matched ${report.matched}, active ${report.activeMatched}, changed ${report.changed}`,
        );
        console.log(`Stop words: ${report.stopWords.join(", ") || "(defaults only)"}`);
        if (report.examples.length > 0) {
          console.log("Examples:");
          for (const ex of report.examples) console.log(`  ${ex.id}  ${ex.entity}`);
        }
        if (!report.apply) console.log("Dry-run only. Re-run with --apply to null matched entity fields.");
      }),
    );

  mem
    .command("backfill-decay")
    .description("Backfill legacy stable decay classes (compat alias for decay reclassify --stable-only --apply)")
    .action(
      withExit(async () => {
        const updated = factsDb.backfillDecay();
        const total = Object.values(updated).reduce((a, b) => a + b, 0);
        console.log(`Backfilled decayAt for ${total} facts.`);
      }),
    );

  const decayCommand = mem.command("decay").description("Inspect and repair decay-class TTL hygiene");

  decayCommand
    .command("reclassify")
    .description(
      "Reclassify decay classes using source/category/importance and recall/access signals (dry-run by default)",
    )
    .option("--apply", "Apply changes; default is dry-run")
    .option("--stable-only", "Only scan active facts currently marked stable")
    .option("--limit <n>", "Maximum facts to scan")
    .option("--inactive-days <n>", "Demote unrecalled/unaccessed facts older than N days to short", "90")
    .option("--promote-recall-count <n>", "Promote TTL-bearing facts recalled/accessed at least N times", "3")
    .option("--json", "Emit JSON")
    .action(
      withExit(
        async (opts?: {
          apply?: boolean;
          stableOnly?: boolean;
          limit?: string;
          inactiveDays?: string;
          promoteRecallCount?: string;
          json?: boolean;
        }) => {
          const limit = opts?.limit != null ? Number.parseInt(opts.limit, 10) : undefined;
          const inactiveDays = Number.parseInt(opts?.inactiveDays ?? "90", 10);
          const promoteRecallCount = Number.parseInt(opts?.promoteRecallCount ?? "3", 10);
          if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
            console.error("error: --limit must be a positive integer");
            process.exitCode = 1;
            return;
          }
          if (!Number.isFinite(inactiveDays) || inactiveDays < 1) {
            console.error("error: --inactive-days must be a positive integer");
            process.exitCode = 1;
            return;
          }
          if (!Number.isFinite(promoteRecallCount) || promoteRecallCount < 1) {
            console.error("error: --promote-recall-count must be a positive integer");
            process.exitCode = 1;
            return;
          }
          const report = factsDb.reclassifyDecayClasses({
            apply: opts?.apply === true,
            stableOnly: opts?.stableOnly === true,
            limit,
            inactiveDays,
            promoteRecallCount,
          });
          if (opts?.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
          console.log(
            `Decay reclassify ${report.apply ? "applied" : "dry-run"}: scanned ${report.scanned}, changed ${report.changed}`,
          );
          console.log(
            `Stable+permanent before: ${report.stablePermanentBefore} (${pct(report.stablePermanentRatioBefore)})`,
          );
          console.log(
            `Stable+permanent after: ${report.stablePermanentAfter} (${pct(report.stablePermanentRatioAfter)})`,
          );
          if (Object.keys(report.changes).length > 0) {
            console.log("Transitions:");
            for (const [transition, count] of Object.entries(report.changes)) console.log(`  ${transition}: ${count}`);
          }
          if (!report.apply) console.log("Dry-run only. Re-run with --apply to update decay_class/expires_at.");
        },
      ),
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

  const graph = mem.command("graph").description("Graph repair and audit utilities");
  graph
    .command("repair")
    .description("Repair historical graph pathologies")
    .option("--collapse-event-hubs", "Collapse legacy dream-cycle/session heartbeat DERIVED_FROM mega-hubs")
    .option("--apply", "Apply mutations. Omit for dry-run")
    .option("--threshold <n>", "Outbound DERIVED_FROM threshold for hub candidates", "500")
    .option("--json", "Emit JSON instead of markdown")
    .action(
      withExit(async (opts?: { collapseEventHubs?: boolean; apply?: boolean; threshold?: string; json?: boolean }) => {
        if (!opts?.collapseEventHubs) {
          console.error("error: graph repair currently requires --collapse-event-hubs");
          process.exitCode = 1;
          return;
        }
        const threshold = Number.parseInt(opts.threshold ?? "500", 10);
        if (!Number.isFinite(threshold) || threshold < 1) {
          console.error("error: --threshold must be a positive integer");
          process.exitCode = 1;
          return;
        }
        const raw = factsDb.getRawDb?.();
        if (!raw) {
          console.error("error: raw SQLite handle is unavailable");
          process.exitCode = 1;
          return;
        }
        const report = repairEventHubs(raw, { threshold, apply: opts.apply === true });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`# Graph repair: collapse event hubs (${report.apply ? "apply" : "dry-run"})`);
        console.log("");
        console.log(`Threshold: ${report.threshold}`);
        console.log(`Candidates: ${report.candidates.length}`);
        console.log(`Before max outbound DERIVED_FROM: ${report.before.maxOutboundDerivedFrom}`);
        console.log(`Before facts over threshold: ${report.before.overThresholdFacts}`);
        console.log(`Before link types: ${JSON.stringify(report.before.linkTypes)}`);
        if (report.candidates.length > 0) {
          console.log("");
          console.log("Candidate examples:");
          for (const candidate of report.candidates.slice(0, 10)) {
            console.log(
              `- ${candidate.factId}: ${candidate.outboundDerivedFrom} DERIVED_FROM (${candidate.reason}) ${candidate.textPreview}`,
            );
          }
        }
        if (!report.apply) {
          console.log("");
          console.log(
            "Dry-run only. Re-run with --apply to migrate provenance_json and delete eligible DERIVED_FROM links.",
          );
          return;
        }
        console.log("");
        console.log(`Migrated facts: ${report.migratedFacts}`);
        console.log(`Deleted DERIVED_FROM links: ${report.deletedLinks}`);
        console.log(`After max outbound DERIVED_FROM: ${report.after?.maxOutboundDerivedFrom ?? 0}`);
        console.log(`After facts over threshold: ${report.after?.overThresholdFacts ?? 0}`);
        console.log(`After link types: ${JSON.stringify(report.after?.linkTypes ?? [])}`);
      }),
    );

  const runAuditHealth = async (opts?: { json?: boolean; strict?: boolean }) => {
    const report = buildAuditHealthReport(factsDb, getMemoryCategories);
    if (opts?.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printAuditHealthMarkdown(report);
    }
    if (opts?.strict && !report.ok) process.exitCode = 2;
  };

  mem
    .command("audit-health")
    .description("One-shot non-destructive hybrid-memory health report (JSON or markdown)")
    .option("--json", "Emit versioned JSON instead of markdown")
    .option("--strict", "Exit non-zero when warnings are present")
    .action(withExit(runAuditHealth));

  const audit = mem.command("audit").description("Audit hybrid-memory health and maintenance state");
  audit
    .command("health")
    .description("One-shot non-destructive hybrid-memory health report (JSON or markdown)")
    .option("--json", "Emit versioned JSON instead of markdown")
    .option("--strict", "Exit non-zero when warnings are present")
    .action(withExit(runAuditHealth));

  const categoriesCommand = mem
    .command("categories")
    .description("Inspect and repair category drift")
    .action(
      withExit(async () => {
        try {
          const cats = factsDb.uniqueMemoryCategories();
          console.log(`Categories in memory (${cats.length}):`);
          for (const c of cats) {
            console.log(`  - ${c}`);
          }
          console.log("");
          console.log("Tip: run 'openclaw hybrid-mem categories audit' to compare configured vs in-memory categories.");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "categories",
          });
          throw err;
        }
      }),
    );

  categoriesCommand
    .command("audit")
    .description("Show configured vs in-memory category drift with counts and example fact ids")
    .option("--json", "Emit JSON")
    .option("--examples <n>", "Example fact ids per category", "5")
    .action(
      withExit(async (opts?: { json?: boolean; examples?: string }) => {
        const examples = Number.parseInt(opts?.examples ?? "5", 10);
        if (!Number.isFinite(examples) || examples < 0 || examples > 50) {
          console.error("error: --examples must be an integer from 0 to 50");
          process.exitCode = 1;
          return;
        }
        const report = factsDb.auditCategories(getMemoryCategories(), examples);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Categories configured (${report.configured.length}): ${report.configured.join(", ")}`);
        console.log(`Categories in memory (${report.inMemory.length}):`);
        for (const row of report.inMemory) {
          const marker = report.unknown.some((u) => u.category === row.category) ? " [unknown]" : "";
          const examplesText = row.examples.length > 0 ? ` examples=${row.examples.join(",")}` : "";
          console.log(`  - ${row.category}: ${row.count}${marker}${examplesText}`);
        }
        if (report.unknown.length > 0) {
          console.log("");
          console.log("Discovered/unknown categories:");
          for (const row of report.unknown) {
            const examplesText = row.examples.length > 0 ? ` examples=${row.examples.join(",")}` : "";
            console.log(`  - ${row.category}: ${row.count}${examplesText}`);
          }
          console.log("");
          console.log("Remap with: openclaw hybrid-mem categories remap --from <unknown> --to <configured> --apply");
        } else {
          console.log("");
          console.log("Discovered/unknown categories: 0");
        }
        if (report.configuredOnly.length > 0) {
          console.log(`Configured categories with no active facts: ${report.configuredOnly.join(", ")}`);
        }
      }),
    );

  categoriesCommand
    .command("remap")
    .description("Bulk-remap facts from one category to a configured category (dry-run by default)")
    .requiredOption("--from <category>", "Existing category to remap")
    .requiredOption("--to <category>", "Configured destination category")
    .option("--apply", "Apply the remap; default is dry-run")
    .option("--json", "Emit JSON")
    .action(
      withExit(async (opts?: { from?: string; to?: string; apply?: boolean; json?: boolean }) => {
        const from = (opts?.from ?? "").trim();
        const to = (opts?.to ?? "").trim();
        if (!from || !to) {
          console.error("error: --from and --to are required");
          process.exitCode = 1;
          return;
        }
        if (from === to) {
          console.error("error: --from and --to must differ");
          process.exitCode = 1;
          return;
        }
        if (!isValidCategory(to)) {
          console.error(
            `error: --to must be a configured category. Valid categories: ${getMemoryCategories().join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        const report = factsDb.remapCategory(from, to, opts?.apply === true);
        if (opts?.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`Category remap ${report.apply ? "applied" : "dry-run"}: ${report.from} -> ${report.to}`);
        console.log(`Matched facts: ${report.matched} (${report.activeMatched} active)`);
        console.log(`Changed facts: ${report.changed}`);
        if (!report.apply) {
          console.log("Dry-run only. Re-run with --apply to update facts.");
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
