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

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { capturePluginError } from "../services/error-reporter.js";
import { parseTags, serializeTags } from "../utils/tags.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

/** TTL modes for edicts */
type EdictTtl = "never" | "event" | number;

function normalizeEdictText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseIsoDateToUnixSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** An edict entry — verified ground-truth fact */
interface EdictEntry {
  id: string;
  /** The verified statement of fact */
  text: string;
  /** Optional source describing who or what verified this edict (e.g. "human:markus", "ops:oncall-runbook") */
  source?: string | null;
  /** Unix timestamp when this edict was verified */
  verifiedAt: number | null;
  /** ISO 8601 date or null. Edict expires after this date (for ttl="event"). */
  expiresAt: string | null;
  /** Unix epoch seconds expiry (preferred for comparisons); derived from expiresAt. */
  expiresAtSec: number | null;
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
interface AddEdictInput {
  text: string;
  source?: string;
  tags?: string[];
  ttl?: EdictTtl;
  expiresAt?: string;
}

/** Input for updating an existing edict */
interface UpdateEdictInput {
  id: string;
  text?: string;
  source?: string;
  tags?: string[];
  ttl?: EdictTtl;
  expiresAt?: string;
}

/** Options for listing/retrieving edicts */
interface ListEdictsOptions {
  tags?: string[];
  includeExpired?: boolean;
  limit?: number;
}

/** Options for getEdicts (extends ListEdictsOptions) */
interface GetEdictsOptions extends ListEdictsOptions {
  format?: "full" | "prompt";
}

/** Statistics about the edict store */
interface EdictStats {
  total: number;
  byTag: Record<string, number>;
  expired: number;
  expiringIn7Days: number;
}

/** Render an edict as a Markdown bullet line with tag prefix */
function renderEdictLine(edict: EdictEntry): string {
  // Edicts are intended to be short and declarative, but cap pathological cases so
  // forced injection cannot explode prompt size.
  const MAX_EDICT_PROMPT_TEXT_CHARS = 1000;
  const tagStr = edict.tags.length > 0 ? `[${edict.tags[0]}] ` : "";
  const text =
    edict.text.length > MAX_EDICT_PROMPT_TEXT_CHARS
      ? `${edict.text.slice(0, MAX_EDICT_PROMPT_TEXT_CHARS)}…`
      : edict.text;
  return `- ${tagStr}${text}`;
}

/** Render a list of edicts as a Markdown block for system prompt injection */
function renderEdictsForPrompt(edicts: EdictEntry[]): string {
  if (edicts.length === 0) return "";
  const header = "## Verified Ground Truth\n";
  const lines = edicts.map((e) => renderEdictLine(e));
  return `${header + lines.join("\n")}\n`;
}

/** Escape a string for safe use as a SQLite LIKE pattern */
function escapeLikePattern(s: string): string {
  return s.replace(/[~%_]/g, "~$&");
}

export class EdictStore extends BaseSqliteStore {
  /** Set true only after `runMigrations()` completes successfully (issue #964 / #953). */
  private _isReady = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db, { deferClose: true });

    try {
      this.runMigrations();
      this._isReady = true;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "edict-store",
        operation: "runMigrations",
      });
      this._isReady = false;
    }
  }

  protected getSubsystemName(): string {
    return "edict-store";
  }

  /** Run all schema migrations. Idempotent — safe to call on existing databases. */
  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edicts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        normalized_text TEXT,
        source TEXT,
        verified_at INTEGER,
        expires_at TEXT,
        expires_at_sec INTEGER,
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

    // Backward-compat migrations for databases created before these columns existed.
    const tableInfo = this.db.prepare("PRAGMA table_info(edicts)").all() as Array<{ name: string }>;
    const hasCol = (name: string) => tableInfo.some((c) => c.name === name);

    if (!hasCol("id")) {
      // SQLite cannot add a PRIMARY KEY via ALTER TABLE; add a plain column + unique index instead.
      this.db.exec("ALTER TABLE edicts ADD COLUMN id TEXT");
    }
    // Populate ids for any legacy/incomplete rows deterministically enough for our use-case.
    this.db.exec("UPDATE edicts SET id = ('e_' || lower(hex(randomblob(6)))) WHERE id IS NULL OR id = ''");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_edicts_id_unique ON edicts(id)");

    if (!hasCol("normalized_text")) {
      this.db.exec("ALTER TABLE edicts ADD COLUMN normalized_text TEXT");
    }

    if (!hasCol("expires_at_sec")) {
      this.db.exec("ALTER TABLE edicts ADD COLUMN expires_at_sec INTEGER");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_edicts_expires_sec ON edicts(expires_at_sec)");

    // Backfill derived columns best-effort (id may already exist).
    const rows = this.db.prepare("SELECT rowid, id, text, expires_at FROM edicts ORDER BY rowid ASC").all() as Array<{
      rowid: number;
      id: string | null;
      text: string;
      expires_at: string | null;
    }>;

    const updateNorm = this.db.prepare("UPDATE edicts SET normalized_text = ? WHERE rowid = ?");
    const updateExpires = this.db.prepare("UPDATE edicts SET expires_at_sec = ? WHERE rowid = ?");
    for (const row of rows) {
      // Keep normalized_text in sync even for legacy rows.
      try {
        updateNorm.run(normalizeEdictText(row.text), row.rowid);
      } catch {
        // Best-effort only.
      }

      if (row.expires_at?.trim()) {
        const sec = parseIsoDateToUnixSeconds(row.expires_at.trim());
        if (sec != null) {
          try {
            updateExpires.run(sec, row.rowid);
          } catch {
            // Best-effort only.
          }
        }
      }
    }
  }

  /** Check if an edict is currently expired (based on ttl and expires_at) */
  isExpired(edict: EdictEntry): boolean {
    if (edict.ttl === "never") return false;
    if (edict.ttl === "event") {
      const expiresAt = edict.expiresAt?.trim();
      // Fail closed for malformed legacy rows: event TTL without a valid expiry is considered expired.
      if (!expiresAt) return true;
      const sec = edict.expiresAtSec ?? parseIsoDateToUnixSeconds(expiresAt);
      if (sec == null) return true;
      return Math.floor(Date.now() / 1000) >= sec;
    }
    // Numeric TTL: seconds since creation
    const ttlSec = typeof edict.ttl === "number" ? edict.ttl : 0;
    return Date.now() / 1000 > edict.createdAt + ttlSec;
  }

  /** Add a new edict. Returns the created edict. Throws on duplicate text (normalized). */
  add(input: AddEdictInput): EdictEntry {
    return this.runWithDb("add", () => this.addInternal(input));
  }

  private addInternal(input: AddEdictInput): EdictEntry {
    const nowSec = Math.floor(Date.now() / 1000);
    const id = `e_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const source = input.source ?? null;
    const tagsStr = input.tags && input.tags.length > 0 ? serializeTags(input.tags) : null;
    const ttl: EdictTtl = input.ttl ?? "never";

    const ttlStr = typeof ttl === "number" ? String(ttl) : ttl;

    if (typeof ttl === "number" && (!Number.isFinite(ttl) || ttl <= 0 || !Number.isInteger(ttl))) {
      throw new Error("Edict ttl must be a positive integer number of seconds, 'never', or 'event'");
    }

    const expiresAt = input.expiresAt ?? null;
    const expiresAtSec = expiresAt ? parseIsoDateToUnixSeconds(expiresAt) : null;
    if (ttl === "event") {
      if (!expiresAt) {
        throw new Error("Edict ttl='event' requires expiresAt (ISO 8601)");
      }
      if (expiresAtSec == null) {
        throw new Error("Edict expiresAt must be a valid ISO 8601 date");
      }
    }

    const normalizedText = normalizeEdictText(input.text);
    const existing = this.findByNormalizedTextInternal(normalizedText);
    if (existing) {
      throw new Error(`Edict with similar text already exists: ${existing.id}`);
    }

    this.liveDb
      .prepare(
        `INSERT INTO edicts (id, text, normalized_text, source, verified_at, expires_at, expires_at_sec, ttl, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.text.trim(),
        normalizedText,
        source,
        nowSec,
        expiresAt,
        expiresAtSec,
        ttlStr,
        tagsStr,
        nowSec,
        nowSec,
      );

    return {
      id,
      text: input.text.trim(),
      source,
      verifiedAt: nowSec,
      expiresAt,
      expiresAtSec,
      ttl,
      tags: input.tags ?? [],
      createdAt: nowSec,
      updatedAt: nowSec,
    };
  }

  /** Find an edict by normalized text (for duplicate detection) */
  private findByNormalizedTextInternal(normalized: string): EdictEntry | null {
    const rows = this.liveDb.prepare("SELECT * FROM edicts WHERE normalized_text = ? LIMIT 1").all(normalized) as Array<
      Record<string, unknown>
    >;
    return rows.length > 0 ? this.rowToEntry(rows[0]) : null;
  }

  /** Get a single edict by id */
  getById(id: string): EdictEntry | null {
    return this.runWithDb("getById", () => this.getByIdInternal(id));
  }

  private getByIdInternal(id: string): EdictEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM edicts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /** List edicts, optionally filtered by tags */
  list(options: ListEdictsOptions = {}): EdictEntry[] {
    if (!this._isReady) return [];
    try {
      return this.runWithDb("list", () => this.listInternal(options));
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "edict-store",
        operation: "list",
      });
      return [];
    }
  }

  private listInternal(options: ListEdictsOptions = {}): EdictEntry[] {
    const { tags, includeExpired = false, limit = 100 } = options;
    const nowSec = Math.floor(Date.now() / 1000);
    const parts: string[] = [];
    const params: SQLInputValue[] = [];

    if (!includeExpired) {
      parts.push(
        `((ttl = 'never') OR (ttl = 'event' AND expires_at_sec IS NOT NULL AND expires_at_sec > ?) OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) > ?))`,
      );
      params.push(nowSec, nowSec);
    }

    if (tags && tags.length > 0) {
      const tagParts: string[] = [];
      for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        tagParts.push(`(',' || LOWER(COALESCE(tags, '')) || ',') LIKE ? ESCAPE '~'`);
        params.push(`%,${escapeLikePattern(t.toLowerCase())},%`);
      }
      if (tagParts.length > 0) parts.push(`(${tagParts.join(" OR ")})`);
    }

    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const where = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
    params.push(safeLimit);

    const rows = this.liveDb
      .prepare(`SELECT * FROM edicts ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEntry(r));
  }

  /** Get all non-expired edicts, optionally filtered by tags */
  getEdicts(options: GetEdictsOptions = {}): {
    edicts: EdictEntry[];
    renderForPrompt: string;
  } {
    if (!this._isReady) {
      return { edicts: [], renderForPrompt: "" };
    }
    try {
      return this.runWithDb("getEdicts", () => {
        const { tags, format = "prompt", limit = 100 } = options;
        const edicts = this.listInternal({
          tags,
          includeExpired: false,
          limit,
        });
        const renderForPrompt = format === "prompt" ? renderEdictsForPrompt(edicts) : "";
        return { edicts, renderForPrompt };
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "edict-store",
        operation: "getEdicts",
      });
      return { edicts: [], renderForPrompt: "" };
    }
  }

  /** Update an existing edict. Returns the updated edict or null if not found. */
  update(input: UpdateEdictInput): EdictEntry | null {
    return this.runWithDb("update", () => this.updateInternal(input));
  }

  private updateInternal(input: UpdateEdictInput): EdictEntry | null {
    const existing = this.getByIdInternal(input.id);
    if (!existing) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const text = input.text !== undefined ? input.text.trim() : existing.text;
    const source = input.source !== undefined ? input.source : existing.source;
    const tags = input.tags !== undefined ? input.tags : existing.tags;
    const ttl = input.ttl !== undefined ? input.ttl : existing.ttl;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
    const ttlStr = typeof ttl === "number" ? String(ttl) : ttl;
    const expiresAtSec = expiresAt ? parseIsoDateToUnixSeconds(expiresAt) : null;
    if (typeof ttl === "number" && (!Number.isFinite(ttl) || ttl <= 0 || !Number.isInteger(ttl))) {
      throw new Error("Edict ttl must be a positive integer number of seconds, 'never', or 'event'");
    }
    if (ttl === "event") {
      if (!expiresAt) {
        throw new Error("Edict ttl='event' requires expiresAt (ISO 8601)");
      }
      if (expiresAtSec == null) {
        throw new Error("Edict expiresAt must be a valid ISO 8601 date");
      }
    }
    const tagsStr = tags.length > 0 ? serializeTags(tags) : null;
    const normalizedText = normalizeEdictText(text);

    this.liveDb
      .prepare(
        "UPDATE edicts SET text = ?, normalized_text = ?, source = ?, expires_at = ?, expires_at_sec = ?, ttl = ?, tags = ?, updated_at = ? WHERE id = ?",
      )
      .run(text, normalizedText, source ?? null, expiresAt ?? null, expiresAtSec, ttlStr, tagsStr, nowSec, input.id);

    return {
      ...existing,
      text,
      expiresAtSec,
      source,
      expiresAt,
      ttl,
      tags,
      updatedAt: nowSec,
    };
  }

  /** Remove an edict by id */
  remove(id: string): boolean {
    return this.runWithDb("remove", () => {
      const result = this.liveDb.prepare("DELETE FROM edicts WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  /** Count total edicts */
  count(): number {
    return this.runWithDb("count", () => {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM edicts").get() as { cnt: number };
      return row.cnt;
    });
  }

  /** Get statistics about the edict store */
  stats(): EdictStats {
    return this.runWithDb("stats", () => this.statsInternal());
  }

  private statsInternal(): EdictStats {
    const nowSec = Math.floor(Date.now() / 1000);
    const totalRow = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM edicts").get() as { cnt: number };
    const total = totalRow.cnt;

    const expiredRow = this.liveDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM edicts WHERE
         (ttl = 'event' AND (expires_at_sec IS NULL OR expires_at_sec <= ?))
         OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) <= ?)`,
      )
      .get(nowSec, nowSec) as { cnt: number };
    const expired = expiredRow.cnt;

    const sevenDaysFromNowSec = nowSec + 7 * 24 * 3600;
    const expiringRow = this.liveDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM edicts WHERE ttl = 'event' AND expires_at_sec IS NOT NULL AND expires_at_sec > ? AND expires_at_sec <= ?`,
      )
      .get(nowSec, sevenDaysFromNowSec) as { cnt: number };
    const expiringIn7Days = expiringRow.cnt;

    const allRows = this.liveDb.prepare("SELECT tags FROM edicts").all() as Array<{ tags: string | null }>;
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
    return this.runWithDb("pruneExpired", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const result = this.liveDb
        .prepare(
          `DELETE FROM edicts WHERE
         (ttl = 'event' AND (expires_at_sec IS NULL OR expires_at_sec <= ?))
         OR (CAST(ttl AS INTEGER) > 0 AND created_at + CAST(ttl AS INTEGER) <= ?)`,
        )
        .run(nowSec, nowSec);
      return Number(result.changes ?? 0);
    });
  }

  /** Convert a raw SQLite row to an EdictEntry */
  private rowToEntry(row: Record<string, unknown>): EdictEntry {
    const ttlRaw = (row.ttl as string) ?? "never";
    let ttl: EdictTtl;
    if (ttlRaw === "never") ttl = "never";
    else if (ttlRaw === "event") ttl = "event";
    else {
      const parsed = Number(ttlRaw);
      ttl = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    }

    return {
      id: row.id as string,
      text: row.text as string,
      source: (row.source as string) ?? null,
      verifiedAt: (row.verified_at as number) ?? null,
      expiresAt: (row.expires_at as string) ?? null,
      expiresAtSec: (row.expires_at_sec as number) ?? null,
      ttl,
      tags: parseTags(row.tags as string | null),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
