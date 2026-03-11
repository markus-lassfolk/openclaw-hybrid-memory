/**
 * Event Bus — append-only SQLite table that all sensor sweeps write to and the
 * Rumination Engine reads from.
 *
 * Status lifecycle: raw → processed → surfaced → pushed → archived
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

export type EventStatus = "raw" | "processed" | "surfaced" | "pushed" | "archived";

export interface MemoryEvent {
  id: number;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  importance: number;
  status: EventStatus;
  created_at: string;
  processed_at: string | null;
  fingerprint: string | null;
}

export interface QueryFilter {
  status?: EventStatus;
  type?: string;
  since?: string;
  limit?: number;
}

/**
 * Compute a SHA-256 fingerprint from a string.
 * Callers compose the input from type + entity_id + summary + ttl_bucket.
 */
export function computeFingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export class EventBus {
  private db: Database.Database;
  private readonly dbPath: string;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.migrate();
  }

  private migrate(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        status TEXT DEFAULT 'raw',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        processed_at TEXT,
        fingerprint TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_status ON memory_events(status);
      CREATE INDEX IF NOT EXISTS idx_events_type ON memory_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON memory_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON memory_events(fingerprint);
    `);
  }

  private get liveDb(): Database.Database {
    if (this.closed) {
      throw new Error("EventBus is closed");
    }
    if (!this.db.open) {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    }
    return this.db;
  }

  /**
   * Append a new event and return its auto-generated id.
   */
  appendEvent(
    type: string,
    source: string,
    payload: Record<string, unknown>,
    importance = 0.5,
    fingerprint?: string,
  ): number {
    const result = this.liveDb
      .prepare(
        `INSERT INTO memory_events (event_type, source, payload, importance, fingerprint)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(type, source, JSON.stringify(payload), importance, fingerprint ?? null);
    return result.lastInsertRowid as number;
  }

  /**
   * Query events with optional filters.
   */
  queryEvents(filter: QueryFilter = {}): MemoryEvent[] {
    const { status, type, since, limit = 100 } = filter;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status !== undefined) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (type !== undefined) {
      conditions.push("event_type = ?");
      params.push(type);
    }
    if (since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM memory_events ${where} ORDER BY id ASC LIMIT ?`;
    params.push(limit);

    const rows = this.liveDb.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * Update the status of an event. Sets processed_at when transitioning away from 'raw'.
   */
  updateStatus(id: number, newStatus: EventStatus): void {
    const processedAt = newStatus !== "raw" ? new Date().toISOString() : null;
    this.liveDb
      .prepare(
        `UPDATE memory_events SET status = ?, processed_at = COALESCE(processed_at, ?) WHERE id = ?`,
      )
      .run(newStatus, processedAt, id);
  }

  /**
   * Check if a recent duplicate exists for the given fingerprint within a cooldown window.
   * Returns true if a duplicate was found (caller should skip inserting).
   */
  dedup(fingerprint: string, cooldownHours = 6): boolean {
    const cutoff = new Date(Date.now() - cooldownHours * 3600 * 1000).toISOString();
    const row = this.liveDb
      .prepare(
        `SELECT 1 FROM memory_events
         WHERE fingerprint = ? AND created_at >= ?
         LIMIT 1`,
      )
      .get(fingerprint, cutoff);
    return row !== undefined;
  }

  /**
   * Delete archived events older than N days. Returns the number of rows deleted.
   */
  pruneArchived(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    const result = this.liveDb
      .prepare(`DELETE FROM memory_events WHERE status = 'archived' AND created_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row["payload"] as string) as Record<string, unknown>;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "json-parse-payload",
        severity: "info",
        subsystem: "event-bus",
      });
    }

    return {
      id: row["id"] as number,
      event_type: row["event_type"] as string,
      source: row["source"] as string,
      payload,
      importance: row["importance"] as number,
      status: row["status"] as EventStatus,
      created_at: row["created_at"] as string,
      processed_at: (row["processed_at"] as string | null) ?? null,
      fingerprint: (row["fingerprint"] as string | null) ?? null,
    };
  }

  isOpen(): boolean {
    return !this.closed && this.db.open;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        severity: "info",
        subsystem: "event-bus",
      });
    }
  }
}
