/**
 * Episodic Event Log — Layer 1 of the three-layer memory architecture.
 *
 * Captures raw episodic events during a session before they are consolidated
 * into long-term facts (Layer 2) or archived (Layer 3). Acts as a high-fidelity
 * journal: what happened, when, in which session, and involving which entities.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, createWriteStream, createReadStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import { capturePluginError } from "../services/error-reporter.js";
import { expandTilde } from "../utils/path.js";

export type EventType =
  | "fact_learned"
  | "decision_made"
  | "action_taken"
  | "entity_mentioned"
  | "preference_expressed"
  | "correction";

export function categoryToEventType(category: string): EventType {
  switch (category) {
    case "preference":
      return "preference_expressed";
    case "decision":
      return "decision_made";
    case "action":
      return "action_taken";
    case "entity":
      return "entity_mentioned";
    default:
      return "fact_learned";
  }
}

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

export class EventLog extends BaseSqliteStore {
  private readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.dbPath = dbPath;

    this.liveDb.exec(`
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

  protected getSubsystemName(): string {
    return "event-log";
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
    const insertAll = createTransaction(this.liveDb, (batch: Omit<EventLogEntry, "id" | "createdAt">[]) => {
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
    });
    insertAll(entries);
    return ids;
  }

  /** Return events for a session in chronological order (oldest-first) with a safety limit. */
  getBySession(sessionId: string, limit = 1000): EventLogEntry[] {
    const rows = this.liveDb
      .prepare("SELECT * FROM event_log WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?")
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Return a single event by id (or null if not found). */
  getById(id: string): EventLogEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM event_log WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /** Return events whose timestamp falls within [from, to] (ISO strings), optionally filtered by eventType. */
  getByTimeRange(from: string, to: string, eventType?: string): EventLogEntry[] {
    const params: SQLInputValue[] = [from, to];
    let query = "SELECT * FROM event_log WHERE timestamp >= ? AND timestamp <= ?";
    if (eventType) {
      query += " AND event_type = ?";
      params.push(eventType);
    }
    query += " ORDER BY timestamp ASC";
    const rows = this.liveDb.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Return events not yet consolidated into a fact. Optionally only events older than N days. */
  getUnconsolidated(olderThanDays?: number): EventLogEntry[] {
    const params: SQLInputValue[] = [];
    let query = "SELECT * FROM event_log WHERE consolidated_into IS NULL";
    if (olderThanDays !== undefined) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
      query += " AND timestamp < ?";
      params.push(cutoff);
    }
    query += " ORDER BY timestamp ASC";
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
    const stmt = this.liveDb.prepare("UPDATE event_log SET consolidated_into = ? WHERE id = ?");
    const updateAll = createTransaction(this.liveDb, (ids: string[]) => {
      for (const id of ids) {
        stmt.run(factId, id);
      }
    });
    updateAll(eventIds);
  }

  /**
   * Archive consolidated events older than N days to compressed JSONL files.
   * Returns the number of rows archived and the files written.
   */
  async archiveConsolidated(olderThanDays: number, archiveDir: string): Promise<{ archived: number; files: string[] }> {
    if (olderThanDays <= 0) return { archived: 0, files: [] };
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    const resolvedDir = expandTilde(archiveDir);
    mkdirSync(resolvedDir, { recursive: true });

    const months = this.liveDb
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', timestamp) AS ym
         FROM event_log
         WHERE timestamp < ? AND consolidated_into IS NOT NULL
         ORDER BY ym ASC`,
      )
      .all(cutoff) as { ym: string | null }[];

    const files: string[] = [];
    let archived = 0;
    for (const row of months) {
      const month = row.ym;
      if (!month) continue;
      const countRow = this.liveDb
        .prepare(
          `SELECT COUNT(*) AS count FROM event_log
           WHERE timestamp < ?
             AND consolidated_into IS NOT NULL
             AND strftime('%Y-%m', timestamp) = ?`,
        )
        .get(cutoff, month) as { count: number };
      if (!countRow?.count) continue;

      const ids: string[] = [];
      const stmt = this.liveDb.prepare(
        `SELECT * FROM event_log
         WHERE timestamp < ?
           AND consolidated_into IS NOT NULL
           AND strftime('%Y-%m', timestamp) = ?
         ORDER BY timestamp ASC`,
      );
      const filePath = join(resolvedDir, `${month}.jsonl.gz`);
      const tempPath = `${filePath}.tmp`;
      const rowToEntry = this.rowToEntry.bind(this);

      try {
        const lineStream = Readable.from(
          (async function* () {
            const seenIds = new Set<string>();

            if (existsSync(filePath)) {
              try {
                const input = createReadStream(filePath).pipe(createGunzip());
                const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
                for await (const line of rl) {
                  if (!line.trim()) continue;
                  try {
                    const o = JSON.parse(line) as { id?: string };
                    if (o.id) seenIds.add(o.id);
                  } catch {
                    // Skip corrupt line but still yield to preserve archive
                  }
                  yield `${line}\n`;
                }
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  operation: "read-existing-archive",
                  severity: "info",
                  subsystem: "event-log",
                });
                const backupPath = `${filePath}.corrupted.${Date.now()}`;
                try {
                  renameSync(filePath, backupPath);
                } catch (renameErr) {
                  capturePluginError(renameErr instanceof Error ? renameErr : new Error(String(renameErr)), {
                    operation: "backup-corrupted-archive",
                    severity: "info",
                    subsystem: "event-log",
                  });
                }
              }
            }

            for (const r of stmt.iterate(cutoff, month) as Iterable<Record<string, unknown>>) {
              const entry = rowToEntry(r);
              ids.push(entry.id);
              if (!seenIds.has(entry.id)) {
                seenIds.add(entry.id);
                yield `${JSON.stringify(entry)}\n`;
              }
            }
          })(),
        );

        await pipeline(lineStream, createGzip(), createWriteStream(tempPath));

        // renameSync must succeed before we delete source rows.
        // If rename throws, we fall into the catch block and tempPath is cleaned up.
        renameSync(tempPath, filePath);

        // Only delete rows after both the write pipeline AND the atomic rename have
        // succeeded — ensures rows are never deleted from SQLite unless their data
        // is safely in the final archive file.
        const del = this.liveDb.prepare("DELETE FROM event_log WHERE id = ?");
        const deleteBatch = createTransaction(this.liveDb, (batch: string[]) => {
          for (const id of batch) del.run(id);
        });
        deleteBatch(ids);
        files.push(filePath);
        archived += ids.length;
      } catch (err) {
        if (existsSync(tempPath)) {
          try {
            unlinkSync(tempPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        throw err;
      }
    }
    return { archived, files };
  }

  /**
   * Delete events whose timestamp is older than N days.
   * By default, only deletes events that have already been consolidated
   * (consolidated_into IS NOT NULL) to prevent silent data loss of unprocessed
   * episodic events. When includeUnconsolidated is true, deletes all old events.
   * Returns the number of rows deleted.
   */
  archiveOld(olderThanDays: number, includeUnconsolidated = false): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    const result = this.liveDb
      .prepare("DELETE FROM event_log WHERE timestamp < ? AND (consolidated_into IS NOT NULL OR ?)")
      .run(cutoff, includeUnconsolidated ? 1 : 0);
    return Number(result.changes);
  }

  /** Return aggregate statistics about the event log. */
  getStats(): {
    total: number;
    unconsolidated: number;
    byType: Record<string, number>;
    oldestUnconsolidated: string | null;
  } {
    const totalRow = this.liveDb.prepare("SELECT COUNT(*) AS count FROM event_log").get() as { count: number };
    const unconsolidatedRow = this.liveDb
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE consolidated_into IS NULL")
      .get() as { count: number };
    const typeRows = this.liveDb
      .prepare("SELECT event_type, COUNT(*) AS count FROM event_log GROUP BY event_type")
      .all() as { event_type: string; count: number }[];
    const oldestRow = this.liveDb
      .prepare("SELECT MIN(timestamp) AS oldest FROM event_log WHERE consolidated_into IS NULL")
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
      content = JSON.parse(row.content as string) as Record<string, unknown>;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "json-parse-content",
        severity: "info",
        subsystem: "event-log",
      });
    }

    let entities: string[] | undefined;
    if (row.entities != null) {
      try {
        entities = JSON.parse(row.entities as string) as string[];
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse-entities",
          severity: "info",
          subsystem: "event-log",
        });
      }
    }

    let metadata: Record<string, unknown> | undefined;
    if (row.metadata != null) {
      try {
        metadata = JSON.parse(row.metadata as string) as Record<string, unknown>;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse-metadata",
          severity: "info",
          subsystem: "event-log",
        });
      }
    }

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as string,
      eventType: row.event_type as EventType,
      content,
      entities,
      consolidatedInto: row.consolidated_into != null ? (row.consolidated_into as string) : undefined,
      metadata,
      createdAt: row.created_at as string,
    };
  }
}
