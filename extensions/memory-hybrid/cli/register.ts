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
  /** FR-010: Fact id this store supersedes (replaces). */
  supersedes?: string;
  /** FR-006: Memory scope (global, user, agent, session). Default global. */
  scope?: "global" | "user" | "agent" | "session";
  /** FR-006: Scope target (userId, agentId, sessionId). Required when scope is user/agent/session. */
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

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
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
  /** FR-004: Run memory tier compaction (completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT). */
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  /** Detect top 3 languages from memory text; LLM produces intent-based natural equivalents (triggers, extraction patterns) and writes .language-keywords.json. */
  runBuildLanguageKeywords: (opts: { model?: string; dryRun?: boolean }) => Promise<
    | { ok: true; path: string; topLanguages: string[]; languagesAdded: number }
    | { ok: false; error: string }
  >;
  /** Self-correction (issue #34): extract incidents from session JSONL using multi-language correction signals from .language-keywords.json. */
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
};

/** Chainable command type (Commander-style). */
type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: unknown[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  argument(name: string, desc?: string): Chainable;
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
  } = ctx;

  mem
    .command("compact")
    .description("FR-004: Run tier compaction — completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT")
    .action(async () => {
      const counts = await runCompaction();
      console.log(`Tier compaction: hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
    });

  mem
    .command("stats")
    .description("Show memory statistics with decay breakdown. Use --efficiency for tiers, sources, and token estimates.")
    .option("--efficiency", "Show tier/source breakdown, estimated tokens, and token-savings note")
    .action(async (opts?: { efficiency?: boolean }) => {
      const efficiency = opts?.efficiency ?? false;
      const sqlCount = factsDb.count();
      let lanceCount = 0;
      try {
        lanceCount = await vectorDb.count();
      } catch {
        // vectorDb may be unavailable
      }
      const breakdown = factsDb.statsBreakdown();
      const expired = factsDb.countExpired();

      console.log(`memory-hybrid ${versionInfo.pluginVersion} (memory-manager ${versionInfo.memoryManagerVersion}, schema ${versionInfo.schemaVersion})`);
      console.log(`SQLite facts:    ${sqlCount}`);
      console.log(`LanceDB vectors: ${lanceCount}`);
      console.log(`Total: ${sqlCount + lanceCount} (with overlap)`);
      console.log(`\nBy decay class:`);
      for (const [cls, cnt] of Object.entries(breakdown)) {
        console.log(`  ${cls.padEnd(12)} ${cnt}`);
      }
      if (expired > 0) {
        console.log(`\nExpired (pending prune): ${expired}`);
      }

      if (efficiency) {
        const tierBreakdown = factsDb.statsBreakdownByTier();
        const sourceBreakdown = factsDb.statsBreakdownBySource();
        const totalTokens = factsDb.estimateStoredTokens();
        const tokensByTier = factsDb.estimateStoredTokensByTier();

        console.log(`\n--- Efficiency ---`);
        console.log(`\nBy tier (FR-004 hot/warm/cold):`);
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
    });

  mem
    .command("prune")
    .description("Remove expired facts and decay aging confidence")
    .option("--hard", "Only hard-delete expired facts")
    .option("--soft", "Only soft-decay confidence")
    .option("--dry-run", "Show what would be pruned without deleting")
    .action(async (opts: { dryRun?: boolean; hard?: boolean; soft?: boolean }) => {
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
    });

  mem
    .command("checkpoint")
    .description("Save or restore a pre-flight checkpoint")
    .argument("<action>", "save or restore")
    .option("--intent <text>", "Intent for save")
    .option("--state <text>", "State for save")
    .action(async (action: string, opts: { intent?: string; state?: string }) => {
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
    });

  mem
    .command("backfill-decay")
    .description("Re-classify existing facts with auto-detected decay classes")
    .action(async () => {
      const counts = factsDb.backfillDecayClasses();
      if (Object.keys(counts).length === 0) {
        console.log("All facts already properly classified.");
      } else {
        console.log("Reclassified:");
        for (const [cls, cnt] of Object.entries(counts)) {
          console.log(`  ${cls}: ${cnt}`);
        }
      }
    });

  mem
    .command("search")
    .description("Search memories across both backends")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", "5")
    .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
    .option("--as-of <date>", "FR-010: Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
    .option("--include-superseded", "FR-010: Include superseded (historical) facts")
    .option("--user-id <id>", "FR-006: Include user-private memories for this user")
    .option("--agent-id <id>", "FR-006: Include agent-specific memories for this agent")
    .option("--session-id <id>", "FR-006: Include session-scoped memories for this session")
    .action(async (query: string, opts: { limit?: string; tag?: string; asOf?: string; includeSuperseded?: boolean; userId?: string; agentId?: string; sessionId?: string }) => {
      const limit = parseInt(opts.limit || "5");
      const tag = opts.tag?.trim();
      const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseDate(opts.asOf) : undefined;
      const scopeFilter: ScopeFilter | undefined =
        opts.userId || opts.agentId || opts.sessionId
          ? { userId: opts.userId ?? null, agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null }
          : undefined;
      const searchOpts = { tag, includeSuperseded: opts.includeSuperseded === true, scopeFilter, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
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
    });

  mem
    .command("lookup")
    .description("Exact entity lookup in SQLite")
    .argument("<entity>", "Entity name")
    .option("--key <key>", "Optional key filter")
    .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
    .option("--as-of <date>", "FR-010: Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
    .option("--include-superseded", "FR-010: Include superseded (historical) facts")
    .action(async (entity: string, opts: { key?: string; tag?: string; asOf?: string; includeSuperseded?: boolean }) => {
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
    });

  mem
    .command("categories")
    .description("List all configured memory categories")
    .action(() => {
      const cats = getMemoryCategories();
      console.log(`Memory categories (${cats.length}):`);
      for (const cat of cats) {
        const count = factsDb.getByCategory(cat).length;
        console.log(`  ${cat}: ${count} facts`);
      }
    });

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
    .option("--supersedes <id>", "FR-010: Fact id this one supersedes (replaces)")
    .option("--scope <scope>", "FR-006: Memory scope (global, user, agent, session). Default global.")
    .option("--scope-target <target>", "FR-006: Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.")
    .action(async (opts: { text: string; category?: string; entity?: string; key?: string; value?: string; sourceDate?: string; tags?: string; supersedes?: string; scope?: string; scopeTarget?: string }) => {
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
    });

  mem
    .command("install")
    .description("Apply full recommended config, prompts, and optional jobs (idempotent). Run after first plugin setup for best defaults.")
    .option("--dry-run", "Print what would be merged without writing")
    .action(async (opts: { dryRun?: boolean }) => {
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
    });

  mem
    .command("verify")
    .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
    .option("--fix", "Print or apply default config for missing items")
    .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
    .action(async (opts: { fix?: boolean; logFile?: string }) => {
      await runVerify(
        { fix: !!opts.fix, logFile: opts.logFile },
        { log: (s) => console.log(s), error: (s) => console.error(s) },
      );
    });

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
    .option("--directives", "Also extract directives (issue #39)")
    .option("--reinforcement", "Also extract reinforcement (issue #40)")
    .action(async (opts: { dryRun?: boolean; all?: boolean; days?: string; since?: string; model?: string; verbose?: boolean; maxSessions?: string; maxSessionTokens?: string; directives?: boolean; reinforcement?: boolean }) => {
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
    });

  mem
    .command("distill-window")
    .description("Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process; end the job with record-distill.")
    .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
    .action(async (opts: { json?: boolean }) => {
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
    });

  mem
    .command("record-distill")
    .description("Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)")
    .action(async () => {
      const result = await runRecordDistill();
      console.log(`Recorded distillation run: ${result.timestamp}`);
      console.log(`Written to ${result.path}. Run 'openclaw hybrid-mem verify' to see it.`);
    });

  mem
    .command("extract-daily")
    .description("Extract structured facts from daily memory files")
    .option("--days <n>", "How many days back to scan", "7")
    .option("--dry-run", "Show extractions without storing")
    .action(async (opts: { days: string; dryRun?: boolean }) => {
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
    });

  mem
    .command("extract-procedures")
    .description("Procedural memory: extract tool-call sequences from session JSONL and store as procedures")
    .option("--dir <path>", "Session directory (default: config procedures.sessionsDir)")
    .option("--days <n>", "Only sessions modified in last N days (default: all in dir)", "")
    .option("--dry-run", "Show what would be stored without writing")
    .action(async (opts: { dir?: string; days?: string; dryRun?: boolean }) => {
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
    });

  mem
    .command("generate-auto-skills")
    .description("Generate SKILL.md + recipe.json in skills/auto/ for procedures validated enough times")
    .option("--dry-run", "Show what would be generated without writing")
    .action(async (opts: { dryRun?: boolean }) => {
      const result = await runGenerateAutoSkills({ dryRun: !!opts.dryRun });
      if (result.dryRun) {
        console.log(`\n[dry-run] Would generate ${result.generated} auto-skills`);
      } else {
        console.log(`\nGenerated ${result.generated} auto-skills${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`);
        for (const p of result.paths) console.log(`  ${p}`);
      }
    });

  mem
    .command("extract-directives")
    .description("Issue #39: Extract directive incidents from session JSONL (10 categories)")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each directive as it is detected")
    .option("--dry-run", "Show what would be extracted without storing")
    .action(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days || "3", 10);
      // TODO: Implement runExtractDirectives
      console.log(`Extract-directives not fully implemented yet. Would scan last ${days} days.`);
      console.log("Placeholder: extract directives, optionally store as facts with category 'rule' or 'preference'.");
    });

  mem
    .command("extract-reinforcement")
    .description("Issue #40: Extract reinforcement incidents from session JSONL and annotate facts/procedures")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--verbose", "Log each reinforcement as it is detected")
    .option("--dry-run", "Show what would be annotated without storing")
    .action(async (opts: { days?: string; verbose?: boolean; dryRun?: boolean }) => {
      const days = parseInt(opts.days || "3", 10);
      // TODO: Implement runExtractReinforcement
      console.log(`Extract-reinforcement not fully implemented yet. Would scan last ${days} days.`);
      console.log("Placeholder: extract reinforcement, correlate with facts, call reinforceFact().");
    });

  mem
    .command("backfill")
    .description("Index MEMORY.md and memory/**/*.md into SQLite + LanceDB (fast bulk import)")
    .option("--dry-run", "Show what would be indexed without storing")
    .option("--workspace <path>", "Workspace root (default: OPENCLAW_WORKSPACE or ~/.openclaw/workspace)")
    .option("--limit <n>", "Max facts to store (0 = no limit)", "0")
    .action(async (opts: { dryRun?: boolean; workspace?: string; limit?: string }) => {
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
    });

  mem
    .command("ingest-files")
    .description("Index workspace markdown (skills, TOOLS.md, etc.) as facts via LLM extraction (issue #33)")
    .option("--dry-run", "Show what would be processed without storing")
    .option("--workspace <path>", "Workspace root (default: OPENCLAW_WORKSPACE or cwd)")
    .option("--paths <globs>", "Comma-separated globs (default: config ingest.paths or skills/**/*.md,TOOLS.md,AGENTS.md)")
    .action(async (opts: { dryRun?: boolean; workspace?: string; paths?: string }) => {
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
    });

  mem
    .command("find-duplicates")
    .description("Report pairs of facts with embedding similarity ≥ threshold (2.2); no merge")
    .option("--threshold <n>", "Similarity threshold 0–1 (default 0.92)", "0.92")
    .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
    .option("--limit <n>", "Max facts to consider (default 300)", "300")
    .action(async (opts: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
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
    });

  mem
    .command("consolidate")
    .description("Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster (2.4)")
    .option("--threshold <n>", "Cosine similarity threshold 0–1 (default 0.96; higher = fewer merges)", "0.96")
    .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
    .option("--dry-run", "Report clusters and would-merge only; do not store or delete")
    .option("--limit <n>", "Max facts to consider (default 300)", "300")
    .option("--model <model>", "LLM for merge (default gpt-4o-mini)", "gpt-4o-mini")
    .action(async (opts: { threshold?: string; includeStructured?: boolean; dryRun?: boolean; limit?: string; model?: string }) => {
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
    });

  mem
    .command("reflect")
    .description("FR-011: Analyze recent facts, extract behavioral patterns, store as pattern-category facts")
    .option("--window <days>", "Time window in days (default: config or 14)")
    .option("--dry-run", "Show extracted patterns without storing")
    .option("--model <model>", "LLM for reflection (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(async (opts: { window?: string; dryRun?: boolean; model?: string; force?: boolean }) => {
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
    });

  mem
    .command("reflect-rules")
    .description("FR-011 optional: Synthesize patterns into actionable one-line rules (category rule)")
    .option("--dry-run", "Show extracted rules without storing")
    .option("--model <model>", "LLM (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
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
    });

  mem
    .command("reflect-meta")
    .description("FR-011 optional: Synthesize patterns into 1-3 higher-level meta-patterns")
    .option("--dry-run", "Show extracted meta-patterns without storing")
    .option("--model <model>", "LLM (default: config or gpt-4o-mini)")
    .option("--force", "Run even if reflection is disabled in config")
    .action(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
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
    });

  mem
    .command("classify")
    .description("Auto-classify 'other' facts using LLM (uses autoClassify config). Runs category discovery first when enabled.")
    .option("--dry-run", "Show classifications without applying")
    .option("--limit <n>", "Max facts to classify", "500")
    .option("--model <model>", "Override LLM model")
    .action(async (opts: { dryRun?: boolean; limit?: string; model?: string }) => {
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
    });

  mem
    .command("build-languages")
    .description("Detect top 3 languages from memory text; use English as intent template and generate natural triggers, structural phrases, and extraction patterns per language (not literal translation). Writes .language-keywords.json (v2). Run once or when you add new languages.")
    .option("--dry-run", "Detect and translate but do not write file")
    .option("--model <model>", "LLM model for detection and translation", "gpt-4o-mini")
    .action(async (opts: { dryRun?: boolean; model?: string }) => {
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
    });

  mem
    .command("self-correction-extract")
    .description("Issue #34: Extract user correction incidents from session JSONL (last N days). Uses multi-language correction signals from .language-keywords.json — run build-languages first for non-English. Output JSON to file or stdout.")
    .option("--days <n>", "Scan sessions from last N days (default: 3)", "3")
    .option("--output <path>", "Write incidents JSON to file (optional)")
    .action(async (opts: { days?: string; output?: string }) => {
      const days = opts.days ? parseInt(opts.days, 10) : 3;
      const result = await runSelfCorrectionExtract({
        days: Number.isFinite(days) ? days : 3,
        outputPath: opts.output?.trim() || undefined,
      });
      console.log(`Sessions scanned: ${result.sessionsScanned}; incidents: ${result.incidents.length}`);
      if (result.incidents.length > 0 && !opts.output) {
        console.log(JSON.stringify(result.incidents, null, 2));
      }
    });

  mem
    .command("self-correction-run")
    .description("Issue #34: Analyze incidents, auto-remediate (memory + TOOLS section or rewrite). TOOLS rules are applied by default; use --no-apply-tools to only suggest.")
    .option("--extract <path>", "Path to incidents JSON from self-correction-extract --output (else runs extract in memory)")
    .option("--workspace <path>", "Workspace root for TOOLS.md and memory/reports (default: OPENCLAW_WORKSPACE or ~/.openclaw/workspace)")
    .option("--dry-run", "Analyze and report only; do not store or append")
    .option("--approve", "Force apply suggested TOOLS rules (when config applyToolsByDefault is false)")
    .option("--no-apply-tools", "Do not apply TOOLS rules this run (only suggest in report). Opt-out from default apply.")
    .option("--model <model>", "LLM for analysis (default: config.distill.defaultModel or gemini-3-pro-preview)", "gemini-3-pro-preview")
    .action(async (opts: { extract?: string; workspace?: string; dryRun?: boolean; approve?: boolean; applyTools?: boolean; model?: string }) => {
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
    });

  const cred = mem
    .command("credentials")
    .description("Credentials vault commands");
  cred
    .command("migrate-to-vault")
    .description("Move credential facts from memory into vault and redact originals (idempotent)")
    .action(async () => {
      const result = await runMigrateToVault();
      if (result === null) {
        console.error("Credentials vault is disabled. Enable it in plugin config (credentials.encryptionKey) and restart.");
        return;
      }
      console.log(`Migrated: ${result.migrated}, skipped: ${result.skipped}`);
      if (result.errors.length > 0) {
        console.error("Errors:");
        result.errors.forEach((e) => console.error(`  - ${e}`));
      }
    });

  const scopeCmd = mem
    .command("scope")
    .description("FR-006: Memory scoping — prune session memories, promote to durable");
  scopeCmd
    .command("prune-session")
    .description("Delete session-scoped memories for a given session (cleared on session end)")
    .argument("<session-id>", "Session identifier to prune")
    .action(async (sessionId: string) => {
      const count = factsDb.pruneSessionScope(sessionId);
      console.log(`Pruned ${count} session-scoped memories for session "${sessionId}".`);
    });
  scopeCmd
    .command("promote")
    .description("Promote a session-scoped memory to global or agent scope (persists after session end)")
    .requiredOption("--id <fact-id>", "Fact id to promote")
    .requiredOption("--scope <global|agent>", "New scope: global or agent")
    .option("--scope-target <target>", "Required when scope is agent: agent identifier")
    .action(async (opts: { id: string; scope: string; scopeTarget?: string }) => {
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
    });

  mem
    .command("upgrade")
    .argument("[version]", "Optional version to install (e.g. 2026.2.181); default: latest")
    .description("Upgrade from npm. Removes current install, fetches version (or latest), rebuilds native deps. Restart the gateway afterward.")
    .action(async (versionArg: string | undefined) => {
      const result = await runUpgrade(versionArg);
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Upgraded to openclaw-hybrid-memory@${result.version}`);
      console.log("Restart the gateway to load the new version: openclaw gateway stop && openclaw gateway start");
    });

  mem
    .command("uninstall")
    .description("Revert to OpenClaw default memory (memory-core). Safe: OpenClaw works normally; your data is kept unless you use --clean-all.")
    .option("--clean-all", "Remove SQLite and LanceDB data (irreversible)")
    .option("--force-cleanup", "Same as --clean-all")
    .option("--leave-config", "Do not modify openclaw.json; only print instructions")
    .action(async (opts: { cleanAll?: boolean; forceCleanup?: boolean; leaveConfig?: boolean }) => {
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
    });
}