/**
 * NarrativesDB — chronological session/period summaries for fast resumability.
 *
 * Stores concise temporal narratives separate from fact storage. Narratives are
 * intentionally prose-level context and should reference fact IDs/topics instead
 * of duplicating canonical fact content.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";

export interface NarrativeEntry {
  id: string;
  sessionId: string;
  periodStart: number;
  periodEnd: number;
  tag: string;
  narrativeText: string;
  createdAt: number;
}

export interface StoreNarrativeInput {
  sessionId: string;
  periodStart: number;
  periodEnd: number;
  tag: "session" | "weekly-rollup";
  narrativeText: string;
}

interface NarrativeRow {
  id: string;
  session_id: string;
  period_start: number;
  period_end: number;
  tag: string;
  narrative_text: string;
  created_at: number;
}

export class NarrativesDB {
  private readonly db: DatabaseSync;
  private _dbOpen = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.applyPragmas();

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS narratives (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        tag TEXT NOT NULL,
        narrative_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_narratives_created_at ON narratives(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_narratives_session ON narratives(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_narratives_tag ON narratives(tag, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_narratives_session_tag ON narratives(session_id, tag);
    `);
  }

  private applyPragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }

  private get liveDb(): DatabaseSync {
    if (!this._dbOpen) {
      this.db.open();
      this._dbOpen = true;
      this.applyPragmas();
    }
    return this.db;
  }

  store(input: StoreNarrativeInput): NarrativeEntry {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare(
        `INSERT INTO narratives (id, session_id, period_start, period_end, tag, narrative_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, tag) DO UPDATE SET
           period_start = excluded.period_start,
           period_end = excluded.period_end,
           narrative_text = excluded.narrative_text,
           created_at = excluded.created_at`,
      )
      .run(id, input.sessionId, input.periodStart, input.periodEnd, input.tag, input.narrativeText, createdAt);

    const row = this.liveDb
      .prepare("SELECT * FROM narratives WHERE session_id = ? AND tag = ? LIMIT 1")
      .get(input.sessionId, input.tag) as NarrativeRow | undefined;

    if (!row) {
      throw new Error("Failed to load narrative after upsert");
    }
    return this.rowToEntry(row);
  }

  getById(id: string): NarrativeEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM narratives WHERE id = ?").get(id) as NarrativeRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  listRecent(limit = 3, tag: "session" | "weekly-rollup" | "all" = "session"): NarrativeEntry[] {
    const sql =
      tag === "all"
        ? "SELECT * FROM narratives ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM narratives WHERE tag = ? ORDER BY created_at DESC LIMIT ?";
    const rows =
      tag === "all"
        ? (this.liveDb.prepare(sql).all(limit) as unknown as NarrativeRow[])
        : (this.liveDb.prepare(sql).all(tag, limit) as unknown as NarrativeRow[]);
    return rows.map((r) => this.rowToEntry(r));
  }

  listBySession(sessionId: string, limit = 5, tag: "session" | "weekly-rollup" | "all" = "all"): NarrativeEntry[] {
    const sql =
      tag === "all"
        ? "SELECT * FROM narratives WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM narratives WHERE session_id = ? AND tag = ? ORDER BY created_at DESC LIMIT ?";
    const rows =
      tag === "all"
        ? (this.liveDb.prepare(sql).all(sessionId, limit) as unknown as NarrativeRow[])
        : (this.liveDb.prepare(sql).all(sessionId, tag, limit) as unknown as NarrativeRow[]);
    return rows.map((r) => this.rowToEntry(r));
  }

  pruneOlderThan(days: number): number {
    if (days <= 0) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const result = this.liveDb.prepare("DELETE FROM narratives WHERE created_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this._dbOpen = false;
    try {
      this.db.close();
    } catch (err: unknown) {
      // Only ignore the specific "already closed"/"not open" condition.
      const isAlreadyClosedError =
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string" &&
        ((err as { message: string }).message.includes("not open") ||
          (err as { message: string }).message.includes("already closed"));

      if (!isAlreadyClosedError) {
        // Log unexpected close failures instead of swallowing them silently.
        // Close remains non-fatal for callers.
        // eslint-disable-next-line no-console
        console.error("NarrativesDB.close() failed:", err);
      }
    }
  }

  private rowToEntry(row: NarrativeRow): NarrativeEntry {
    return {
      id: row.id,
      sessionId: row.session_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      tag: row.tag,
      narrativeText: row.narrative_text,
      createdAt: row.created_at,
    };
  }
}
