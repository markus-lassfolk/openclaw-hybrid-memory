/**
 * EdictStore — SQLite-backed store for verified ground-truth facts.
 *
 * Edicts are facts that are:
 * 1. Verified — confidence is explicitly marked as verified by a human or trusted source
 * 2. Non-negotiable — the agent treats it as true without reasoning
 * 3. Forced-injection — always included in context regardless of token budget pressure
 * 4. Small and declarative — not a story, just a statement of fact
 *
 * Edicts are stored separately from facts (own table) to allow independent lifecycle
 * management and to ensure they are never pruned by normal memory decay.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serializeTags, parseTags } from "../utils/tags.js";
import { capturePluginError } from "../services/error-reporter.js";

/** TTL modes for edicts */
export type EdictTtl = "never" | "event" | number;

/** An edict entry — verified ground-truth fact */
export interface EdictEntry {
  id: string;
  /** The verified statement of fact */
  text: string;
  /** Optional source describing who or what verified this edict (e.g. "human:markus", "ops:oncall-runbook") */
  source?: string | null;
  /** Unix timestamp when this edict was verified */
  verifiedAt: number | null;
  /** ISO 8601 date or null. Edict expires after this date (for ttl="event"). */
  expiresAt: string | null;
  /** TTL mode: "never" (permanent), "event" (expiresAt date), or seconds (ttl as number) */
  ttl: EdictTtl;
  /** Labels for filtering (e.g. ["operations", "ssh"]) */
  tags: string[];
  /** When this edict was created (Unix epoch seconds) */
  createdAt: number;
  /** When this edict was last updated (Unix epoch seconds) */
  updatedAt: number;
}

/** Input for creating a new edict */
export interface AddEdictInput {
  text: string;
  source?: string;
  tags?: string[];
  ttl?: EdictTtl;
  expiresAt?: string;
}

/** Input for updating an existing edict */
export interface UpdateEdictInput {
  id: string;
  text?: string;
  source?: string;
  tags?: string[];
  ttl?: EdictTtl;
  expiresAt?: string;
}

/** Options for listing/retrieving edicts */
export interface ListEdictsOptions {
  tags?: string[];
  includeExpired?: boolean;
  limit?: number;
}

/** Options for getEdicts (extends ListEdictsOptions) */
export interface GetEdictsOptions extends ListEdictsOptions {
  format?: "full" | "prompt";
}

/** Statistics about the edict store */
export interface EdictStats {
  total: number;
  byTag: Record<string, number>;
  expired: number;
  expiringIn7Days: number;
}

/** Render an edict as a Markdown bullet line with tag prefix */
function renderEdictLine(edict: EdictEntry): string {
  const tagStr = edict.tags.length > 0 ? `[${edict.tags[0]}] ` : "";
  return `- ${tagStr}${edict.text}`;
}

/** Render a list of edicts as a Markdown block for system prompt injection */
export function renderEdictsForPrompt(edicts: EdictEntry[]): string {
  if (edicts.length === 0) return "";
  const header = "## Verified Ground Truth\n";
  const lines = edicts.map((e) => renderEdictLine(e));
  return header + lines.join("\n") + "\n";
}

/** Escape a string for safe use as a SQLite LIKE pattern */
function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export class EdictStore {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.runMigrations();
  }

  /** Run all schema migrations. Idempotent — safe to call on existing databases. */
  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edicts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT,
        verified_at INTEGER,
        expires_at TEXT,
        ttl TEXT NOT NULL DEFAULT 'never',
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edicts_tags ON edicts(tags)
        WHERE tags IS NOT NULL AND tags != ''
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edicts_expires ON edicts(expires_at)
        WHERE expires_at IS NOT NULL
    `);

    // Ensure the id column is present (backward compat for edicts created before id was added)
    const tableInfo = this.db.prepare("PRAGMA table_info(edicts)").all() as Array<{ name: string }>;
    if (!tableInfo.some((c) => c.name === "id")) {
      this.db.exec("ALTER TABLE edicts ADD COLUMN id TEXT PRIMARY KEY");
    }
  }

  /** Check if an edict is currently expired (based on ttl and expires_at) */
  isExpired(edict: EdictEntry): boolean {
    if (edict.ttl === "never") return false;
    if (edict.ttl === "event") {
      if (!edict.expiresAt) return false;
      return new Date(edict.expiresAt) <= new Date();
    }
    // Numeric TTL: seconds since creation
    const ttlSec = typeof edict.ttl === "number" ? edict.ttl : 0;
    return Date.now() / 1000 > edict.createdAt + ttlSec;
  }

  /** Add a new edict. Returns the created edict. Throws on duplicate text (normalized). */
  add(input: AddEdictInput): EdictEntry {
    const nowSec = Math.floor(Date.now() / 1000);
    const id = `e_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const source = input.source ?? null;
    const tagsStr = input.tags && input.tags.length > 0 ? serializeTags(input.tags) : null;
    const ttl: EdictTtl = input.ttl ?? "never";

    // Serialize ttl
    const ttlStr = typeof ttl === "number" ? String(ttl) : ttl;

    // For ttl="event", expiresAt is required
    const expiresAt = input.expiresAt ?? (ttl === "event" ? null : null);

    // Check for duplicate text (case-insensitive, normalized whitespace)
    const normalizedText = input.text.trim().replace(/\s+/g, " ").toLowerCase();
    const existing = this.findByNormalizedText(normalizedText);
    if (existing) {
      throw new Error(`Edict with similar text already exists: ${existing.id}`);
    }

    this.db
      .prepare(
        `INSERT INTO edicts (id, text, source, verified_at, expires_at, ttl, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.text.trim(), source, nowSec, expiresAt, ttlStr, tagsStr, nowSec, nowSec);

    return {
      id,
      text: input.text.trim(),
      source,
      verifiedAt: nowSec,
      expiresAt,
      ttl,
      tags: input.tags ?? [],
      createdAt: nowSec,
      updatedAt: nowSec,
    };
  }

  /** Find an edict by normalized text (for duplicate detection) */
  private findByNormalizedText(normalized: string): EdictEntry | null {
    const rows = this.db
      .prepare("SELECT * FROM edicts")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const storedText = (row.text as string).trim().replace(/\s+/g, " ").toLowerCase();
      if (storedText === normalized) {
        return this.rowToEntry(row);
      }
    }
    return null;
  }

  /** Get a single edict by id */
  getById(id: string): EdictEntry | null {
    const row = this.db.prepare("SELECT * FROM edicts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /** List edicts, optionally filtered by tags */
  list(options: ListEdictsOptions = {}): EdictEntry[] {
    const { tags, includeExpired = false, limit = 100 } = options;
    const nowSec = Math.floor(Date.now() / 1000);
    const parts: string[] = [];
    const params: SQLInputValue[] = [];

    if (!includeExpired) {
      parts.push(
        `((ttl = 'never') OR (ttl = 'event' AND (expires_at IS NULL OR expires_at > datetime(?))) OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) > ?))`,
      );
      params.push(new Date().toISOString(), nowSec);
    }

    if (tags && tags.length > 0) {
      for (const tag of tags) {
        parts.push(`(',' || COALESCE(tags, '') || ',') LIKE ?`);
        params.push(`%,${escapeLikePattern(tag.toLowerCase())},%`);
      }
    }

    const where = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM edicts ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEntry(r));
  }

  /** Get all non-expired edicts, optionally filtered by tags */
  getEdicts(options: GetEdictsOptions = {}): { edicts: EdictEntry[]; renderForPrompt: string } {
    const { tags, format = "prompt", limit = 100 } = options;
    const edicts = this.list({ tags, includeExpired: false, limit });
    const renderForPrompt = format === "prompt" ? renderEdictsForPrompt(edicts) : "";
    return { edicts, renderForPrompt };
  }

  /** Update an existing edict. Returns the updated edict or null if not found. */
  update(input: UpdateEdictInput): EdictEntry | null {
    const existing = this.getById(input.id);
    if (!existing) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const text = input.text !== undefined ? input.text.trim() : existing.text;
    const source = input.source !== undefined ? input.source : existing.source;
    const tags = input.tags !== undefined ? input.tags : existing.tags;
    const ttl = input.ttl !== undefined ? input.ttl : existing.ttl;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
    const ttlStr = typeof ttl === "number" ? String(ttl) : ttl;
    const tagsStr = tags.length > 0 ? serializeTags(tags) : null;

    this.db
      .prepare(`UPDATE edicts SET text = ?, source = ?, expires_at = ?, ttl = ?, tags = ?, updated_at = ? WHERE id = ?`)
      .run(text, source ?? null, expiresAt ?? null, ttlStr, tagsStr, nowSec, input.id);

    return {
      ...existing,
      text,
      source,
      expiresAt,
      ttl,
      tags,
      updatedAt: nowSec,
    };
  }

  /** Remove an edict by id */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM edicts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Count total edicts */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM edicts").get() as { cnt: number };
    return row.cnt;
  }

  /** Get statistics about the edict store */
  stats(): EdictStats {
    const nowSec = Math.floor(Date.now() / 1000);
    const total = this.count();

    // Count expired (ttl="event" with expires_at in the past, or numeric TTL that's elapsed)
    const expiredRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edicts WHERE
         (ttl = 'event' AND expires_at IS NOT NULL AND expires_at <= datetime(?))
         OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) <= ?)`,
      )
      .get(new Date().toISOString(), nowSec) as { cnt: number };
    const expired = expiredRow.cnt;

    // Count expiring in next 7 days (only ttl="event")
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const expiringRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edicts WHERE ttl = 'event' AND expires_at IS NOT NULL AND expires_at > datetime(?) AND expires_at <= ?`,
      )
      .get(new Date().toISOString(), sevenDaysFromNow) as { cnt: number };
    const expiringIn7Days = expiringRow.cnt;

    // Count by tag
    const allRows = this.db.prepare("SELECT tags FROM edicts").all() as Array<{ tags: string | null }>;
    const byTag: Record<string, number> = {};
    for (const row of allRows) {
      if (!row.tags) continue;
      const parsed = parseTags(row.tags);
      for (const tag of parsed) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
      }
    }

    return { total, byTag, expired, expiringIn7Days };
  }

  /** Prune all expired edicts. Returns count of deleted rows. */
  pruneExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        `DELETE FROM edicts WHERE
         (ttl = 'event' AND expires_at IS NOT NULL AND expires_at <= datetime(?))
         OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) <= ?)`,
      )
      .run(new Date().toISOString(), nowSec);
    return Number(result.changes ?? 0);
  }

  /** Convert a raw SQLite row to an EdictEntry */
  private rowToEntry(row: Record<string, unknown>): EdictEntry {
    const ttlRaw = (row.ttl as string) ?? "never";
    const ttl: EdictTtl = ttlRaw === "never" ? "never" : ttlRaw === "event" ? "event" : Number(ttlRaw);

    return {
      id: row.id as string,
      text: row.text as string,
      source: (row.source as string) ?? null,
      verifiedAt: (row.verified_at as number) ?? null,
      expiresAt: (row.expires_at as string) ?? null,
      ttl,
      tags: parseTags(row.tags as string | null),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}
