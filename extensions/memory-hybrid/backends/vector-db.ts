/**
 * LanceDB vector backend for semantic search.
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import type { MemoryCategory, DecayClass } from "../config.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";

const LANCE_TABLE = "memories";

export type VectorDBLogger = { warn: (msg: string) => void };

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private logger: VectorDBLogger | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  setLogger(logger: VectorDBLogger): void {
    this.logger = logger;
  }

  private logWarn(msg: string): void {
    if (this.logger) this.logger.warn(msg);
    else if (typeof console !== "undefined" && console.warn) console.warn(msg);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.closed) throw new Error("VectorDB is closed");
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(LANCE_TABLE)) {
      this.table = await this.db.openTable(LANCE_TABLE);
    } else {
      this.table = await this.db.createTable(LANCE_TABLE, [
        {
          id: "__schema__",
          text: "",
          vector: new Array(this.vectorDim).fill(0),
          importance: 0,
          category: "other",
          createdAt: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  /** Store a vector row. If id is provided (e.g. fact id from SQLite), it is used so search returns fact ids for FR-008 classification. */
  async store(entry: {
    text: string;
    vector: number[];
    importance: number;
    category: string;
    /** Optional fact id from SQLite; when set, search results will use this id for classification. */
    id?: string;
  }): Promise<string> {
    try {
      await this.ensureInitialized();
      const id = entry.id ?? randomUUID();
      await this.table!.add([{ ...entry, id, createdAt: Math.floor(Date.now() / 1000) }]);
      return id;
    } catch (err) {
      this.logWarn(`memory-hybrid: LanceDB store failed: ${err}`);
      throw err;
    }
  }

  async search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<SearchResult[]> {
    try {
      await this.ensureInitialized();
      const results = await this.table!.vectorSearch(vector).limit(limit).toArray();
      return results
        .map((row) => {
          const distance = row._distance ?? 0;
          const score = 1 / (1 + distance);
          return {
            entry: {
              id: row.id as string,
              text: row.text as string,
              category: row.category as MemoryCategory,
              importance: row.importance as number,
              entity: null,
              key: null,
              value: null,
              source: "conversation",
              createdAt: (row.createdAt as number) > 10_000_000_000
                ? Math.floor((row.createdAt as number) / 1000)
                : (row.createdAt as number),
              decayClass: "stable" as DecayClass,
              expiresAt: null,
              lastConfirmedAt: 0,
              confidence: 1.0,
            },
            score,
            backend: "lancedb" as const,
          };
        })
        .filter((r) => r.score >= minScore);
    } catch (err) {
      this.logWarn(`memory-hybrid: LanceDB search failed: ${err}`);
      return [];
    }
  }

  async hasDuplicate(vector: number[], threshold = 0.95): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const results = await this.table!.vectorSearch(vector).limit(1).toArray();
      if (results.length === 0) return false;
      const score = 1 / (1 + (results[0]._distance ?? 0));
      return score >= threshold;
    } catch (err) {
      this.logWarn(`memory-hybrid: LanceDB hasDuplicate failed: ${err}`);
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) throw new Error(`Invalid ID: ${id}`);
      await this.table!.delete(`id = '${id}'`);
      return true;
    } catch (err) {
      this.logWarn(`memory-hybrid: LanceDB delete failed: ${err}`);
      throw err;
    }
  }

  async count(): Promise<number> {
    try {
      await this.ensureInitialized();
      return this.table!.countRows();
    } catch (err) {
      this.logWarn(`memory-hybrid: LanceDB count failed: ${err}`);
      return 0;
    }
  }

  close(): void {
    this.closed = true;
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}
