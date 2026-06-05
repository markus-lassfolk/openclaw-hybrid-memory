/**
 * Live Change Feed — append-only log of system mutations (persona, skills, frustration, etc.).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { FactsDB } from "../backends/facts-db.js";

export type ChangeEventTier = "session" | "persistent";
export type ChangeEventCategory =
  | "frustration"
  | "persona"
  | "skill"
  | "tool"
  | "procedure-skill"
  | "dream-cycle";
export type ChangeEventAction = "detected" | "proposed" | "applied" | "reverted" | "rejected";
export type ChangeEventActivation = "immediate" | "next-turn" | "next-reload";
export type ChangeEventStatus = "active" | "reverted" | "superseded";

export interface ChangeEvent {
  id: string;
  ordinal: number;
  sessionKey: string;
  timestamp: number;
  tier: ChangeEventTier;
  category: ChangeEventCategory;
  action: ChangeEventAction;
  title: string;
  detail: string;
  proposalKey: string | null;
  rollbackAvailable: boolean;
  activation: ChangeEventActivation;
  status: ChangeEventStatus;
}

export type ChangeEventInput = Omit<ChangeEvent, "id" | "ordinal" | "status"> & {
  status?: ChangeEventStatus;
};

type ChangeEventRow = {
  id: string;
  session_key: string;
  ordinal: number;
  timestamp_ms: number;
  tier: ChangeEventTier;
  category: ChangeEventCategory;
  action: ChangeEventAction;
  title: string;
  detail: string;
  proposal_key: string | null;
  rollback_available: number;
  activation: ChangeEventActivation;
  status: ChangeEventStatus;
};

function rowToEvent(row: ChangeEventRow): ChangeEvent {
  return {
    id: row.id,
    ordinal: row.ordinal,
    sessionKey: row.session_key,
    timestamp: row.timestamp_ms,
    tier: row.tier,
    category: row.category,
    action: row.action,
    title: row.title,
    detail: row.detail,
    proposalKey: row.proposal_key,
    rollbackAvailable: row.rollback_available === 1,
    activation: row.activation,
    status: row.status,
  };
}

export class ChangeFeed {
  private readonly getDb: () => DatabaseSync;

  constructor(factsDb: FactsDB) {
    this.getDb = () => factsDb.getRawDb();
    this.migrate();
  }

  /** For tests: construct from a raw DatabaseSync handle. */
  static fromDb(db: DatabaseSync): ChangeFeed {
    const feed = Object.create(ChangeFeed.prototype) as ChangeFeed;
    (feed as { getDb: () => DatabaseSync }).getDb = () => db;
    feed.migrate();
    return feed;
  }

  migrate(): void {
    this.getDb().exec(`
      CREATE TABLE IF NOT EXISTS change_events (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        tier TEXT NOT NULL CHECK(tier IN ('session', 'persistent')),
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        proposal_key TEXT,
        rollback_available INTEGER NOT NULL DEFAULT 0,
        activation TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'reverted', 'superseded')),
        UNIQUE(session_key, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_change_events_session_ts
        ON change_events(session_key, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_change_events_status
        ON change_events(status, timestamp_ms DESC);
    `);
  }

  append(input: ChangeEventInput): ChangeEvent {
    const db = this.getDb();
    const sessionKey = input.sessionKey.trim() || "default";
    const maxRow = db
      .prepare(`SELECT MAX(ordinal) AS maxOrd FROM change_events WHERE session_key = ?`)
      .get(sessionKey) as { maxOrd: number | null } | undefined;
    const ordinal = (maxRow?.maxOrd ?? 0) + 1;
    const id = randomUUID();
    const event: ChangeEvent = {
      id,
      ordinal,
      sessionKey,
      timestamp: input.timestamp,
      tier: input.tier,
      category: input.category,
      action: input.action,
      title: input.title,
      detail: input.detail,
      proposalKey: input.proposalKey,
      rollbackAvailable: input.rollbackAvailable,
      activation: input.activation,
      status: input.status ?? "active",
    };
    db.prepare(
      `INSERT INTO change_events (
        id, session_key, ordinal, timestamp_ms, tier, category, action,
        title, detail, proposal_key, rollback_available, activation, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.sessionKey,
      event.ordinal,
      event.timestamp,
      event.tier,
      event.category,
      event.action,
      event.title,
      event.detail,
      event.proposalKey,
      event.rollbackAvailable ? 1 : 0,
      event.activation,
      event.status,
    );
    return event;
  }

  listRecent(opts?: {
    sessionKey?: string;
    limit?: number;
    since?: number;
    status?: ChangeEventStatus;
  }): ChangeEvent[] {
    const db = this.getDb();
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.sessionKey) {
      clauses.push("session_key = ?");
      params.push(opts.sessionKey);
    }
    if (opts?.since != null) {
      clauses.push("timestamp_ms > ?");
      params.push(opts.since);
    }
    if (opts?.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM change_events ${where} ORDER BY timestamp_ms DESC LIMIT ?`,
      )
      .all(...params, limit) as ChangeEventRow[];
    return rows.map(rowToEvent);
  }

  getById(id: string): ChangeEvent | null {
    const row = this.getDb()
      .prepare(`SELECT * FROM change_events WHERE id = ?`)
      .get(id) as ChangeEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  getByOrdinal(sessionKey: string, ordinal: number): ChangeEvent | null {
    const row = this.getDb()
      .prepare(`SELECT * FROM change_events WHERE session_key = ? AND ordinal = ?`)
      .get(sessionKey.trim() || "default", ordinal) as ChangeEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  markReverted(id: string): void {
    this.getDb()
      .prepare(`UPDATE change_events SET status = 'reverted' WHERE id = ? AND status = 'active'`)
      .run(id);
  }

  markSuperseded(id: string): void {
    this.getDb()
      .prepare(`UPDATE change_events SET status = 'superseded' WHERE id = ? AND status = 'active'`)
      .run(id);
  }

  pruneOlderThan(days: number): number {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = this.getDb()
      .prepare(`DELETE FROM change_events WHERE timestamp_ms < ?`)
      .run(cutoff);
    return typeof result.changes === "number" ? result.changes : 0;
  }
}
