/**
 * Episodic Event Log — Layer 1 of the three-layer memory architecture.
 *
 * Captures raw episodic events during a session before they are consolidated
 * into long-term facts (Layer 2) or archived (Layer 3). Acts as a high-fidelity
 * journal: what happened, when, in which session, and involving which entities.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

export type EventType =
  | "fact_learned"
  | "decision_made"
  | "action_taken"
  | "entity_mentioned"
  | "preference_expressed"
  | "correction";

export interface EventLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  eventType: EventType;
  content: Record<string, unknown>;
  entities?: string[];
  consolidatedInto?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export class EventLog {
  private db: Database.Database;
  private readonly dbPath: string;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('fact_learned', 'decision_made', 'action_taken', 'entity_mentioned', 'preference_expressed', 'correction')),
        content TEXT NOT NULL,
        entities TEXT,
        consolidated_into TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_event_log_consolidated ON event_log(consolidated_into);
    `);
  }

  private get liveDb(): Database.Database {
    if (!this.db.open) {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    }
    return this.db;
  }

  /** Append a single event and return its generated id. */
  append(entry: Omit<EventLogEntry, "id" | "createdAt">): string {
    const id = randomUUID();
    this.liveDb
      .prepare(
        `INSERT INTO event_log (id, session_id, timestamp, event_type, content, entities, consolidated_into, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.sessionId,
        entry.timestamp,
        entry.eventType,
        JSON.stringify(entry.content),
        entry.entities != null ? JSON.stringify(entry.entities) : null,
        entry.consolidatedInto ?? null,
        entry.metadata != null ? JSON.stringify(entry.metadata) : null,
      );
    return id;
  }

  /** Append multiple events atomically. Returns array of generated ids in input order. */
  appendBatch(entries: Omit<EventLogEntry, "id" | "createdAt">[]): string[] {
    const ids: string[] = [];
    const stmt = this.liveDb.prepare(
      `INSERT INTO event_log (id, session_id, timestamp, event_type, content, entities, consolidated_into, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.liveDb.transaction(
      (batch: Omit<EventLogEntry, "id" | "createdAt">[]) => {
        for (const entry of batch) {
          const id = randomUUID();
          ids.push(id);
          stmt.run(
            id,
            entry.sessionId,
            entry.timestamp,
            entry.eventType,
            JSON.stringify(entry.content),
            entry.entities != null ? JSON.stringify(entry.entities) : null,
            entry.consolidatedInto ?? null,
            entry.metadata != null ? JSON.stringify(entry.metadata) : null,
          );
        }
      },
    );
    insertAll(entries);
    return ids;
  }

  /** Return events for a session, newest-first by default with a safety limit. */
  getBySession(sessionId: string, limit = 1000): EventLogEntry[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM event_log WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Return events whose timestamp falls within [from, to] (ISO strings), optionally filtered by eventType. */
  getByTimeRange(from: string, to: string, eventType?: string): EventLogEntry[] {
    const params: unknown[] = [from, to];
    let query = `SELECT * FROM event_log WHERE timestamp >= ? AND timestamp <= ?`;
    if (eventType) {
      query += ` AND event_type = ?`;
      params.push(eventType);
    }
    query += ` ORDER BY timestamp ASC`;
    const rows = this.liveDb.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Return events not yet consolidated into a fact. Optionally only events older than N days. */
  getUnconsolidated(olderThanDays?: number): EventLogEntry[] {
    const params: unknown[] = [];
    let query = `SELECT * FROM event_log WHERE consolidated_into IS NULL`;
    if (olderThanDays !== undefined) {
      const cutoff = new Date(
        Date.now() - olderThanDays * 24 * 3600 * 1000,
      ).toISOString();
      query += ` AND timestamp < ?`;
      params.push(cutoff);
    }
    query += ` ORDER BY timestamp ASC`;
    const rows = this.liveDb.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Return events that mention the given entity name (exact match within the entities JSON array). */
  getByEntity(entityName: string, limit = 1000): EventLogEntry[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM event_log
         WHERE entities IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(entities) WHERE value = ?)
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(entityName, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Mark a set of events as consolidated into the given fact id. */
  markConsolidated(eventIds: string[], factId: string): void {
    const stmt = this.liveDb.prepare(
      `UPDATE event_log SET consolidated_into = ? WHERE id = ?`,
    );
    const updateAll = this.liveDb.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(factId, id);
      }
    });
    updateAll(eventIds);
  }

  /**
   * Delete events whose timestamp is older than N days.
   * Returns the number of rows deleted.
   */
  archiveOld(olderThanDays: number): number {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 3600 * 1000,
    ).toISOString();
    const result = this.liveDb
      .prepare(`DELETE FROM event_log WHERE timestamp < ?`)
      .run(cutoff);
    return result.changes;
  }

  /** Return aggregate statistics about the event log. */
  getStats(): {
    total: number;
    unconsolidated: number;
    byType: Record<string, number>;
    oldestUnconsolidated: string | null;
  } {
    const totalRow = this.liveDb
      .prepare(`SELECT COUNT(*) AS count FROM event_log`)
      .get() as { count: number };
    const unconsolidatedRow = this.liveDb
      .prepare(
        `SELECT COUNT(*) AS count FROM event_log WHERE consolidated_into IS NULL`,
      )
      .get() as { count: number };
    const typeRows = this.liveDb
      .prepare(
        `SELECT event_type, COUNT(*) AS count FROM event_log GROUP BY event_type`,
      )
      .all() as { event_type: string; count: number }[];
    const oldestRow = this.liveDb
      .prepare(
        `SELECT MIN(timestamp) AS oldest FROM event_log WHERE consolidated_into IS NULL`,
      )
      .get() as { oldest: string | null };

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.event_type] = row.count;
    }

    return {
      total: totalRow?.count ?? 0,
      unconsolidated: unconsolidatedRow?.count ?? 0,
      byType,
      oldestUnconsolidated: oldestRow?.oldest ?? null,
    };
  }

  private rowToEntry(row: Record<string, unknown>): EventLogEntry {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(row["content"] as string) as Record<string, unknown>;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "json-parse-content",
        severity: "info",
        subsystem: "event-log",
      });
    }

    let entities: string[] | undefined;
    if (row["entities"] != null) {
      try {
        entities = JSON.parse(row["entities"] as string) as string[];
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse-entities",
          severity: "info",
          subsystem: "event-log",
        });
      }
    }

    let metadata: Record<string, unknown> | undefined;
    if (row["metadata"] != null) {
      try {
        metadata = JSON.parse(row["metadata"] as string) as Record<string, unknown>;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse-metadata",
          severity: "info",
          subsystem: "event-log",
        });
      }
    }

    return {
      id: row["id"] as string,
      sessionId: row["session_id"] as string,
      timestamp: row["timestamp"] as string,
      eventType: row["event_type"] as EventType,
      content,
      entities,
      consolidatedInto:
        row["consolidated_into"] != null
          ? (row["consolidated_into"] as string)
          : undefined,
      metadata,
      createdAt: row["created_at"] as string,
    };
  }

  /** True if the database connection is still open. */
  isOpen(): boolean {
    return !this.closed;
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
        subsystem: "event-log",
      });
    }
  }
}
