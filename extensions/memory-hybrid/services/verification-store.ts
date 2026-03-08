/**
 * Verification Store for Critical Facts (Issue #162).
 *
 * Provides a high-trust storage tier with immutability, integrity checking,
 * and protection against silent decay or corruption.
 */

import Database from "better-sqlite3";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { capturePluginError } from "./error-reporter.js";
import { expandTilde } from "../utils/path.js";
import { VAULT_POINTER_PREFIX } from "./auto-capture.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifiedFact {
  id: string;
  factId: string;
  canonicalText: string;
  checksum: string;
  verifiedAt: string;
  verifiedBy: "agent" | "user" | "system";
  nextVerification: string | null;
  version: number;
  previousVersionId: string | null;
  createdAt: string;
}

export interface IntegrityReport {
  valid: boolean;
  corrupted?: string[];
  checked: number;
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeChecksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isIpAddress(value: string): boolean {
  const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  return ipPattern.test(value);
}

function isHostname(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length < 3) return false;
  if (isIpAddress(trimmed)) return false;
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return false;
  if (!/[a-z0-9]/.test(trimmed)) return false;
  if (trimmed.includes("..") || trimmed.startsWith(".") || trimmed.endsWith(".")) return false;
  if (!trimmed.includes(".")) return false;
  return true;
}

function containsHostname(text: string): boolean {
  const hostnamePattern = /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+\b/gi;
  const matches = text.match(hostnamePattern);
  if (!matches) return false;
  
  for (const match of matches) {
    if (/[a-z]/i.test(match)) {
      return true;
    }
  }
  return false;
}

function toISODate(d: Date): string {
  return d.toISOString();
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

// ---------------------------------------------------------------------------
// Raw row type returned from SQLite queries
// ---------------------------------------------------------------------------

interface VerifiedFactRow {
  id: string;
  fact_id: string;
  canonical_text: string;
  checksum: string;
  verified_at: string;
  verified_by: string;
  next_verification: string | null;
  version: number;
  previous_version_id: string | null;
  created_at: string;
}

function rowToVerifiedFact(row: VerifiedFactRow): VerifiedFact {
  return {
    id: row.id,
    factId: row.fact_id,
    canonicalText: row.canonical_text,
    checksum: row.checksum,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by as "agent" | "user" | "system",
    nextVerification: row.next_verification,
    version: row.version,
    previousVersionId: row.previous_version_id,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// shouldAutoVerify — heuristic check for critical facts
// ---------------------------------------------------------------------------

/**
 * Returns true if the fact should be automatically verified.
 */
export function shouldAutoVerify(fact: {
  text: string;
  category: string;
  tags: string[];
  entity?: string | null;
  key?: string | null;
  value?: string | null;
  verificationTier?: string | null;
}): boolean {
  const verificationTier = (fact.verificationTier ?? "").trim().toLowerCase();
  if (verificationTier === "critical") return true;

  const entity = (fact.entity ?? "").trim();
  const text = fact.text ?? "";
  if (entity && (isIpAddress(entity) || isHostname(entity))) return true;
  if (isIpAddress(text) || containsHostname(text)) return true;

  const entityLower = entity.toLowerCase();
  const keyLower = (fact.key ?? "").toLowerCase();
  const valueLower = (fact.value ?? "").toLowerCase();
  if (
    entityLower.includes("credential") ||
    keyLower.includes("credential") ||
    valueLower.startsWith(VAULT_POINTER_PREFIX)
  ) {
    return true;
  }

  // Infrastructure + technical category
  if (
    fact.tags.map((t) => t.toLowerCase()).includes("infrastructure") &&
    fact.category === "technical"
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// VerificationStore
// ---------------------------------------------------------------------------

export class VerificationStore {
  private db: Database.Database;
  private readonly backupPath: string;
  private readonly reverificationDays: number;
  private readonly logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };

  /**
   * @param dbPathOrInstance - Either a file path string (opens its own connection) or an
   *   existing Database instance to share (e.g. FactsDB.getRawDb()). When sharing an
   *   instance, the caller is responsible for pragma setup and lifecycle.
   */
  constructor(
    dbPathOrInstance: string | Database.Database,
    options?: {
      backupPath?: string;
      reverificationDays?: number;
      logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
    },
  ) {
    if (typeof dbPathOrInstance === "string") {
      mkdirSync(dirname(dbPathOrInstance), { recursive: true });
      this.db = new Database(dbPathOrInstance);
      this.applyPragmas();
    } else {
      // Shared instance — caller owns the connection lifecycle
      this.db = dbPathOrInstance;
    }
    this.reverificationDays = options?.reverificationDays ?? 30;
    this.logger = options?.logger;

    const rawBackup = options?.backupPath ?? "~/.openclaw/verified-facts.json";
    this.backupPath = expandTilde(rawBackup);
    mkdirSync(dirname(this.backupPath), { recursive: true });

    this.initSchema();
  }

  private applyPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
  }

  /** Schema for standalone verification DB (no facts table). When verified_facts lives in FactsDB, the migration in facts-db.ts is used. */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verified_facts (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        canonical_text TEXT NOT NULL,
        checksum TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        verified_by TEXT NOT NULL,
        next_verification TEXT,
        version INTEGER DEFAULT 1,
        previous_version_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verified_facts_fact_id ON verified_facts(fact_id);
      CREATE INDEX IF NOT EXISTS idx_verified_facts_next_verification ON verified_facts(next_verification);
    `);
  }

  // -------------------------------------------------------------------------
  // verify — add a fact to the verification store
  // -------------------------------------------------------------------------

  verify(
    factId: string,
    text: string,
    verifiedBy: "agent" | "user" | "system",
  ): string {
    const existing = this.db
      .prepare(`SELECT 1 FROM verified_facts WHERE fact_id = ? LIMIT 1`)
      .get(factId);
    if (existing) {
      throw new VerificationError(
        `Fact ${factId} is already verified; use update() to create a new version`,
      );
    }

    const id = randomUUID();
    const now = toISODate(new Date());
    const nextVerification = toISODate(
      addDays(new Date(), this.reverificationDays),
    );
    const checksum = computeChecksum(text);

    this.db
      .prepare(
        `INSERT INTO verified_facts
          (id, fact_id, canonical_text, checksum, verified_at, verified_by, next_verification, version, previous_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      )
      .run(id, factId, text, checksum, now, verifiedBy, nextVerification, now);

    this.writeBackup({
      action: "verify",
      id,
      fact_id: factId,
      canonical_text: text,
      checksum,
      verified_at: now,
      verified_by: verifiedBy,
      version: 1,
      nextVerification,
      previousVersionId: null,
      ts: now,
    });

    return id;
  }

  // -------------------------------------------------------------------------
  // checkIntegrity — verify checksums match stored text
  // -------------------------------------------------------------------------

  checkIntegrity(factId?: string): IntegrityReport {
    let rows: VerifiedFactRow[];
    if (factId !== undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM verified_facts WHERE fact_id = ? ORDER BY version DESC`,
        )
        .all(factId) as VerifiedFactRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM verified_facts`)
        .all() as VerifiedFactRow[];
    }

    const corrupted: string[] = [];

    for (const row of rows) {
      const live = computeChecksum(row.canonical_text);
      if (live !== row.checksum) {
        corrupted.push(row.id);
      }
    }

    return {
      valid: corrupted.length === 0,
      corrupted: corrupted.length > 0 ? corrupted : undefined,
      checked: rows.length,
    };
  }

  // -------------------------------------------------------------------------
  // getVerified — retrieve a verified fact, throws on checksum mismatch
  // -------------------------------------------------------------------------

  getVerified(factId: string): VerifiedFact | null {
    const row = this.db
      .prepare(
        `SELECT * FROM verified_facts WHERE fact_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(factId) as VerifiedFactRow | undefined;

    if (!row) return null;

    const live = computeChecksum(row.canonical_text);
    if (live !== row.checksum) {
      const message =
        `Checksum mismatch for verified fact ${row.id} (fact_id=${factId}): stored checksum does not match canonical_text`;
      this.logCorruption(message);
      throw new VerificationError(message);
    }

    return rowToVerifiedFact(row);
  }

  // -------------------------------------------------------------------------
  // listDueForReverification — facts whose next_verification <= now or verified_at is stale
  // -------------------------------------------------------------------------

  listDueForReverification(): VerifiedFact[] {
    const now = toISODate(new Date());
    const cutoff = toISODate(addDays(new Date(), -this.reverificationDays));
    const rows = this.db
      .prepare(
        `SELECT vf.*
         FROM verified_facts vf
         JOIN (
           SELECT fact_id, MAX(version) as max_version
           FROM verified_facts
           GROUP BY fact_id
         ) latest
         ON vf.fact_id = latest.fact_id AND vf.version = latest.max_version
         WHERE (vf.next_verification IS NOT NULL AND vf.next_verification <= ?)
            OR vf.verified_at <= ?
         ORDER BY COALESCE(vf.next_verification, vf.verified_at) ASC`,
      )
      .all(now, cutoff) as VerifiedFactRow[];

    return rows
      .filter((row) => this.validateRowChecksum(row))
      .map(rowToVerifiedFact);
  }

  // -------------------------------------------------------------------------
  // listLatestVerified — latest versions for each fact_id
  // -------------------------------------------------------------------------

  listLatestVerified(): VerifiedFact[] {
    const rows = this.db
      .prepare(
        `SELECT vf.*
         FROM verified_facts vf
         JOIN (
           SELECT fact_id, MAX(version) as max_version
           FROM verified_facts
           GROUP BY fact_id
         ) latest
         ON vf.fact_id = latest.fact_id AND vf.version = latest.max_version
         ORDER BY vf.verified_at DESC`,
      )
      .all() as VerifiedFactRow[];

    return rows
      .filter((row) => this.validateRowChecksum(row))
      .map(rowToVerifiedFact);
  }

  // -------------------------------------------------------------------------
  // update — create a new version, linking to the superseded one
  // -------------------------------------------------------------------------

  update(
    id: string,
    newText: string,
    verifiedBy: "agent" | "user" | "system",
  ): string {
    const existing = this.db
      .prepare(`SELECT * FROM verified_facts WHERE id = ?`)
      .get(id) as VerifiedFactRow | undefined;

    if (!existing) {
      throw new VerificationError(`No verified fact found with id=${id}`);
    }

    const latest = this.db
      .prepare(
        `SELECT id FROM verified_facts WHERE fact_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(existing.fact_id) as { id: string } | undefined;
    if (!latest || latest.id !== id) {
      throw new VerificationError(
        `Can only update from the latest version; id=${id} is not the current latest for fact_id=${existing.fact_id}`,
      );
    }

    const newId = randomUUID();
    const now = toISODate(new Date());
    const nextVerification = toISODate(
      addDays(new Date(), this.reverificationDays),
    );
    const checksum = computeChecksum(newText);
    const newVersion = existing.version + 1;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO verified_facts
          (id, fact_id, canonical_text, checksum, verified_at, verified_by, next_verification, version, previous_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId,
          existing.fact_id,
          newText,
          checksum,
          now,
          verifiedBy,
          nextVerification,
          newVersion,
          id,
          now,
        );
      this.db.prepare(`UPDATE verified_facts SET next_verification = NULL WHERE id = ?`).run(id);
    })();

    this.writeBackup({
      action: "update",
      id: newId,
      fact_id: existing.fact_id,
      canonical_text: newText,
      checksum,
      verified_at: now,
      verified_by: verifiedBy,
      version: newVersion,
      nextVerification,
      previousVersionId: id,
      ts: now,
    });

    return newId;
  }

  // -------------------------------------------------------------------------
  // close — close the underlying SQLite connection
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  private validateRowChecksum(row: VerifiedFactRow): boolean {
    const live = computeChecksum(row.canonical_text);
    if (live !== row.checksum) {
      const message =
        `Checksum mismatch for verified fact ${row.id} (fact_id=${row.fact_id}): stored checksum does not match canonical_text`;
      this.logCorruption(message);
      return false;
    }
    return true;
  }

  private logCorruption(message: string): void {
    if (this.logger?.error) {
      this.logger.error(`memory-hybrid: verification corruption detected: ${message}`);
      return;
    }
    if (this.logger?.warn) {
      this.logger.warn(`memory-hybrid: verification corruption detected: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private: append-only backup
  // -------------------------------------------------------------------------

  private hasLoggedBackupError = false;

  private writeBackup(entry: {
    action: "verify" | "update";
    id: string;
    fact_id: string;
    canonical_text: string;
    checksum: string;
    verified_at: string;
    verified_by: string;
    version: number;
    nextVerification: string | null;
    previousVersionId: string | null;
    ts: string;
  }): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.backupPath, line, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      if (!this.hasLoggedBackupError) {
        this.hasLoggedBackupError = true;
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "verification-store",
          operation: "writeBackup",
        });
      }
    }
  }
}
