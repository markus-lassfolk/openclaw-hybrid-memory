/**
 * Multi-hook retrieval aliases (Issue #149).
 *
 * At storage time, generate 3-5 alternative phrasings per fact and index
 * their embeddings — so facts can be found from multiple semantic angles.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { EmbeddingProvider } from "./embeddings.js";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import type { AliasesConfig } from "../config.js";
import { cosineSimilarity } from "./ambient-retrieval.js";

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

/**
 * SQLite-backed storage for fact_aliases.
 * Schema: (id TEXT PK, factId TEXT, aliasText TEXT, embedding BLOB)
 *
 * Embeddings are stored as raw Float32Array binary blobs for compact,
 * fast deserialization during linear cosine-similarity search.
 */
export class AliasDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_aliases (
        id TEXT PRIMARY KEY,
        factId TEXT NOT NULL,
        aliasText TEXT NOT NULL,
        embedding BLOB NOT NULL
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_fact_aliases_factId ON fact_aliases(factId)`,
    );
  }

  /** Store a single alias with its embedding. Returns the generated row id. */
  store(factId: string, aliasText: string, embedding: number[]): string {
    const id = randomUUID();
    const blob = Buffer.from(new Float32Array(embedding).buffer);
    this.db
      .prepare(
        `INSERT INTO fact_aliases (id, factId, aliasText, embedding) VALUES (?, ?, ?, ?)`,
      )
      .run(id, factId, aliasText, blob);
    return id;
  }

  /** Return all alias rows (without embedding) for a given fact. */
  getByFactId(factId: string): AliasRow[] {
    return this.db
      .prepare(
        `SELECT id, factId, aliasText FROM fact_aliases WHERE factId = ?`,
      )
      .all(factId) as AliasRow[];
  }

  /** Delete all aliases for a fact (e.g., when the fact is superseded). */
  deleteByFactId(factId: string): void {
    this.db.prepare(`DELETE FROM fact_aliases WHERE factId = ?`).run(factId);
  }

  /** Total alias count. */
  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM fact_aliases`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Search alias embeddings by cosine similarity.
   *
   * Loads all alias embeddings, computes cosine similarity with queryVector,
   * deduplicates by factId (keeps best score per fact), and returns up to
   * `limit` results above `minScore`, sorted descending by score.
   */
  search(
    queryVector: number[],
    limit: number,
    minScore: number,
  ): AliasSearchResult[] {
    const rows = this.db
      .prepare(`SELECT factId, embedding FROM fact_aliases`)
      .all() as Array<{ factId: string; embedding: Buffer }>;

    // Track best score per factId to deduplicate across aliases for the same fact
    const bestByFact = new Map<string, number>();
    for (const row of rows) {
      const alignedBuffer = row.embedding.slice().buffer;
      const floats = new Float32Array(alignedBuffer);
      const score = cosineSimilarity(queryVector, Array.from(floats));
      if (score >= minScore) {
        const existing = bestByFact.get(row.factId);
        if (existing === undefined || score > existing) {
          bestByFact.set(row.factId, score);
        }
      }
    }

    return Array.from(bestByFact.entries())
      .map(([factId, score]) => ({ factId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  close(): void {
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
  const prompt =
    `Generate ${maxAliases} alternative phrasings for the following fact. ` +
    `The alternatives should differ in wording but preserve the meaning, ` +
    `to enable retrieval of this fact from different semantic angles. ` +
    `Return only the alternatives, one per line, no numbering or bullets.\n\n` +
    `Fact: ${factText}`;

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
    capturePluginError(
      err instanceof Error ? err : new Error(String(err)),
      { subsystem: "aliases", operation: "generate-aliases" },
    );
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

  for (const alias of aliases) {
    try {
      const vec = await embeddings.embed(alias);
      aliasDb.store(factId, alias, vec);
    } catch (err) {
      capturePluginError(
        err instanceof Error ? err : new Error(String(err)),
        { subsystem: "aliases", operation: "store-alias-embedding" },
      );
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
export function searchAliasStrategy(
  aliasDb: AliasDB,
  queryVector: number[],
  topK: number,
  minScore = 0.3,
): Array<{ factId: string; rank: number; source: "aliases" }> {
  const results = aliasDb.search(queryVector, topK, minScore);
  return results.map((r, i) => ({
    factId: r.factId,
    rank: i + 1,
    source: "aliases" as const,
  }));
}
