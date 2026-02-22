/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildAppliedContent, buildUnifiedDiff } from "./proposals.js";
import type {
  FindDuplicatesResult,
  StoreCliOpts,
  StoreCliResult,
  BackfillCliResult,
  BackfillCliSink,
  IngestFilesResult,
  IngestFilesSink,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  MigrateToVaultResult,
  UpgradeCliResult,
  UninstallCliResult,
  ConfigCliResult,
} from "./types.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { SearchResult } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import type { ScopeFilter } from "../types/memory.js";
import { parseSourceDate } from "../utils/dates.js";
import { capturePluginError } from "../services/error-reporter.js";
import { withExit, type Chainable } from "./shared.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";

export type ManageContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  cfg: { distill?: { reinforcementBoost?: number; reinforcementProcedureBoost?: number; reinforcementPromotionThreshold?: number } };
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
  runBackfill: (opts: { dryRun: boolean; workspace?: string; limit?: number }, sink: BackfillCliSink) => Promise<BackfillCliResult>;
  runIngestFiles: (opts: { dryRun: boolean; workspace?: string; paths?: string[] }, sink: IngestFilesSink) => Promise<IngestFilesResult>;
  runMigrateToVault: () => Promise<MigrateToVaultResult | null>;
  runUninstall: (opts: { cleanAll: boolean; leaveConfig: boolean }) => Promise<UninstallCliResult>;
  runUpgrade: (version?: string) => Promise<UpgradeCliResult>;
  runConfigMode: (mode: string) => ConfigCliResult | Promise<ConfigCliResult>;
  runConfigSet: (key: string, value: string) => ConfigCliResult | Promise<ConfigCliResult>;
  runConfigSetHelp: (key: string) => ConfigCliResult | Promise<ConfigCliResult>;
  runFindDuplicates: (opts: {
    threshold: number;
    includeStructured: boolean;
    limit: number;
  }) => Promise<FindDuplicatesResult>;
  runConsolidate: (opts: {
    threshold: number;
    includeStructured: boolean;
    dryRun: boolean;
    limit: number;
    model: string;
  }) => Promise<{ clustersFound: number; merged: number; deleted: number }>;
  runReflection: (opts: { window: number; dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
  }>;
  runReflectionRules: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{ rulesExtracted: number; rulesStored: number }>;
  runReflectionMeta: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{ metaExtracted: number; metaStored: number }>;
  reflectionConfig: { enabled: boolean; defaultWindow: number; minObservations: number; model: string };
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
  }>;
  autoClassifyConfig: { model: string; batchSize: number; suggestCategories?: boolean };
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  runDistill?: (opts: { dryRun: boolean; days?: number; verbose?: boolean }, sink: { log: (s: string) => void; warn: (s: string) => void }) => Promise<{ stored: number; skipped: number; factsExtracted: number; sessionsScanned: number; dryRun?: boolean }>;
  runRecordDistill?: () => Promise<unknown>;
  runExtractProcedures?: (opts: { days?: number; dryRun: boolean }) => Promise<unknown>;
  runBuildLanguageKeywords: (opts: { model?: string; dryRun?: boolean }) => Promise<
    | { ok: true; path: string; topLanguages: string[]; languagesAdded: number }
    | { ok: false; error: string }
  >;
  runSelfCorrectionExtract: (opts: { days?: number; outputPath?: string }) => Promise<SelfCorrectionExtractResult>;
  runSelfCorrectionRun: (opts: {
    extractPath?: string;
    incidents?: Array<{ userMessage: string; precedingAssistant: string; followingAssistant: string; timestamp?: string; sessionFile: string }>;
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
  }) => Promise<SelfCorrectionRunResult>;
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{ factsExported: number; proceduresExported: number; filesWritten: number; outputPath: string }>;
  richStatsExtras?: {
    getCredentialsCount: () => number;
    getProposalsPending: () => number;
    getWalPending: () => number;
    getLastRunTimestamps: () => { distill?: string; reflect?: string; compact?: string };
    getStorageSizes: () => Promise<{ sqliteBytes?: number; lanceBytes?: number }>;
  };
  listCommands?: {
    listProposals: (opts: { status?: string }) => Promise<Array<{ id: string; title: string; targetFile: string; status: string; confidence: number; createdAt: number }>>;
    proposalApprove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    proposalReject: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
    listCorrections: (opts: { workspace?: string }) => Promise<{ reportPath: string | null; items: string[] }>;
    correctionsApproveAll: (opts: { workspace?: string }) => Promise<{ applied: number; error?: string }>;
    showItem: (id: string) => Promise<{ type: "fact" | "proposal"; data: unknown } | null>;
  };
  tieringEnabled: boolean;
  resolvedSqlitePath?: string;
  resolvePath?: (file: string) => string;
  runExtractDaily?: (opts: { days: number; dryRun: boolean; verbose?: boolean }, sink: { log: (s: string) => void; warn: (s: string) => void }) => Promise<{ stored?: number; totalStored?: number; totalExtracted?: number; daysBack?: number; dryRun?: boolean }>;
  runExtractDirectives?: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ sessionsScanned: number }>;
  runExtractReinforcement?: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ sessionsScanned: number }>;
  runGenerateAutoSkills?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ generated: number; skipped?: number; paths?: string[] }>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ created: number }>;
};

export function registerManageCommands(mem: Chainable, ctx: ManageContext): void {
  const {
    factsDb,
    vectorDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    parseSourceDate: parseDate,
    getMemoryCategories,
    cfg,
    runStore,
    runBackfill,
    runIngestFiles,
    runMigrateToVault,
    runUninstall,
    runUpgrade,
    runConfigMode,
    runConfigSet,
    runConfigSetHelp,
    runFindDuplicates,
    runConsolidate,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    reflectionConfig,
    runClassify,
    autoClassifyConfig,
    runSelfCorrectionExtract,
    runSelfCorrectionRun,
    runCompaction,
    runDistill,
    runExtractProcedures,
    runBuildLanguageKeywords,
    runExport,
    listCommands,
    tieringEnabled,
    resolvedSqlitePath,
    runExtractDaily,
    runExtractDirectives,
    runExtractReinforcement,
    runGenerateAutoSkills,
    runGenerateProposals,
    resolvePath,
  } = ctx;

  const BACKFILL_DECAY_MARKER = ".backfill-decay-done";

  mem
    .command("run-all")
    .description("Run all maintenance tasks in optimal order (prune, compact, distill, extract-*, reflection, generate-proposals, self-correction, build-languages). Use --dry-run to list steps only.")
    .option("--dry-run", "List steps that would run without executing")
    .option("--verbose", "Show detailed output for each step")
    .action(withExit(async (opts?: { dryRun?: boolean; verbose?: boolean }) => {
      const dryRun = !!opts?.dryRun;
      const verbose = !!opts?.verbose;
      const log = (s: string) => console.log(s);
      const sink = { log, warn: (s: string) => console.warn(s) };
      const memoryDir = resolvedSqlitePath ? dirname(resolvedSqlitePath) : null;
      const backfillDonePath = memoryDir ? join(memoryDir, BACKFILL_DECAY_MARKER) : null;

      const steps: { name: string; run: () => Promise<void> }[] = [
        {
          name: "backfill-decay",
          run: async () => {
            if (backfillDonePath && existsSync(backfillDonePath)) {
              if (verbose) log("Backfill-decay already done; skipping.");
              return;
            }
            const n = factsDb.backfillDecay();
            const total = Object.values(n).reduce((a, b) => a + b, 0);
            log(`Backfilled decay for ${total} facts.`);
            if (backfillDonePath) {
              try {
                writeFileSync(backfillDonePath, new Date().toISOString() + "\n");
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "run-all:backfill-decay-marker" });
              }
            }
          },
        },
        {
          name: "prune",
          run: async () => {
            const n = factsDb.prune();
            log(`Pruned ${n} expired facts.`);
          },
        },
        {
          name: "compact",
          run: async () => {
            const c = await runCompaction();
            log(`Compaction: hot=${c.hot} warm=${c.warm} cold=${c.cold}`);
          },
        },
        ...(runDistill
          ? [{
              name: "distill (3 days)",
              run: async () => {
                const r = await runDistill({ dryRun: false, days: 3, verbose }, sink);
                log(`Distill: ${r.stored} stored from ${r.sessionsScanned} sessions.`);
              },
            }]
          : []),
        ...(runExtractDaily
          ? [{
              name: "extract-daily (7 days)",
              run: async () => {
                const r = await runExtractDaily({ days: 7, dryRun: false, verbose }, sink);
                const stored = r.totalStored ?? r.stored ?? 0;
                log(`Extract-daily: ${stored} stored.`);
              },
            }]
          : []),
        ...(runExtractDirectives
          ? [{
              name: "extract-directives (7 days)",
              run: async () => {
                const r = await runExtractDirectives({ days: 7, verbose, dryRun: false });
                log(`Extract-directives: ${r.sessionsScanned} sessions scanned.`);
              },
            }]
          : []),
        ...(runExtractReinforcement
          ? [{
              name: "extract-reinforcement (7 days)",
              run: async () => {
                const r = await runExtractReinforcement({ days: 7, verbose, dryRun: false });
                log(`Extract-reinforcement: ${r.sessionsScanned} sessions scanned.`);
              },
            }]
          : []),
        ...(runExtractProcedures
          ? [{
              name: "extract-procedures (7 days)",
              run: async () => {
                await runExtractProcedures({ days: 7, dryRun: false });
                log("Extract procedures done.");
              },
            }]
          : []),
        ...(runGenerateAutoSkills
          ? [{
              name: "generate-auto-skills",
              run: async () => {
                const r = await runGenerateAutoSkills({ dryRun: false, verbose });
                log(`Generate-auto-skills: ${r.generated} generated.`);
              },
            }]
          : []),
        {
          name: "reflect",
          run: async () => {
            const r = await runReflection({ window: reflectionConfig.defaultWindow, dryRun: false, model: reflectionConfig.model, verbose });
            log(`Reflect: ${r.patternsStored} patterns stored.`);
          },
        },
        {
          name: "reflect-rules",
          run: async () => {
            const r = await runReflectionRules({ dryRun: false, model: reflectionConfig.model, verbose });
            log(`Reflect-rules: ${r.rulesStored} rules stored.`);
          },
        },
        {
          name: "reflect-meta",
          run: async () => {
            const r = await runReflectionMeta({ dryRun: false, model: reflectionConfig.model, verbose });
            log(`Reflect-meta: ${r.metaStored} meta-patterns stored.`);
          },
        },
        ...(runGenerateProposals
          ? [{
              name: "generate-proposals",
              run: async () => {
                const r = await runGenerateProposals({ dryRun: false, verbose });
                log(`Generate-proposals: ${r.created} created.`);
              },
            }]
          : []),
        {
          name: "self-correction-run",
          run: async () => {
            await runSelfCorrectionRun({ dryRun: false });
            log("Self-correction run done.");
          },
        },
        {
          name: "build-languages",
          run: async () => {
            const langPath = getLanguageKeywordsFilePath();
            if (langPath && existsSync(langPath)) {
              try {
                const ageMs = Date.now() - statSync(langPath).mtimeMs;
                const ageDays = ageMs / (24 * 60 * 60 * 1000);
                if (ageDays < 7) {
                  if (verbose) log(`Build-languages: skipped (updated ${ageDays.toFixed(1)} days ago).`);
                  return;
                }
              } catch (err) {
                if (verbose) log(`Build-languages: could not read mtime (${err}); running anyway.`);
              }
            }
            const r = await runBuildLanguageKeywords({ dryRun: false });
            if (r.ok) log(`Build-languages: ${r.languagesAdded} languages added.`);
            else if (verbose) log(`Build-languages: ${r.error}`);
          },
        },
      ];
      if (dryRun) {
        log("run-all (dry-run). Would run:");
        steps.forEach((s, i) => log(`  ${i + 1}. ${s.name}`));
        return;
      }
      for (let i = 0; i < steps.length; i++) {
        log(`[${i + 1}/${steps.length}] ${steps[i].name}`);
        try {
          await steps[i].run();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: `run-all:${steps[i].name}`,
          });
          throw err;
        }
      }
      log("run-all complete.");
    }));

  mem
    .command("compact")
    .description("Run tier compaction: completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT")
    .action(withExit(async () => {
      let counts;
      try {
        counts = await runCompaction();
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "compact" });
        throw err;
      }
      console.log(`Tier compaction: hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
    }));

  mem
    .command("stats")
    .description("Show memory statistics. Rich output includes procedures, rules, patterns, directives, graph, and operational info. Use --efficiency for tiers, sources, and token estimates.")
    .option("--efficiency", "Show tier/source breakdown, estimated tokens, and token-savings note")
    .option("--brief", "Show only storage and decay counts (legacy-style)")
    .action(withExit(async (opts?: { efficiency?: boolean; brief?: boolean }) => {
      const efficiency = opts?.efficiency ?? false;
      const brief = opts?.brief ?? false;
      const sqlCount = factsDb.count();
      let lanceCount = 0;
      try {
        lanceCount = await vectorDb.count();
      } catch (err) {
        capturePluginError(err as Error, {
          operation: 'vector-count',
          severity: 'info',
          subsystem: 'cli'
        });
        // vectorDb may be unavailable
      }
      const breakdown = factsDb.statsBreakdown();
      const expired = factsDb.countExpired();

      const extras = ctx.richStatsExtras;
      const useRich = !brief && extras;

      if (useRich) {
        const byCategory = factsDb.statsBreakdownByCategory();
        const procedures = factsDb.proceduresCount();
        const proceduresValidated = factsDb.proceduresValidatedCount();
        const proceduresPromoted = factsDb.proceduresPromotedCount();
        const directives = factsDb.directivesCount();
        const rules = byCategory["rule"] ?? 0;
        const patterns = byCategory["pattern"] ?? 0;
        const metaPatterns = factsDb.metaPatternsCount();
        const links = factsDb.linksCount();
        const entities = factsDb.entityCount();
        const categoriesConfigured = getMemoryCategories();
        const uniqueInMemory = factsDb.uniqueMemoryCategories();
        const credentials = extras.getCredentialsCount();
        const proposalsPending = extras.getProposalsPending();
        const walPending = extras.getWalPending();
        const timestamps = extras.getLastRunTimestamps();
        const sizes = await extras.getStorageSizes();

        const { reflectionPatternsCount, reflectionRulesCount } = factsDb.statsReflection();
        const selfCorrectionCount = factsDb.selfCorrectionIncidentsCount();
        const languageKeywordsCount = factsDb.languageKeywordsCount();

        console.log("=== Memory Statistics (rich) ===");
        console.log(`Schema version: ${versionInfo.schemaVersion}`);
        console.log(`Plugin version: ${versionInfo.pluginVersion}`);
        console.log(`Memory Manager: ${versionInfo.memoryManagerVersion}`);
        console.log("");
        console.log(`Total facts (SQLite): ${sqlCount}`);
        console.log(`Total vectors (LanceDB): ${lanceCount}`);
        console.log(`Expired (prunable): ${expired}`);
        console.log("");
        console.log(`Procedures: ${procedures} (validated: ${proceduresValidated}, promoted: ${proceduresPromoted})`);
        console.log(`Rules: ${rules}`);
        console.log(`Patterns: ${patterns}`);
        console.log(`Meta-patterns: ${metaPatterns}`);
        console.log(`Directives: ${directives}`);
        console.log(`Reflection (patterns/rules): ${reflectionPatternsCount}/${reflectionRulesCount}`);
        console.log(`Self-correction incidents: ${selfCorrectionCount}`);
        console.log(`Language keywords: ${languageKeywordsCount}`);
        console.log("");
        console.log(`Graph (links/entities): ${links}/${entities}`);
        console.log(`Credentials (vaulted): ${credentials}`);
        console.log(`Proposals (pending): ${proposalsPending}`);
        console.log(`WAL (pending distill): ${walPending}`);
        console.log("");
        console.log(`Categories configured: ${categoriesConfigured.length} [${categoriesConfigured.slice(0, 3).join(", ")}...]`);
        console.log(`Categories in memory: ${uniqueInMemory.length} [${uniqueInMemory.slice(0, 3).join(", ")}...]`);
        console.log("");
        console.log(`Breakdown: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural}`);
        console.log("");
        if (timestamps.distill) console.log(`Last distill: ${timestamps.distill}`);
        if (timestamps.reflect) console.log(`Last reflect: ${timestamps.reflect}`);
        if (timestamps.compact) console.log(`Last compact: ${timestamps.compact}`);
        if (timestamps.distill || timestamps.reflect || timestamps.compact) console.log("");
        if (sizes.sqliteBytes != null) console.log(`SQLite size: ${(sizes.sqliteBytes / 1024 / 1024).toFixed(2)} MB`);
        if (sizes.lanceBytes != null) console.log(`LanceDB size: ${(sizes.lanceBytes / 1024 / 1024).toFixed(2)} MB`);
        if (sizes.sqliteBytes != null || sizes.lanceBytes != null) console.log("");
      } else if (efficiency) {
        const byTier = breakdown;
        const bySource = factsDb.statsBySource();
        const estimatedTokens = factsDb.estimateTokens();
        console.log("=== Memory Efficiency Stats ===");
        console.log(`Breakdown: hot=${byTier.hot}, warm=${byTier.warm}, cold=${byTier.cold}, structural=${byTier.structural}`);
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
        console.log(`Breakdown: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural}`);
      }
    }));

  mem
    .command("prune")
    .description("Remove expired facts (decayed past threshold)")
    .action(withExit(async () => {
      const before = factsDb.count();
      const pruned = factsDb.prune();
      const after = factsDb.count();
      console.log(`Pruned ${pruned} expired facts. Before: ${before}, After: ${after}`);
    }));

  mem
    .command("checkpoint")
    .description("Checkpoint vector DB to disk (LanceDB optimization)")
    .action(withExit(async () => {
      await vectorDb.checkpoint?.();
      console.log("Vector DB checkpoint complete.");
    }));

  mem
    .command("backfill-decay")
    .description("Backfill decayAt for facts missing it (one-time migration)")
    .action(withExit(async () => {
      const updated = factsDb.backfillDecay();
      console.log(`Backfilled decayAt for ${updated} facts.`);
    }));

  mem
    .command("search <query>")
    .description("Hybrid search (vector + SQL). Returns up to 20 results.")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .option("--scope <s>", "Filter by scope (global/user/agent/session)")
    .option("--scope-target <st>", "Scope target (userId/agentId/sessionId)")
    .action(withExit(async (query: string, opts?: {
      category?: string;
      entity?: string;
      key?: string;
      source?: string;
      tier?: string;
      scope?: string;
      scopeTarget?: string;
    }) => {
      try {
        // Build scope filter from CLI options
        const scopeFilter: ScopeFilter | undefined = opts?.scope ? (() => {
          const filter: ScopeFilter = {};
          if (opts.scope === 'user') filter.userId = opts.scopeTarget || null;
          else if (opts.scope === 'agent') filter.agentId = opts.scopeTarget || null;
          else if (opts.scope === 'session') filter.sessionId = opts.scopeTarget || null;
          return filter;
        })() : undefined;

        const embedding = await embeddings.embed(query);
        const vectorResults = await vectorDb.search(embedding, 50);
        const sqlResults = factsDb.search(query, 50, {
          scopeFilter,
          tierFilter: opts?.tier === 'cold' ? 'all' : 'warm',
        });

        // Filter vector results by scope
        let filteredVectorResults = vectorResults;
        if (scopeFilter) {
          filteredVectorResults = filterByScope(
            vectorResults,
            (id, opts) => factsDb.getById(id, opts),
            scopeFilter
          );
        }

        let combined = merge(filteredVectorResults, sqlResults, 20, factsDb);

        if (tieringEnabled && opts?.tier !== 'cold') {
          combined = combined.filter((r) => r.entry.tier !== "cold");
        }

        console.log(`Search results for "${query}": ${combined.length}`);
        for (const r of combined) {
          console.log(`  [${r.entry.id}] ${r.entry.text} (score=${r.score.toFixed(3)}, tier=${r.entry.tier}, category=${r.entry.category ?? "none"})`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "search" });
        throw err;
      }
    }));

  mem
    .command("lookup <id>")
    .description("Lookup a fact by ID")
    .action(withExit(async (id: string) => {
      try {
        const fact = factsDb.get(id);
        if (!fact) {
          console.log(`Fact not found: ${id}`);
          return;
        }
        console.log(JSON.stringify(fact, null, 2));
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "lookup" });
        throw err;
      }
    }));

  mem
    .command("categories")
    .description("List all categories in memory (discovered from facts)")
    .action(withExit(async () => {
      try {
        const cats = factsDb.uniqueMemoryCategories();
        console.log(`Categories in memory (${cats.length}):`);
        for (const c of cats) {
          console.log(`  - ${c}`);
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "categories" });
        throw err;
      }
    }));

  mem
    .command("list")
    .description("List recent facts (default 10)")
    .option("--limit <n>", "Max results", "10")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .action(withExit(async (opts?: {
      limit?: string;
      category?: string;
      entity?: string;
      key?: string;
      source?: string;
      tier?: string;
    }) => {
      try {
        const limit = parseInt(opts?.limit ?? "10", 10);
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
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "list" });
        throw err;
      }
    }));

  mem
    .command("show <id>")
    .description("Show full detail for a fact by ID. For proposals use: hybrid-mem proposals show <id> (supports --diff, --json)")
    .action(withExit(async (id: string) => {
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
    }));

  const proposals = mem.command("proposals").description("Manage persona-driven proposals");
  const proposalStatusValues = ["pending", "approved", "rejected", "applied"] as const;
  proposals
    .command("list")
    .description("List pending proposals")
    .option("--status <s>", `Filter by status: ${proposalStatusValues.join(", ")}`)
    .action(withExit(async (opts?: { status?: string }) => {
      if (!listCommands?.listProposals) {
        console.log("Proposals feature not available (personaProposals disabled or no workspace).");
        return;
      }
      const status = opts?.status;
      if (status != null && status !== "" && !proposalStatusValues.includes(status as typeof proposalStatusValues[number])) {
        console.error(`error: --status requires one of: ${proposalStatusValues.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const items = await listCommands.listProposals({ status: status || undefined });
      console.log(`Proposals (${items.length}):`);
      for (const p of items) {
        console.log(`  [${p.id}] ${p.title} (target=${p.targetFile}, status=${p.status}, confidence=${p.confidence.toFixed(2)})`);
      }
    }));
  proposals
    .command("approve <id>")
    .description("Approve a proposal by ID")
    .action(withExit(async (id: string) => {
      if (!listCommands?.proposalApprove) {
        console.log("Proposals feature not available.");
        return;
      }
      const res = await listCommands.proposalApprove(id);
      if (res.ok) {
        console.log(`Proposal ${id} approved and applied.`);
      } else {
        console.error(`Error approving proposal ${id}: ${res.error}`);
        process.exitCode = 1;
      }
    }));
  proposals
    .command("reject <id>")
    .description("Reject a proposal by ID")
    .option("--reason <r>", "Rejection reason")
    .action(withExit(async (id: string, opts?: { reason?: string }) => {
      if (!listCommands?.proposalReject) {
        console.log("Proposals feature not available.");
        return;
      }
      const res = await listCommands.proposalReject(id, opts?.reason);
      if (res.ok) {
        console.log(`Proposal ${id} rejected.`);
      } else {
        console.error(`Error rejecting proposal ${id}: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  proposals
    .command("show <proposalId>")
    .description("Show full proposal content (observation, suggested change, optional diff)")
    .option("--json", "Machine-readable output")
    .option("--diff", "Show unified diff against current target file")
    .action(withExit(async (proposalId: string, opts?: { json?: boolean; diff?: boolean }) => {
      if (!listCommands?.showItem) {
        console.log("Proposals feature not available.");
        return;
      }
      const item = await listCommands.showItem(proposalId);
      if (!item || item.type !== "proposal") {
        console.error(`Proposal ${proposalId} not found`);
        process.exitCode = 1;
        return;
      }
      const proposal = item.data as { id: string; status: string; targetFile: string; confidence: number; observation: string; suggestedChange: string; createdAt: number; evidenceSessions?: string[] };
      const workspace = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
      const targetPath = join(workspace, proposal.targetFile);
      const includeDiff = !!opts?.diff || !!opts?.json;
      let diffText: string | null = null;
      if (includeDiff) {
        try {
          const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
          const proposed = buildAppliedContent(current, proposal, new Date().toISOString()).content;
          diffText = buildUnifiedDiff(current, proposed, proposal.targetFile);
        } catch { diffText = null; }
      }
      if (opts?.json) {
        console.log(JSON.stringify({ ...proposal, diff: diffText }, null, 2));
        return;
      }
      const created = new Date(proposal.createdAt * 1000).toISOString();
      const evidenceCount = Array.isArray(proposal.evidenceSessions) ? proposal.evidenceSessions.length : 0;
      console.log(`Proposal: ${proposal.id}`);
      console.log(`Status: ${proposal.status}`);
      console.log(`Target: ${proposal.targetFile}`);
      console.log(`Confidence: ${proposal.confidence.toFixed(2)}`);
      console.log(`Created: ${created}`);
      console.log(`Evidence: ${evidenceCount} sessions`);
      console.log("");
      console.log("── Observation ──");
      console.log(proposal.observation);
      console.log("");
      console.log("── Suggested Change ──");
      console.log(proposal.suggestedChange);
      if (opts?.diff && diffText) {
        console.log("");
        console.log("── Preview (diff) ──");
        console.log(diffText);
      }
    }));

  const corrections = mem.command("corrections").description("Manage self-correction reports");
  corrections
    .command("list")
    .description("List pending corrections (from latest self-correction run)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(withExit(async (opts?: { workspace?: string }) => {
      if (!listCommands?.listCorrections) {
        console.log("Corrections feature not available.");
        return;
      }
      const { reportPath, items } = await listCommands.listCorrections({ workspace: opts?.workspace });
      if (!reportPath) {
        console.log("No corrections report found.");
        return;
      }
      console.log(`Corrections report: ${reportPath}`);
      console.log(`Pending items (${items.length}):`);
      for (const item of items) {
        console.log(`  - ${item}`);
      }
    }));
  corrections
    .command("approve-all")
    .description("Approve all pending corrections (auto-fix memory + TOOLS.md)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(withExit(async (opts?: { workspace?: string }) => {
      if (!listCommands?.correctionsApproveAll) {
        console.log("Corrections feature not available.");
        return;
      }
      const { applied, error } = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
      if (error) {
        console.error(`Error applying corrections: ${error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Applied ${applied} corrections.`);
    }));

  mem
    .command("review")
    .description("Start interactive review of pending proposals + corrections")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(withExit(async (opts?: { workspace?: string }) => {
      console.log("=== Interactive Review (proposals + corrections) ===");
      if (!listCommands) {
        console.log("Review feature not available (personaProposals disabled or no workspace).");
        return;
      }
      const proposals = listCommands.listProposals ? await listCommands.listProposals({ status: "pending" }) : [];
      const { reportPath, items: corrections } = listCommands.listCorrections ? await listCommands.listCorrections({ workspace: opts?.workspace }) : { reportPath: null, items: [] };

      console.log(`Pending proposals: ${proposals.length}`);
      console.log(`Pending corrections: ${corrections.length}`);
      console.log("");
      console.log("To approve/reject proposals: hybrid-mem proposals approve <id> | reject <id>");
      console.log("To approve all corrections: hybrid-mem corrections approve-all");
      console.log("");
      console.log("Proposals:");
      for (const p of proposals) {
        console.log(`  [${p.id}] ${p.title} (target=${p.targetFile}, confidence=${p.confidence.toFixed(2)})`);
      }
      console.log("");
      if (reportPath) {
        console.log(`Corrections report: ${reportPath}`);
        for (const item of corrections) {
          console.log(`  - ${item}`);
        }
      } else {
        console.log("No corrections report found.");
      }
    }));

  mem
    .command("store <text>")
    .description("Store a fact (with optional category, entity, key-value, sourceDate, tags, supersedes, scope)")
    .option("--category <cat>", "Category")
    .option("--entity <ent>", "Entity")
    .option("--key <k>", "Key")
    .option("--value <v>", "Value")
    .option("--source-date <d>", "Source date (ISO or timestamp)")
    .option("--tags <t>", "Tags (comma-separated)")
    .option("--supersedes <id>", "Fact ID this store supersedes (replaces)")
    .option("--scope <s>", "Memory scope (global, user, agent, session). Default global.")
    .option("--scope-target <st>", "Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.")
    .action(withExit(async (text: string, opts?: {
      category?: string;
      entity?: string;
      key?: string;
      value?: string;
      sourceDate?: string;
      tags?: string;
      supersedes?: string;
      scope?: "global" | "user" | "agent" | "session";
      scopeTarget?: string;
    }) => {
      let res;
      try {
        res = await runStore({
        text,
        category: opts?.category,
        entity: opts?.entity,
        key: opts?.key,
        value: opts?.value,
        sourceDate: opts?.sourceDate,
        tags: opts?.tags,
        supersedes: opts?.supersedes,
        scope: opts?.scope,
        scopeTarget: opts?.scopeTarget,
      });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "store" });
        throw err;
      }
      if (res.outcome === "duplicate") {
        console.log("Duplicate fact (skipped).");
      } else if (res.outcome === "credential") {
        console.log(`Credential stored: ${res.service} (${res.type}), id=${res.id}`);
      } else if (res.outcome === "credential_parse_error") {
        console.log("Credential parse error (skipped).");
      } else if (res.outcome === "noop") {
        console.log(`No-op: ${res.reason}`);
      } else if (res.outcome === "retracted") {
        console.log(`Retracted fact ${res.targetId}: ${res.reason}`);
      } else if (res.outcome === "updated") {
        console.log(`Updated fact ${res.id} (superseded ${res.supersededId}): ${res.reason}`);
      } else if (res.outcome === "stored") {
        console.log(`Stored: ${res.textPreview} (id=${res.id}${res.supersededId ? `, superseded ${res.supersededId}` : ""})`);
      }
    }));

  mem
    .command("config-mode <mode>")
    .description("Set memory mode (essential, normal, expert, full). Writes memory/.config if needed.")
    .action(withExit(async (mode: string) => {
      let res;
      try {
        res = await runConfigMode(mode);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "config-mode" });
        throw err;
      }
      if (res.ok) {
        console.log(res.message);
      } else {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  mem
    .command("config-set <key> <value>")
    .description("Set a config key in memory/.config. For help on a key: hybrid-mem help config-set <key>")
    .action(withExit(async (key: string, value: string) => {
      let res;
      try {
        res = await runConfigSet(key, value);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "config-set" });
        throw err;
      }
      if (res.ok) {
        console.log(res.message);
      } else {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  mem
    .command("help config-set <key>")
    .description("Show help for a config key")
    .action(withExit(async (key: string) => {
      let res;
      try {
        res = await runConfigSetHelp(key);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "config-set-help" });
        throw err;
      }
      if (res.ok) {
        console.log(res.message);
      } else {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  mem
    .command("backfill")
    .description("Backfill memory from workspace documents (Markdown, text files). Run once to seed memory with existing project docs.")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--limit <n>", "Max facts to store (default: no limit)")
    .action(withExit(async (opts?: { dryRun?: boolean; workspace?: string; limit?: string }) => {
      let res;
      try {
        res = await runBackfill(
          { dryRun: !!opts?.dryRun, workspace: opts?.workspace, limit: opts?.limit ? parseInt(opts.limit, 10) : undefined },
          { log: console.log, warn: console.warn },
        );
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "backfill" });
        throw err;
      }
      console.log(`Backfill complete: ${res.stored} stored, ${res.skipped} skipped, ${res.candidates} candidates, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`);
    }));

  mem
    .command("ingest-files")
    .description("Ingest files from workspace (Markdown, text). Extract facts and store in memory. Use --paths for specific files.")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--paths <p...>", "Specific file paths (relative to workspace)")
    .action(withExit(async (opts?: { dryRun?: boolean; workspace?: string; paths?: string[] }) => {
      let res;
      try {
        res = await runIngestFiles(
          { dryRun: !!opts?.dryRun, workspace: opts?.workspace, paths: opts?.paths },
          { log: console.log, warn: console.warn },
        );
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "ingest-files" });
        throw err;
      }
      console.log(`Ingest complete: ${res.stored} stored, ${res.skipped} skipped, ${res.extracted} extracted, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`);
    }));

  mem!
    .command("export")
    .description("Export memory to MEMORY.md + memory/ directory (vanilla OpenClaw format). Use --output to specify path.")
    .requiredOption("--output <path>", "Output directory path")
    .option("--exclude-credentials", "Exclude credentials from export")
    .option("--include-credentials", "Include credentials in export (default: exclude)")
    .option("--sources <s...>", "Filter by source (comma-separated)")
    .option("--mode <m>", "Export mode: replace (overwrite) or additive (merge). Default: replace.", "replace")
    .action(withExit(async (opts: {
      output: string;
      excludeCredentials?: boolean;
      includeCredentials?: boolean;
      sources?: string[];
      mode?: "replace" | "additive";
    }) => {
      let res;
      try {
        res = await runExport({
          outputPath: opts.output,
          excludeCredentials: opts.excludeCredentials,
          includeCredentials: opts.includeCredentials,
          sources: opts.sources,
          mode: opts.mode ?? "replace",
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "export" });
        throw err;
      }
      console.log(`Exported ${res.factsExported} facts, ${res.proceduresExported} procedures to ${res.outputPath} (${res.filesWritten} files written).`);
    }));

  mem
    .command("find-duplicates")
    .description("Find duplicate or near-duplicate facts using vector similarity")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in search")
    .option("--limit <n>", "Max pairs to return (default 100)", "100")
    .action(withExit(async (opts?: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
      const threshold = parseFloat(opts?.threshold ?? "0.85");
      const includeStructured = !!opts?.includeStructured;
      const limit = parseInt(opts?.limit ?? "100", 10);
      let res;
      try {
        res = await runFindDuplicates({ threshold, includeStructured, limit });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "find-duplicates" });
        throw err;
      }
      console.log(`Found ${res.pairs.length} duplicate pairs (threshold=${threshold}, candidates=${res.candidatesCount}, skippedStructured=${res.skippedStructured})`);
      for (const p of res.pairs) {
        console.log(`  [${p.idA}] <-> [${p.idB}] (score=${p.score.toFixed(3)})`);
        console.log(`    A: ${p.textA.substring(0, 60)}...`);
        console.log(`    B: ${p.textB.substring(0, 60)}...`);
      }
    }));

  mem
    .command("consolidate")
    .description("Consolidate duplicate facts: cluster by vector similarity, merge via LLM, delete originals")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in consolidation")
    .option("--dry-run", "Show what would be consolidated without consolidating")
    .option("--limit <n>", "Max clusters to process (default 10)", "10")
    .option("--model <m>", "LLM model for merging (default from autoClassify config)")
    .action(withExit(async (opts?: { threshold?: string; includeStructured?: boolean; dryRun?: boolean; limit?: string; model?: string }) => {
      const threshold = parseFloat(opts?.threshold ?? "0.85");
      const includeStructured = !!opts?.includeStructured;
      const dryRun = !!opts?.dryRun;
      const limit = parseInt(opts?.limit ?? "10", 10);
      const model = opts?.model ?? ctx.autoClassifyConfig.model;
      let res;
      try {
        res = await runConsolidate({ threshold, includeStructured, dryRun, limit, model });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "consolidate" });
        throw err;
      }
      console.log(`Consolidation complete: ${res.clustersFound} clusters found, ${res.merged} merged, ${res.deleted} deleted ${dryRun ? "(dry-run)" : ""}`);
    }));

  mem
    .command("reflect")
    .description("Run reflection: analyze recent facts, extract patterns, store in memory")
    .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each pattern as it is extracted")
    .action(withExit(async (opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean }) => {
      const window = opts?.window ? parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
      const dryRun = !!opts?.dryRun;
      const model = opts?.model ?? reflectionConfig.model;
      const verbose = !!opts?.verbose;
      let res;
      try {
        res = await runReflection({ window, dryRun, model, verbose });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "reflect" });
        throw err;
      }
      console.log(`Reflection complete: analyzed ${res.factsAnalyzed} facts, extracted ${res.patternsExtracted} patterns, stored ${res.patternsStored} ${dryRun ? "(dry-run)" : ""}`);
    }));

  mem
    .command("reflect-rules")
    .description("Run reflection (rules): extract high-level rules from patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each rule as it is extracted")
    .action(withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
      const dryRun = !!opts?.dryRun;
      const model = opts?.model ?? reflectionConfig.model;
      const verbose = !!opts?.verbose;
      let res;
      try {
        res = await runReflectionRules({ dryRun, model, verbose });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "reflect-rules" });
        throw err;
      }
      console.log(`Reflection (rules) complete: extracted ${res.rulesExtracted} rules, stored ${res.rulesStored} ${dryRun ? "(dry-run)" : ""}`);
    }));

  mem
    .command("reflect-meta")
    .description("Run reflection (meta-patterns): extract meta-patterns from existing patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each meta-pattern as it is extracted")
    .action(withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
      const dryRun = !!opts?.dryRun;
      const model = opts?.model ?? reflectionConfig.model;
      const verbose = !!opts?.verbose;
      let res;
      try {
        res = await runReflectionMeta({ dryRun, model, verbose });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "reflect-meta" });
        throw err;
      }
      console.log(`Reflection (meta) complete: extracted ${res.metaExtracted} meta-patterns, stored ${res.metaStored} ${dryRun ? "(dry-run)" : ""}`);
    }));

  mem
    .command("classify")
    .description("Reclassify uncategorized facts using LLM (auto-classify)")
    .option("--dry-run", "Show what would be reclassified without reclassifying")
    .option("--limit <n>", "Max facts to classify (default 100)", "100")
    .option("--model <m>", "LLM model (default from config)")
    .action(withExit(async (opts?: { dryRun?: boolean; limit?: string; model?: string }) => {
      const dryRun = !!opts?.dryRun;
      const limit = parseInt(opts?.limit ?? "100", 10);
      const model = opts?.model;
      let res;
      try {
        res = await runClassify({ dryRun, limit, model });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "classify" });
        throw err;
      }
      console.log(`Classify complete: reclassified ${res.reclassified}/${res.total} facts ${dryRun ? "(dry-run)" : ""}`);
      if (res.breakdown) {
        console.log("Breakdown by category:");
        for (const [cat, count] of Object.entries(res.breakdown)) {
          console.log(`  ${cat}: ${count}`);
        }
      }
    }));

  mem
    .command("build-languages")
    .description("Detect top 3 languages from memory text; LLM produces intent-based natural equivalents (triggers, extraction patterns) and writes .language-keywords.json")
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--dry-run", "Show what would be generated without writing")
    .action(withExit(async (opts?: { model?: string; dryRun?: boolean }) => {
      const model = opts?.model ?? ctx.autoClassifyConfig.model;
      const dryRun = !!opts?.dryRun;
      let res;
      try {
        res = await runBuildLanguageKeywords({ model, dryRun });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "build-languages" });
        throw err;
      }
      if (res.ok) {
        console.log(`Built language keywords: top languages=[${res.topLanguages.join(", ")}], added=${res.languagesAdded}, path=${res.path} ${dryRun ? "(dry-run)" : ""}`);
      } else {
        console.error(`Error building language keywords: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  mem
    .command("self-correction-extract")
    .description("Extract self-correction incidents from session JSONL using multi-language correction signals from .language-keywords.json")
    .option("--days <n>", "Days to look back (default 7)", "7")
    .option("--output <path>", "Output path for incidents JSON (default: memory/.self-correction-incidents.json)")
    .action(withExit(async (opts?: { days?: string; output?: string }) => {
      const days = opts?.days ? parseInt(opts.days, 10) : 7;
      const outputPath = opts?.output;
      let res;
      try {
        res = await runSelfCorrectionExtract({ days, outputPath });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "self-correction-extract" });
        throw err;
      }
      console.log(`Self-correction extract complete: ${res.incidents.length} incidents found, ${res.sessionsScanned} sessions scanned.`);
    }));

  mem
    .command("self-correction-run")
    .description("Analyze extracted incidents and auto-remediate (memory store, TOOLS.md); report to memory/reports")
    .option("--extract-path <path>", "Path to incidents JSON (default: memory/.self-correction-incidents.json)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .option("--dry-run", "Show what would be applied without applying")
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--approve", "Auto-approve all corrections (skip review)")
    .option("--no-apply-tools", "Skip TOOLS.md updates (memory-only)")
    .action(withExit(async (opts?: {
      extractPath?: string;
      workspace?: string;
      dryRun?: boolean;
      model?: string;
      approve?: boolean;
      applyTools?: boolean;
    }) => {
      const extractPath = opts?.extractPath;
      const workspace = opts?.workspace;
      const dryRun = !!opts?.dryRun;
      const model = opts?.model ?? ctx.autoClassifyConfig.model;
      const approve = !!opts?.approve;
      let res;
      try {
        res = await runSelfCorrectionRun({ extractPath, workspace, dryRun, model, approve, applyTools: opts?.applyTools });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "self-correction-run" });
        throw err;
      }
      if (res.error) {
        console.error(`Error: ${res.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Self-correction run complete: ${res.incidentsFound} incidents found, ${res.analysed} analysed, ${res.autoFixed} auto-fixed ${dryRun ? "(dry-run)" : ""}`);
      if (res.proposals.length > 0) {
        console.log(`Proposals (${res.proposals.length}):`);
        for (const p of res.proposals) {
          console.log(`  - ${p}`);
        }
      }
      if (res.reportPath) {
        console.log(`Report: ${res.reportPath}`);
      }
      if (res.toolsSuggestions && res.toolsSuggestions.length > 0) {
        console.log(`TOOLS.md suggestions (${res.toolsSuggestions.length}):`);
        for (const s of res.toolsSuggestions) {
          console.log(`  - ${s}`);
        }
      }
      if (res.toolsApplied != null && res.toolsApplied > 0) {
        console.log(`TOOLS.md updates applied: ${res.toolsApplied}`);
      }
    }));

  const credentials = mem.command("credentials").description("Manage credentials (vaulted)");
  credentials
    .command("migrate-to-vault")
    .description("Migrate credentials from plaintext to vaulted storage (one-time)")
    .action(withExit(async () => {
      let res;
      try {
        res = await runMigrateToVault();
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "migrate-to-vault" });
        throw err;
      }
      if (!res) {
        console.log("No credentials to migrate (or migration already done).");
        return;
      }
      if (res.errors.length > 0) {
        console.error(`Errors during migration: ${res.errors.join(", ")}`);
      }
      console.log(`Migrated ${res.migrated} credentials (${res.skipped} skipped).`);
    }));

  const scope = mem.command("scope").description("Manage memory scopes (global, user, agent, session)");
  scope
    .command("list")
    .description("List all scopes in memory (discovered from facts)")
    .action(withExit(async () => {
      const scopes = factsDb.uniqueScopes();
      console.log(`Scopes in memory (${scopes.length}):`);
      for (const s of scopes) {
        console.log(`  - ${s}`);
      }
    }));
  scope
    .command("stats")
    .description("Show scope statistics (count by scope)")
    .action(withExit(async () => {
      const stats = factsDb.scopeStats();
      console.log("Scope stats:");
      for (const [s, count] of Object.entries(stats)) {
        console.log(`  ${s}: ${count}`);
      }
    }));
  scope!
    .command("prune")
    .description("Prune all facts in a specific scope (WARNING: destructive)")
    .requiredOption("--scope <s>", "Scope to prune (global/user/agent/session)")
    .option("--scope-target <st>", "Scope target (userId/agentId/sessionId). Required when scope is user/agent/session.")
    .action(withExit(async (opts: { scope: string; scopeTarget?: string }) => {
      const scopeFilter: ScopeFilter = {};
      if (opts.scope === 'user') scopeFilter.userId = opts.scopeTarget || null;
      else if (opts.scope === 'agent') scopeFilter.agentId = opts.scopeTarget || null;
      else if (opts.scope === 'session') scopeFilter.sessionId = opts.scopeTarget || null;

      const deleted = factsDb.pruneScopedFacts(scopeFilter);
      console.log(`Pruned ${deleted} facts from scope ${opts.scope}${opts.scopeTarget ? ` (target=${opts.scopeTarget})` : ""}.`);
    }));

  mem
    .command("version")
    .description("Show installed version and latest available on GitHub and npm")
    .option("--json", "Machine-readable JSON output")
    .action(withExit(async (opts?: { json?: boolean }) => {
      const installed = ctx.versionInfo.pluginVersion;
      const timeoutMs = 3000;
      const fetchWithTimeout = async (url: string): Promise<Response> => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: c.signal });
          clearTimeout(t);
          return res;
        } catch (err) {
          clearTimeout(t);
          if (err instanceof Error && err.name === "AbortError") throw new Error("Request timed out");
          throw err;
        }
      };

      let githubVersion: string | null = null;
      let npmVersion: string | null = null;
      try {
        const ghRes = await fetchWithTimeout("https://api.github.com/repos/markus-lassfolk/openclaw-hybrid-memory/releases/latest");
        if (ghRes.ok) {
          const data = (await ghRes.json()) as { tag_name?: string };
          const tag = data.tag_name;
          githubVersion = typeof tag === "string" ? tag.replace(/^v/, "") : null;
        }
      } catch {
        githubVersion = null;
      }
      try {
        const npmRes = await fetchWithTimeout("https://registry.npmjs.org/openclaw-hybrid-memory/latest");
        if (npmRes.ok) {
          const data = (await npmRes.json()) as { version?: string };
          npmVersion = typeof data.version === "string" ? data.version : null;
        }
      } catch {
        npmVersion = null;
      }

      const compare = (a: string, b: string): number => {
        const parseNum = (s: string): number => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };
        const pa = a.replace(/[-+].*/,"").split(".").map(parseNum);
        const pb = b.replace(/[-+].*/,"").split(".").map(parseNum);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const va = pa[i] ?? 0;
          const vb = pb[i] ?? 0;
          if (va !== vb) return va < vb ? -1 : 1;
        }
        return 0;
      };
      const updateHint = (latest: string | null) => {
        if (latest == null) return "";
        return compare(installed, latest) < 0 ? " ⬆ update available" : " (up to date)";
      };

      if (opts?.json) {
        console.log(JSON.stringify({
          name: "openclaw-hybrid-memory",
          installed,
          github: githubVersion ?? "unavailable",
          npm: npmVersion ?? "unavailable",
          updateAvailable: (githubVersion != null && compare(installed, githubVersion) < 0) || (npmVersion != null && compare(installed, npmVersion) < 0),
        }, null, 2));
        return;
      }

      console.log("openclaw-hybrid-memory");
      console.log(`  Installed:  ${installed}`);
      console.log(`  GitHub:     ${githubVersion ?? "unavailable"}${githubVersion != null && compare(installed, githubVersion) > 0 ? " (installed is newer)" : updateHint(githubVersion)}`);
      console.log(`  npm:        ${npmVersion ?? "unavailable"}${npmVersion != null && compare(installed, npmVersion) > 0 ? " (installed is newer)" : updateHint(npmVersion)}`);
    }));

  mem
    .command("upgrade [version]")
    .description("Upgrade hybrid-mem to a specific version (or latest). Downloads and installs plugin from GitHub.")
    .action(withExit(async (version?: string) => {
      const res = await runUpgrade(version);
      if (res.ok) {
        console.log(`Upgraded to version ${res.version}. Plugin installed at: ${res.pluginDir}`);
      } else {
        console.error(`Error upgrading: ${res.error}`);
        process.exitCode = 1;
      }
    }));

  mem
    .command("uninstall")
    .description("Uninstall hybrid-mem: clean plugin files, optionally remove from OpenClaw config")
    .option("--clean-all", "Remove all plugin data (SQLite, LanceDB, reports, config)")
    .option("--leave-config", "Keep OpenClaw config entry (just clean plugin files)")
    .action(withExit(async (opts?: { cleanAll?: boolean; leaveConfig?: boolean }) => {
      let res;
      try {
        res = await runUninstall({
          cleanAll: !!opts?.cleanAll,
          leaveConfig: !!opts?.leaveConfig,
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "uninstall" });
        throw err;
      }
      if (res.outcome === "config_updated") {
        console.log(`Uninstalled ${res.pluginId}: config updated, cleaned ${res.cleaned.length} files.`);
      } else if (res.outcome === "config_not_found") {
        console.log(`Uninstalled ${res.pluginId}: config not found, cleaned ${res.cleaned.length} files.`);
      } else if (res.outcome === "config_error") {
        console.error(`Uninstalled ${res.pluginId}: config error (${res.error}), cleaned ${res.cleaned.length} files.`);
      } else if (res.outcome === "leave_config") {
        console.log(`Uninstalled ${res.pluginId}: config left intact, cleaned ${res.cleaned.length} files.`);
      }
    }));
}
