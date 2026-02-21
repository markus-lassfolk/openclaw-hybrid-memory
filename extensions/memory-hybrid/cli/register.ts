/**
 * Register hybrid-mem CLI subcommands.
 * Receives the "hybrid-mem" command object and a context; registers stats, prune,
 * checkpoint, backfill-decay, search, lookup. Remaining commands stay in index.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { SearchResult } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import type { ScopeFilter } from "../types/memory.js";
import { parseSourceDate } from "../utils/dates.js";

export type FindDuplicatesResult = {
  pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }>;
  candidatesCount: number;
  skippedStructured: number;
};

export type StoreCliOpts = {
  text: string;
  category?: string;
  entity?: string;
  key?: string;
  value?: string;
  sourceDate?: string;
  tags?: string;
  /** Fact id this store supersedes (replaces). */
  supersedes?: string;
  /** Memory scope (global, user, agent, session). Default global. */
  scope?: "global" | "user" | "agent" | "session";
  /** Scope target (userId, agentId, sessionId). Required when scope is user/agent/session. */
  scopeTarget?: string;
};

export type StoreCliResult =
  | { outcome: "duplicate" }
  | { outcome: "credential"; id: string; service: string; type: string }
  | { outcome: "credential_parse_error" }
  | { outcome: "noop"; reason: string }
  | { outcome: "retracted"; targetId: string; reason: string }
  | { outcome: "updated"; id: string; supersededId: string; reason: string }
  | { outcome: "stored"; id: string; textPreview: string; supersededId?: string };

export type InstallCliResult =
  | { ok: true; configPath: string; dryRun: boolean; written: boolean; configJson?: string; pluginId: string }
  | { ok: false; error: string };

export type VerifyCliSink = { log: (s: string) => void; error?: (s: string) => void };

export type DistillWindowResult = { mode: "full" | "incremental"; startDate: string; endDate: string; mtimeDays: number };

export type RecordDistillResult = { path: string; timestamp: string };

export type ExtractDailyResult = { totalExtracted: number; totalStored: number; daysBack: number; dryRun: boolean };
export type ExtractDailySink = { log: (s: string) => void; warn: (s: string) => void };

export type ExtractProceduresResult = {
  sessionsScanned: number;
  proceduresStored: number;
  positiveCount: number;
  negativeCount: number;
  dryRun: boolean;
};

export type GenerateAutoSkillsResult = {
  generated: number;
  skipped: number;
  dryRun: boolean;
  paths: string[];
};

export type BackfillCliResult = { stored: number; skipped: number; candidates: number; files: number; dryRun: boolean };
export type BackfillCliSink = { log: (s: string) => void; warn: (s: string) => void };

export type IngestFilesResult = { stored: number; skipped: number; extracted: number; files: number; dryRun: boolean };
export type IngestFilesSink = { log: (s: string) => void; warn: (s: string) => void };

export type DistillCliResult = { sessionsScanned: number; factsExtracted: number; stored: number; skipped: number; dryRun: boolean };
export type DistillCliSink = { log: (s: string) => void; warn: (s: string) => void };

export type SelfCorrectionExtractResult = {
  incidents: Array<{ userMessage: string; precedingAssistant: string; followingAssistant: string; timestamp?: string; sessionFile: string }>;
  sessionsScanned: number;
};
export type SelfCorrectionRunResult = {
  incidentsFound: number;
  analysed: number;
  autoFixed: number;
  proposals: string[];
  reportPath: string | null;
  toolsSuggestions?: string[];
  toolsApplied?: number;
  error?: string;
};
export type MigrateToVaultResult = { migrated: number; skipped: number; errors: string[] };

export type UpgradeCliResult =
  | { ok: true; version: string; pluginDir: string }
  | { ok: false; error: string };

export type UninstallCliResult =
  | { outcome: "config_updated"; pluginId: string; cleaned: string[] }
  | { outcome: "config_not_found"; pluginId: string; cleaned: string[] }
  | { outcome: "config_error"; error: string; pluginId: string; cleaned: string[] }
  | { outcome: "leave_config"; pluginId: string; cleaned: string[] };

export type ConfigCliResult =
  | { ok: true; configPath: string; message: string }
  | { ok: false; error: string };

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  cfg: { distill?: { reinforcementBoost?: number; reinforcementProcedureBoost?: number; reinforcementPromotionThreshold?: number } };
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
  runInstall: (opts: { dryRun: boolean }) => Promise<InstallCliResult>;
  runVerify: (opts: { fix: boolean; logFile?: string }, sink: VerifyCliSink) => Promise<void>;
  runDistillWindow: (opts: { json: boolean }) => Promise<DistillWindowResult>;
  runRecordDistill: () => Promise<RecordDistillResult>;
  runExtractDaily: (opts: { days: number; dryRun: boolean }, sink: ExtractDailySink) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: { sessionDir?: string; days?: number; dryRun: boolean }) => Promise<ExtractProceduresResult>;
  runGenerateAutoSkills: (opts: { dryRun: boolean }) => Promise<GenerateAutoSkillsResult>;
  runBackfill: (opts: { dryRun: boolean; workspace?: string; limit?: number }, sink: BackfillCliSink) => Promise<BackfillCliResult>;
  runIngestFiles: (opts: { dryRun: boolean; workspace?: string; paths?: string[] }, sink: IngestFilesSink) => Promise<IngestFilesResult>;
  runDistill: (opts: { dryRun: boolean; all?: boolean; days?: number; since?: string; model?: string; verbose?: boolean; maxSessions?: number; maxSessionTokens?: number }, sink: DistillCliSink) => Promise<DistillCliResult>;
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
  runReflection: (opts: { window: number; dryRun: boolean; model: string }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
  }>;
  runReflectionRules: (opts: { dryRun: boolean; model: string }) => Promise<{ rulesExtracted: number; rulesStored: number }>;
  runReflectionMeta: (opts: { dryRun: boolean; model: string }) => Promise<{ metaExtracted: number; metaStored: number }>;
  reflectionConfig: { enabled: boolean; defaultWindow: number; minObservations: number; model: string };
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
  }>;
  autoClassifyConfig: { model: string; batchSize: number; suggestCategories?: boolean };
  /** Run memory tier compaction (completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT). */
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  /** Detect top 3 languages from memory text; LLM produces intent-based natural equivalents (triggers, extraction patterns) and writes .language-keywords.json. */
  runBuildLanguageKeywords: (opts: { model?: string; dryRun?: boolean }) => Promise<
    | { ok: true; path: string; topLanguages: string[]; languagesAdded: number }
    | { ok: false; error: string }
  >;
  /** Self-correction: extract incidents from session JSONL using multi-language correction signals from .language-keywords.json. */
  runSelfCorrectionExtract: (opts: { days?: number; outputPath?: string }) => Promise<SelfCorrectionExtractResult>;
  /** Self-correction: analyze extracted incidents and auto-remediate (memory store, TOOLS.md); report to memory/reports. */
  runSelfCorrectionRun: (opts: {
    extractPath?: string;
    incidents?: Array<{ userMessage: string; precedingAssistant: string; followingAssistant: string; timestamp?: string; sessionFile: string }>;
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    noApplyTools?: boolean;
  }) => Promise<SelfCorrectionRunResult>;
  runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; categories: string[]; extractedRule: string; precedingAssistant: string; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number }>;
  runExtractReinforcement: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; agentBehavior: string; recalledMemoryIds: string[]; toolCallSequence: string[]; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number }>;
  /** Export memory to vanilla OpenClaw–compatible MEMORY.md + memory/ directory layout. */
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{ factsExported: number; proceduresExported: number; filesWritten: number; outputPath: string }>;
  /** Optional: used by stats for rich output (credentials, proposals, WAL, last run timestamps, storage sizes). */
  richStatsExtras?: {
    getCredentialsCount: () => number;
    getProposalsPending: () => number;
    getWalPending: () => number;
    getLastRunTimestamps: () => { distill?: string; reflect?: string; compact?: string };
    getStorageSizes: () => { sqliteBytes?: number; lanceBytes?: number };
  };
  /** List/manage proposals and corrections (issue #56). Optional when personaProposals disabled or no workspace. */
  listCommands?: {
    listProposals: (opts: { status?: string }) => Promise<Array<{ id: string; title: string; targetFile: string; status: string; confidence: number; createdAt: number }>>;
    proposalApprove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    proposalReject: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
    listCorrections: (opts: { workspace?: string }) => Promise<{ reportPath: string | null; items: string[] }>;
    correctionsApproveAll: (opts: { workspace?: string }) => Promise<{ applied: number; error?: string }>;
    showItem: (id: string) => Promise<{ type: "fact" | "proposal"; data: unknown } | null>;
  };
};

/** Chainable command type (Commander-style). */
type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: any[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  requiredOption(flags: string, desc?: string, defaultValue?: string): Chainable;
  argument(name: string, desc?: string): Chainable;
  alias?(name: string): Chainable;
};

export function registerHybridMemCli(mem: Chainable, ctx: HybridMemCliContext): void {
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
    runInstall,
    runVerify,
    runDistillWindow,
    runRecordDistill,
    runExtractDaily,
    runExtractProcedures,
    runGenerateAutoSkills,
    runBackfill,
    runIngestFiles,
    runDistill,
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
    runBuildLanguageKeywords,
    runExtractDirectives,
    runExtractReinforcement,
    runExport,
    listCommands,
  } = ctx;

  /** Run an async action and exit when done (avoids hang from open DB/handles when run as standalone CLI).
   * Only force-exits when running as standalone CLI (argv contains 'openclaw'), not when called programmatically from gateway. */
  const withExit = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      const isStandaloneCli = process.argv.some((arg) => arg.includes("openclaw") || arg.includes("hybrid-mem"));
      Promise.resolve(fn(...args)).then(
        () => {
          if (isStandaloneCli) process.exit(process.exitCode ?? 0);
        },
        (err: unknown) => {
          console.error(err);
          if (isStandaloneCli) process.exit(1);
          else throw err; // Propagate error when called programmatically
        },
      );
    };

  mem
    .command("compact")
    .description("Run tier compaction: completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT")
    .action(withExit(async () => {
      const counts = await runCompaction();
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
      } catch {
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
        const categoriesActive = Object.keys(byCategory).filter((c) => (byCategory[c] ?? 0) > 0).length;
        const { getCredentialsCount, getProposalsPending, getWalPending, getLastRunTimestamps, getStorageSizes } = extras;
        const credentialsCount = getCredentialsCount();
        const proposalsPending = getProposalsPending();
        const walPending = getWalPending();
        const lastRun = getLastRunTimestamps();
        const sizes = await getStorageSizes();
        const sqliteMB = sizes.sqliteBytes != null ? (sizes.sqliteBytes / (1024 * 1024)).toFixed(1) : null;
        const lanceMB = sizes.lanceBytes != null ? (sizes.lanceBytes / (1024 * 1024)).toFixed(1) : null;

        console.log(`memory-hybrid ${versionInfo.pluginVersion} (schema ${versionInfo.schemaVersion})\n`);
        console.log("Storage:");
        console.log(` SQLite: ${sqlCount.toLocaleString()} facts${sqliteMB != null ? ` (${sqliteMB} MB)` : ""}`);
        console.log(` LanceDB: ${lanceCount.toLocaleString()} vectors${lanceMB != null ? ` (${lanceMB} MB)` : ""}`);
        if (walPending > 0) console.log(` WAL: ${walPending} pending writes`);
        console.log("");
        console.log("Knowledge:");
        const factsTotal = Object.values(byCategory).reduce((a, b) => a + b, 0);
        console.log(` Facts: ${factsTotal.toLocaleString()}`);
        console.log(` Entities: ${entities.toLocaleString()} distinct`);
        console.log(` Categories: ${categoriesConfigured.length} configured, ${categoriesActive} active`);
        console.log("");
        console.log("Learned Behavior:");
        console.log(` Procedures: ${procedures} (${proceduresValidated} validated, ${proceduresPromoted} promoted)`);
        console.log(` Directives: ${directives}`);
        console.log(` Rules: ${rules}`);
        console.log(` Patterns: ${patterns}`);
        if (metaPatterns > 0) console.log(` Meta-patterns: ${metaPatterns}`);
        console.log("");
        console.log("Graph:");
        console.log(` Links: ${links.toLocaleString()} connections`);
        console.log("");
        console.log("Operational:");
        const vaultEnabled = cfg.credentials?.enabled === true;
        const vaultEncrypted = (cfg.credentials?.encryptionKey?.length ?? 0) >= 16;
        console.log(` Credentials: ${credentialsCount} captured (vault: ${vaultEnabled ? (vaultEncrypted ? "enabled, encrypted" : "enabled, plaintext") : "disabled"})`);
        if (proposalsPending > 0) console.log(` Proposals: ${proposalsPending} pending`);
        if (lastRun.distill) console.log(` Last distill: ${lastRun.distill.trim()}`);
        if (lastRun.reflect) console.log(` Last reflect: ${lastRun.reflect.trim()}`);
        if (lastRun.compact) console.log(` Last compact: ${lastRun.compact.trim()}`);
        console.log("");
        console.log("Decay Distribution:");
        for (const [cls, cnt] of Object.entries(breakdown)) {
          console.log(` ${cls}: ${cnt}`);
        }
        if (expired > 0) console.log(`\nExpired (pending prune): ${expired}`);
      } else {
        console.log(`memory-hybrid ${versionInfo.pluginVersion} (memory-manager ${versionInfo.memoryManagerVersion}, schema ${versionInfo.schemaVersion})`);
        console.log(`SQLite facts:    ${sqlCount}`);
        console.log(`LanceDB vectors: ${lanceCount}`);
        console.log(`Total: ${sqlCount + lanceCount} (with overlap)`);
        console.log(`\nBy decay class:`);
        for (const [cls, cnt] of Object.entries(breakdown)) {
          console.log(`  ${cls.padEnd(12)} ${cnt}`);
        }
        if (expired > 0) console.log(`\nExpired (pending prune): ${expired}`);
      }

      if (efficiency) {
        const tierBreakdown = factsDb.statsBreakdownByTier();
        const sourceBreakdown = factsDb.statsBreakdownBySource();
        const totalTokens = factsDb.estimateStoredTokens();
        const tokensByTier = factsDb.estimateStoredTokensByTier();
        console.log(`\n--- Efficiency ---`);
        console.log(`\nBy tier (hot/warm/cold):`);
        for (const t of ["hot", "warm", "cold"]) {
          const cnt = tierBreakdown[t] ?? 0;
          const tok = tokensByTier[t as keyof typeof tokensByTier] ?? 0;
          console.log(`  ${t.padEnd(6)} ${cnt} facts  ~${tok.toLocaleString()} tokens`);
        }
        console.log(`\nBy source:`);
        const sources = Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1]);
        for (const [src, cnt] of sources) {
          console.log(`  ${src.padEnd(16)} ${cnt}`);
        }
        console.log(`\nEstimated tokens in memory: ~${totalTokens.toLocaleString()}`);
        console.log(`\nToken savings: When auto-recall injects memories, providers can cache them.`);
        console.log(`Cache Read is typically 90%+ cheaper than Input. Compare your provider dashboard`);
        console.log(`(Input vs Cache Read) to see actual savings — many users see 90-97% reduction.`);
      }
    }));

  mem
    .command("prune")
    .description("Remove expired facts and decay aging confidence")
    .option("--hard", "Only hard-delete expired facts")
    .option("--soft", "Only soft-decay confidence")
    .option("--dry-run", "Show what would be pruned without deleting")
    .action(withExit(async (opts: { dryRun?: boolean; hard?: boolean; soft?: boolean }) => {
      if (opts.dryRun) {
        const expired = factsDb.countExpired();
        console.log(`Would prune: ${expired} expired facts`);
        return;
      }
      let hardPruned = 0;
      let softPruned = 0;
      if (opts.hard) {
        hardPruned = factsDb.pruneExpired();
      } else if (opts.soft) {
        softPruned = factsDb.decayConfidence();
      } else {
        hardPruned = factsDb.pruneExpired();
        softPruned = factsDb.decayConfidence();
      }
      console.log(`Hard-pruned: ${hardPruned} expired`);
      console.log(`Soft-pruned: ${softPruned} low-confidence`);
    }));

  mem
    .command("checkpoint")
    .description("Save or restore a pre-flight checkpoint")
    .argument("<action>", "save or restore")
    .option("--intent <text>", "Intent for save")
    .option("--state <text>", "State for save")
    .action(withExit(async (action: string, opts: { intent?: string; state?: string }) => {
      if (action === "save") {
        if (!opts.intent || !opts.state) {
          console.error("--intent and --state required for save");
          return;
        }
        const id = factsDb.saveCheckpoint({
          intent: opts.intent,
          state: opts.state,
        });
        console.log(`Checkpoint saved: ${id}`);
      } else if (action === "restore") {
        const cp = factsDb.restoreCheckpoint();
        if (!cp) {
          console.log("No active checkpoint.");
          return;
        }
        console.log(JSON.stringify(cp, null, 2));
      } else {
        console.error("Usage: checkpoint <save|restore>");
      }
    }));

  mem
    .command("backfill-decay")
    .description("Re-classify existing facts with auto-detected decay classes")
    .action(withExit(async () => {
      const counts = factsDb.backfillDecayClasses();
      if (Object.keys(counts).length === 0) {
        console.log("All facts already properly classified.");
      } else {
        console.log("Reclassified:");
        for (const [cls, cnt] of Object.entries(counts)) {
          console.log(`  ${cls}: ${cnt}`);
        }
      }
    }));

  mem
    .command("search")
    .description("Search memories across both backends")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", "5")
    .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
    .option("--as-of <date>", "Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
    .option("--include-superseded", "Include superseded (historical) facts")
    .option("--user-id <id>", "Include user-private memories for this user")
    .option("--agent-id <id>", "Include agent-specific memories for this agent")
    .option("--session-id <id>", "Include session-scoped memories for this session")
    .action(withExit(async (query: string, opts: { limit?: string; tag?: string; asOf?: string; includeSuperseded?: boolean; userId?: string; agentId?: string; sessionId?: string }) => {
      const limit = parseInt(opts.limit || "5");
      const tag = opts.tag?.trim();
      const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseDate(opts.asOf) : undefined;
      const scopeFilter: ScopeFilter | undefined =
        opts.userId || opts.agentId || opts.sessionId
          ? { userId: opts.userId ?? null, agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null }
          : undefined;
      const searchOpts = {
        tag,
        includeSuperseded: opts.includeSuperseded === true,
        scopeFilter,
        reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
        ...(asOfSec != null ? { asOf: asOfSec } : {}),
      };
      const sqlResults = factsDb.search(query, limit, searchOpts);
      let lanceResults: SearchResult[] = [];
      if (!tag) {
        try {
          const vector = await embeddings.embed(query);
          lanceResults = await vectorDb.search(vector, limit * 3, 0.3);
          lanceResults = filterByScope(lanceResults, (id, o) => factsDb.getById(id, o), scopeFilter);
        } catch (err) {
          console.warn(`memory-hybrid: vector search failed: ${err}`);
        }
      }
      const merged = merge(sqlResults, lanceResults, limit, factsDb);

      const output = merged.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        category: r.entry.category,
        entity: r.entry.entity,
        score: r.score,
        backend: r.backend,
        tags: r.entry.tags?.length ? r.entry.tags : undefined,
        sourceDate: r.entry.sourceDate
          ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
          : undefined,
      }));
      console.log(JSON.stringify(output, null, 2));
    }));

  mem
    .command("lookup")
    .description("Exact entity lookup in SQLite")
    .argument("<entity>", "Entity name")
    .option("--key <key>", "Optional key filter")
    .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
    .option("--as-of <date>", "Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
    .option("--include-superseded", "Include superseded (historical) facts")
    .action(withExit(async (entity: string, opts: { key?: string; tag?: string; asOf?: string; includeSuperseded?: boolean }) => {
      const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseDate(opts.asOf) : undefined;
      const lookupOpts = { includeSuperseded: opts.includeSuperseded === true, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
      const results = factsDb.lookup(entity, opts.key, opts.tag?.trim(), lookupOpts);
      const output = results.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        entity: r.entry.entity,
        key: r.entry.key,
        value: r.entry.value,
        tags: r.entry.tags?.length ? r.entry.tags : undefined,
        sourceDate: r.entry.sourceDate
          ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
          : undefined,
      }));
      console.log(JSON.stringify(output, null, 2));
    }));

  mem
    .command("categories")
    .description("List all configured memory categories")
    .action(withExit(async () => {
      const cats = getMemoryCategories();
      console.log(`Memory categories (${cats.length}):`);
      for (const cat of cats) {
        const count = factsDb.getByCategory(cat).length;
        console.log(`  ${cat}: ${count} facts`);
      }
    }));

  // ---------- List / show / proposals / corrections (issue #56) ----------
  mem
    .command("list <type>")
    .description("List items by type: patterns, rules, directives, procedures, proposals, or corrections")
    .option("--limit <n>", "Max items to show", "50")
    .option("--status <status>", "For proposals: pending|approved|rejected|applied. For corrections: pending|applied")
    .action(withExit(async (type: string, opts?: { limit?: string; status?: string }) => {
      const limit = Math.min(500, Math.max(1, parseInt(opts?.limit ?? "50", 10) || 50));
      const t = (type ?? "").toLowerCase();
      if (t === "patterns") {
        const items = factsDb.listFactsByCategory("pattern", limit);
        console.log(`Patterns (${items.length}):`);
        items.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${(e.text || "").slice(0, 80)}${(e.text?.length ?? 0) > 80 ? "..." : ""}`));
        return;
      }
      if (t === "rules") {
        const items = factsDb.listFactsByCategory("rule", limit);
        console.log(`Rules (${items.length}):`);
        items.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${(e.text || "").slice(0, 80)}${(e.text?.length ?? 0) > 80 ? "..." : ""}`));
        return;
      }
      if (t === "directives") {
        const items = factsDb.listDirectives(limit);
        console.log(`Directives (${items.length}):`);
        items.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${(e.text || "").slice(0, 80)}${(e.text?.length ?? 0) > 80 ? "..." : ""}`));
        return;
      }
      if (t === "procedures") {
        const items = factsDb.listProcedures(limit);
        console.log(`Procedures (${items.length}):`);
        items.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${e.procedureType} — ${(e.taskPattern || "").slice(0, 60)}${(e.taskPattern?.length ?? 0) > 60 ? "..." : ""}`));
        return;
      }
      if (t === "proposals") {
        if (!listCommands) {
          console.error("Proposals feature is not enabled. Enable persona proposals or self-correction to use this command.");
          process.exitCode = 1;
          return;
        }
        const items = await listCommands.listProposals({ status: opts?.status });
        console.log(`Proposals (${items.length}):`);
        items.forEach((p) => console.log(`  ${p.id}  ${p.status}  ${p.title}  → ${p.targetFile} (conf: ${p.confidence})`));
        return;
      }
      if (t === "corrections") {
        if (!listCommands) {
          console.error("Corrections feature is not enabled. Enable self-correction to use this command.");
          process.exitCode = 1;
          return;
        }
        const { reportPath, items } = await listCommands.listCorrections({});
        if (!reportPath) {
          console.log("No self-correction report found. Run: openclaw hybrid-mem self-correction-run");
          return;
        }
        console.log(`Corrections (from ${reportPath}, ${items.length} proposed):`);
        items.forEach((line, i) => console.log(`  ${i + 1}. ${line.slice(0, 100)}${line.length > 100 ? "..." : ""}`));
        return;
      }
      console.error(`Unknown type: ${type}. Use: patterns, rules, directives, procedures, proposals, or corrections.`);
      process.exitCode = 1;
    }));

  mem
    .command("show <id>")
    .description("Show details of a fact or proposal by ID")
    .action(withExit(async (id: string) => {
      if (!id?.trim()) {
        console.error("Usage: show <id>");
        process.exitCode = 1;
        return;
      }
      const fact = factsDb.getById(id.trim());
      if (fact) {
        console.log("Type: fact");
        console.log(JSON.stringify({ id: fact.id, text: fact.text, category: fact.category, entity: fact.entity, key: fact.key, source: fact.source, created_at: fact.createdAt }, null, 2));
        return;
      }
      if (listCommands) {
        const result = await listCommands.showItem(id.trim());
        if (result?.type === "proposal") {
          console.log("Type: proposal");
          console.log(JSON.stringify(result.data, null, 2));
          return;
        }
      }
      const proc = factsDb.getProcedureById(id.trim());
      if (proc) {
        console.log("Type: procedure");
        console.log(JSON.stringify({ id: proc.id, taskPattern: proc.taskPattern, procedureType: proc.procedureType, successCount: proc.successCount, confidence: proc.confidence }, null, 2));
        return;
      }
      console.error(`Not found: ${id}`);
      process.exitCode = 1;
    }));

  const proposalsCmd = mem
    .command("proposals")
    .description("Manage persona proposals (list, approve, reject)");
  proposalsCmd
    .command("list")
    .description("List persona proposals")
    .option("--status <s>", "pending|approved|rejected|applied")
    .action(withExit(async (opts?: { status?: string }) => {
      if (!listCommands) {
        console.error("Persona proposals not enabled or not available.");
        process.exitCode = 1;
        return;
      }
      const items = await listCommands.listProposals({ status: opts?.status });
      if (items.length === 0) console.log("No proposals.");
      else items.forEach((p) => console.log(`${p.id}  ${p.status}  ${p.title}  → ${p.targetFile}`));
    }));
  proposalsCmd
    .command("approve <id>")
    .description("Approve a persona proposal")
    .action(withExit(async (id: string) => {
      if (!listCommands) {
        console.error("Persona proposals not enabled or not available.");
        process.exitCode = 1;
        return;
      }
      const r = await listCommands.proposalApprove(id?.trim() ?? "");
      if (!r.ok) {
        console.error(r.error ?? "Approve failed");
        process.exitCode = 1;
        return;
      }
      console.log(`Proposal ${id} approved. Use 'openclaw proposals apply ${id}' to apply to file.`);
    }));
  proposalsCmd
    .command("reject <id>")
    .description("Reject a persona proposal")
    .option("--reason <text>", "Optional reason")
    .action(withExit(async (id: string, opts?: { reason?: string }) => {
      if (!listCommands) {
        console.error("Persona proposals not enabled or not available.");
        process.exitCode = 1;
        return;
      }
      const r = await listCommands.proposalReject(id?.trim() ?? "", opts?.reason);
      if (!r.ok) {
        console.error(r.error ?? "Reject failed");
        process.exitCode = 1;
        return;
      }
      console.log(`Proposal ${id} rejected.`);
    }));

  const correctionsCmd = mem
    .command("corrections")
    .description("Self-correction proposals from last report (list, approve --all)");
  correctionsCmd
    .command("list")
    .description("List proposed corrections from latest self-correction report")
    .option("--workspace <path>", "Workspace root")
    .action(withExit(async (opts?: { workspace?: string }) => {
      if (!listCommands) {
        console.error("List corrections not available.");
        process.exitCode = 1;
        return;
      }
      const { reportPath, items } = await listCommands.listCorrections({ workspace: opts?.workspace });
      if (!reportPath) {
        console.log("No self-correction report found. Run: openclaw hybrid-mem self-correction-run");
        return;
      }
      console.log(`Report: ${reportPath}`);
      if (items.length === 0) console.log("No proposed corrections.");
      else items.forEach((line, i) => console.log(`  ${i + 1}. ${line.slice(0, 120)}${line.length > 120 ? "..." : ""}`));
    }));
  correctionsCmd
    .command("approve")
    .description("Apply all proposed TOOLS rules from latest report")
    .option("--all", "Apply all (required)")
    .option("--workspace <path>", "Workspace root")
    .action(withExit(async (opts?: { all?: boolean; workspace?: string }) => {
      if (!opts?.all) {
        console.error("Use --all to apply all proposed corrections from the latest report.");
        process.exitCode = 1;
        return;
      }
      if (!listCommands) {
        console.error("Corrections approve not available.");
        process.exitCode = 1;
        return;
      }
      const r = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
      if (r.error) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Applied ${r.applied} rule(s) to TOOLS.md.`);
    }));

  mem
    .command("review")
    .description("Interactive review: step through pending proposals and corrections (a=approve, r=reject, s=skip)")
    .option("--workspace <path>", "Workspace root for corrections report")
    .action(withExit(async (opts?: { workspace?: string }) => {
      // Check if running in non-interactive environment
      if (!process.stdin.isTTY) {
        console.error("Error: 'review' command requires an interactive terminal (TTY).");
        console.error("Use individual commands instead: 'proposals approve <id>', 'corrections approve --all', etc.");
        process.exitCode = 1;
        return;
      }
      if (!listCommands) {
        console.error("Review not available (proposals/corrections not enabled).");
        process.exitCode = 1;
        return;
      }
      const proposals = await listCommands.listProposals({ status: "pending" });
      const { items: correctionItems, reportPath } = await listCommands.listCorrections({ workspace: opts?.workspace });
      const total = proposals.length + (correctionItems.length > 0 ? 1 : 0);
      if (total === 0) {
        console.log("No pending items to review.");
        return;
      }
      console.log(`Pending: ${proposals.length} proposal(s), ${correctionItems.length > 0 ? "1 correction report" : "0"}.`);
      for (const p of proposals) {
        console.log("\n--- Proposal ---");
        console.log(`ID: ${p.id}  Title: ${p.title}  Target: ${p.targetFile}`);
        console.log(`  [a]pprove  [r]eject  [s]kip`);
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("> ", (line) => { rl.close(); resolve((line ?? "").trim().toLowerCase()); }));
        if (answer === "a") await listCommands.proposalApprove(p.id);
        else if (answer === "r") await listCommands.proposalReject(p.id);
      }
      if (correctionItems.length > 0) {
        console.log("\n--- Corrections (from report) ---");
        console.log(`${correctionItems.length} proposed rule(s). [a]pprove all  [s]kip`);
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("> ", (line) => { rl.close(); resolve((line ?? "").trim().toLowerCase()); }));
        if (answer === "a") {
          const r = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
          console.log(r.error ?? `Applied ${r.applied} rule(s).`);
        }
      }
      console.log("Done.");
    }));

  mem
    .command("store")
    .description("Store a fact (for scripts; agents use memory_store tool)")
    .requiredOption("--text <text>", "Fact text")
    .option("--category <cat>", "Category", "other")
    .option("--entity <entity>", "Entity name")
    .option("--key <key>", "Structured key")
    .option("--value <value>", "Structured value")
    .option("--source-date <date>", "When fact originated (ISO-8601, e.g. 2026-01-15)")
    .option("--tags <tags>", "Comma-separated topic tags (e.g. nibe,zigbee); auto-inferred if omitted")
    .option("--supersedes <id>", "Fact id this store supersedes (replaces)")
    .option("--scope <scope>", "Memory scope (global, user, agent, session). Default global.")
    .option("--scope-target <target>", "Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.")
    .action(withExit(async (opts: { text: string; category?: string; entity?: string; key?: string; value?: string; sourceDate?: string; tags?: string; supersedes?: string; scope?: string; scopeTarget?: string }) => {
      const text = opts.text;
      if (!text || text.length < 2) {
        console.error("--text is required and must be at least 2 characters");
        process.exitCode = 1;
        return;
      }
      const scope = opts.scope as "global" | "user" | "agent" | "session" | undefined;
      if (scope && scope !== "global" && !opts.scopeTarget?.trim()) {
        console.error(`Scope "${scope}" requires --scope-target (userId, agentId, or sessionId).`);
        process.exitCode = 1;
        return;
      }
      const result = await runStore({
        text,
        category: opts.category,
        entity: opts.entity,
        key: opts.key,
        value: opts.value,
        sourceDate: opts.sourceDate,
        tags: opts.tags,
        supersedes: opts.supersedes?.trim() || undefined,
        scope,
        scopeTarget: opts.scopeTarget?.trim(),
      });
      switch (result.outcome) {
        case "duplicate":
          console.log("Similar memory already exists.");
          break;
        case "credential":
          console.log(`Credential stored in vault for ${result.service} (${result.type}). Pointer [id: ${result.id}].`);
          break;
        case "credential_parse_error":
          console.error(
            "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
          );
          process.exitCode = 1;
          break;
        case "noop":
          console.log(`Already known: ${result.reason}`);
          break;
        case "retracted":
          console.log(`Retracted fact ${result.targetId}: ${result.reason}`);
          break;
        case "updated":
          console.log(`Updated: superseded ${result.supersededId} with ${result.id}. ${result.reason}`);
          break;
        case "stored":
          console.log(
            "supersededId" in result && result.supersededId
              ? `Stored (supersedes ${result.supersededId}): "${result.textPreview}" [id: ${result.id}]`
              : `Stored: "${result.textPreview}" [id: ${result.id}]`,
          );
          break;
      }
    }));

  mem
    .command("install")
    .description("Apply full recommended config, prompts, and optional jobs (idempotent). Run after first plugin setup for best defaults.")
    .option("--dry-run", "Print what would be merged without writing")
    .action(withExit(async (opts: { dryRun?: boolean }) => {
      const result = await runInstall({ dryRun: !!opts.dryRun });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (result.dryRun) {
        console.log("Would merge into " + result.configPath + ":");
        console.log(result.configJson ?? "");
        return;
      }
      console.log("Config written: " + result.configPath);
      console.log(`Applied: plugins.slots.memory=${result.pluginId}, ${result.pluginId} config (all features), memorySearch, compaction prompts, bootstrap limits, autoClassify. Add cron jobs via 'openclaw cron add' if needed (see docs/SESSION-DISTILLATION.md).`);
      console.log("\nNext steps:");
      console.log(`  1. Set embedding.apiKey in plugins.entries["${result.pluginId}"].config (or use env:OPENAI_API_KEY in config).`);
      console.log("  2. Restart the gateway: openclaw gateway stop && openclaw gateway start");
      console.log("  3. Run: openclaw hybrid-mem verify [--fix]");
    }));

  mem
    .command("verify")
    .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
    .option("--fix", "Print or apply default config for missing items")
    .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
    .action(withExit(async (opts: { fix?: boolean; logFile?: string }) => {
      await runVerify(
        { fix: !!opts.fix, logFile: opts.logFile },
        { log: (s) => console.log(s), error: (s) => console.error(s) },
      );
    }));

  (() => {
    const cmd = mem.command("config-mode <preset>");
    if (cmd.alias) cmd.alias("set-mode");
    return cmd;
  })()
    .description("Set configuration preset (essential | normal | expert | full). Writes to openclaw.json. Restart gateway after.")
    .action(withExit(async (preset: string) => {
      const result = await runConfigMode(preset);
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(result.message);
    }));

  mem
    .command("help config-set <key>")
    .description("Show current value and a short description for a config key (e.g. autoCapture, credentials.enabled).")
    .action(withExit(async (key: string) => {
      const result = await runConfigSetHelp(key);
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(result.message);
    }));

  mem
    .command("config-set <key> [value]")
    .description("Set a plugin config key (use true/false for booleans). Omit value to show current value and description. Writes to openclaw.json. Restart gateway after.")
    .action(withExit(async (key: string, value?: string) => {
      if (value === undefined || value === "") {
        const result = await runConfigSetHelp(key);
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        console.log(result.message);
        return;
      }
      const result = await runConfigSet(key, value);
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(result.message);
    }));

  mem
    .command("distill")
    .description("Index session JSONL into memory (extract facts via LLM, dedup, store). Use distill-window for date range info.")
    .option("--dry-run", "Show what would be processed without storing")
    .option("--all", "Process all sessions (last 90 days)")
    .option("--days <n>", "Process sessions from last N days (default: 3)", "3")
    .option("--since <date>", "Process sessions since date (YYYY-MM-DD)")
    .option("--model <model>", "LLM for extraction (recommended: gemini-3-pro-preview for 1M context). Default: config.distill.defaultModel or gemini-3-pro-preview", "gemini-3-pro-preview")
    .option("--verbose", "Log each fact as it is stored")
    .option("--max-sessions <n>", "Limit sessions to process (for cost control)", "0")
    .option("--max-session-tokens <n>", "Max tokens per session chunk; oversized sessions are split into overlapping chunks (default: batch limit)", "0")
    .action(withExit(async (opts: { dryRun?: boolean; all?: boolean; days?: string; since?: string; model?: string; verbose?: boolean; maxSessions?: string; maxSessionTokens?: string }) => {
      const sink = { log: (s: string) => console.log(s), warn: (s: string) => console.warn(s) };
      const maxSessions = Math.max(0, parseInt(opts.maxSessions || "0") || 0);
      const maxSessionTokens = Math.max(0, parseInt(opts.maxSessionTokens || "0") || 0);
      const result = await runDistill(
        {
          dryRun: !!opts.dryRun,
          all: !!opts.all,
          days: opts.days ? parseInt(opts.days) : undefined,
          since: opts.since?.trim() || undefined,
          model: opts.model,
          verbose: !!opts.verbose,
          maxSessions: maxSessions > 0 ? maxSessions : undefined,
          maxSessionTokens: maxSessionTokens > 0 ? maxSessionTokens : undefined,
        },
        sink,
      );
      if (result.dryRun) {
        console.log(`\nWould extract ${result.factsExtracted} facts from ${result.sessionsScanned} sessions.`);
      } else {
        console.log(
          `\nDistill done: ${result.stored} stored, ${result.skipped} skipped (${result.factsExtracted} extracted from ${result.sessionsScanned} sessions).`,
        );
      }
    }));

  mem
    .command("distill-window")
    .description("Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process; end the job with record-distill.")
    .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
    .action(withExit(async (opts: { json?: boolean }) => {
      const result = await runDistillWindow({ json: !!opts.json });
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(`Distill window: ${result.mode}`);
      console.log(`  startDate: ${result.startDate}`);
      console.log(`  endDate: ${result.endDate}`);
      console.log(`  mtimeDays: ${result.mtimeDays} (use find ... -mtime -${result.mtimeDays} for session files)`);
      console.log("Process sessions from that window; then run: openclaw hybrid-mem record-distill");
    }));

  mem
    .command("record-distill")
    .description("Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)")
    .action(withExit(async () => {
      const result = await runRecordDistill();
      console.log(`Recorded distillation run: ${result.timestamp}`);
      console.log(`Written to ${result.path}. Run 'openclaw hybrid-mem verify' to see it.`);
    }));

  mem
    .command("extract-daily")
    .description("Extract structured facts from daily memory files")
    .option("--days <n>", "How many days back to scan", "7")
    .option("--dry-run", "Show extractions without storing")
    .action(withExit(async (opts: { days: string; dryRun?: boolean }) => {
      const daysBack = parseInt(opts.days);
      const result = await runExtractDaily(
        { days: daysBack, dryRun: !!opts.dryRun },
        { log: (s) => console.log(s), warn: (s) => console.warn(s) },
      );
      if (result.dryRun) {
        console.log(`\nWould extract: ${result.totalExtracted} facts from last ${result.daysBack} days`);
      } else {
        console.log(
          `\nExtracted ${result.totalStored} new facts (${result.totalExtracted} candidates, ${
            result.totalExtracted - result.totalStored
          } duplicates skipped)`,
        );
      }
    }));

  mem
    .command("extract-procedures")
    .description("Procedural memory: extract tool-call sequences from session JSONL and store as procedures")
    .option("--dir <path>", "Session directory (default: config procedures.sessionsDir)")
    .option("--days <n>", "Only sessions modified in last N days (default: all in dir)", "")
    .option("--dry-run", "Show what would be stored without writing")
    .action(withExit(async (opts: { dir?: string; days?: string; dryRun?: boolean }) => {
      const days = opts.days ? parseInt(opts.days, 10) : undefined;
      const result = await runExtractProcedures({
        sessionDir: opts.dir,
        days: Number.isFinite(days) ? days : undefined,
        dryRun: !!opts.dryRun,
      });
      if (result.dryRun) {
        console.log(`\n[dry-run] Sessions scanned: ${result.sessionsScanned}, procedures that would be stored: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`);
      } else {
        console.log(
          `\nSessions scanned: ${result.sessionsScanned}; procedures stored/updated: ${result.proceduresStored} (${result.positiveCount} positive, ${result.negativeCount} negative)`,
        );
      }
    }));

  mem
    .command("generate-auto-skills")
    .description("Generate SKILL.md + recipe.json in skills/auto/ for procedures validated enough times")
    .option("--dry-run", "Show what would be generated without writing")
    .action(withExit(async (opts: { dryRun?: boolean }) => {
      const result = await runGenerateAutoSkills({ dryRun: !!opts.dryRun });
      if (result.dryRun) {
        console.log(`\n[dry-run] Would generate ${result.generated} auto-skills`);
      } else {
        console.log(`\nGenerated ${result.generated} auto-skills${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`);
        for (const p of result.paths) console.log(`  ${p}`);
      }
    }));

  mem
    .command("extract-directives")
    .description("Extract directive incidents from session JSONL (10 categories)")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each directive as it is detected")
    .option("--dry-run", "Show what would be extracted without storing")
    .action(withExit(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days || "3", 10);
      const result = await runExtractDirectives({ days, verbose: opts.verbose, dryRun: opts.dryRun });
      console.log(`\nSessions scanned: ${result.sessionsScanned}; directives found: ${result.incidents.length}`);
      if (opts.dryRun) {
        console.log(`[dry-run] Would store ${result.incidents.length} directives as facts.`);
      } else {
        console.log(`Stored ${result.incidents.length} directives as facts.`);
      }
    }));

  mem
    .command("extract-reinforcement")
    .description("Extract reinforcement incidents from session JSONL and annotate facts/procedures")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each reinforcement as it is detected")
    .option("--dry-run", "Show what would be annotated without storing")
    .action(withExit(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days || "3", 10);
      const result = await runExtractReinforcement({ days, verbose: opts.verbose, dryRun: opts.dryRun });
      console.log(`\nSessions scanned: ${result.sessionsScanned}; reinforcement incidents found: ${result.incidents.length}`);
      if (opts.dryRun) {
        console.log(`[dry-run] Would annotate facts/procedures with reinforcement data.`);
      } else {
        const factsReinforced = result.incidents.reduce((sum, i) => sum + i.recalledMemoryIds.length, 0);
        console.log(`Annotated ${factsReinforced} facts with reinforcement data.`);
      }
    }));

  mem
    .command("backfill")
    .description("Index MEMORY.md and memory/**/*.md into SQLite + LanceDB (fast bulk import)")
    .option("--dry-run", "Show what would be indexed without storing")
    .option("--workspace <path>", "Workspace root (default: OPENCLAW_WORKSPACE or ~/.openclaw/workspace)")
    .option("--limit <n>", "Max facts to store (0 = no limit)", "0")
    .action(withExit(async (opts: { dryRun?: boolean; workspace?: string; limit?: string }) => {
      const sink = { log: (s: string) => console.log(s), warn: (s: string) => console.warn(s) };
      const limit = Math.max(0, parseInt(opts.limit || "0") || 0);
      const result = await runBackfill(
        { dryRun: !!opts.dryRun, workspace: opts.workspace?.trim() || undefined, limit: limit > 0 ? limit : undefined },
        sink,
      );
      if (result.dryRun) {
        console.log(`\nWould index ${result.candidates} facts from ${result.files} files`);
      } else {
        console.log(
          `\nBackfill done: ${result.stored} new facts stored, ${result.skipped} duplicates skipped (${result.candidates} candidates from ${result.files} files)`,
        );
      }
    }));

  mem
    .command("ingest-files")
    .description("Index workspace markdown (skills, TOOLS.md, etc.) as facts via LLM extraction")
    .option("--dry-run", "Show what would be processed without storing")
    .option("--workspace <path>", "Workspace root (default: OPENCLAW_WORKSPACE or cwd)")
    .option("--paths <globs>", "Comma-separated globs (default: config ingest.paths or skills/**/*.md,TOOLS.md,AGENTS.md)")
    .action(withExit(async (opts: { dryRun?: boolean; workspace?: string; paths?: string }) => {
      const sink = { log: (s: string) => console.log(s), warn: (s: string) => console.warn(s) };
      const paths = opts.paths?.split(",").map((p) => p.trim()).filter(Boolean);
      const result = await runIngestFiles(
        { dryRun: !!opts.dryRun, workspace: opts.workspace?.trim() || undefined, paths: paths?.length ? paths : undefined },
        sink,
      );
      if (result.dryRun) {
        console.log(`\nWould extract ~${result.extracted} facts from ${result.files} files`);
      } else {
        console.log(
          `\nIngest done: ${result.stored} stored, ${result.skipped} skipped (${result.extracted} extracted from ${result.files} files)`,
        );
      }
    }));

  mem
    .command("export")
    .description("Export memory to vanilla OpenClaw–compatible MEMORY.md + memory/**/*.md layout. Plain markdown, one file per fact.")
    .requiredOption("--output <path>", "Output directory (created if missing)")
    .option("--include-credentials", "Include credential pointer facts (default: exclude)")
    .option("--source <sources>", "Filter by fact source: comma-separated (e.g. conversation,cli,distillation,ingest,reflection). Omit for all.")
    .option("--mode <mode>", "replace = clear output first; additive = add/overwrite (default: replace)", "replace")
    .action(withExit(async (opts: { output: string; includeCredentials?: boolean; source?: string; mode?: string }) => {
      const outputPath = opts.output.trim();
      const sources = opts.source ? opts.source.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const mode = opts.mode === "additive" ? "additive" : "replace";
      if (!runExport) {
        console.error("Export not available.");
        process.exitCode = 1;
        return;
      }
      const result = await runExport({
        outputPath,
        excludeCredentials: !opts.includeCredentials,
        includeCredentials: !!opts.includeCredentials,
        sources,
        mode,
      });
      console.log(
        `Export done: ${result.factsExported} facts, ${result.proceduresExported} procedures → ${result.filesWritten} files in ${result.outputPath}`,
      );
    }));

  mem
    .command("find-duplicates")
    .description("Report pairs of facts with embedding similarity ≥ threshold (2.2); no merge")
    .option("--threshold <n>", "Similarity threshold 0–1 (default 0.92)", "0.92")
    .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
    .option("--limit <n>", "Max facts to consider (default 300)", "300")
    .action(withExit(async (opts: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
      const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.92")));
      const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
      const result = await runFindDuplicates({
        threshold,
        includeStructured: !!opts.includeStructured,
        limit,
      });
      console.log(`Candidates: ${result.candidatesCount} (skipped identifier-like: ${result.skippedStructured})`);
      console.log(`Pairs with similarity ≥ ${threshold}: ${result.pairs.length}`);
      const trim = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + "…");
      for (const p of result.pairs) {
        console.log(`  ${p.idA} <-> ${p.idB} (${p.score.toFixed(3)})`);
        console.log(`    A: ${trim(p.textA, 80)}`);
        console.log(`    B: ${trim(p.textB, 80)}`);
      }
    }));

  mem
    .command("consolidate")
    .description("Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster (2.4)")
    .option("--threshold <n>", "Cosine similarity threshold 0–1 (default 0.96; higher = fewer merges)", "0.96")
    .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
    .option("--dry-run", "Report clusters and would-merge only; do not store or delete")
    .option("--limit <n>", "Max facts to consider (default 300)", "300")
    .option("--model <model>", "LLM for merge (default gpt-4o-mini)", "gpt-4o-mini")
    .action(withExit(async (opts: { threshold?: string; includeStructured?: boolean; dryRun?: boolean; limit?: string; model?: string }) => {
      const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.96")));
      const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
      const result = await runConsolidate({
        threshold,
        includeStructured: !!opts.includeStructured,
        dryRun: !!opts.dryRun,
        limit,
        model: opts.model || "gpt-4o-mini",
      });
      console.log(`Clusters found: ${result.clustersFound}`);
      console.log(`Merged: ${result.merged}`);
      console.log(`Deleted: ${result.deleted}${opts.dryRun ? " (dry run)" : ""}`);
    }));

  mem
    .command("reflect")
    .description("Analyze recent facts, extract behavioral patterns, store as pattern-category facts")
    .option("--window <days>", "Time window in days (default: config or 14)")
    .option("--dry-run", "Show extracted patterns without storing")
    .option("--model <model>", "LLM for reflection (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(withExit(async (opts: { window?: string; dryRun?: boolean; model?: string; force?: boolean }) => {
      if (!opts.force && !reflectionConfig.enabled) {
        console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
        return;
      }
      const window = Math.min(90, Math.max(1, parseInt(opts.window || String(reflectionConfig.defaultWindow)) || 14));
      const result = await runReflection({
        window,
        dryRun: !!opts.dryRun,
        model: opts.model || reflectionConfig.model,
      });
      console.log(`Facts analyzed: ${result.factsAnalyzed}`);
      console.log(`Patterns extracted: ${result.patternsExtracted}`);
      console.log(`Patterns stored: ${result.patternsStored}${opts.dryRun ? " (dry run)" : ""}`);
      console.log(`Window: ${result.window} days`);
    }));

  mem
    .command("reflect-rules")
    .description("Synthesize patterns into actionable one-line rules (category rule)")
    .option("--dry-run", "Show extracted rules without storing")
    .option("--model <model>", "LLM (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(withExit(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
      if (!opts.force && !reflectionConfig.enabled) {
        console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
        return;
      }
      const result = await runReflectionRules({
        dryRun: !!opts.dryRun,
        model: opts.model || reflectionConfig.model,
      });
      console.log(`Rules extracted: ${result.rulesExtracted}`);
      console.log(`Rules stored: ${result.rulesStored}${opts.dryRun ? " (dry run)" : ""}`);
    }));

  mem
    .command("reflect-meta")
    .description("Synthesize patterns into 1-3 higher-level meta-patterns")
    .option("--dry-run", "Show extracted meta-patterns without storing")
    .option("--model <model>", "LLM (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(withExit(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
      if (!opts.force && !reflectionConfig.enabled) {
        console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
        return;
      }
      const result = await runReflectionMeta({
        dryRun: !!opts.dryRun,
        model: opts.model || reflectionConfig.model,
      });
      console.log(`Meta-patterns extracted: ${result.metaExtracted}`);
      console.log(`Meta-patterns stored: ${result.metaStored}${opts.dryRun ? " (dry run)" : ""}`);
    }));

  mem
    .command("classify")
    .description("Auto-classify 'other' facts using LLM (uses autoClassify config). Runs category discovery first when enabled.")
    .option("--dry-run", "Show classifications without applying")
    .option("--limit <n>", "Max facts to classify", "500")
    .option("--model <model>", "Override LLM model")
    .action(withExit(async (opts: { dryRun?: boolean; limit?: string; model?: string }) => {
      const limit = Math.min(2000, Math.max(1, parseInt(opts.limit || "500")));
      const logger = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
      console.log(`Auto-classify config:`);
      console.log(`  Model: ${opts.model || autoClassifyConfig.model}`);
      console.log(`  Batch size: ${autoClassifyConfig.batchSize}`);
      console.log(`  Suggest categories: ${autoClassifyConfig.suggestCategories !== false}`);
      console.log(`  Categories: ${getMemoryCategories().join(", ")}`);
      console.log(`  Limit: ${limit}`);
      console.log(`  Dry run: ${!!opts.dryRun}\n`);

      const result = await runClassify({
        dryRun: !!opts.dryRun,
        limit,
        model: opts.model,
      });

      if (result.total === 0) {
        console.log("No 'other' facts to classify.");
        return;
      }

      console.log(`\n\nResult: ${result.reclassified}/${result.total} reclassified${opts.dryRun ? " (dry run)" : ""}`);
      if (result.breakdown) {
        console.log("\nUpdated category breakdown:");
        for (const [cat, count] of Object.entries(result.breakdown)) {
          console.log(`  ${cat}: ${count}`);
        }
      }
    }));

  mem
    .command("build-languages")
    .description("Detect top 3 languages from memory text; use English as intent template and generate natural triggers, structural phrases, and extraction patterns per language (not literal translation). Writes .language-keywords.json (v2). Run once or when you add new languages.")
    .option("--dry-run", "Detect and translate but do not write file")
    .option("--model <model>", "LLM model for detection and translation", "gpt-4o-mini")
    .action(withExit(async (opts: { dryRun?: boolean; model?: string }) => {
      const result = await runBuildLanguageKeywords({
        model: opts.model || autoClassifyConfig.model,
        dryRun: !!opts.dryRun,
      });
      if (!result.ok) {
        console.error("build-languages failed:", result.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Detected languages: ${result.topLanguages.join(", ")}`);
      console.log(`Languages added (translations): ${result.languagesAdded}`);
      console.log(`Path: ${result.path}${opts.dryRun ? " (dry run, not written)" : ""}`);
    }));

  mem
    .command("self-correction-extract")
    .description("Extract user correction incidents from session JSONL (last N days). Uses .language-keywords.json — run build-languages first for non-English. Output JSON to file or stdout.")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--output <path>", "Write incidents JSON to file (optional)")
    .action(withExit(async (opts: { days?: string; output?: string }) => {
      const days = opts.days ? parseInt(opts.days, 10) : 3;
      const result = await runSelfCorrectionExtract({
        days: Number.isFinite(days) ? days : 3,
        outputPath: opts.output?.trim() || undefined,
      });
      console.log(`Sessions scanned: ${result.sessionsScanned}; incidents: ${result.incidents.length}`);
      if (result.incidents.length > 0 && !opts.output) {
        console.log(JSON.stringify(result.incidents, null, 2));
      }
    }));

  mem
    .command("self-correction-run")
    .description("Analyze incidents, auto-remediate (memory + TOOLS section or rewrite). TOOLS rules applied by default; use --no-apply-tools to only suggest.")
    .option("--extract <path>", "Path to incidents JSON from self-correction-extract --output (else runs extract in memory)")
    .option("--workspace <path>", "Workspace root for TOOLS.md and memory/reports (default: OPENCLAW_WORKSPACE or ~/.openclaw/workspace)")
    .option("--dry-run", "Analyze and report only; do not store or append")
    .option("--approve", "Force apply suggested TOOLS rules (when config applyToolsByDefault is false)")
    .option("--no-apply-tools", "Do not apply TOOLS rules this run (only suggest in report). Opt-out from default apply.")
    .option("--model <model>", "LLM for analysis (default: config.distill.defaultModel or gemini-3-pro-preview)", "gemini-3-pro-preview")
    .action(withExit(async (opts: { extract?: string; workspace?: string; dryRun?: boolean; approve?: boolean; applyTools?: boolean; model?: string }) => {
      const result = await runSelfCorrectionRun({
        extractPath: opts.extract?.trim(),
        workspace: opts.workspace?.trim(),
        dryRun: !!opts.dryRun,
        approve: !!opts.approve,
        noApplyTools: opts.applyTools === false,
        model: opts.model?.trim(),
      });
      if (result.error) {
        console.error("self-correction-run error:", result.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Incidents: ${result.incidentsFound}; analysed: ${result.analysed}; auto-fixed: ${result.autoFixed}; proposals: ${result.proposals.length}`);
      if (result.toolsSuggestions?.length && result.toolsApplied === 0) {
        console.log("TOOLS suggestions (run with --approve to apply):", result.toolsSuggestions.length);
      }
      if (result.toolsApplied) console.log(`TOOLS.md: ${result.toolsApplied} rule(s) applied.`);
      if (result.reportPath) console.log(`Report: ${result.reportPath}`);
      if (result.proposals.length > 0) {
        console.log("Proposed (review before applying):");
        result.proposals.forEach((p) => console.log(`  - ${p}`));
      }
    }));

  const cred = mem
    .command("credentials")
    .description("Credentials vault commands");
  cred
    .command("migrate-to-vault")
    .description("Move credential facts from memory into vault and redact originals (idempotent)")
    .action(withExit(async () => {
      const result = await runMigrateToVault();
      if (result === null) {
        console.error("Credentials vault is disabled. Enable it in plugin config (credentials.enabled) and restart.");
        return;
      }
      console.log(`Migrated: ${result.migrated}, skipped: ${result.skipped}`);
      if (result.errors.length > 0) {
        console.error("Errors:");
        result.errors.forEach((e) => console.error(`  - ${e}`));
      }
    }));

  const scopeCmd = mem
    .command("scope")
    .description("Memory scoping: prune session memories, promote to durable");
  scopeCmd
    .command("prune-session")
    .description("Delete session-scoped memories for a given session (cleared on session end)")
    .argument("<session-id>", "Session identifier to prune")
    .action(withExit(async (sessionId: string) => {
      const count = factsDb.pruneSessionScope(sessionId);
      console.log(`Pruned ${count} session-scoped memories for session "${sessionId}".`);
    }));
  scopeCmd
    .command("promote")
    .description("Promote a session-scoped memory to global or agent scope (persists after session end)")
    .requiredOption("--id <fact-id>", "Fact id to promote")
    .requiredOption("--scope <global|agent>", "New scope: global or agent")
    .option("--scope-target <target>", "Required when scope is agent: agent identifier")
    .action(withExit(async (opts: { id: string; scope: string; scopeTarget?: string }) => {
      const scope = opts.scope as "global" | "agent";
      if (scope !== "global" && scope !== "agent") {
        console.error("Scope must be 'global' or 'agent'.");
        process.exitCode = 1;
        return;
      }
      if (scope === "agent" && !opts.scopeTarget?.trim()) {
        console.error("Scope 'agent' requires --scope-target (agent identifier).");
        process.exitCode = 1;
        return;
      }
      const ok = factsDb.promoteScope(opts.id, scope, scope === "agent" ? opts.scopeTarget!.trim() : null);
      if (!ok) {
        console.error(`Could not promote memory ${opts.id}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Promoted memory ${opts.id} to scope "${scope}"${scope === "agent" ? ` (agent: ${opts.scopeTarget})` : ""}.`);
    }));

  mem
    .command("upgrade")
    .argument("[version]", "Optional version to install (e.g. 2026.2.181); default: latest")
    .description("Upgrade from npm. Removes current install, fetches version (or latest), rebuilds native deps. Restart the gateway afterward.")
    .action(withExit(async (versionArg: string | undefined) => {
      const result = await runUpgrade(versionArg);
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Upgraded to openclaw-hybrid-memory@${result.version}`);
      console.log("Restart the gateway to load the new version: openclaw gateway stop && openclaw gateway start");
    }));

  mem
    .command("uninstall")
    .description("Revert to OpenClaw default memory (memory-core). Safe: OpenClaw works normally; your data is kept unless you use --clean-all.")
    .option("--clean-all", "Remove SQLite and LanceDB data (irreversible)")
    .option("--force-cleanup", "Same as --clean-all")
    .option("--leave-config", "Do not modify openclaw.json; only print instructions")
    .action(withExit(async (opts: { cleanAll?: boolean; forceCleanup?: boolean; leaveConfig?: boolean }) => {
      const cleanAll = !!opts.cleanAll || !!opts.forceCleanup;
      const result = await runUninstall({ cleanAll, leaveConfig: !!opts.leaveConfig });
      const pluginId = result.pluginId;
      switch (result.outcome) {
        case "config_updated":
          console.log(`Config updated: plugins.slots.memory = "memory-core", ${pluginId} disabled.`);
          console.log("OpenClaw will use the default memory manager. Restart the gateway. Your hybrid data is kept unless you run with --clean-all.");
          break;
        case "config_not_found":
          console.log("Config file not found. Apply these changes manually:");
          console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
          console.log("  2. Set plugins.slots.memory to \"memory-core\".");
          console.log(`  3. Set plugins.entries["${pluginId}"].enabled to false.`);
          console.log("  4. Restart the gateway.");
          break;
        case "config_error":
          console.error(`Could not update config: ${result.error}`);
          console.log("Apply these changes manually:");
          console.log("  1. Set plugins.slots.memory to \"memory-core\"");
          console.log(`  2. Set plugins.entries["${pluginId}"].enabled to false`);
          console.log("  3. Restart the gateway.");
          break;
        case "leave_config":
          console.log("To use the default OpenClaw memory manager instead of hybrid:");
          console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
          console.log("  2. Set plugins.slots.memory to \"memory-core\".");
          console.log(`  3. Set plugins.entries["${pluginId}"].enabled to false.`);
          console.log("  4. Restart the gateway.");
          break;
      }
      if (!cleanAll) {
        console.log("\nMemory data (SQLite and LanceDB) was left in place. To remove it: openclaw hybrid-mem uninstall --clean-all");
      } else if (result.cleaned.length > 0) {
        console.log("\nRemoving hybrid-memory data...");
        console.log("Removed: " + result.cleaned.join(", "));
      } else {
        console.log("\nNo hybrid data files found at configured paths.");
      }
    }));
}