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
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    this.db.exec(`
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

  store(input: StoreNarrativeInput): NarrativeEntry {
    const id = randomUUID();
    const createdAt = Date.now();
    const safeNarrativeText = input.narrativeText.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db
      .prepare(
        `INSERT INTO narratives (id, session_id, period_start, period_end, tag, narrative_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, tag) DO UPDATE SET
           period_start = excluded.period_start,
           period_end = excluded.period_end,
           narrative_text = excluded.narrative_text,
           created_at = excluded.created_at`,
      )
      .run(id, input.sessionId, input.periodStart, input.periodEnd, input.tag, safeNarrativeText, createdAt);

    const row = this.db
      .prepare("SELECT * FROM narratives WHERE session_id = ? AND tag = ? LIMIT 1")
      .get(input.sessionId, input.tag) as any;
    return this.rowToEntry(row);
  }

  getById(id: string): NarrativeEntry | null {
    const row = this.db.prepare("SELECT * FROM narratives WHERE id = ?").get(id) as NarrativeRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  listRecent(limit = 3, tag: "session" | "weekly-rollup" | "all" = "session"): NarrativeEntry[] {
    const sql =
      tag === "all"
        ? "SELECT * FROM narratives ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM narratives WHERE tag = ? ORDER BY created_at DESC LIMIT ?";
    const rows =
      tag === "all"
        ? (this.db.prepare(sql).all(limit) as unknown as NarrativeRow[])
        : (this.db.prepare(sql).all(tag, limit) as unknown as NarrativeRow[]);
    return rows.map((r) => this.rowToEntry(r));
  }

  pruneOlderThan(days: number): number {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = this.db.prepare("DELETE FROM narratives WHERE created_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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
