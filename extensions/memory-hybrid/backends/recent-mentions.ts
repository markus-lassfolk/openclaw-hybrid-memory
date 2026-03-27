/**
 * Recent Mentions Store — Frequency-based auto-save for Issue #784
 *
 * Tracks entity and credential mentions across sessions to enable
 * frequency-based auto-capture. When a non-credential entity is mentioned
 * threshold+ times, it's auto-saved as a memory. When a credential is mentioned
 * threshold+ times, it's stored in the vault.
 *
 * Key design:
 * - SHA-256 hash of mention text for deduplication (never stores raw credential values)
 * - Supersession key = host+username+scope for multi-credential per host support
 * - TTL purge for stale mention records (30 days by default)
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pluginLogger } from "../utils/logger.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

export interface MentionRecord {
  entityText: string;
  mentionHash: string;
  mentionCount: number;
  firstSeen: number;
  lastSeen: number;
  autoStored: boolean;
  isCredential: boolean;
  /** For credentials: host/username/scope format */
  credentialKey?: string;
  /** SHA-256 hash of the credential value (not the raw value) */
  credentialValueHash?: string;
  /** Credential type: ssh, token, api_key, etc. */
  credentialType?: string;
}

export interface CredentialCandidate {
  host: string;
  username?: string;
  scope: string;
  rawValue: string;
  valueHash: string;
  type: string;
}

export interface FrequencyCaptureConfig {
  enabled: boolean;
  mentionThreshold: number;
  lookbackSessions: number;
  defaultImportance: number;
  captureCredentials: boolean;
  ttlDays: number;
}

/** Default config values */
export const DEFAULT_FREQUENCY_CONFIG: FrequencyCaptureConfig = {
  enabled: false,
  mentionThreshold: 3,
  lookbackSessions: 5,
  defaultImportance: 0.6,
  captureCredentials: true,
  ttlDays: 30,
};

const SCHEMA_VERSION = 1;

export class RecentMentionsDB extends BaseSqliteStore {
  private readonly ttlDays: number;

  constructor(db: DatabaseSync, ttlDays: number = DEFAULT_FREQUENCY_CONFIG.ttlDays) {
    super(db);
    this.ttlDays = ttlDays;
    this.initSchema();
  }

  protected getSubsystemName(): string {
    return "recent-mentions";
  }

  private initSchema(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS recent_mentions_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const versionRow = this.liveDb
      .prepare("SELECT value FROM recent_mentions_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!versionRow) {
      this.liveDb.exec(`
        CREATE TABLE IF NOT EXISTS recent_mentions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_text TEXT NOT NULL,
          mention_hash TEXT NOT NULL,
          mention_count INTEGER NOT NULL DEFAULT 1,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          auto_stored INTEGER NOT NULL DEFAULT 0,
          is_credential INTEGER NOT NULL DEFAULT 0,
          credential_key TEXT,
          credential_value_hash TEXT,
          credential_type TEXT,
          UNIQUE(mention_hash, is_credential)
        )
      `);
      this.liveDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_recent_mentions_hash ON recent_mentions(mention_hash)
      `);
      this.liveDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_recent_mentions_credential_key ON recent_mentions(credential_key) WHERE credential_key IS NOT NULL
      `);
      this.liveDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_recent_mentions_auto_stored ON recent_mentions(auto_stored) WHERE auto_stored = 0
      `);
      this.liveDb
        .prepare("INSERT INTO recent_mentions_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    }
  }

  /**
   * Compute SHA-256 hash of a string for deduplication.
   * Used for both entity mentions and credential values.
   */
  static sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  /**
   * Build a credential key in host/username/scope format.
   * Examples: 192.168.1.99/ssh/root, github.com/github-pat/markus
   */
  static buildCredentialKey(host: string, username: string | undefined, scope: string): string {
    return `${host}/${scope}/${username ?? ""}`;
  }

  /**
   * Record a mention of an entity or credential.
   * For credentials, also stores the credential key and value hash.
   *
   * @returns true if this is a new mention record, false if it updated an existing one
   */
  recordMention(
    entityText: string,
    isCredential: boolean,
    credentialKey?: string,
    credentialValueHash?: string,
    credentialType?: string,
  ): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const storedText = isCredential ? (credentialKey ?? "[REDACTED CREDENTIAL]") : entityText;
    const mentionHash = RecentMentionsDB.sha256(entityText);

    const existing = this.liveDb
      .prepare("SELECT * FROM recent_mentions WHERE mention_hash = ? AND is_credential = ?")
      .get(mentionHash, isCredential ? 1 : 0) as Record<string, unknown> | undefined;

    if (existing) {
      // Update existing mention
      this.liveDb
        .prepare(
          `UPDATE recent_mentions
             SET mention_count = mention_count + 1,
                 last_seen = ?
             WHERE id = ?`,
        )
        .run(nowSec, existing.id as number);
      return false;
    }

    // Insert new mention
    this.liveDb
      .prepare(
        `INSERT INTO recent_mentions (entity_text, mention_hash, mention_count, first_seen, last_seen, auto_stored, is_credential, credential_key, credential_value_hash, credential_type)
             VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        storedText,
        mentionHash,
        nowSec,
        nowSec,
        isCredential ? 1 : 0,
        credentialKey ?? null,
        credentialValueHash ?? null,
        credentialType ?? null,
      );
    return true;
  }

  /**
   * Get mention records that have reached the threshold and haven't been auto-stored yet.
   */
  getCandidatesAboveThreshold(threshold: number, isCredential: boolean): MentionRecord[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM recent_mentions
           WHERE mention_count >= ? AND auto_stored = 0 AND is_credential = ?
           ORDER BY mention_count DESC, last_seen DESC`,
      )
      .all(threshold, isCredential ? 1 : 0) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMentionRecord(row));
  }

  /**
   * Mark a mention record as auto-stored.
   */
  markAutoStored(mentionHash: string, isCredential: boolean): void {
    this.liveDb
      .prepare("UPDATE recent_mentions SET auto_stored = 1 WHERE mention_hash = ? AND is_credential = ?")
      .run(mentionHash, isCredential ? 1 : 0);
  }

  /**
   * Find a credential by its exact credential_key and value hash.
   * Returns the mention record if found, null otherwise.
   */
  findCredentialMention(credentialKey: string, credentialValueHash: string): MentionRecord | null {
    const row = this.liveDb
      .prepare(
        `SELECT * FROM recent_mentions
           WHERE credential_key = ? AND credential_value_hash = ? AND is_credential = 1
           LIMIT 1`,
      )
      .get(credentialKey, credentialValueHash) as Record<string, unknown> | undefined;
    return row ? this.rowToMentionRecord(row) : null;
  }

  /**
   * Find a credential by its credential_key (regardless of value hash).
   * Used to check if a credential key exists before supersession.
   */
  findCredentialByKey(credentialKey: string): MentionRecord | null {
    const row = this.liveDb
      .prepare(
        `SELECT * FROM recent_mentions
           WHERE credential_key = ? AND is_credential = 1
           ORDER BY last_seen DESC LIMIT 1`,
      )
      .get(credentialKey) as Record<string, unknown> | undefined;
    return row ? this.rowToMentionRecord(row) : null;
  }

  /**
   * Purge stale mention records that haven't been seen within the TTL window.
   */
  purgeStale(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - this.ttlDays * 24 * 3600;
    const result = this.liveDb
      .prepare("DELETE FROM recent_mentions WHERE last_seen < ? AND auto_stored = 1")
      .run(cutoff);
    const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
    if (changes > 0) {
      pluginLogger.debug(`recent-mentions: purged ${changes} stale entries`);
    }
    return changes;
  }

  /**
   * Get all recent credential mentions for audit purposes.
   */
  listCredentialMentions(): MentionRecord[] {
    const rows = this.liveDb
      .prepare("SELECT * FROM recent_mentions WHERE is_credential = 1 ORDER BY last_seen DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToMentionRecord(row));
  }

  /**
   * Get mention count for an entity/credential.
   */
  getMentionCount(mentionHash: string, isCredential: boolean): number {
    const row = this.liveDb
      .prepare("SELECT mention_count FROM recent_mentions WHERE mention_hash = ? AND is_credential = ?")
      .get(mentionHash, isCredential ? 1 : 0) as { mention_count: number } | undefined;
    return row?.mention_count ?? 0;
  }

  private rowToMentionRecord(row: Record<string, unknown>): MentionRecord {
    return {
      entityText: row.entity_text as string,
      mentionHash: row.mention_hash as string,
      mentionCount: row.mention_count as number,
      firstSeen: row.first_seen as number,
      lastSeen: row.last_seen as number,
      autoStored: (row.auto_stored as number) === 1,
      isCredential: (row.is_credential as number) === 1,
      credentialKey: (row.credential_key as string) ?? undefined,
      credentialValueHash: (row.credential_value_hash as string) ?? undefined,
      credentialType: (row.credential_type as string) ?? undefined,
    };
  }
}

/** Entity extraction heuristics for frequency capture */
export const ENTITY_EXTRACTION_PATTERNS = {
  /** Hostnames/URLs including IP addresses */
  hostnames:
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|[0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/gi,

  /** File paths */
  filePaths: /\/[^\s'"`\\]+/g,

  /** Error codes/messages */
  errorCodes:
    /\b(?:ECONNREFUSED|ENOTFOUND|EADDRINUSE|EACCES|EPERM|ENOENT|EEXIST|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EMFILE|ENFILE|EROFS|EBUSY|ENOTDIR|EISDIR|EINVAL|ENOSPC|EDQUOT)[^a-zA-Z]*\b/gi,

  /** Error class names */
  errorClasses:
    /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|fetch error|request failed|connection refused|timeout)[^\s]*\b/gi,

  /** Quoted strings (potential project/tool names) */
  quotedStrings: /"(?<quote>[^"]{2,50})"|'(?<quote>[^']{2,50})'/g,
};

/** Credential patterns for auto-detection.
 * Format: { regex, scope } where scope is used in the credential key.
 */
export const CREDENTIAL_EXTRACTION_PATTERNS: Array<{ regex: RegExp; scope: string; type: string }> = [
  { regex: /ghp_[A-Za-z0-9]{36}/, scope: "github-pat", type: "api_key" },
  { regex: /gho_[A-Za-z0-9]{36}/, scope: "github-oauth", type: "token" },
  { regex: /github_pat_[A-Za-z0-9_]{72}/, scope: "github-pat", type: "token" },
  { regex: /sk-[A-Za-z0-9]{20,}/, scope: "openai-key", type: "api_key" },
  { regex: /sk-proj-[A-Za-z0-9_-]{48,}/, scope: "openai-proj", type: "api_key" },
  { regex: /sk-ant-[A-Za-z0-9_-]{48,}/, scope: "anthropic-key", type: "api_key" },
  {
    regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    scope: "jwt-bearer",
    type: "bearer",
  },
  { regex: /Bearer\s+[A-Za-z0-9_-]{20,}/i, scope: "bearer-token", type: "bearer" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, scope: "slack-token", type: "token" },
  {
    regex: /(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
    scope: "password",
    type: "password",
  },
  { regex: /AKIA[0-9A-Z]{16}/, scope: "aws-key", type: "api_key" },
  { regex: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE KEY-----/, scope: "private-key", type: "ssh" },
];

/**
 * Extract credential candidates from text.
 * Returns CredentialCandidate[] with host, username, scope, rawValue, valueHash, and type.
 */
export function extractCredentialCandidates(text: string): CredentialCandidate[] {
  const candidates: CredentialCandidate[] = [];
  const seen = new Set<string>();

  for (const { regex, scope, type } of CREDENTIAL_EXTRACTION_PATTERNS) {
    const matches = text.matchAll(
      new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`),
    );
    for (const match of matches) {
      const rawValue = match[0];
      const valueHash = RecentMentionsDB.sha256(rawValue);

      // Try to extract host from surrounding context
      const host = extractHostFromContext(text, match.index ?? 0, rawValue.length);
      const username = extractUsernameFromContext(text, match.index ?? 0, rawValue.length);

      const credentialKey = RecentMentionsDB.buildCredentialKey(host, username, scope);

      // Deduplicate by credential key + value hash
      const dedupKey = `${credentialKey}:${valueHash}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      candidates.push({
        host,
        username,
        scope,
        rawValue,
        valueHash,
        type,
      });
    }
  }

  return candidates;
}

/**
 * Extract host from context around a credential match.
 * Looks for IPs, hostnames, or service names near the credential.
 */
function extractHostFromContext(text: string, matchIndex: number, matchLen: number): string {
  // Look at 100 chars before and after the match
  const start = Math.max(0, matchIndex - 100);
  const end = Math.min(text.length, matchIndex + matchLen + 100);
  const context = text.slice(start, end);

  // Try to find IP address
  const ipMatch = context.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/);
  if (ipMatch) return ipMatch[0];

  // Try to find hostname
  const hostnameMatch = context.match(
    /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)\b/,
  );
  if (hostnameMatch) return hostnameMatch[0];

  // Try service name patterns like "github.com", "home-assistant"
  const serviceMatch = context.match(
    /\b(?:github|gitlab|bitbucket|openai|anthropic|slack|discord|home[-_]?assistant|unifi|proxmox|nas|plex|jellyfin|nextcloud)[a-zA-Z0-9.-]*/i,
  );
  if (serviceMatch) return serviceMatch[0].toLowerCase().replace(/\s+/g, "-");

  // Default fallback
  return "unknown-host";
}

/**
 * Extract username from context around a credential match.
 * Looks for patterns like "user@host" or "username:password".
 */
function extractUsernameFromContext(text: string, matchIndex: number, matchLen: number): string | undefined {
  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(text.length, matchIndex + matchLen + 50);
  const context = text.slice(start, end);

  // Try user@host pattern
  const userAtHostMatch = context.match(/([a-zA-Z0-9._-]+)@[a-zA-Z0-9._-]+/);
  if (userAtHostMatch) return userAtHostMatch[1];

  // Try "username:" or "user:" pattern
  const userColonMatch = context.match(/(?:user|username|login|account)\s*[:=]\s*([a-zA-Z0-9._-]+)/i);
  if (userColonMatch) return userColonMatch[1];

  // Try for "for <service> user" pattern
  const forUserMatch = context.match(/for\s+([a-zA-Z0-9_-]+)\s+(?:user|account|key|token)/i);
  if (forUserMatch) return forUserMatch[1];

  return undefined;
}

/**
 * Extract entity candidates from text for non-credential frequency tracking.
 * Returns array of entity texts that are worth tracking.
 */
export function extractEntityCandidates(text: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();

  // Extract hostnames/IPs
  for (const match of text.matchAll(ENTITY_EXTRACTION_PATTERNS.hostnames)) {
    const normalized = match[0].toLowerCase();
    if (!seen.has(normalized) && normalized.length >= 3) {
      seen.add(normalized);
      entities.push(normalized);
    }
  }

  // Extract file paths (limit to significant ones)
  for (const match of text.matchAll(ENTITY_EXTRACTION_PATTERNS.filePaths)) {
    const path = match[0];
    // Skip very short paths or common patterns
    if (path.length >= 5 && !path.includes("$") && !seen.has(path)) {
      seen.add(path);
      entities.push(path);
    }
  }

  // Extract error codes
  for (const match of text.matchAll(ENTITY_EXTRACTION_PATTERNS.errorCodes)) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      entities.push(match[0]);
    }
  }

  // Extract error class names
  for (const match of text.matchAll(ENTITY_EXTRACTION_PATTERNS.errorClasses)) {
    const normalized = match[0].toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      entities.push(normalized);
    }
  }

  return entities;
}
