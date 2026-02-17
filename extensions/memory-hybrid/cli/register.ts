/**
 * Register hybrid-mem CLI subcommands.
 * Receives the "hybrid-mem" command object and a context; registers stats, prune,
 * checkpoint, backfill-decay, search, lookup. Remaining commands stay in index.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { SearchResult } from "../types/memory.js";
import { mergeResults } from "../services/merge-results.js";
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
};

export type StoreCliResult =
  | { outcome: "duplicate" }
  | { outcome: "credential"; id: string; service: string; type: string }
  | { outcome: "credential_parse_error" }
  | { outcome: "noop"; reason: string }
  | { outcome: "retracted"; targetId: string; reason: string }
  | { outcome: "updated"; id: string; supersededId: string; reason: string }
  | { outcome: "stored"; id: string; textPreview: string };

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
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
    runFindDuplicates,
    runConsolidate,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    reflectionConfig,
    runClassify,
    autoClassifyConfig,
  } = ctx;

  mem
    .command("stats")
    .description("Show memory statistics with decay breakdown")
    .action(async () => {
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
    .action(async (query: string, opts: { limit?: string; tag?: string; asOf?: string; includeSuperseded?: boolean }) => {
      const limit = parseInt(opts.limit || "5");
      const tag = opts.tag?.trim();
      const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseDate(opts.asOf) : undefined;
      const searchOpts = { tag, includeSuperseded: opts.includeSuperseded === true, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
      const sqlResults = factsDb.search(query, limit, searchOpts);
      let lanceResults: SearchResult[] = [];
      if (!tag) {
        try {
          const vector = await embeddings.embed(query);
          lanceResults = await vectorDb.search(vector, limit, 0.3);
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
    .action(async (opts: { text: string; category?: string; entity?: string; key?: string; value?: string; sourceDate?: string; tags?: string }) => {
      const text = opts.text;
      if (!text || text.length < 2) {
        console.error("--text is required and must be at least 2 characters");
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
          console.log(`Stored: "${result.textPreview}" [id: ${result.id}]`);
          break;
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
}
