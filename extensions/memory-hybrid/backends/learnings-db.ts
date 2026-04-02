/**
 * Learnings DB — SQLite backend for the `.learnings/` intake buffer (Issue #617).
 *
 * Stages errors, lessons, and feature requests for human review before
 * promoting them to permanent memory or documentation.
 *
 * Engineering Goals addressed:
 *  - Rock-Solid Stability: WAL mode, busy_timeout, graceful close.
 *  - Strict Separation of Concerns: storage-only layer, no promotion logic here.
 *  - Testability: single constructor arg, no global state.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { capturePluginError } from "../services/error-reporter.js";
import type {
  CreateLearningEntryInput,
  LearningEntry,
  LearningEntryStatus,
  LearningEntryType,
} from "../types/learnings-types.js";
import { LEARNING_STATUS_TRANSITIONS } from "../types/learnings-types.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

/** TYPE_PREFIX maps entry type → slug prefix character(s). */
const TYPE_PREFIX: Record<LearningEntryType, string> = {
  error: "ERR",
  learning: "LRN",
  feature_request: "FR",
};

interface LearningRow {
  id: string;
  slug: string;
  type: string;
  status: string;
  area: string;
  content: string;
  recurrence: number;
  promoted_to: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

export class LearningsDB extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS learnings (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        area        TEXT NOT NULL,
        content     TEXT NOT NULL,
        recurrence  INTEGER NOT NULL DEFAULT 1,
        promoted_to TEXT,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_type   ON learnings(type);
      CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings(status);
      CREATE INDEX IF NOT EXISTS idx_learnings_area   ON learnings(area);
    `);
  }

  protected getSubsystemName(): string {
    return "learnings-db";
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  create(input: CreateLearningEntryInput): LearningEntry {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.liveDb.exec("BEGIN IMMEDIATE");
    try {
      const seq = this.nextSeq(input.type);
      const slug = `${TYPE_PREFIX[input.type]}-${String(seq).padStart(3, "0")}`;

      this.liveDb
        .prepare(
          `INSERT INTO learnings (id, slug, type, status, area, content, recurrence, tags, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, 1, ?, ?, ?)`,
        )
        .run(id, slug, input.type, input.area, input.content, JSON.stringify(input.tags ?? []), now, now);

      this.liveDb.exec("COMMIT");
      // biome-ignore lint/style/noNonNullAssertion: Known to exist
      return this.get(id)!;
    } catch (err) {
      this.liveDb.exec("ROLLBACK");
      throw err;
    }
  }

  /** Increment the recurrence counter on an existing entry (same issue recurred). */
  incrementRecurrence(id: string): LearningEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`LearningEntry not found: ${id}`);

    const now = new Date().toISOString();
    this.liveDb.prepare("UPDATE learnings SET recurrence = recurrence + 1, updated_at = ? WHERE id = ?").run(now, id);

    // biome-ignore lint/style/noNonNullAssertion: Known to exist
    return this.get(id)!;
  }

  transition(id: string, newStatus: LearningEntryStatus, promotedTo?: string): LearningEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`LearningEntry not found: ${id}`);

    const allowed = LEARNING_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${existing.status} → ${newStatus}. Allowed: ${allowed.join(", ") || "none"}`,
      );
    }

    if (newStatus === "promoted" && !promotedTo) {
      throw new Error(`promotedTo is required when transitioning to "promoted" status`);
    }

    const now = new Date().toISOString();
    const sets: string[] = ["status = ?", "updated_at = ?"];
    const params: SQLInputValue[] = [newStatus, now];

    if (newStatus === "promoted" && promotedTo) {
      sets.push("promoted_to = ?");
      params.push(promotedTo);
    }

    params.push(id);
    this.liveDb.prepare(`UPDATE learnings SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    // biome-ignore lint/style/noNonNullAssertion: Known to exist
    return this.get(id)!;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  get(id: string): LearningEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as unknown as
      | LearningRow
      | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  getBySlug(slug: string): LearningEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM learnings WHERE slug = ?").get(slug) as unknown as
      | LearningRow
      | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  list(filter?: {
    type?: LearningEntryType[];
    status?: LearningEntryStatus[];
    area?: string;
    limit?: number;
  }): LearningEntry[] {
    let query = "SELECT * FROM learnings WHERE 1=1";
    const params: SQLInputValue[] = [];

    if (filter?.type && filter.type.length > 0) {
      query += ` AND type IN (${filter.type.map(() => "?").join(", ")})`;
      params.push(...filter.type);
    }
    if (filter?.status && filter.status.length > 0) {
      query += ` AND status IN (${filter.status.map(() => "?").join(", ")})`;
      params.push(...filter.status);
    }
    if (filter?.area) {
      query += " AND area = ?";
      params.push(filter.area);
    }

    query += " ORDER BY created_at DESC";

    if (filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.liveDb.prepare(query).all(...params) as unknown as LearningRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  count(filter?: { type?: LearningEntryType; status?: LearningEntryStatus }): number {
    let query = "SELECT COUNT(*) as n FROM learnings WHERE 1=1";
    const params: SQLInputValue[] = [];
    if (filter?.type) {
      query += " AND type = ?";
      params.push(filter.type);
    }
    if (filter?.status) {
      query += " AND status = ?";
      params.push(filter.status);
    }
    const row = this.liveDb.prepare(query).get(...params) as unknown as { n: number };
    return row.n;
  }

  findByAreaContent(
    type: LearningEntryType,
    area: string,
    content: string,
    status: LearningEntryStatus,
  ): LearningEntry | null {
    const row = this.liveDb
      .prepare("SELECT * FROM learnings WHERE type = ? AND area = ? AND content = ? AND status = ?")
      .get(type, area, content, status) as unknown as LearningRow | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Remove promoted/wont_promote entries older than N days. */
  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.liveDb
      .prepare(`DELETE FROM learnings WHERE status IN ('promoted', 'wont_promote') AND updated_at <= ?`)
      .run(cutoff);
    return Number(result.changes);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Return the next sequential number for slugs of a given type. */
  private nextSeq(type: LearningEntryType): number {
    const prefix = TYPE_PREFIX[type];
    const rows = this.liveDb.prepare("SELECT slug FROM learnings WHERE slug LIKE ?").all(`${prefix}-%`) as unknown as {
      slug: string;
    }[];

    if (rows.length === 0) return 1;

    let maxSeq = 0;
    for (const row of rows) {
      const match = row.slug.match(/-(\d+)$/);
      if (match) {
        const seq = Number.parseInt(match[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    }
    return maxSeq + 1;
  }

  private rowToEntry(row: LearningRow): LearningEntry {
    function parseJson<T>(value: string | null | undefined, fallback: T): T {
      if (!value) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse",
          subsystem: "learnings-db",
          severity: "info",
        });
        return fallback;
      }
    }

    return {
      id: row.id,
      slug: row.slug,
      type: row.type as LearningEntryType,
      status: row.status as LearningEntryStatus,
      area: row.area,
      content: row.content,
      recurrence: row.recurrence,
      promotedTo: row.promoted_to ?? undefined,
      tags: parseJson<string[]>(row.tags, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
