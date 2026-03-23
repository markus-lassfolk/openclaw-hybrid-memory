/**
 * Multi-hook retrieval aliases (Issue #149).
 *
 * At storage time, generate 3-5 alternative phrasings per fact and index
 * their embeddings — so facts can be found from multiple semantic angles.
 */

import { DatabaseSync } from "node:sqlite";
import * as lancedb from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import type { AliasesConfig } from "../config.js";
import { UUID_REGEX } from "../utils/constants.js";
import { pluginLogger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// AliasDB
// ---------------------------------------------------------------------------

/** A single alias row (without embedding). */
export interface AliasRow {
  id: string;
  factId: string;
  aliasText: string;
}

/** A search result from alias embeddings. */
export interface AliasSearchResult {
  factId: string;
  score: number;
}

const ALIAS_LANCE_TABLE = "fact_aliases";

class AliasVectorIndex {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((err) => {
      capturePluginError(err as Error, {
        operation: "alias-vector-db-init",
        subsystem: "aliases",
      });
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();
    if (tables.includes(ALIAS_LANCE_TABLE)) {
      this.table = await this.db.openTable(ALIAS_LANCE_TABLE);
      await this.validateSchema();
      return;
    }
    this.table = await this.db.createTable(ALIAS_LANCE_TABLE, [
      {
        id: "__schema__",
        factId: "__schema__",
        aliasText: "",
        vector: new Array(this.vectorDim).fill(0),
        createdAt: 0,
      },
    ]);
    try {
      await this.table.delete('id = "__schema__"');
    } catch (deleteErr) {
      // Non-fatal; keep the seed row if delete fails.
      pluginLogger.warn(`memory-hybrid: failed to delete alias schema seed row (non-fatal): ${deleteErr}`);
    }
  }

  private async validateSchema(): Promise<void> {
    try {
      const schema = await this.table?.schema();
      const vectorField = schema?.fields.find(
        (f: { type?: { typeId?: number; listSize?: number } }) =>
          typeof f.type?.typeId === "number" && f.type.typeId === 16,
      );
      if (!vectorField) {
        pluginLogger.warn(
          `memory-hybrid: ⚠️  Alias LanceDB table '${ALIAS_LANCE_TABLE}' has no vector column — alias search will fall back to linear scan.`,
        );
        return;
      }
      const actualDim = (vectorField.type as { listSize?: number }).listSize;
      if (typeof actualDim !== "number" || actualDim !== this.vectorDim) {
        const actual = typeof actualDim === "number" ? actualDim : "unknown";
        pluginLogger.warn(
          `memory-hybrid: ⚠️  Alias LanceDB dimension mismatch — table has dim=${actual}, configured embedding model expects dim=${this.vectorDim}. Alias search will fall back to linear scan until resolved.`,
        );
      }
    } catch (err) {
      pluginLogger.warn(`memory-hybrid: alias LanceDB schema validation failed (non-fatal): ${err}`);
    }
  }

  private getTable(): lancedb.Table {
    if (!this.table) {
      throw new Error("AliasVectorIndex not initialized. Call ensureInitialized() first.");
    }
    return this.table;
  }

  async store(entry: { id: string; factId: string; aliasText: string; vector: number[] }): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.getTable().add([
        {
          id: entry.id,
          factId: entry.factId,
          aliasText: entry.aliasText,
          vector: entry.vector,
          createdAt: Math.floor(Date.now() / 1000),
        },
      ]);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "alias-vector-store",
        subsystem: "aliases",
      });
      pluginLogger.warn(`memory-hybrid: alias LanceDB store failed (non-fatal): ${err}`);
    }
  }

  async search(vector: number[], limit: number, minScore: number): Promise<AliasSearchResult[]> {
    try {
      await this.ensureInitialized();
      const searchLimit = Math.max(limit * 6, 50);
      const results = await this.getTable().vectorSearch(vector).limit(searchLimit).toArray();
      const bestByFact = new Map<string, number>();
      for (const row of results) {
        const distance = row._distance ?? 0;
        const score = 1 / (1 + distance);
        if (score < minScore) continue;
        const factId = row.factId as string;
        const existing = bestByFact.get(factId);
        if (existing === undefined || score > existing) {
          bestByFact.set(factId, score);
        }
      }
      return Array.from(bestByFact.entries())
        .map(([factId, score]) => ({ factId, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "alias-vector-search",
        severity: "info",
        subsystem: "aliases",
      });
      pluginLogger.warn(`memory-hybrid: alias LanceDB search failed (non-fatal): ${err}`);
      return [];
    }
  }

  async deleteByFactId(factId: string): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!UUID_REGEX.test(factId)) {
        pluginLogger.warn(`memory-hybrid: skipping alias LanceDB delete for non-UUID factId: ${factId}`);
        return;
      }
      await this.getTable().delete(`factId = '${factId.toLowerCase()}'`);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "alias-vector-delete",
        subsystem: "aliases",
      });
      pluginLogger.warn(`memory-hybrid: alias LanceDB delete failed (non-fatal): ${err}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.table = null;
      this.db?.close();
      this.db = null;
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * SQLite-backed storage for fact_aliases.
 * Schema: (id TEXT PK, factId TEXT, aliasText TEXT, embedding BLOB)
 *
 * Embeddings are stored as raw Float32Array binary blobs for compact,
 * fast deserialization during linear cosine-similarity search.
 */
export class AliasDB {
  private db: DatabaseSync;
  private aliasIndex: AliasVectorIndex;
  /** Cached alias count — invalidated on store/delete to avoid COUNT(*) on every search. */
  private aliasCountCache: number | null = null;

  constructor(dbPath: string, aliasLancePath: string, vectorDim: number) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_aliases (
        id TEXT PRIMARY KEY,
        factId TEXT NOT NULL,
        aliasText TEXT NOT NULL,
        embedding BLOB NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fact_aliases_factId ON fact_aliases(factId)");
    this.aliasIndex = new AliasVectorIndex(aliasLancePath, vectorDim);
  }

  /** Store a single alias with its embedding. Returns the generated row id. */
  store(factId: string, aliasText: string, embedding: number[]): string {
    const id = randomUUID();
    // Normalize factId to lowercase so all stored values are consistent, enabling
    // plain equality queries that benefit from idx_fact_aliases_factId.
    const normalizedFactId = factId.toLowerCase();
    const floatArray = Float32Array.from(embedding);
    const blob = Buffer.from(floatArray.buffer.slice(0));
    this.db
      .prepare("INSERT INTO fact_aliases (id, factId, aliasText, embedding) VALUES (?, ?, ?, ?)")
      .run(id, normalizedFactId, aliasText, blob);
    if (this.aliasCountCache != null) this.aliasCountCache += 1;
    void this.aliasIndex.store({ id, factId: normalizedFactId, aliasText, vector: embedding });
    return id;
  }

  /** Return all alias rows (without embedding) for a given fact. */
  getByFactId(factId: string): AliasRow[] {
    // factIds are normalized to lowercase on write; pre-lowercase the param so SQLite
    // can use the idx_fact_aliases_factId index (COLLATE NOCASE would bypass it).
    const normalizedFactId = factId.toLowerCase();
    return this.db
      .prepare("SELECT id, factId, aliasText FROM fact_aliases WHERE factId COLLATE NOCASE = ?")
      .all(normalizedFactId) as unknown as AliasRow[];
  }

  /** Delete all aliases for a fact (e.g., when the fact is superseded). */
  deleteByFactId(factId: string): void {
    // Pre-lowercase to match normalized storage; avoids COLLATE NOCASE index bypass.
    const normalizedFactId = factId.toLowerCase();
    const res = this.db.prepare("DELETE FROM fact_aliases WHERE factId = ?").run(normalizedFactId);
    if (this.aliasCountCache != null) {
      this.aliasCountCache = Math.max(0, this.aliasCountCache - Number(res.changes ?? 0));
    }
    void this.aliasIndex.deleteByFactId(factId);
  }

  /** Total alias count (cached to avoid COUNT(*) on every search call). */
  count(): number {
    if (this.aliasCountCache != null) return this.aliasCountCache;
    const row = this.db.prepare("SELECT COUNT(*) as n FROM fact_aliases").get() as { n: number };
    this.aliasCountCache = row.n;
    return row.n;
  }

  /**
   * Search alias embeddings by cosine similarity.
   *
   * Loads all alias embeddings, computes cosine similarity with queryVector,
   * deduplicates by factId (keeps best score per fact), and returns up to
   * `limit` results above `minScore`, sorted descending by score.
   */
  async search(queryVector: number[], limit: number, minScore: number): Promise<AliasSearchResult[]> {
    const aliasCount = this.count();
    if (aliasCount >= 1000) {
      // Prefer LanceDB vector search for larger datasets; fallback to linear scan on errors.
      try {
        return await this.aliasIndex.search(queryVector, limit, minScore);
      } catch {
        return this.linearSearch(queryVector, limit, minScore);
      }
    }
    return this.linearSearch(queryVector, limit, minScore);
  }

  private linearSearch(queryVector: number[], limit: number, minScore: number): AliasSearchResult[] {
    // Track best score per factId to deduplicate across aliases for the same fact
    const bestByFact = new Map<string, number>();
    const queryNormSq = queryVector.reduce((sum, v) => sum + v * v, 0);
    if (queryNormSq === 0) return [];

    const stmt = this.db.prepare("SELECT factId, embedding FROM fact_aliases");
    for (const row of stmt.iterate() as Iterable<{ factId: string; embedding: Buffer }>) {
      if (row.embedding.byteLength % 4 !== 0) continue;
      const floats = new Float32Array(
        row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
      );
      if (floats.length !== queryVector.length) continue;
      let dot = 0;
      let floatsNormSq = 0;
      for (let i = 0; i < floats.length; i++) {
        const f = floats[i]!;
        const q = queryVector[i]!;
        dot += q * f;
        floatsNormSq += f * f;
      }
      const denom = Math.sqrt(queryNormSq) * Math.sqrt(floatsNormSq);
      if (denom === 0) continue;
      const score = dot / denom;
      if (score < minScore) continue;
      const existing = bestByFact.get(row.factId);
      if (existing === undefined || score > existing) {
        bestByFact.set(row.factId, score);
      }
    }

    return Array.from(bestByFact.entries())
      .map(([factId, score]) => ({ factId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  close(): void {
    this.aliasIndex.close();
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Alias generation
// ---------------------------------------------------------------------------

/**
 * Generate alternative phrasings for a fact using an LLM.
 *
 * Returns up to maxAliases unique strings (excluding the original text).
 * On LLM error returns an empty array — alias generation is non-blocking.
 */
export async function generateAliases(
  factText: string,
  openai: OpenAI,
  model: string,
  maxAliases: number,
): Promise<string[]> {
  const prompt = `Generate ${maxAliases} alternative phrasings for the following fact. The alternatives should differ in wording but preserve the meaning, to enable retrieval of this fact from different semantic angles. Return only the alternatives, one per line, no numbering or bullets.\n\nFact: ${factText}`;

  try {
    const response = await chatComplete({
      model,
      content: prompt,
      temperature: 0.7,
      openai,
    });
    const lines = response
      .split("\n")
      .map((l) => l.trim().replace(/^([-*•]\s+|\d+[.)]\s*)/, ""))
      .filter((l) => l.length > 0 && l !== factText);
    return [...new Set(lines)].slice(0, maxAliases);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "aliases",
      operation: "generate-aliases",
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Storage orchestration
// ---------------------------------------------------------------------------

/**
 * Generate aliases for a fact, embed each, and persist to AliasDB.
 *
 * Non-blocking: embedding failures for individual aliases are logged and
 * skipped. The function is typically called with `void` after fact storage.
 */
export async function storeAliases(
  factId: string,
  factText: string,
  config: AliasesConfig,
  model: string,
  openai: OpenAI,
  embeddings: EmbeddingProvider,
  aliasDb: AliasDB,
  logWarn?: (msg: string) => void,
): Promise<void> {
  if (!config.enabled) return;

  const aliases = await generateAliases(factText, openai, model, config.maxAliases);

  // Delete any existing aliases for this fact before storing new ones.
  // This makes alias generation idempotent and prevents unbounded row accumulation
  // when storeAliases is called multiple times for the same fact (e.g. on re-store).
  aliasDb.deleteByFactId(factId);

  for (const alias of aliases) {
    try {
      const vec = await embeddings.embed(alias);
      aliasDb.store(factId, alias, vec);
    } catch (err) {
      // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "aliases",
          operation: "store-alias-embedding",
        });
      }
      logWarn?.(`memory-hybrid: alias embedding failed: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Retrieval strategy
// ---------------------------------------------------------------------------

/**
 * Search alias embeddings for a query vector.
 * Returns ranked results (rank 1 = best match) compatible with RRF fusion.
 */
export async function searchAliasStrategy(
  aliasDb: AliasDB,
  queryVector: number[],
  topK: number,
  minScore = 0.3,
): Promise<Array<{ factId: string; rank: number; source: "aliases" }>> {
  const results = await aliasDb.search(queryVector, topK, minScore);
  return results.map((r, i) => ({
    factId: r.factId,
    rank: i + 1,
    source: "aliases" as const,
  }));
}
