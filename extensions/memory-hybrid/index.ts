/**
 * OpenClaw Memory Hybrid Plugin
 *
 * Two-tier memory system:
 *   1. SQLite + FTS5 — structured facts, instant full-text search, zero API cost
 *   2. LanceDB — semantic vector search for fuzzy/contextual recall
 *
 * Retrieval merges results from both backends, deduplicates, and prioritizes
 * high-confidence FTS5 matches over approximate vector matches.
 */

import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { createHash, randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import {
  DEFAULT_MEMORY_CATEGORIES,
  getMemoryCategories,
  setMemoryCategories,
  isValidCategory,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  type HybridMemoryConfig,
  hybridConfigSchema,
  vectorDimsForModel,
  CREDENTIAL_TYPES,
  type CredentialType,
  PROPOSAL_STATUSES,
  type IdentityFileType,
} from "./config.js";
import { versionInfo } from "./versionInfo.js";
import { WriteAheadLog } from "./backends/wal.js";
import { VectorDB } from "./backends/vector-db.js";
import { FactsDB, MEMORY_LINK_TYPES, type MemoryLinkType } from "./backends/facts-db.js";
import { registerHybridMemCli } from "./cli/register.js";
import { Embeddings, safeEmbed } from "./services/embeddings.js";
import { mergeResults } from "./services/merge-results.js";
import type { MemoryEntry, SearchResult } from "./types/memory.js";
import { loadPrompt, fillPrompt } from "./utils/prompt-loader.js";
import { truncateText, truncateForStorage, estimateTokens, estimateTokensForDisplay } from "./utils/text.js";
import {
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  CREDENTIAL_NOTES_MAX_CHARS,
} from "./utils/constants.js";
import {
  normalizeTextForDedupe,
  normalizedHash,
  TAG_PATTERNS,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
} from "./utils/tags.js";
import { parseSourceDate } from "./utils/dates.js";
import { calculateExpiry, classifyDecay } from "./utils/decay.js";

// ============================================================================
// Credentials Store (opt-in, encrypted)
// ============================================================================

const CRED_IV_LEN = 12;
const CRED_AUTH_TAG_LEN = 16;
const CRED_ALGO = "aes-256-gcm";

function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

function encryptValue(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(CRED_IV_LEN);
  const cipher = createCipheriv(CRED_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptValue(buffer: Buffer, key: Buffer): string {
  const iv = buffer.subarray(0, CRED_IV_LEN);
  const authTag = buffer.subarray(CRED_IV_LEN, CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const encrypted = buffer.subarray(CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const decipher = createDecipheriv(CRED_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

type CredentialEntry = {
  service: string;
  type: CredentialType;
  value: string;
  url: string | null;
  notes: string | null;
  created: number;
  updated: number;
  expires: number | null;
};

class CredentialsDB {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly key: Buffer;

  constructor(dbPath: string, encryptionKey: string) {
    this.dbPath = dbPath;
    this.key = deriveKey(encryptionKey);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applyPragmas();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        value BLOB NOT NULL,
        url TEXT,
        notes TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        expires INTEGER,
        PRIMARY KEY (service, type)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_credentials_service ON credentials(service)
    `);
  }

  private applyPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  /** Get the live DB handle, reopening if closed after a SIGUSR1 restart. */
  private get liveDb(): Database.Database {
    if (!this.db.open) {
      this.db = new Database(this.dbPath);
      this.applyPragmas();
    }
    return this.db;
  }

  store(entry: {
    service: string;
    type: CredentialType;
    value: string;
    url?: string;
    notes?: string;
    expires?: number | null;
  }): CredentialEntry {
    const now = Math.floor(Date.now() / 1000);
    const encrypted = encryptValue(entry.value, this.key);
    this.liveDb
      .prepare(
        `INSERT INTO credentials (service, type, value, url, notes, created, updated, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, type) DO UPDATE SET
           value = excluded.value,
           url = excluded.url,
           notes = excluded.notes,
           updated = excluded.updated,
           expires = excluded.expires`,
      )
      .run(
        entry.service,
        entry.type,
        encrypted,
        entry.url ?? null,
        entry.notes ?? null,
        now,
        now,
        entry.expires ?? null,
      );
    return {
      service: entry.service,
      type: entry.type,
      value: "[redacted]",
      url: entry.url ?? null,
      notes: entry.notes ?? null,
      created: now,
      updated: now,
      expires: entry.expires ?? null,
    };
  }

  get(service: string, type?: CredentialType): CredentialEntry | null {
    const row = type
      ? (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? AND type = ?").get(service, type) as Record<string, unknown> | undefined)
      : (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? ORDER BY updated DESC LIMIT 1").get(service) as Record<string, unknown> | undefined);
    if (!row) return null;
    const buf = row.value as Buffer;
    const value = decryptValue(buf, this.key);
    return {
      service: row.service as string,
      type: (row.type as string) as CredentialType,
      value,
      url: (row.url as string) ?? null,
      notes: (row.notes as string) ?? null,
      created: row.created as number,
      updated: row.updated as number,
      expires: (row.expires as number) ?? null,
    };
  }

  list(): Array<{ service: string; type: string; url: string | null; expires: number | null }> {
    const rows = this.liveDb.prepare("SELECT service, type, url, expires FROM credentials ORDER BY service, type").all() as Array<{
      service: string;
      type: string;
      url: string | null;
      expires: number | null;
    }>;
    return rows;
  }

  delete(service: string, type?: CredentialType): boolean {
    if (type) {
      const r = this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, type);
      return r.changes > 0;
    }
    const r = this.liveDb.prepare("DELETE FROM credentials WHERE service = ?").run(service);
    return r.changes > 0;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// ============================================================================
// Persona Proposals Database
// ============================================================================

type ProposalEntry = {
  id: string;
  targetFile: string;
  title: string;
  observation: string;
  suggestedChange: string;
  confidence: number;
  evidenceSessions: string[];
  status: string;
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  appliedAt: number | null;
  expiresAt: number | null;
};

class ProposalsDB {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        target_file TEXT NOT NULL,
        title TEXT NOT NULL,
        observation TEXT NOT NULL,
        suggested_change TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_sessions TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        reviewed_by TEXT,
        applied_at INTEGER,
        expires_at INTEGER
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);
    `);
  }

  create(entry: {
    targetFile: string;
    title: string;
    observation: string;
    suggestedChange: string;
    confidence: number;
    evidenceSessions: string[];
    expiresAt?: number | null;
  }): ProposalEntry {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const evidenceJson = JSON.stringify(entry.evidenceSessions);

    this.db
      .prepare(
        `INSERT INTO proposals (id, target_file, title, observation, suggested_change, confidence, evidence_sessions, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        entry.targetFile,
        entry.title,
        entry.observation,
        entry.suggestedChange,
        entry.confidence,
        evidenceJson,
        now,
        entry.expiresAt ?? null,
      );

    return this.get(id)!;
  }

  get(id: string): ProposalEntry | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  list(filters?: { status?: string; targetFile?: string }): ProposalEntry[] {
    let query = "SELECT * FROM proposals WHERE 1=1";
    const params: any[] = [];

    if (filters?.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.targetFile) {
      query += " AND target_file = ?";
      params.push(filters.targetFile);
    }

    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => this.rowToEntry(r));
  }

  updateStatus(
    id: string,
    status: string,
    reviewedBy?: string,
  ): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "UPDATE proposals SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
      )
      .run(status, now, reviewedBy ?? null, id);
    return this.get(id);
  }

  markApplied(id: string): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("UPDATE proposals SET status = 'applied', applied_at = ? WHERE id = ?")
      .run(now, id);
    return this.get(id);
  }

  countRecentProposals(daysBack: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - daysBack * 24 * 3600;
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM proposals WHERE created_at >= ?")
      .get(cutoff) as any;
    return row?.count ?? 0;
  }

  pruneExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        "DELETE FROM proposals WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'pending'",
      )
      .run(now);
    return result.changes;
  }

  private rowToEntry(row: any): ProposalEntry {
    // Parse evidence_sessions with error handling for corrupted data
    let evidenceSessions: string[] = [];
    try {
      evidenceSessions = JSON.parse(row.evidence_sessions);
      if (!Array.isArray(evidenceSessions)) {
        evidenceSessions = [];
      }
    } catch {
      // Corrupted JSON - fallback to empty array
      evidenceSessions = [];
    }

    return {
      id: row.id,
      targetFile: row.target_file,
      title: row.title,
      observation: row.observation,
      suggestedChange: row.suggested_change,
      confidence: row.confidence,
      evidenceSessions,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      appliedAt: row.applied_at,
      expiresAt: row.expires_at,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ============================================================================
// FR-008: Memory Operation Classification (ADD/UPDATE/DELETE/NOOP)
// ============================================================================

type MemoryClassification = {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  targetId?: string;
  reason: string;
  /** For UPDATE: the updated text to store (only if LLM suggests a merge) */
  updatedText?: string;
};

/**
 * FR-008: Classify an incoming fact against existing similar facts.
 * Uses a cheap LLM call to determine ADD/UPDATE/DELETE/NOOP.
 * Falls back to ADD on error.
 */
async function classifyMemoryOperation(
  candidateText: string,
  candidateEntity: string | null,
  candidateKey: string | null,
  existingFacts: MemoryEntry[],
  openai: OpenAI,
  model: string,
  logger: { warn: (msg: string) => void },
): Promise<MemoryClassification> {
  if (existingFacts.length === 0) {
    return { action: "ADD", reason: "no similar facts found" };
  }

  const existingLines = existingFacts
    .slice(0, 5)
    .map(
      (f, i) =>
        `${i + 1}. [id=${f.id}] ${f.category}${f.entity ? ` | entity: ${f.entity}` : ""}${f.key ? ` | key: ${f.key}` : ""}: ${f.text.slice(0, 300)}`,
    )
    .join("\n");

  const template = loadPrompt("memory-classify");
  const prompt = fillPrompt(template, {
    NEW_FACT: candidateText.slice(0, 500),
    ENTITY_LINE: candidateEntity ? `\nEntity: ${candidateEntity}` : "",
    KEY_LINE: candidateKey ? `\nKey: ${candidateKey}` : "",
    EXISTING_FACTS: existingLines,
  });

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 100,
    });
    const content = (resp.choices[0]?.message?.content ?? "").trim();

    // Parse: "ACTION [id] | reason"
    const match = content.match(/^(ADD|UPDATE|DELETE|NOOP)\s*([a-f0-9-]*)\s*\|\s*(.+)$/i);
    if (!match) {
      return { action: "ADD", reason: `unparseable LLM response: ${content.slice(0, 80)}` };
    }

    const action = match[1].toUpperCase() as MemoryClassification["action"];
    const targetId = match[2]?.trim() || undefined;
    const reason = match[3].trim();

    // Validate targetId if UPDATE or DELETE - must have a valid targetId
    if (action === "UPDATE" || action === "DELETE") {
      if (!targetId) {
        return { action: "ADD", reason: `missing targetId for ${action}; treating as ADD` };
      }
      const validTarget = existingFacts.find((f) => f.id === targetId);
      if (!validTarget) {
        return { action: "ADD", reason: `LLM referenced unknown id ${targetId}; treating as ADD` };
      }
    }

    return { action, targetId, reason };
  } catch (err) {
    logger.warn(`memory-hybrid: classify operation failed: ${err}`);
    return { action: "ADD", reason: "classification failed; defaulting to ADD" };
  }
}

/** FR-008: Get top-N existing facts by embedding similarity. Resolves vector search ids via factsDb (filters superseded). Falls back to empty array on vector search failure. */
async function findSimilarByEmbedding(
  vectorDb: VectorDB,
  factsDb: { getById(id: string): MemoryEntry | null },
  vector: number[],
  limit: number,
  minScore = 0.3,
): Promise<MemoryEntry[]> {
  const results = await vectorDb.search(vector, limit, minScore);
  const entries: MemoryEntry[] = [];
  for (const r of results) {
    const entry = factsDb.getById(r.entry.id);
    if (entry && entry.supersededAt == null) entries.push(entry);
  }
  return entries;
}

// ============================================================================
// Structured Fact Extraction
// ============================================================================

function extractStructuredFields(
  text: string,
  category: MemoryCategory,
): { entity: string | null; key: string | null; value: string | null } {
  const lower = text.toLowerCase();

  const decisionMatch = text.match(
    /(?:decided|chose|picked|went with|selected|choosing)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for|due to|over)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    return {
      entity: "decision",
      key: decisionMatch[1].trim().slice(0, 100),
      value: decisionMatch[2]?.trim() || "no rationale recorded",
    };
  }

  const choiceMatch = text.match(
    /(?:use|using|chose|prefer|picked)\s+(.+?)\s+(?:over|instead of|rather than)\s+(.+?)(?:\s+(?:because|since|for|due to)\s+(.+?))?\.?$/i,
  );
  if (choiceMatch) {
    return {
      entity: "decision",
      key: `${choiceMatch[1].trim()} over ${choiceMatch[2].trim()}`,
      value: choiceMatch[3]?.trim() || "preference",
    };
  }

  const ruleMatch = text.match(
    /(?:always|never|must|should always|should never)\s+(.+?)\.?$/i,
  );
  if (ruleMatch) {
    return {
      entity: "convention",
      key: ruleMatch[1].trim().slice(0, 100),
      value: lower.includes("never") ? "never" : "always",
    };
  }

  const possessiveMatch = text.match(
    /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/,
  );
  if (possessiveMatch) {
    return {
      entity: possessiveMatch[1] || "user",
      key: possessiveMatch[2].trim(),
      value: possessiveMatch[3].trim(),
    };
  }

  const preferMatch = text.match(
    /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/,
  );
  if (preferMatch) {
    return {
      entity: "user",
      key: preferMatch[1],
      value: preferMatch[2].trim(),
    };
  }

  const emailMatch = text.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (emailMatch) {
    return { entity: null, key: "email", value: emailMatch[1] };
  }

  const phoneMatch = text.match(/(\+?\d{10,})/);
  if (phoneMatch) {
    return { entity: null, key: "phone", value: phoneMatch[1] };
  }

  if (category === "entity") {
    const words = text.split(/\s+/);
    const properNouns = words.filter((w) => /^[A-Z][a-z]+/.test(w));
    if (properNouns.length > 0) {
      return { entity: properNouns[0], key: null, value: null };
    }
  }

  return { entity: null, key: null, value: null };
}

// ============================================================================
// Auto-capture Filters
// ============================================================================

const MEMORY_TRIGGERS = [
  /remember|zapamatuj si|pamatuj/i,
  /prefer|radši|nechci/i,
  /decided|rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
  /born on|birthday|lives in|works at/i,
  /password is|api key|token is/i,
  /chose|selected|went with|picked/i,
  /over.*because|instead of.*since/i,
  /\balways\b.*\buse\b|\bnever\b.*\buse\b/i,
  /architecture|stack|approach/i,
];

const SENSITIVE_PATTERNS = [
  /password/i,
  /api.?key/i,
  /secret/i,
  /token\s+is/i,
  /\bssn\b/i,
  /credit.?card/i,
];

/** Patterns that suggest a credential value - for auto-detect prompt to store */
const CREDENTIAL_PATTERNS: Array<{ regex: RegExp; type: string; hint: string }> = [
  { regex: /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i, type: "bearer", hint: "Bearer/JWT token" },
  { regex: /sk-[A-Za-z0-9]{20,}/, type: "api_key", hint: "OpenAI-style API key (sk-...)" },
  { regex: /ghp_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub personal access token" },
  { regex: /gho_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub OAuth token" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, type: "token", hint: "Slack token" },
  { regex: /ssh\s+[\w@.-]+\s+[\w@.-]+/i, type: "ssh", hint: "SSH connection string" },
  { regex: /[\w.-]+@[\w.-]+\.\w+.*(?:password|passwd|token|key)\s*[:=]\s*\S+/i, type: "password", hint: "Credentials with host/email" },
];

function detectCredentialPatterns(text: string): Array<{ type: string; hint: string }> {
  const found: Array<{ type: string; hint: string }> = [];
  const seen = new Set<string>();
  for (const { regex, type, hint } of CREDENTIAL_PATTERNS) {
    if (regex.test(text) && !seen.has(hint)) {
      seen.add(hint);
      found.push({ type, hint });
    }
  }
  return found;
}

/** First credential-like match in text; used to extract secret for vault. */
function extractCredentialMatch(text: string): { type: string; secretValue: string } | null {
  for (const { regex, type } of CREDENTIAL_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      const secretValue = match[0].replace(/^Bearer\s+/i, "").trim();
      if (secretValue.length >= 8) return { type, secretValue };
    }
  }
  return null;
}

/** True if content should be treated as a credential (store in vault when enabled, else in memory). */
function isCredentialLike(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
): boolean {
  if ((entity ?? "").toLowerCase() === "credentials") return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["api_key", "password", "token", "secret", "bearer"].some((x) => k.includes(x) || e.includes(x)))
    return true;
  if (value && value.length >= 8 && /^(eyJ|sk-|ghp_|gho_|xox[baprs]-)/i.test(value)) return true;
  return CREDENTIAL_PATTERNS.some((p) => p.regex.test(text)) || SENSITIVE_PATTERNS.some((r) => r.test(text));
}

const VAULT_POINTER_PREFIX = "vault:";

/** Parse into vault entry when vault is enabled. Returns null if not credential-like or cannot derive service/secret. */
function tryParseCredentialForVault(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
): { service: string; type: "token" | "password" | "api_key" | "ssh" | "bearer" | "other"; secretValue: string; url?: string; notes?: string } | null {
  if (!isCredentialLike(text, entity, key, value)) return null;
  const match = extractCredentialMatch(text);
  const secretValue = (value && value.length >= 8 ? value : match?.secretValue) ?? null;
  if (!secretValue) return null;
  const typeFromPattern = (match?.type ?? "other") as "token" | "password" | "api_key" | "ssh" | "bearer" | "other";
  const service =
    (entity?.toLowerCase() === "credentials" ? key : null) ||
    key ||
    (entity && entity.toLowerCase() !== "credentials" ? entity : null) ||
    inferServiceFromText(text) ||
    "imported";
  const serviceSlug = service.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "imported";
  return {
    service: serviceSlug,
    type: typeFromPattern,
    secretValue,
    notes: text.length <= CREDENTIAL_NOTES_MAX_CHARS ? text : truncateText(text, CREDENTIAL_NOTES_MAX_CHARS - 3, "..."),
  };
}

function inferServiceFromText(text: string): string {
  const lower = text.toLowerCase();
  if (/home\s*assistant|ha\s*token|hass/i.test(lower)) return "home-assistant";
  if (/unifi|ubiquiti/i.test(lower)) return "unifi";
  if (/github|ghp_|gho_/i.test(lower)) return "github";
  if (/openai|sk-proj/i.test(lower)) return "openai";
  if (/twilio/i.test(lower)) return "twilio";
  if (/duckdns/i.test(lower)) return "duckdns";
  if (/slack|xox[baprs]/i.test(lower)) return "slack";
  return "imported";
}

const CREDENTIAL_REDACTION_MIGRATION_FLAG = ".credential-redaction-migrated";

/**
 * When vault is enabled: move existing credential facts from memory into the vault and replace them with pointers.
 * Idempotent: facts that are already pointers (value starts with vault:) are skipped.
 * Returns { migrated, skipped, errors }. If markDone is true, writes a flag file so init only runs once.
 */
async function migrateCredentialsToVault(opts: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  credentialsDb: CredentialsDB;
  migrationFlagPath: string;
  markDone: boolean;
}): Promise<{ migrated: number; skipped: number; errors: string[] }> {
  const { factsDb, vectorDb, embeddings, credentialsDb, migrationFlagPath, markDone } = opts;
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  const results = factsDb.lookup("Credentials");
  const toMigrate = results.filter(
    (r) =>
      !r.entry.text.includes("stored in secure vault") &&
      (r.entry.value == null || !String(r.entry.value).startsWith(VAULT_POINTER_PREFIX)),
  );

  for (const { entry } of toMigrate) {
    const parsed = tryParseCredentialForVault(
      entry.text,
      entry.entity,
      entry.key,
      entry.value,
    );
    if (!parsed) {
      skipped++;
      continue;
    }
    try {
      credentialsDb.store({
        service: parsed.service,
        type: parsed.type,
        value: parsed.secretValue,
        url: parsed.url,
        notes: parsed.notes,
      });
      factsDb.delete(entry.id);
      try {
        await vectorDb.delete(entry.id);
      } catch {
        // LanceDB row might not exist
      }
      const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
      const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
      const pointerEntry = factsDb.store({
        text: pointerText,
        category: "technical" as MemoryCategory,
        importance: 0.8,
        entity: "Credentials",
        key: parsed.service,
        value: pointerValue,
        source: "conversation",
        decayClass: "permanent",
        tags: ["auth", ...extractTags(pointerText, "Credentials")],
      });
      try {
        const vector = await embeddings.embed(pointerText);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: pointerText,
            vector,
            importance: 0.8,
            category: "technical",
            id: pointerEntry.id,
          });
        }
      } catch (e) {
        errors.push(`vector store for ${parsed.service}: ${String(e)}`);
      }
      migrated++;
    } catch (e) {
      errors.push(`${parsed.service}: ${String(e)}`);
    }
  }

  if (markDone) {
    try {
      writeFileSync(migrationFlagPath, "1", "utf8");
    } catch (e) {
      errors.push(`write migration flag: ${String(e)}`);
    }
  }
  return { migrated, skipped, errors };
}

/** True if fact looks like identifier/number (IP, email, phone, UUID, etc.). Used by consolidate to skip by default (2.2/2.4). */
function isStructuredForConsolidation(
  text: string,
  entity: string | null,
  key: string | null,
): boolean {
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) return true;
  if (/[\w.-]+@[\w.-]+\.\w+/.test(text)) return true;
  if (/\+\d{10,}/.test(text) || /\b\d{10,}\b/.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["email", "phone", "api_key", "ip", "uuid", "password"].some((x) => k.includes(x) || e.includes(x))) return true;
  if (SENSITIVE_PATTERNS.some((r) => r.test(text))) return true;
  return false;
}

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > cfg.captureMaxChars) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (SENSITIVE_PATTERNS.some((r) => r.test(text))) return false;
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/decided|chose|went with|selected|always use|never use|over.*because|instead of.*since|rozhodli|will use|budeme/i.test(lower))
    return "decision";
  if (/prefer|radši|like|love|hate|want/i.test(lower)) return "preference";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower))
    return "entity";
  if (/born|birthday|lives|works|is\s|are\s|has\s|have\s/i.test(lower))
    return "fact";
  return "other";
}

// ============================================================================
// LLM-based Auto-Classifier
// ============================================================================

/** Union-find for building clusters from edges. Returns parent map; use getRoot to resolve cluster root. */
function unionFind(ids: string[], edges: Array<[string, string]>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  function find(x: string): string {
    const p = parent.get(x)!;
    if (p !== x) parent.set(x, find(p));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, b] of edges) union(a, b);
  return parent;
}

function getRoot(parent: Map<string, string>, id: string): string {
  let r = id;
  while (parent.get(r) !== r) r = parent.get(r)!;
  return r;
}

/**
 * Consolidation (2.4): find clusters of similar facts (by embedding), merge each cluster with LLM, store one fact and delete cluster.
 * Uses SQLite as source; re-embeds to compute similarity (no Lance scan). Merged fact is stored in both SQLite and Lance.
 * Does not delete from Lance (ids differ); optional future: sync Lance.
 */
async function runConsolidate(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: {
    threshold: number;
    includeStructured: boolean;
    dryRun: boolean;
    limit: number;
    model: string;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ clustersFound: number; merged: number; deleted: number }> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  let candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: consolidate — fewer than 2 candidate facts");
    return { clustersFound: 0, merged: 0, deleted: 0 };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: consolidate — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      try {
        const vec = await embeddings.embed(f.text);
        vectors.push(vec);
      } catch (err) {
        logger.warn(`memory-hybrid: consolidate embed failed for ${id}: ${err}`);
        vectors.push([]);
      }
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vj = vectors[j];
      if (vj.length === 0) continue;
      const score = vi.reduce((s, v, k) => s + v * vj[k], 0);
      if (score >= opts.threshold) edges.push([ids[i], ids[j]]);
    }
  }

  const parent = unionFind(ids, edges);
  const rootToCluster = new Map<string, string[]>();
  for (const id of ids) {
    const r = getRoot(parent, id);
    if (!rootToCluster.has(r)) rootToCluster.set(r, []);
    rootToCluster.get(r)!.push(id);
  }
  const clusters = [...rootToCluster.values()].filter((c) => c.length >= 2);
  logger.info(`memory-hybrid: consolidate — ${clusters.length} clusters (≥2 facts)`);

  if (clusters.length === 0) return { clustersFound: 0, merged: 0, deleted: 0 };

  let merged = 0;
  let deleted = 0;
  for (const clusterIds of clusters) {
    const texts = clusterIds.map((id) => idToFact.get(id)!.text);
    const factsList = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = fillPrompt(loadPrompt("consolidate"), { facts_list: factsList });
    let mergedText: string;
    try {
      const resp = await openai.chat.completions.create({
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 300,
      });
      mergedText = (resp.choices[0]?.message?.content ?? "").trim().slice(0, 5000);
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate LLM failed for cluster: ${err}`);
      continue;
    }
    if (!mergedText) continue;

    const clusterFacts = clusterIds.map((id) => factsDb.getById(id)).filter(Boolean) as MemoryEntry[];
    const first = clusterFacts[0];
    const category = (first?.category as MemoryCategory) ?? "other";
    const maxSourceDate = clusterFacts.reduce(
      (acc, f) => (f.sourceDate != null && (acc == null || f.sourceDate > acc) ? f.sourceDate : acc),
      null as number | null,
    );
    const mergedTags = [...new Set(clusterFacts.flatMap((f) => f.tags ?? []))];

    if (opts.dryRun) {
      logger.info(`memory-hybrid: consolidate [dry-run] would merge ${clusterIds.length} facts → "${mergedText.slice(0, 80)}..."`);
      merged++;
      continue;
    }

    const entry = factsDb.store({
      text: mergedText,
      category,
      importance: 0.8,
      entity: first?.entity ?? null,
      key: null,
      value: null,
      source: "conversation",
      sourceDate: maxSourceDate,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
    });
    try {
      const vector = await embeddings.embed(mergedText);
      await vectorDb.store({ text: mergedText, vector, importance: 0.8, category, id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate vector store failed: ${err}`);
    }
    for (const id of clusterIds) {
      factsDb.delete(id);
      deleted++;
    }
    merged++;
  }

  return { clustersFound: clusters.length, merged, deleted };
}

const REFLECTION_PATTERN_MIN_CHARS = 20;
const REFLECTION_PATTERN_MAX_CHARS = 500;
const REFLECTION_DEDUPE_THRESHOLD = 0.85;
/** Rules: short one-liners (FR-011 optional Rules layer). */
const REFLECTION_RULE_MIN_CHARS = 10;
const REFLECTION_RULE_MAX_CHARS = 120;
/** Meta-patterns: 1-2 sentences (FR-011 optional Reflection on reflections). */
const REFLECTION_META_MIN_CHARS = 20;
const REFLECTION_META_MAX_CHARS = 300;
const REFLECTION_MAX_PATTERNS_FOR_RULES = 50;
const REFLECTION_MAX_PATTERNS_FOR_META = 30;

function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/**
 * FR-011: Run reflection — gather recent facts, call LLM to extract patterns, dedupe, store.
 */
async function runReflection(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  config: { defaultWindow: number; minObservations: number },
  opts: { window: number; dryRun: boolean; model: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ factsAnalyzed: number; patternsExtracted: number; patternsStored: number; window: number }> {
  const windowDays = Math.min(90, Math.max(1, opts.window));
  const windowStartSec = Math.floor(Date.now() / 1000) - windowDays * 86400;

  const allFacts = factsDb.getAll();
  const recentFacts = allFacts.filter((f) => {
    const ts = f.sourceDate ?? f.createdAt;
    return ts >= windowStartSec && f.category !== "pattern" && f.category !== "rule";
  });

  if (recentFacts.length < config.minObservations) {
    logger.info(`memory-hybrid: reflection — ${recentFacts.length} facts in window (min ${config.minObservations})`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  // Group by category, cap length and count
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const f of recentFacts) {
    const cat = f.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const arr = byCategory.get(cat)!;
    if (arr.length >= REFLECTION_MAX_FACTS_PER_CATEGORY) continue;
    arr.push(f);
  }

  const factLines: string[] = [];
  for (const [cat, entries] of byCategory) {
    for (const e of entries) {
      const text = e.text.slice(0, REFLECTION_MAX_FACT_LENGTH).trim();
      if (text.length < 10) continue;
      factLines.push(`[${cat}] ${text}`);
    }
  }
  const factsBlock = factLines.join("\n");
  const prompt = fillPrompt(loadPrompt("reflection"), { window: String(windowDays), facts: factsBlock });

  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1500,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflection LLM failed: ${err}`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const patterns: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*PATTERN:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_PATTERN_MIN_CHARS && text.length <= REFLECTION_PATTERN_MAX_CHARS) {
      patterns.push(text);
    }
  }

  // Deduplicate within batch (first occurrence wins)
  const seenInBatch = new Set<string>();
  const uniqueNewPatterns: string[] = [];
  for (const p of patterns) {
    const key = p.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueNewPatterns.push(p);
  }

  if (uniqueNewPatterns.length === 0) {
    logger.info(`memory-hybrid: reflection — 0 patterns extracted from LLM`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: patterns.length, patternsStored: 0, window: windowDays };
  }

  // Existing patterns (non-superseded, still valid) for dedupe
  const nowSec = Math.floor(Date.now() / 1000);
  const existingPatternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  let existingVectors: number[][] = [];
  if (existingPatternFacts.length > 0) {
    for (let i = 0; i < existingPatternFacts.length; i += 20) {
      const batch = existingPatternFacts.slice(i, i + 20);
      for (const f of batch) {
        try {
          const vec = await embeddings.embed(f.text);
          existingVectors.push(normalizeVector(vec));
        } catch {
          existingVectors.push([]);
        }
      }
      if (i + 20 < existingPatternFacts.length) await new Promise((r) => setTimeout(r, 200));
    }
  }

  let stored = 0;
  for (const patternText of uniqueNewPatterns) {
    const vec = await embeddings.embed(patternText);
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflection [dry-run] would store: ${patternText.slice(0, 60)}...`);
      stored++;
      continue;
    }

    const entry = factsDb.store({
      text: patternText,
      category: "pattern" as MemoryCategory,
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern"],
    });
    try {
      await vectorDb.store({
        text: patternText,
        vector: vec,
        importance: 0.9,
        category: "pattern",
        id: entry.id,
      });
    } catch (err) {
      logger.warn(`memory-hybrid: reflection vector store failed: ${err}`);
    }
    existingVectors.push(normVec);
    stored++;
  }

  return {
    factsAnalyzed: recentFacts.length,
    patternsExtracted: patterns.length,
    patternsStored: stored,
    window: windowDays,
  };
}

/**
 * FR-011 optional: Rules layer — synthesize patterns into actionable one-line rules (category "rule").
 */
async function runReflectionRules(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ rulesExtracted: number; rulesStored: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_RULES).map((f) => f.text);
  if (patterns.length < 2) {
    logger.info(`memory-hybrid: reflect-rules — need at least 2 patterns, have ${patterns.length}`);
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-rules"), { patterns: patternsBlock });
  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 800,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-rules LLM failed: ${err}`);
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const rules: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*RULE:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_RULE_MIN_CHARS && text.length <= REFLECTION_RULE_MAX_CHARS) rules.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueRules: string[] = [];
  for (const r of rules) {
    const key = r.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueRules.push(r);
  }
  if (uniqueRules.length === 0) {
    logger.info("memory-hybrid: reflect-rules — 0 rules extracted from LLM");
    return { rulesExtracted: rules.length, rulesStored: 0 };
  }
  const existingRuleFacts = factsDb.getByCategory("rule").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  let existingVectors: number[][] = [];
  for (let i = 0; i < existingRuleFacts.length; i += 20) {
    const batch = existingRuleFacts.slice(i, i + 20);
    for (const f of batch) {
      try {
        existingVectors.push(normalizeVector(await embeddings.embed(f.text)));
      } catch {
        existingVectors.push([]);
      }
    }
    if (i + 20 < existingRuleFacts.length) await new Promise((r) => setTimeout(r, 200));
  }
  let stored = 0;
  for (const ruleText of uniqueRules) {
    const vec = await embeddings.embed(ruleText);
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-rules [dry-run] would store: ${ruleText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: ruleText,
      category: "rule" as MemoryCategory,
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "rule"],
    });
    try {
      await vectorDb.store({ text: ruleText, vector: vec, importance: 0.9, category: "rule", id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-rules vector store failed: ${err}`);
    }
    existingVectors.push(normVec);
    stored++;
  }
  return { rulesExtracted: rules.length, rulesStored: stored };
}

/**
 * FR-011 optional: Reflection on reflections — synthesize patterns into 1-3 meta-patterns (stored as pattern + meta tag).
 */
async function runReflectionMeta(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: { dryRun: boolean; model: string },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ metaExtracted: number; metaStored: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec),
  );
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_META).map((f) => f.text);
  if (patterns.length < 3) {
    logger.info(`memory-hybrid: reflect-meta — need at least 3 patterns, have ${patterns.length}`);
    return { metaExtracted: 0, metaStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-meta"), { patterns: patternsBlock });
  let rawResponse: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    });
    rawResponse = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-meta LLM failed: ${err}`);
    return { metaExtracted: 0, metaStored: 0 };
  }
  const metas: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*META:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_META_MIN_CHARS && text.length <= REFLECTION_META_MAX_CHARS) metas.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueMetas: string[] = [];
  for (const x of metas) {
    const key = x.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueMetas.push(x);
  }
  if (uniqueMetas.length === 0) {
    logger.info("memory-hybrid: reflect-meta — 0 meta-patterns extracted from LLM");
    return { metaExtracted: metas.length, metaStored: 0 };
  }
  const existingMetaFacts = factsDb.getByCategory("pattern").filter(
    (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec) && (f.tags?.includes("meta") === true),
  );
  let existingVectors: number[][] = [];
  for (let i = 0; i < existingMetaFacts.length; i += 20) {
    const batch = existingMetaFacts.slice(i, i + 20);
    for (const f of batch) {
      try {
        existingVectors.push(normalizeVector(await embeddings.embed(f.text)));
      } catch {
        existingVectors.push([]);
      }
    }
    if (i + 20 < existingMetaFacts.length) await new Promise((r) => setTimeout(r, 200));
  }
  let stored = 0;
  for (const metaText of uniqueMetas) {
    const vec = await embeddings.embed(metaText);
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev.length === 0) continue;
      if (cosineSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-meta [dry-run] would store: ${metaText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: metaText,
      category: "pattern" as MemoryCategory,
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern", "meta"],
    });
    try {
      await vectorDb.store({ text: metaText, vector: vec, importance: 0.9, category: "pattern", id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-meta vector store failed: ${err}`);
    }
    existingVectors.push(normVec);
    stored++;
  }
  return { metaExtracted: metas.length, metaStored: stored };
}

/**
 * Find-duplicates (2.2): report pairs of facts with embedding similarity ≥ threshold.
 * Does not modify store. By default skips identifier-like facts; use includeStructured to include.
 */
async function runFindDuplicates(
  factsDb: FactsDB,
  embeddings: Embeddings,
  opts: { threshold: number; includeStructured: boolean; limit: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{
  pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }>;
  candidatesCount: number;
  skippedStructured: number;
}> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  const skippedStructured = opts.includeStructured ? 0 : facts.filter((f) => isStructuredForConsolidation(f.text, f.entity, f.key)).length;
  const candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: find-duplicates — fewer than 2 candidate facts");
    return { pairs: [], candidatesCount: candidateFacts.length, skippedStructured };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: find-duplicates — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      const vec = await safeEmbed(embeddings, f.text, (msg) => logger.warn(msg));
      vectors.push(vec ?? []);
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }> = [];
  const searchLimit = Math.min(100, ids.length);

  // Use LanceDB vector search (indexed) instead of O(n²) pairwise loop
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    const results = await vectorDb.search(vi, searchLimit, opts.threshold);
    for (const r of results) {
      const j = idToIndex.get(r.entry.id);
      if (j !== undefined && j > i) {
        pairs.push({
          idA: ids[i],
          idB: ids[j],
          score: r.score,
          textA: idToFact.get(ids[i])!.text,
          textB: idToFact.get(ids[j])!.text,
        });
      }
    }
  }
  logger.info(`memory-hybrid: find-duplicates — ${pairs.length} pairs ≥ ${opts.threshold}`);
  return { pairs, candidatesCount: candidateFacts.length, skippedStructured };
}

/** Minimum "other" facts before we run category discovery (avoid noise on tiny sets). */
const MIN_OTHER_FOR_DISCOVERY = 15;
/** Batch size for discovery prompts (leave room for JSON array of labels). */
const DISCOVERY_BATCH_SIZE = 25;

/**
 * Normalize a free-form label to a valid category slug: lowercase, alphanumeric + underscore.
 * Returns empty string if result would be "other" or invalid.
 */
function normalizeSuggestedLabel(s: string): string {
  const t = s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return t && t !== "other" && t.length <= 40 ? t : "";
}

/**
 * Ask the LLM to group "other" facts by topic (free-form labels). Labels with at least
 * minFactsForNewCategory facts become new categories; we do not tell the LLM the threshold.
 * Returns list of newly created category names; updates DB and persists to discoveredCategoriesPath.
 */
async function discoverCategoriesFromOther(
  db: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  discoveredCategoriesPath: string,
): Promise<string[]> {
  if (config.suggestCategories !== true) return [];
  const minForNew = config.minFactsForNewCategory ?? 10;
  const others = db.getByCategory("other");
  if (others.length < MIN_OTHER_FOR_DISCOVERY) return [];

  logger.info(`memory-hybrid: category discovery on ${others.length} "other" facts (min ${minForNew} per label)`);

  const existingCategories = new Set(getMemoryCategories());
  const labelToIds = new Map<string, string[]>();

  for (let i = 0; i < others.length; i += DISCOVERY_BATCH_SIZE) {
    const batch = others.slice(i, i + DISCOVERY_BATCH_SIZE);
    const factLines = batch.map((f, idx) => `${idx + 1}. ${f.text.slice(0, 280)}`).join("\n");
    const prompt = fillPrompt(loadPrompt("category-discovery"), { facts: factLines });

    try {
      const resp = await openai.chat.completions.create({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: batch.length * 24,
      });
      const content = resp.choices[0]?.message?.content?.trim() || "[]";
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const labels: unknown[] = JSON.parse(jsonMatch[0]);
      for (let j = 0; j < Math.min(labels.length, batch.length); j++) {
        const raw = typeof labels[j] === "string" ? (labels[j] as string) : "";
        const label = normalizeSuggestedLabel(raw);
        if (!label) continue;
        if (!labelToIds.has(label)) labelToIds.set(label, []);
        labelToIds.get(label)!.push(batch[j].id);
      }
    } catch (err) {
      logger.warn(`memory-hybrid: category discovery batch failed: ${err}`);
    }
    if (i + DISCOVERY_BATCH_SIZE < others.length) await new Promise((r) => setTimeout(r, 400));
  }

  const newCategoryNames: string[] = [];
  for (const [label, ids] of labelToIds) {
    if (existingCategories.has(label)) continue;
    if (ids.length < minForNew) continue;
    newCategoryNames.push(label);
    for (const id of ids) db.updateCategory(id, label);
  }

  if (newCategoryNames.length === 0) return [];

  setMemoryCategories([...getMemoryCategories(), ...newCategoryNames]);
  logger.info(`memory-hybrid: discovered ${newCategoryNames.length} new categories: ${newCategoryNames.join(", ")} (${newCategoryNames.reduce((acc, c) => acc + (labelToIds.get(c)?.length ?? 0), 0)} facts reclassified)`);

  mkdirSync(dirname(discoveredCategoriesPath), { recursive: true });
  const existingList: string[] = existsSync(discoveredCategoriesPath)
    ? (JSON.parse(readFileSync(discoveredCategoriesPath, "utf-8")) as string[])
    : [];
  const merged = [...new Set([...existingList, ...newCategoryNames])];
  writeFileSync(discoveredCategoriesPath, JSON.stringify(merged, null, 2), "utf-8");

  return newCategoryNames;
}

/**
 * Classify a batch of "other" facts into proper categories using a cheap LLM.
 * Returns a map of factId → newCategory.
 */
async function classifyBatch(
  openai: OpenAI,
  model: string,
  facts: { id: string; text: string }[],
  categories: readonly string[],
): Promise<Map<string, string>> {
  const catList = categories.filter((c) => c !== "other").join(", ");
  const factLines = facts
    .map((f, i) => `${i + 1}. ${f.text.slice(0, 300)}`)
    .join("\n");

  const prompt = `You are a memory classifier. Categorize each fact into exactly one category.

Available categories: ${catList}
Use "other" ONLY if no category fits at all.

Facts to classify:
${factLines}

Respond with ONLY a JSON array of category strings, one per fact, in order. Example: ["fact","entity","preference"]`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: facts.length * 20,
    });

    const content = resp.choices[0]?.message?.content?.trim() || "[]";
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return new Map();

    const results: string[] = JSON.parse(jsonMatch[0]);
    const map = new Map<string, string>();

    for (let i = 0; i < Math.min(results.length, facts.length); i++) {
      const cat = results[i]?.toLowerCase()?.trim();
      if (cat && cat !== "other" && isValidCategory(cat)) {
        map.set(facts[i].id, cat);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Run auto-classification on all "other" facts. Called on schedule or manually.
 * If opts.discoveredCategoriesPath and config.suggestCategories are set, runs category discovery first
 * (LLM groups "other" by free-form label; labels with ≥ minFactsForNewCategory become new categories).
 */
async function runAutoClassify(
  db: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  opts?: { discoveredCategoriesPath?: string },
): Promise<{ reclassified: number; suggested: string[] }> {
  const categories = getMemoryCategories();

  // Optionally discover new categories from "other" (free-form grouping; threshold not told to LLM)
  if (opts?.discoveredCategoriesPath && config.suggestCategories) {
    await discoverCategoriesFromOther(db, openai, config, logger, opts.discoveredCategoriesPath);
  }

  // Get all "other" facts (after discovery some may have been reclassified)
  const others = db.getByCategory("other");
  if (others.length === 0) {
    return { reclassified: 0, suggested: [] };
  }

  logger.info(`memory-hybrid: auto-classify starting on ${others.length} "other" facts`);

  let totalReclassified = 0;

  // Process in batches
  for (let i = 0; i < others.length; i += config.batchSize) {
    const batch = others.slice(i, i + config.batchSize).map((e) => ({
      id: e.id,
      text: e.text,
    }));

    const results = await classifyBatch(openai, config.model, batch, categories);

    for (const [id, newCat] of results) {
      db.updateCategory(id, newCat);
      totalReclassified++;
    }

    // Small delay between batches to avoid rate limits
    if (i + config.batchSize < others.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logger.info(`memory-hybrid: auto-classify done — reclassified ${totalReclassified}/${others.length} facts`);
  return { reclassified: totalReclassified, suggested: [] };
}

// ============================================================================
// Plugin Definition
// ============================================================================

// Mutable module-level state so that ALL closures (tools, event handlers,
// timers) always see the *current* instances — even after a SIGUSR1 reload
// where stop() closes the old DB and register() creates a new one.
// Without this, old closures captured const locals from the first register()
// call and kept using a closed database after restart.
let cfg: HybridMemoryConfig;
let resolvedLancePath: string;
let resolvedSqlitePath: string;
let factsDb: FactsDB;
let vectorDb: VectorDB;
let embeddings: Embeddings;
let openaiClient: OpenAI;
let credentialsDb: CredentialsDB | null = null;
let wal: WriteAheadLog | null = null;
let proposalsDb: ProposalsDB | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let classifyTimer: ReturnType<typeof setInterval> | null = null;
let classifyStartupTimeout: ReturnType<typeof setTimeout> | null = null;
let proposalsPruneTimer: ReturnType<typeof setInterval> | null = null;

/** FR-009: Last progressive index fact IDs (1-based position → fact id) so memory_recall(id: 1) can resolve. */
let lastProgressiveIndexIds: string[] = [];

const PLUGIN_ID = "openclaw-hybrid-memory";

const memoryHybridPlugin = {
  id: PLUGIN_ID,
  name: "Memory (Hybrid: SQLite + LanceDB)",
  description:
    "Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  kind: "memory" as const,
  configSchema: hybridConfigSchema,
  versionInfo,

  register(api: ClawdbotPluginApi) {
    // Reopen guard: ensure any previous instance is closed before creating new one (avoids duplicate
    // DB instances if host calls register() before stop(), e.g. on SIGUSR1 or rapid reload).
    if (typeof factsDb?.close === "function") {
      try {
        factsDb.close();
      } catch {
        // ignore
      }
    }
    if (typeof vectorDb?.close === "function") {
      try {
        vectorDb.close();
      } catch {
        // ignore
      }
    }
    if (credentialsDb) {
      try {
        credentialsDb.close();
      } catch {
        // ignore
      }
      credentialsDb = null;
    }
    if (proposalsDb) {
      try {
        proposalsDb.close();
      } catch {
        // ignore
      }
      proposalsDb = null;
    }

    cfg = hybridConfigSchema.parse(api.pluginConfig);
    resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
    resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
    vectorDb = new VectorDB(resolvedLancePath, vectorDim);
    vectorDb.setLogger(api.logger);
    embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);
    openaiClient = new OpenAI({ apiKey: cfg.embedding.apiKey });

    if (cfg.credentials.enabled) {
      const credPath = join(dirname(resolvedSqlitePath), "credentials.db");
      credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey);
      api.logger.info(`memory-hybrid: credentials store enabled (${credPath})`);
    } else {
      credentialsDb = null;
    }

    // Initialize Write-Ahead Log for crash resilience
    if (cfg.wal.enabled) {
      const walPath = cfg.wal.walPath || join(dirname(resolvedSqlitePath), "memory.wal");
      wal = new WriteAheadLog(walPath, cfg.wal.maxAge);
      api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
    } else {
      wal = null;
    }

    if (cfg.personaProposals.enabled) {
      const proposalsPath = join(dirname(resolvedSqlitePath), "proposals.db");
      proposalsDb = new ProposalsDB(proposalsPath);
      api.logger.info(`memory-hybrid: persona proposals enabled (${proposalsPath})`);
    } else {
      proposalsDb = null;
    }

    // Load previously discovered categories so they remain available after restart
    const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
    if (existsSync(discoveredPath)) {
      try {
        const loaded = JSON.parse(readFileSync(discoveredPath, "utf-8")) as string[];
        if (Array.isArray(loaded) && loaded.length > 0) {
          setMemoryCategories([...getMemoryCategories(), ...loaded]);
          api.logger.info(`memory-hybrid: loaded ${loaded.length} discovered categories`);
        }
      } catch {
        // ignore invalid or missing file
      }
    }

    api.logger.info(
      `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
    );

    // Prerequisite checks (async, non-blocking): verify keys and model access so user gets clear errors
    void (async () => {
      try {
        await embeddings.embed("verify");
        api.logger.info("memory-hybrid: embedding API check OK");
      } catch (e) {
        api.logger.error(
          `memory-hybrid: Embedding API check failed — ${String(e)}. ` +
            "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.",
        );
      }
      if (cfg.credentials.enabled && credentialsDb) {
        try {
          const items = credentialsDb.list();
          if (items.length > 0) {
            const first = items[0];
            credentialsDb.get(first.service, first.type as CredentialType);
          }
          api.logger.info("memory-hybrid: credentials vault check OK");
        } catch (e) {
          api.logger.error(
            `memory-hybrid: Credentials vault check failed — ${String(e)}. ` +
              "Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.",
          );
        }
        // When vault is enabled: once per install, move existing credential facts into vault and redact from memory
        const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
        if (!existsSync(migrationFlagPath)) {
          try {
            const result = await migrateCredentialsToVault({
              factsDb,
              vectorDb,
              embeddings,
              credentialsDb,
              migrationFlagPath,
              markDone: true,
            });
            if (result.migrated > 0) {
              api.logger.info(`memory-hybrid: migrated ${result.migrated} credential(s) from memory into vault`);
            }
            if (result.errors.length > 0) {
              api.logger.warn(`memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`);
            }
          } catch (e) {
            api.logger.warn(`memory-hybrid: credential migration failed: ${e}`);
          }
        }
      }
    })();

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories using both structured (exact) and semantic (fuzzy) search.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({
              description: "Search query (omit when using id to fetch a specific memory)",
            }),
          ),
          id: Type.Optional(
            Type.Union([Type.String(), Type.Number()], {
              description:
                "Fetch a specific memory: fact id (UUID string) or 1-based index from the last progressive index (e.g. 1 for first listed memory).",
            }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: 5)" }),
          ),
          entity: Type.Optional(
            Type.String({
              description: "Optional: filter by entity name for exact lookup",
            }),
          ),
          tag: Type.Optional(
            Type.String({
              description: "Optional: filter by topic tag (e.g. nibe, zigbee)",
            }),
          ),
          includeSuperseded: Type.Optional(
            Type.Boolean({
              description: "FR-010: Include superseded (historical) facts in results. Default: only current facts.",
            }),
          ),
          asOf: Type.Optional(
            Type.String({
              description: "FR-010: Point-in-time query: ISO date (YYYY-MM-DD) or epoch seconds. Return only facts valid at that time.",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const {
            query: queryParam,
            id: idParam,
            limit = 5,
            entity,
            tag,
            includeSuperseded = false,
            asOf: asOfParam,
          } = params as {
            query?: string;
            id?: string | number;
            limit?: number;
            entity?: string;
            tag?: string;
            includeSuperseded?: boolean;
            asOf?: string;
          };
          const asOfSec = asOfParam != null && asOfParam !== "" ? parseSourceDate(asOfParam) : undefined;

          // FR-009: Fetch by id (fact id or 1-based index from last progressive index)
          if (idParam !== undefined && idParam !== null && idParam !== "") {
            let factId: string | null = null;
            if (typeof idParam === "number") {
              const idx = Math.floor(idParam);
              if (idx >= 1 && idx <= lastProgressiveIndexIds.length) {
                factId = lastProgressiveIndexIds[idx - 1] ?? null;
              }
            } else if (typeof idParam === "string" && idParam.trim().length > 0) {
              const trimmed = idParam.trim();
              // Check if it's a numeric string (progressive index position)
              if (/^\d+$/.test(trimmed)) {
                const idx = parseInt(trimmed, 10);
                if (idx >= 1 && idx <= lastProgressiveIndexIds.length) {
                  factId = lastProgressiveIndexIds[idx - 1] ?? null;
                }
              } else {
                // Treat as fact ID
                factId = trimmed;
              }
            }
            if (factId) {
              const entry = factsDb.getById(factId);
              if (entry) {
                const text = `[${entry.category}] ${entry.text}`;
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory (id: ${entry.id}):\n\n${text}`,
                    },
                  ],
                  details: {
                    count: 1,
                    memories: [
                      {
                        id: entry.id,
                        text: entry.text,
                        category: entry.category,
                        entity: entry.entity,
                        importance: entry.importance,
                        score: 1,
                        backend: "sqlite" as const,
                        tags: entry.tags?.length ? entry.tags : undefined,
                        sourceDate: entry.sourceDate
                          ? new Date(entry.sourceDate * 1000).toISOString().slice(0, 10)
                          : undefined,
                      },
                    ],
                  },
                };
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    typeof idParam === "number"
                      ? `No memory at index ${idParam}. Use a number between 1 and ${lastProgressiveIndexIds.length} from the index, or provide a fact id.`
                      : `No memory found with id: ${idParam}.`,
                },
              ],
              details: { count: 0 },
            };
          }

          const query = typeof queryParam === "string" && queryParam.trim().length > 0 ? queryParam.trim() : null;
          if (!query) {
            return {
              content: [
                {
                  type: "text",
                  text: "Provide a search query or an id (fact id or index from the memory index) to recall memories.",
                },
              ],
              details: { count: 0 },
            };
          }

          const recallOpts = { tag, includeSuperseded, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
          let sqliteResults: SearchResult[] = [];
          if (entity) {
            sqliteResults = factsDb.lookup(entity, undefined, tag, recallOpts);
          }

          const ftsResults = factsDb.search(query, limit, recallOpts);
          sqliteResults = [...sqliteResults, ...ftsResults];

          let lanceResults: SearchResult[] = [];
          if (!tag) {
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, limit, 0.3);
            } catch (err) {
              api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
            }
          }

          let results = mergeResults(sqliteResults, lanceResults, limit, factsDb);

          // FR-007: Graph traversal — expand results with connected facts when enabled
          if (cfg.graph.enabled && cfg.graph.useInRecall && results.length > 0) {
            const initialIds = new Set(results.map((r) => r.entry.id));
            const connectedIds = factsDb.getConnectedFactIds([...initialIds], cfg.graph.maxTraversalDepth);
            const extraIds = connectedIds.filter((id) => !initialIds.has(id));
            for (const id of extraIds) {
              const entry = factsDb.getById(id);
              if (entry) {
                results.push({
                  entry,
                  score: 0.45,
                  backend: "sqlite",
                });
              }
            }
            results.sort((a, b) => b.score - a.score);
            results = results.slice(0, limit);
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.backend}/${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          const sanitized = results.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            entity: r.entry.entity,
            importance: r.entry.importance,
            score: r.score,
            backend: r.backend,
            tags: r.entry.tags?.length ? r.entry.tags : undefined,
            sourceDate: r.entry.sourceDate
              ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
              : undefined,
          }));

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: { count: results.length, memories: sanitized },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({ description: "Importance 0-1 (default: 0.7)" }),
          ),
          category: Type.Optional(
            stringEnum(getMemoryCategories() as unknown as readonly string[]),
          ),
          entity: Type.Optional(
            Type.String({
              description: "Entity name (person, project, tool, etc.)",
            }),
          ),
          key: Type.Optional(
            Type.String({
              description: "Structured key (e.g. 'birthday', 'email')",
            }),
          ),
          value: Type.Optional(
            Type.String({
              description: "Structured value (e.g. 'Nov 13', 'john@example.com')",
            }),
          ),
          decayClass: Type.Optional(
            stringEnum(DECAY_CLASSES as unknown as readonly string[]),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Topic tags for sharper retrieval (e.g. nibe, zigbee). Auto-inferred if omitted.",
            }),
          ),
          supersedes: Type.Optional(
            Type.String({
              description: "FR-010: Fact id this one supersedes (replaces). Marks the old fact as superseded and links the new one.",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const {
            text,
            importance = 0.7,
            category = "other",
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
            tags: paramTags,
            supersedes,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
            tags?: string[];
            supersedes?: string;
          };

          let textToStore = text;
          textToStore = truncateForStorage(textToStore, cfg.captureMaxChars);

          if (factsDb.hasDuplicate(textToStore)) {
            return {
              content: [
                { type: "text", text: `Similar memory already exists.` },
              ],
              details: { action: "duplicate" },
            };
          }

          const extracted = extractStructuredFields(textToStore, category as MemoryCategory);
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          // Dual-mode credentials: vault enabled → store in vault + pointer in memory; vault disabled → store in memory (live behavior).
          // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
          if (cfg.credentials.enabled && credentialsDb && isCredentialLike(textToStore, entity, key, value)) {
            const parsed = tryParseCredentialForVault(textToStore, entity, key, value);
            if (parsed) {
              credentialsDb.store({
                service: parsed.service,
                type: parsed.type,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
              const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
              const pointerEntry = factsDb.store({
                text: pointerText,
                category: "technical" as MemoryCategory,
                importance,
                entity: "Credentials",
                key: parsed.service,
                value: pointerValue,
                source: "conversation",
                decayClass: paramDecayClass ?? "permanent",
                tags: ["auth", ...extractTags(pointerText, "Credentials")],
              });
              try {
                const vector = await embeddings.embed(pointerText);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({
                    text: pointerText,
                    vector,
                    importance,
                    category: "technical",
                    id: pointerEntry.id,
                  });
                }
              } catch (err) {
                api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
              }
              return {
                content: [{ type: "text", text: `Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer saved in memory.` }],
                details: { action: "credential_vault", id: pointerEntry.id, service: parsed.service, type: parsed.type },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
                },
              ],
              details: { action: "credential_skipped" },
            };
          }

          const tags =
            paramTags && paramTags.length > 0
              ? paramTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
              : extractTags(textToStore, entity);

          const summaryThreshold = cfg.autoRecall.summaryThreshold;
          const summary =
            summaryThreshold > 0 && textToStore.length > summaryThreshold
              ? textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim() + "…"
              : undefined;

          // Generate vector first (needed for WAL and storage)
          let vector: number[] | undefined;
          try {
            vector = await embeddings.embed(textToStore);
          } catch (err) {
            api.logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
          }

          // FR-008: Classify the operation before storing (use embedding similarity per issue #8)
          if (cfg.store.classifyBeforeWrite) {
            let similarFacts: MemoryEntry[] = [];
            if (vector) {
              similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
            }
            if (similarFacts.length === 0) {
              similarFacts = factsDb.findSimilarForClassification(textToStore, entity, key, 5);
            }
            if (similarFacts.length > 0) {
              const classification = await classifyMemoryOperation(
                textToStore, entity, key, similarFacts, openaiClient, cfg.store.classifyModel ?? "gpt-4o-mini", api.logger,
              );

              if (classification.action === "NOOP") {
                return {
                  content: [{ type: "text", text: `Already known: ${classification.reason}` }],
                  details: { action: "noop", reason: classification.reason },
                };
              }

              if (classification.action === "DELETE" && classification.targetId) {
                factsDb.supersede(classification.targetId, null);
                return {
                  content: [{ type: "text", text: `Retracted fact ${classification.targetId}: ${classification.reason}` }],
                  details: { action: "delete", targetId: classification.targetId, reason: classification.reason },
                };
              }

              if (classification.action === "UPDATE" && classification.targetId) {
                const oldFact = factsDb.getById(classification.targetId);
                if (oldFact) {
                  // WAL: Write pending UPDATE operation
                  const walEntryId = randomUUID();
                  if (wal) {
                    try {
                      wal.write({
                        id: walEntryId,
                        timestamp: Date.now(),
                        operation: "update",
                        data: {
                          text: textToStore,
                          category,
                          importance: Math.max(importance, oldFact.importance),
                          entity: entity || oldFact.entity,
                          key: key || oldFact.key,
                          value: value || oldFact.value,
                          source: "conversation",
                          decayClass: paramDecayClass ?? oldFact.decayClass,
                          summary,
                          tags,
                          vector,
                        },
                      });
                    } catch (err) {
                      api.logger.warn(`memory-hybrid: WAL write failed: ${err}`);
                    }
                  }

                  // Store the new version and supersede the old one (FR-010: bi-temporal)
                  const nowSec = Math.floor(Date.now() / 1000);
                  const newEntry = factsDb.store({
                    text: textToStore,
                    category: category as MemoryCategory,
                    importance: Math.max(importance, oldFact.importance),
                    entity: entity || oldFact.entity,
                    key: key || oldFact.key,
                    value: value || oldFact.value,
                    source: "conversation",
                    decayClass: paramDecayClass ?? oldFact.decayClass,
                    summary,
                    tags,
                    validFrom: nowSec,
                    supersedesId: classification.targetId,
                  });
                  factsDb.supersede(classification.targetId, newEntry.id);

                  const finalImportance = Math.max(importance, oldFact.importance);
                  try {
                    if (vector && !(await vectorDb.hasDuplicate(vector))) {
                      await vectorDb.store({ text: textToStore, vector, importance: finalImportance, category, id: newEntry.id });
                    }
                  } catch (err) {
                    api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                  }

                  // WAL: Remove entry after successful commit
                  if (wal) {
                    try {
                      wal.remove(walEntryId);
                    } catch (err) {
                      api.logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
                    }
                  }

                  api.logger.info?.(
                    `memory-hybrid: UPDATE — superseded ${classification.targetId} with ${newEntry.id}: ${classification.reason}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Updated: superseded old fact with "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${newEntry.decayClass}] (reason: ${classification.reason})`,
                      },
                    ],
                    details: { action: "updated", id: newEntry.id, superseded: classification.targetId, reason: classification.reason, backend: "both", decayClass: newEntry.decayClass },
                  };
                }
              }
              // action === "ADD" falls through to normal store
            }
          }

          // WAL: Write pending operation before committing to storage
          const walEntryId = randomUUID();
          if (wal) {
            try {
              wal.write({
                id: walEntryId,
                timestamp: Date.now(),
                operation: "store",
                data: {
                  text: textToStore,
                  category,
                  importance,
                  entity,
                  key,
                  value,
                  source: "conversation",
                  decayClass: paramDecayClass,
                  summary,
                  tags,
                  vector,
                },
              });
            } catch (err) {
              api.logger.warn(`memory-hybrid: WAL write failed: ${err}`);
            }
          }

          // Now commit to actual storage (FR-010: optional supersedes for manual supersession)
          const nowSec = Math.floor(Date.now() / 1000);
          const entry = factsDb.store({
            text: textToStore,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: "conversation",
            decayClass: paramDecayClass,
            summary,
            tags,
            ...(supersedes?.trim()
              ? { validFrom: nowSec, supersedesId: supersedes.trim() }
              : {}),
          });
          if (supersedes?.trim()) {
            factsDb.supersede(supersedes.trim(), entry.id);
          }

          try {
            if (vector && !(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                text: textToStore,
                vector,
                importance,
                category,
                id: entry.id,
              });
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
          }

          // WAL: Remove entry after successful commit
          if (wal) {
            try {
              wal.remove(walEntryId);
            } catch (err) {
              api.logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
            }
          }

          // FR-007: Auto-link to similar facts when enabled
          let autoLinked = 0;
          if (cfg.graph.enabled && cfg.graph.autoLink) {
            const similar = factsDb.findSimilarForClassification(
              textToStore,
              entity ?? null,
              key ?? null,
              cfg.graph.autoLinkLimit,
            );
            for (const s of similar) {
              if (s.id === entry.id) continue;
              factsDb.createLink(entry.id, s.id, "RELATED_TO", cfg.graph.autoLinkMinScore);
              autoLinked++;
            }
          }

          const storedMsg =
            `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]` +
            (supersedes?.trim() ? " (supersedes previous fact)" : "") +
            (autoLinked > 0 ? ` (linked to ${autoLinked} related fact${autoLinked === 1 ? "" : "s"})` : "");

          return {
            content: [
              {
                type: "text",
                text: storedMsg,
              },
            ],
            details: {
              action: supersedes?.trim() ? "updated" : "created",
              id: entry.id,
              backend: "both",
              decayClass: entry.decayClass,
              ...(supersedes?.trim() ? { superseded: supersedes.trim() } : {}),
              ...(autoLinked > 0 ? { autoLinked } : {}),
            },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories from both backends.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: "Search to find memory" }),
          ),
          memoryId: Type.Optional(
            Type.String({ description: "Specific memory ID" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            const sqlDeleted = factsDb.delete(memoryId);
            let lanceDeleted = false;
            try {
              lanceDeleted = await vectorDb.delete(memoryId);
            } catch (err) {
              api.logger.warn(`memory-hybrid: LanceDB delete during tool failed: ${err}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${memoryId} forgotten (sqlite: ${sqlDeleted}, lance: ${lanceDeleted}).`,
                },
              ],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const sqlResults = factsDb.search(query, 5);
            let lanceResults: SearchResult[] = [];
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, 5, 0.7);
            } catch (err) {
              api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
            }

            const results = mergeResults(sqlResults, lanceResults, 5, factsDb);

            if (results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { found: 0 },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              const id = results[0].entry.id;
              factsDb.delete(id);
              try {
                await vectorDb.delete(id);
              } catch (err) {
                api.logger.warn(`memory-hybrid: LanceDB delete during supersede failed: ${err}`);
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].entry.text}"`,
                  },
                ],
                details: { action: "deleted", id },
              };
            }

            const list = results
              .map(
                (r) =>
                  `- [${r.entry.id.slice(0, 8)}] (${r.backend}) ${r.entry.text.slice(0, 60)}...`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: results.map((r) => ({
                  id: r.entry.id,
                  text: r.entry.text,
                  backend: r.backend,
                  score: r.score,
                })),
              },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      },
      { name: "memory_forget" },
    );

    // FR-007: Graph tools (when graph enabled)
    if (cfg.graph.enabled) {
      api.registerTool(
        {
          name: "memory_link",
          label: "Memory Link",
          description:
            "Create a typed relationship between two memories. Link types: SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON.",
          parameters: Type.Object({
            sourceFact: Type.String({ description: "ID of the source fact" }),
            targetFact: Type.String({ description: "ID of the target fact" }),
            linkType: stringEnum(MEMORY_LINK_TYPES as unknown as readonly string[]),
            strength: Type.Optional(
              Type.Number({ description: "Link strength 0.0-1.0 (default 1.0)" }),
            ),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { sourceFact, targetFact, linkType, strength = 1.0 } = params as {
              sourceFact: string;
              targetFact: string;
              linkType: MemoryLinkType;
              strength?: number;
            };
            const src = factsDb.getById(sourceFact);
            const tgt = factsDb.getById(targetFact);
            if (!src) {
              return {
                content: [{ type: "text", text: `Source fact not found: ${sourceFact}` }],
                details: { error: "source_not_found", id: sourceFact },
              };
            }
            if (!tgt) {
              return {
                content: [{ type: "text", text: `Target fact not found: ${targetFact}` }],
                details: { error: "target_not_found", id: targetFact },
              };
            }
            const linkId = factsDb.createLink(sourceFact, targetFact, linkType, strength);
            const msg = `Created ${linkType} link from "${src.text.slice(0, 50)}${src.text.length > 50 ? "…" : ""}" to "${tgt.text.slice(0, 50)}${tgt.text.length > 50 ? "…" : ""}" (strength: ${strength})`;
            return {
              content: [{ type: "text", text: msg }],
              details: { linkId, sourceFact, targetFact, linkType, strength },
            };
          },
        },
        { name: "memory_link" },
      );

      api.registerTool(
        {
          name: "memory_graph",
          label: "Memory Graph",
          description: "Explore connections from a memory: show direct links and optionally traverse up to depth 3.",
          parameters: Type.Object({
            factId: Type.String({ description: "ID of the fact to explore" }),
            depth: Type.Optional(
              Type.Number({ description: "Max hops to traverse (default 2, max 3)" }),
            ),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { factId, depth = 2 } = params as { factId: string; depth?: number };
            const fact = factsDb.getById(factId);
            if (!fact) {
              return {
                content: [{ type: "text", text: `Fact not found: ${factId}` }],
                details: { error: "not_found", id: factId },
              };
            }
            const maxD = Math.min(3, Math.max(1, depth));
            const out = factsDb.getLinksFrom(factId);
            const in_ = factsDb.getLinksTo(factId);
            const lines: string[] = [
              `Fact: "${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}"`,
              "",
              "Direct links:",
            ];
            for (const l of out) {
              const t = factsDb.getById(l.targetFactId);
              lines.push(`  → [${l.linkType}] ${t ? t.text.slice(0, 60) + (t.text.length > 60 ? "…" : "") : l.targetFactId} (strength: ${l.strength.toFixed(2)})`);
            }
            for (const l of in_) {
              const s = factsDb.getById(l.sourceFactId);
              lines.push(`  ← [${l.linkType}] ${s ? s.text.slice(0, 60) + (s.text.length > 60 ? "…" : "") : l.sourceFactId} (strength: ${l.strength.toFixed(2)})`);
            }
            const connectedIds = factsDb.getConnectedFactIds([factId], maxD);
            lines.push("");
            lines.push(`Total connected facts (depth ${maxD}): ${connectedIds.length}`);
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                factId,
                outbound: out.length,
                inbound: in_.length,
                connectedCount: connectedIds.length,
              },
            };
          },
        },
        { name: "memory_graph" },
      );
    }

    // Credential tools (opt-in)
    if (cfg.credentials.enabled && credentialsDb) {
      api.registerTool(
        {
          name: "credential_store",
          label: "Store Credential",
          description:
            "Store a credential (API key, token, password, SSH key, etc.) in encrypted storage. Use exact service names for reliable retrieval.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github', 'openai')" }),
            type: stringEnum(CREDENTIAL_TYPES as unknown as readonly string[]),
            value: Type.String({ description: "The secret value (token, password, API key)" }),
            url: Type.Optional(Type.String({ description: "Optional URL or endpoint" })),
            notes: Type.Optional(Type.String({ description: "Optional notes" })),
            expires: Type.Optional(Type.Number({ description: "Optional Unix timestamp when credential expires" })),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { service, type, value, url, notes, expires } = params as {
              service: string;
              type: CredentialType;
              value: string;
              url?: string;
              notes?: string;
              expires?: number | null;
            };
            if (!credentialsDb) throw new Error("Credentials store not available");
            credentialsDb.store({ service, type, value, url, notes, expires });
            return {
              content: [{ type: "text", text: `Stored credential for ${service} (${type}).` }],
              details: { service, type },
            };
          },
        },
        { name: "credential_store" },
      );

      api.registerTool(
        {
          name: "credential_get",
          label: "Get Credential",
          description:
            "Retrieve a credential by service name. Exact lookup — no fuzzy search. Specify type to disambiguate when multiple credential types exist for a service.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github')" }),
            type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { service, type } = params as { service: string; type?: CredentialType };
            if (!credentialsDb) throw new Error("Credentials store not available");
            const entry = credentialsDb.get(service, type);
            if (!entry) {
              return {
                content: [{ type: "text", text: `No credential found for service "${service}"${type ? ` (type: ${type})` : ""}.` }],
                details: { found: false },
              };
            }
            const warnDays = cfg.credentials.expiryWarningDays ?? 7;
            const nowSec = Math.floor(Date.now() / 1000);
            const expiresSoon = entry.expires != null && entry.expires - nowSec < warnDays * 24 * 3600;
            const expiryWarning = expiresSoon
              ? ` [WARNING: Expires in ${Math.ceil((entry.expires! - nowSec) / 86400)} days — consider rotating]`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Credential for ${entry.service} (${entry.type}) retrieved. Value available in tool result (details.value).${expiryWarning}`,
                },
              ],
              details: {
                service: entry.service,
                type: entry.type,
                url: entry.url,
                expires: entry.expires,
                value: entry.value,
                sensitiveFields: ["value"],
              },
            };
          },
        },
        { name: "credential_get" },
      );

      api.registerTool(
        {
          name: "credential_list",
          label: "List Credentials",
          description: "List stored credentials (service/type/url only — no values). Use credential_get to retrieve a specific credential.",
          parameters: Type.Object({}),
          async execute() {
            if (!credentialsDb) throw new Error("Credentials store not available");
            const items = credentialsDb.list();
            if (items.length === 0) {
              return {
                content: [{ type: "text", text: "No credentials stored." }],
                details: { count: 0, items: [] },
              };
            }
            const lines = items.map(
              (i) => `- ${i.service} (${i.type})${i.url ? ` @ ${i.url}` : ""}${i.expires ? ` [expires: ${new Date(i.expires * 1000).toISOString()}]` : ""}`,
            );
            return {
              content: [{ type: "text", text: `Stored credentials:\n${lines.join("\n")}` }],
              details: { count: items.length, items },
            };
          },
        },
        { name: "credential_list" },
      );

      api.registerTool(
        {
          name: "credential_delete",
          label: "Delete Credential",
          description: "Delete a stored credential by service name. Optionally specify type to delete only that credential type.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name" }),
            type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { service, type } = params as { service: string; type?: CredentialType };
            if (!credentialsDb) throw new Error("Credentials store not available");
            const deleted = credentialsDb.delete(service, type);
            if (!deleted) {
              return {
                content: [{ type: "text", text: `No credential found for "${service}"${type ? ` (type: ${type})` : ""}.` }],
                details: { deleted: false },
              };
            }
            return {
              content: [{ type: "text", text: `Deleted credential for ${service}${type ? ` (${type})` : ""}.` }],
              details: { deleted: true, service, type },
            };
          },
        },
        { name: "credential_delete" },
      );
    }

    api.registerTool(
      {
        name: "memory_checkpoint",
        label: "Memory Checkpoint",
        description:
          "Save or restore pre-flight checkpoints before risky/long operations. Auto-expires after 4 hours.",
        parameters: Type.Object({
          action: stringEnum(["save", "restore"] as const),
          intent: Type.Optional(
            Type.String({ description: "What you're about to do (for save)" }),
          ),
          state: Type.Optional(
            Type.String({ description: "Current state/context (for save)" }),
          ),
          expectedOutcome: Type.Optional(
            Type.String({ description: "What should happen if successful" }),
          ),
          workingFiles: Type.Optional(
            Type.Array(Type.String(), {
              description: "Files being modified",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { action, intent, state, expectedOutcome, workingFiles } =
            params as {
              action: "save" | "restore";
              intent?: string;
              state?: string;
              expectedOutcome?: string;
              workingFiles?: string[];
            };

          if (action === "save") {
            if (!intent || !state) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Checkpoint save requires 'intent' and 'state'.",
                  },
                ],
                details: { error: "missing_param" },
              };
            }
            const id = factsDb.saveCheckpoint({
              intent,
              state,
              expectedOutcome,
              workingFiles,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Checkpoint saved (id: ${id.slice(0, 8)}..., TTL: 4h). Intent: ${intent.slice(0, 80)}`,
                },
              ],
              details: { action: "saved", id },
            };
          }

          const checkpoint = factsDb.restoreCheckpoint();
          if (!checkpoint) {
            return {
              content: [
                {
                  type: "text",
                  text: "No active checkpoint found (may have expired).",
                },
              ],
              details: { action: "not_found" },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Restored checkpoint (saved: ${checkpoint.savedAt}):\n- Intent: ${checkpoint.intent}\n- State: ${checkpoint.state}${checkpoint.expectedOutcome ? `\n- Expected: ${checkpoint.expectedOutcome}` : ""}${checkpoint.workingFiles?.length ? `\n- Files: ${checkpoint.workingFiles.join(", ")}` : ""}`,
              },
            ],
            details: { action: "restored", checkpoint },
          };
        },
      },
      { name: "memory_checkpoint" },
    );

    api.registerTool(
      {
        name: "memory_prune",
        label: "Memory Prune",
        description:
          "Prune expired memories and decay confidence of aging facts.",
        parameters: Type.Object({
          mode: Type.Optional(
            stringEnum(["hard", "soft", "both"] as const),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { mode = "both" } = params as { mode?: "hard" | "soft" | "both" };

          let hardPruned = 0;
          let softPruned = 0;

          if (mode === "hard" || mode === "both") {
            hardPruned = factsDb.pruneExpired();
          }
          if (mode === "soft" || mode === "both") {
            softPruned = factsDb.decayConfidence();
          }

          const breakdown = factsDb.statsBreakdown();
          const expired = factsDb.countExpired();

          return {
            content: [
              {
                type: "text",
                text: `Pruned: ${hardPruned} expired + ${softPruned} low-confidence.\nRemaining by class: ${JSON.stringify(breakdown)}\nPending expired: ${expired}`,
              },
            ],
            details: { hardPruned, softPruned, breakdown, pendingExpired: expired },
          };
        },
      },
      { name: "memory_prune" },
    );

    api.registerTool(
      {
        name: "memory_reflect",
        label: "Memory Reflect",
        description:
          "FR-011: Run reflection on recent facts to synthesize behavioral patterns. Analyzes facts from the last N days, sends to LLM to extract patterns, stores new patterns (permanent, high importance) for better agent alignment.",
        parameters: Type.Object({
          window: Type.Optional(
            Type.Number({
              description: "Time window in days (1–90, default from config)",
              minimum: 1,
              maximum: 90,
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const reflectionCfg = cfg.reflection;
          if (!reflectionCfg.enabled) {
            return {
              content: [
                {
                  type: "text",
                  text: "Reflection is disabled. Enable reflection.enabled in plugin config to use memory_reflect.",
                },
              ],
              details: { error: "reflection_disabled" },
            };
          }
          const window = Math.min(
            90,
            Math.max(1, typeof params.window === "number" ? params.window : reflectionCfg.defaultWindow),
          );
          const result = await runReflection(
            factsDb,
            vectorDb,
            embeddings,
            openaiClient,
            { defaultWindow: reflectionCfg.defaultWindow, minObservations: reflectionCfg.minObservations },
            { window, dryRun: false, model: reflectionCfg.model },
            api.logger,
          );
          return {
            content: [
              {
                type: "text",
                text: `Reflection complete: ${result.factsAnalyzed} facts analyzed, ${result.patternsExtracted} patterns extracted, ${result.patternsStored} stored (window: ${result.window} days).`,
              },
            ],
            details: {
              factsAnalyzed: result.factsAnalyzed,
              patternsExtracted: result.patternsExtracted,
              patternsStored: result.patternsStored,
              window: result.window,
            },
          };
        },
      },
      { name: "memory_reflect" },
    );

    api.registerTool(
      {
        name: "memory_reflect_rules",
        label: "Memory Reflect Rules",
        description:
          "FR-011 optional: Synthesize existing behavioral patterns into actionable one-line rules (category rule). Run after memory_reflect when you have enough patterns.",
        parameters: Type.Object({}),
        async execute() {
          const reflectionCfg = cfg.reflection;
          if (!reflectionCfg.enabled) {
            return {
              content: [{ type: "text", text: "Reflection is disabled. Enable reflection.enabled in plugin config." }],
              details: { error: "reflection_disabled" },
            };
          }
          const result = await runReflectionRules(
            factsDb,
            vectorDb,
            embeddings,
            openaiClient,
            { dryRun: false, model: reflectionCfg.model },
            api.logger,
          );
          return {
            content: [
              {
                type: "text",
                text: `Rules synthesis: ${result.rulesExtracted} rules extracted, ${result.rulesStored} stored.`,
              },
            ],
            details: { rulesExtracted: result.rulesExtracted, rulesStored: result.rulesStored },
          };
        },
      },
      { name: "memory_reflect_rules" },
    );

    api.registerTool(
      {
        name: "memory_reflect_meta",
        label: "Memory Reflect Meta",
        description:
          "FR-011 optional: Synthesize existing patterns into 1-3 higher-level meta-patterns (working style, principles). Run after memory_reflect when you have enough patterns.",
        parameters: Type.Object({}),
        async execute() {
          const reflectionCfg = cfg.reflection;
          if (!reflectionCfg.enabled) {
            return {
              content: [{ type: "text", text: "Reflection is disabled. Enable reflection.enabled in plugin config." }],
              details: { error: "reflection_disabled" },
            };
          }
          const result = await runReflectionMeta(
            factsDb,
            vectorDb,
            embeddings,
            openaiClient,
            { dryRun: false, model: reflectionCfg.model },
            api.logger,
          );
          return {
            content: [
              {
                type: "text",
                text: `Meta-pattern synthesis: ${result.metaExtracted} extracted, ${result.metaStored} stored.`,
              },
            ],
            details: { metaExtracted: result.metaExtracted, metaStored: result.metaStored },
          };
        },
      },
      { name: "memory_reflect_meta" },
    );

    // ========================================================================
    // Persona Proposals Tools (opt-in, disabled by default)
    // ========================================================================

    if (cfg.personaProposals.enabled && proposalsDb) {
      // Shared helper: audit trail logging (used by both tools and CLI commands)
      const auditProposal = (action: string, proposalId: string, details?: any, logger?: { warn?: (msg: string) => void; error?: (msg: string) => void }) => {
        const auditDir = join(dirname(resolvedSqlitePath), "decisions");
        mkdirSync(auditDir, { recursive: true });
        const timestamp = new Date().toISOString();
        const entry = {
          timestamp,
          action,
          proposalId,
          ...details,
        };
        const auditPath = join(auditDir, `proposal-${proposalId}.jsonl`);
        try {
          writeFileSync(auditPath, JSON.stringify(entry) + "\n", { flag: "a" });
        } catch (err) {
          const msg = `Audit log write failed: ${err}`;
          if (logger?.warn) {
            logger.warn(`memory-hybrid: ${msg}`);
          } else if (logger?.error) {
            logger.error(msg);
          }
        }
      };

      // Helper: rate limiting check
      const checkRateLimit = (): { allowed: boolean; count: number; limit: number } => {
        const weekInDays = 7;
        const count = proposalsDb!.countRecentProposals(weekInDays);
        const limit = cfg.personaProposals.maxProposalsPerWeek;
        return { allowed: count < limit, count, limit };
      };

      api.registerTool(
        {
          name: "persona_propose",
          label: "Propose Persona Change",
          description:
            "Propose a change to identity files (SOUL.md, IDENTITY.md, USER.md) based on observed patterns. Requires human approval before applying. Rate-limited to prevent spam.",
          parameters: Type.Object({
            targetFile: stringEnum(cfg.personaProposals.allowedFiles),
            title: Type.String({
              description: "Short title for the proposal (e.g., 'Add tone-matching guidance')",
            }),
            observation: Type.String({
              description: "What pattern or behavior you observed (e.g., 'Over ~50 interactions, user responds better to bullet points')",
            }),
            suggestedChange: Type.String({
              description: "The specific change to make to the file (be precise about location and wording)",
            }),
            confidence: Type.Number({
              description: "Confidence score 0-1 (must be >= minConfidence from config)",
              minimum: 0,
              maximum: 1,
            }),
            evidenceSessions: Type.Array(Type.String(), {
              description: "List of session IDs or references that support this proposal",
            }),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const {
              targetFile,
              title,
              observation,
              suggestedChange,
              confidence,
              evidenceSessions,
            } = params as {
              targetFile: string;
              title: string;
              observation: string;
              suggestedChange: string;
              confidence: number;
              evidenceSessions: string[];
            };

            // Field length validation (prevent database bloat and file corruption)
            const MAX_TITLE_LENGTH = 200;
            const MAX_OBSERVATION_LENGTH = 5000;
            const MAX_SUGGESTED_CHANGE_LENGTH = 10000;

            if (title.length > MAX_TITLE_LENGTH) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Title too long: ${title.length} chars (max: ${MAX_TITLE_LENGTH})`,
                  },
                ],
                details: { error: "title_too_long", length: title.length, max: MAX_TITLE_LENGTH },
              };
            }

            if (observation.length > MAX_OBSERVATION_LENGTH) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Observation too long: ${observation.length} chars (max: ${MAX_OBSERVATION_LENGTH})`,
                  },
                ],
                details: { error: "observation_too_long", length: observation.length, max: MAX_OBSERVATION_LENGTH },
              };
            }

            if (suggestedChange.length > MAX_SUGGESTED_CHANGE_LENGTH) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Suggested change too long: ${suggestedChange.length} chars (max: ${MAX_SUGGESTED_CHANGE_LENGTH})`,
                  },
                ],
                details: { error: "suggested_change_too_long", length: suggestedChange.length, max: MAX_SUGGESTED_CHANGE_LENGTH },
              };
            }

            // Rate limiting
            const rateCheck = checkRateLimit();
            if (!rateCheck.allowed) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Rate limit exceeded: ${rateCheck.count}/${rateCheck.limit} proposals this week. Try again later.`,
                  },
                ],
                details: { error: "rate_limit_exceeded", ...rateCheck },
              };
            }

            // Confidence check
            if (confidence < cfg.personaProposals.minConfidence) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Confidence ${confidence} is below minimum ${cfg.personaProposals.minConfidence}. Gather more evidence before proposing.`,
                  },
                ],
                details: { error: "confidence_too_low", confidence, minRequired: cfg.personaProposals.minConfidence },
              };
            }

            // Evidence validation: check count and content quality
            if (evidenceSessions.length < cfg.personaProposals.minSessionEvidence) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Need at least ${cfg.personaProposals.minSessionEvidence} session evidence (provided: ${evidenceSessions.length})`,
                  },
                ],
                details: { error: "insufficient_evidence", provided: evidenceSessions.length, minRequired: cfg.personaProposals.minSessionEvidence },
              };
            }

            // Validate evidence session content (non-empty, unique)
            const invalidSessions = evidenceSessions.filter(s => typeof s !== "string" || s.trim().length === 0);
            if (invalidSessions.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Evidence sessions must be non-empty strings. Found ${invalidSessions.length} invalid entries.`,
                  },
                ],
                details: { error: "invalid_evidence_sessions", invalidCount: invalidSessions.length },
              };
            }

            // Check for duplicate evidence sessions (without trimming to preserve exact matches)
            const uniqueSessions = new Set(evidenceSessions);
            if (uniqueSessions.size !== evidenceSessions.length) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Evidence sessions must be unique. Found ${evidenceSessions.length - uniqueSessions.size} duplicate(s).`,
                  },
                ],
                details: { error: "duplicate_evidence_sessions", duplicateCount: evidenceSessions.length - uniqueSessions.size },
              };
            }

            // Calculate expiry
            const expiresAt = cfg.personaProposals.proposalTTLDays > 0
              ? Math.floor(Date.now() / 1000) + cfg.personaProposals.proposalTTLDays * 24 * 3600
              : null;

            // Create proposal
            const proposal = proposalsDb!.create({
              targetFile,
              title,
              observation,
              suggestedChange,
              confidence,
              evidenceSessions,
              expiresAt,
            });

            auditProposal("created", proposal.id, {
              targetFile,
              title,
              confidence,
              evidenceCount: evidenceSessions.length,
            }, api.logger);

            api.logger.info(`memory-hybrid: persona proposal created — ${proposal.id} (${title})`);

            return {
              content: [
                {
                  type: "text",
                  text: `Proposal created: ${proposal.id}\nTitle: ${title}\nTarget: ${targetFile}\nStatus: pending\n\nAwaiting human review. Use persona_proposals_list to view all pending proposals.`,
                },
              ],
              details: { proposalId: proposal.id, status: "pending", expiresAt: proposal.expiresAt },
            };
          },
        },
        { name: "persona_propose" },
      );

      api.registerTool(
        {
          name: "persona_proposals_list",
          label: "List Persona Proposals",
          description:
            "List all persona proposals, optionally filtered by status (pending/approved/rejected/applied) or target file.",
          parameters: Type.Object({
            status: Type.Optional(stringEnum(PROPOSAL_STATUSES)),
            targetFile: Type.Optional(Type.String()),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { status, targetFile } = params as { status?: string; targetFile?: string };

            const proposals = proposalsDb!.list({ status, targetFile });

            if (proposals.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No proposals found matching filters.",
                  },
                ],
                details: { count: 0, filters: { status, targetFile } },
              };
            }

            const lines = proposals.map((p) => {
              const age = Math.floor((Date.now() / 1000 - p.createdAt) / 86400);
              const expires = p.expiresAt ? Math.floor((p.expiresAt - Date.now() / 1000) / 86400) : null;
              return `[${p.status.toUpperCase()}] ${p.id}\n  Title: ${p.title}\n  Target: ${p.targetFile}\n  Confidence: ${p.confidence}\n  Evidence: ${p.evidenceSessions.length} sessions\n  Age: ${age}d${expires !== null ? `, expires in ${expires}d` : ""}\n  Observation: ${p.observation.length > 120 ? p.observation.slice(0, 120) + "..." : p.observation}`;
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${proposals.length} proposal(s):\n\n${lines.join("\n\n")}`,
                },
              ],
              details: { count: proposals.length, proposals: proposals.map(p => ({ id: p.id, status: p.status, title: p.title, targetFile: p.targetFile })) },
            };
          },
        },
        { name: "persona_proposals_list" },
      );

      // NOTE: persona_proposal_review and persona_proposal_apply are intentionally
      // NOT registered as agent-callable tools. They are CLI-only commands to ensure
      // human approval is required. This prevents agents from self-approving and
      // applying their own proposals, maintaining the security guarantee.

      // Periodic cleanup of expired proposals (stored in module-level variable for cleanup on stop)
      proposalsPruneTimer = setInterval(() => {
        try {
          if (proposalsDb) {
            const pruned = proposalsDb.pruneExpired();
            if (pruned > 0) {
              api.logger.info(`memory-hybrid: pruned ${pruned} expired proposal(s)`);
            }
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: proposal prune failed: ${err}`);
        }
      }, 24 * 60 * 60_000); // daily

      // Register CLI commands for human-only review/apply operations
      api.registerCli(({ program }) => {
        const proposals = program.command("proposals").description("Manage persona proposals (human-only commands)");

        proposals
          .command("review <proposalId> <action>")
          .description("Approve or reject a persona proposal (action: approve|reject)")
          .option("--reviewed-by <name>", "Name/ID of reviewer")
          .action(async (proposalId: string, action: string, opts: { reviewedBy?: string }) => {
            if (action !== "approve" && action !== "reject") {
              console.error("Action must be 'approve' or 'reject'");
              process.exit(1);
            }

            const proposal = proposalsDb!.get(proposalId);
            if (!proposal) {
              console.error(`Proposal ${proposalId} not found`);
              process.exit(1);
            }

            if (proposal.status !== "pending") {
              console.error(`Proposal ${proposalId} is already ${proposal.status}. Cannot review again.`);
              process.exit(1);
            }

            const newStatus = action === "approve" ? "approved" : "rejected";
            proposalsDb!.updateStatus(proposalId, newStatus, opts.reviewedBy);

            auditProposal(action, proposalId, {
              reviewedBy: opts.reviewedBy ?? "cli-user",
              previousStatus: "pending",
              newStatus,
            }, { error: console.error });

            console.log(`Proposal ${proposalId} ${action}d.`);
            if (action === "approve") {
              console.log(`\nUse 'openclaw proposals apply ${proposalId}' to apply the change.`);
            }
          });

        proposals
          .command("apply <proposalId>")
          .description("Apply an approved persona proposal to its target identity file")
          .action(async (proposalId: string) => {
            const proposal = proposalsDb!.get(proposalId);
            if (!proposal) {
              console.error(`Proposal ${proposalId} not found`);
              process.exit(1);
            }

            if (proposal.status !== "approved") {
              console.error(`Proposal ${proposalId} is ${proposal.status}. Only approved proposals can be applied.`);
              process.exit(1);
            }

            // Re-validate targetFile against current allowedFiles config (defense against config changes or DB tampering)
            if (!cfg.personaProposals.allowedFiles.includes(proposal.targetFile as IdentityFileType)) {
              console.error(`Target file ${proposal.targetFile} is no longer in allowedFiles. Cannot apply.`);
              console.error(`Current allowedFiles: ${cfg.personaProposals.allowedFiles.join(", ")}`);
              process.exit(1);
            }

            // Additional path traversal defense (even though schema validates at creation)
            if (proposal.targetFile.includes("..") || proposal.targetFile.includes("/") || proposal.targetFile.includes("\\")) {
              console.error(`Invalid target file path: ${proposal.targetFile}. Path traversal detected.`);
              process.exit(1);
            }

            // Resolve target file path
            const targetPath = api.resolvePath(proposal.targetFile);

            if (!existsSync(targetPath)) {
              console.error(`Target file ${proposal.targetFile} not found at ${targetPath}`);
              process.exit(1);
            }

            // Create backup
            const backupPath = `${targetPath}.backup-${Date.now()}`;
            try {
              const original = readFileSync(targetPath, "utf-8");
              writeFileSync(backupPath, original);

              // Escape HTML comment sequences to prevent breakout
              const escapeHtmlComment = (text: string): string => {
                return text.replace(/-->/g, "-- >").replace(/<!--/g, "<! --");
              };

              // Apply change (simple append strategy)
              // TODO: Future enhancement - use LLM for smart diff application, content validation, merge conflict resolution
              const timestamp = new Date().toISOString();
              const safeObservation = escapeHtmlComment(proposal.observation);
              const changeBlock = `\n\n<!-- Proposal ${proposalId} applied at ${timestamp} -->\n<!-- Observation: ${safeObservation} -->\n\n${proposal.suggestedChange}\n`;
              writeFileSync(targetPath, original + changeBlock);

              // Mark as applied only after successful file write
              proposalsDb!.markApplied(proposalId);

              auditProposal("applied", proposalId, {
                targetFile: proposal.targetFile,
                targetPath,
                backupPath,
                timestamp,
              }, { error: console.error });

              console.log(`Proposal ${proposalId} applied to ${proposal.targetFile}`);
              console.log(`Backup saved: ${backupPath}`);
              console.log(`\nChange:\n${proposal.suggestedChange}`);
            } catch (err) {
              console.error(`Failed to apply proposal: ${err}`);
              process.exit(1);
            }
          });
      });
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program.command("hybrid-mem")
          .description("Hybrid memory plugin commands");

        registerHybridMemCli(mem, { factsDb, vectorDb, versionInfo });

        mem
          .command("extract-daily")
          .description("Extract structured facts from daily memory files")
          .option("--days <n>", "How many days back to scan", "7")
          .option("--dry-run", "Show extractions without storing")
          .action(async (opts: { days: string; dryRun?: boolean }) => {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { homedir: getHomedir } = await import("node:os");
            const memoryDir = path.join(getHomedir(), ".openclaw", "memory");
            const daysBack = parseInt(opts.days);

            let totalExtracted = 0;
            let totalStored = 0;

            for (let d = 0; d < daysBack; d++) {
              const date = new Date();
              date.setDate(date.getDate() - d);
              const dateStr = date.toISOString().split("T")[0];
              const filePath = path.join(memoryDir, `${dateStr}.md`);

              if (!fs.existsSync(filePath)) continue;

              const content = fs.readFileSync(filePath, "utf-8");
              const lines = content.split("\n").filter((l: string) => l.trim().length > 10);

              console.log(`\nScanning ${dateStr} (${lines.length} lines)...`);

              for (const line of lines) {
                const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
                if (trimmed.length < 15 || trimmed.length > 500) continue;

                const category = detectCategory(trimmed);
                const extracted = extractStructuredFields(trimmed, category);

                // Dual-mode credentials: vault on → store in vault + pointer only; vault off → store in facts (live behavior).
                // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
                if (isCredentialLike(trimmed, extracted.entity, extracted.key, extracted.value)) {
                  if (cfg.credentials.enabled && credentialsDb) {
                    const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value);
                    if (parsed) {
                      if (!opts.dryRun) {
                        credentialsDb.store({
                          service: parsed.service,
                          type: parsed.type,
                          value: parsed.secretValue,
                          url: parsed.url,
                          notes: parsed.notes,
                        });
                        const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                        const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                        const pointerEntry = factsDb.store({
                          text: pointerText,
                          category: "technical",
                          importance: 0.8,
                          entity: "Credentials",
                          key: parsed.service,
                          value: VAULT_POINTER_PREFIX + parsed.service,
                          source: `daily-scan:${dateStr}`,
                          sourceDate: sourceDateSec,
                          tags: ["auth", ...extractTags(pointerText, "Credentials")],
                        });
                        try {
                          const vector = await embeddings.embed(pointerText);
                          if (!(await vectorDb.hasDuplicate(vector))) {
                            await vectorDb.store({ text: pointerText, vector, importance: 0.8, category: "technical", id: pointerEntry.id });
                          }
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                        }
                        totalStored++;
                      } else {
                        totalExtracted++;
                      }
                      continue;
                    }
                    /* vault enabled but parse failed: skip this line (do not store credential-like text in facts) */
                    continue;
                  }
                  /* vault disabled: fall through to store in facts */
                }

                if (!extracted.entity && !extracted.key && category !== "decision") continue;

                totalExtracted++;

                if (opts.dryRun) {
                  console.log(
                    `  [${category}] ${extracted.entity || "?"} / ${extracted.key || "?"} = ${
                      extracted.value || trimmed.slice(0, 60)
                    }`,
                  );
                  continue;
                }

                if (factsDb.hasDuplicate(trimmed)) continue;

                const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                const storePayload = {
                  text: trimmed,
                  category,
                  importance: 0.8,
                  entity: extracted.entity,
                  key: extracted.key,
                  value: extracted.value,
                  source: `daily-scan:${dateStr}` as const,
                  sourceDate: sourceDateSec,
                  tags: extractTags(trimmed, extracted.entity),
                };

                let vecForStore: number[] | undefined;
                if (cfg.store.classifyBeforeWrite) {
                  try {
                    vecForStore = await embeddings.embed(trimmed);
                  } catch (err) {
                    api.logger.warn(`memory-hybrid: extract-daily embedding failed: ${err}`);
                  }
                  if (vecForStore) {
                    let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vecForStore, 3);
                    if (similarFacts.length === 0) {
                      similarFacts = factsDb.findSimilarForClassification(trimmed, extracted.entity, extracted.key, 3);
                    }
                    if (similarFacts.length > 0) {
                      try {
                        const classification = await classifyMemoryOperation(
                          trimmed, extracted.entity, extracted.key, similarFacts,
                          openaiClient, cfg.store.classifyModel ?? "gpt-4o-mini", api.logger,
                        );
                        if (classification.action === "NOOP") continue;
                        if (classification.action === "DELETE" && classification.targetId) {
                          factsDb.supersede(classification.targetId, null);
                          continue;
                        }
                        if (classification.action === "UPDATE" && classification.targetId) {
                          const oldFact = factsDb.getById(classification.targetId);
                          if (oldFact) {
                            const newEntry = factsDb.store({
                              ...storePayload,
                              entity: extracted.entity ?? oldFact.entity,
                              key: extracted.key ?? oldFact.key,
                              value: extracted.value ?? oldFact.value,
                              validFrom: sourceDateSec,
                              supersedesId: classification.targetId,
                            });
                            factsDb.supersede(classification.targetId, newEntry.id);
                            try {
                              if (!(await vectorDb.hasDuplicate(vecForStore))) {
                                await vectorDb.store({ text: trimmed, vector: vecForStore, importance: 0.8, category, id: newEntry.id });
                              }
                            } catch (err) {
                              api.logger.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                            }
                            totalStored++;
                            continue;
                          }
                        }
                      } catch (err) {
                        api.logger.warn(`memory-hybrid: extract-daily classification failed: ${err}`);
                      }
                    }
                  }
                }

                const entry = factsDb.store(storePayload);
                try {
                  const vector = vecForStore ?? await embeddings.embed(trimmed);
                  if (!(await vectorDb.hasDuplicate(vector))) {
                    await vectorDb.store({ text: trimmed, vector, importance: 0.8, category, id: entry.id });
                  }
                } catch (err) {
                  api.logger.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                }
                totalStored++;
              }
            }

            if (opts.dryRun) {
              console.log(
                `\nWould extract: ${totalExtracted} facts from last ${daysBack} days`,
              );
            } else {
              console.log(
                `\nExtracted ${totalStored} new facts (${totalExtracted} candidates, ${
                  totalExtracted - totalStored
                } duplicates skipped)`,
              );
            }
          });

        mem
          .command("search")
          .description("Search memories across both backends")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
          .option("--as-of <date>", "FR-010: Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
          .option("--include-superseded", "FR-010: Include superseded (historical) facts")
          .action(async (query: string, opts: { limit?: string; tag?: string; asOf?: string; includeSuperseded?: boolean }) => {
            const limit = parseInt(opts.limit || "5");
            const tag = opts.tag?.trim();
            const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseSourceDate(opts.asOf) : undefined;
            const searchOpts = { tag, includeSuperseded: opts.includeSuperseded === true, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
            const sqlResults = factsDb.search(query, limit, searchOpts);
            let lanceResults: SearchResult[] = [];
            if (!tag) {
              try {
                const vector = await embeddings.embed(query);
                lanceResults = await vectorDb.search(vector, limit, 0.3);
              } catch (err) {
                console.warn(`memory-hybrid: vector search failed: ${err}`);
              }
            }
            const merged = mergeResults(sqlResults, lanceResults, limit, factsDb);

            const output = merged.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              entity: r.entry.entity,
              score: r.score,
              backend: r.backend,
              tags: r.entry.tags?.length ? r.entry.tags : undefined,
              sourceDate: r.entry.sourceDate
                ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
                : undefined,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("lookup")
          .description("Exact entity lookup in SQLite")
          .argument("<entity>", "Entity name")
          .option("--key <key>", "Optional key filter")
          .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
          .option("--as-of <date>", "FR-010: Point-in-time: ISO date (YYYY-MM-DD) or epoch seconds")
          .option("--include-superseded", "FR-010: Include superseded (historical) facts")
          .action(async (entity: string, opts: { key?: string; tag?: string; asOf?: string; includeSuperseded?: boolean }) => {
            const asOfSec = opts.asOf != null && opts.asOf !== "" ? parseSourceDate(opts.asOf) : undefined;
            const lookupOpts = { includeSuperseded: opts.includeSuperseded === true, ...(asOfSec != null ? { asOf: asOfSec } : {}) };
            const results = factsDb.lookup(entity, opts.key, opts.tag?.trim(), lookupOpts);
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              entity: r.entry.entity,
              key: r.entry.key,
              value: r.entry.value,
              tags: r.entry.tags?.length ? r.entry.tags : undefined,
              sourceDate: r.entry.sourceDate
                ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
                : undefined,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("store")
          .description("Store a fact (for scripts; agents use memory_store tool)")
          .requiredOption("--text <text>", "Fact text")
          .option("--category <cat>", "Category", "other")
          .option("--entity <entity>", "Entity name")
          .option("--key <key>", "Structured key")
          .option("--value <value>", "Structured value")
          .option("--source-date <date>", "When fact originated (ISO-8601, e.g. 2026-01-15)")
          .option("--tags <tags>", "Comma-separated topic tags (e.g. nibe,zigbee); auto-inferred if omitted")
          .action(async (opts: { text: string; category?: string; entity?: string; key?: string; value?: string; sourceDate?: string; tags?: string }) => {
            const text = opts.text;
            if (!text || text.length < 2) {
              console.error("--text is required and must be at least 2 characters");
              process.exitCode = 1;
              return;
            }
            if (factsDb.hasDuplicate(text)) {
              console.log("Similar memory already exists.");
              return;
            }
            const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
            const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
            const entity = opts.entity ?? extracted.entity ?? null;
            const key = opts.key ?? extracted.key ?? null;
            const value = opts.value ?? extracted.value ?? null;

            // Dual-mode: vault enabled and credential-like → vault + pointer; else store in memory.
            // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
            if (cfg.credentials.enabled && credentialsDb && isCredentialLike(text, entity, key, value)) {
              const parsed = tryParseCredentialForVault(text, entity, key, value);
              if (parsed) {
                credentialsDb.store({
                  service: parsed.service,
                  type: parsed.type,
                  value: parsed.secretValue,
                  url: parsed.url,
                  notes: parsed.notes,
                });
                const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
                const pointerEntry = factsDb.store({
                  text: pointerText,
                  category: "technical" as MemoryCategory,
                  importance: 0.7,
                  entity: "Credentials",
                  key: parsed.service,
                  value: pointerValue,
                  source: "cli",
                  sourceDate,
                  tags: ["auth", ...extractTags(pointerText, "Credentials")],
                });
                try {
                  const vector = await embeddings.embed(pointerText);
                  if (!(await vectorDb.hasDuplicate(vector))) {
                    await vectorDb.store({ text: pointerText, vector, importance: 0.7, category: "technical", id: pointerEntry.id });
                  }
                } catch (err) {
                  api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                }
                console.log(`Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer [id: ${pointerEntry.id}].`);
                return;
              }
              console.error(
                "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
              );
              process.exitCode = 1;
              return;
            }

            const tags = opts.tags
              ? opts.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
              : undefined;
            const category = (opts.category ?? "other") as MemoryCategory;

            // FR-008: Classify before store when enabled (same as memory_store tool)
            if (cfg.store.classifyBeforeWrite) {
              let vector: number[] | undefined;
              try {
                vector = await embeddings.embed(text);
              } catch (err) {
                api.logger.warn(`memory-hybrid: CLI store embedding failed: ${err}`);
              }
              if (vector) {
                let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
                if (similarFacts.length === 0) {
                  similarFacts = factsDb.findSimilarForClassification(text, entity, key, 5);
                }
                if (similarFacts.length > 0) {
                  try {
                    const classification = await classifyMemoryOperation(
                      text, entity, key, similarFacts, openaiClient, cfg.store.classifyModel ?? "gpt-4o-mini", api.logger,
                    );
                    if (classification.action === "NOOP") {
                      console.log(`Already known: ${classification.reason}`);
                      return;
                    }
                    if (classification.action === "DELETE" && classification.targetId) {
                      factsDb.supersede(classification.targetId, null);
                      console.log(`Retracted fact ${classification.targetId}: ${classification.reason}`);
                      return;
                    }
                    if (classification.action === "UPDATE" && classification.targetId) {
                      const oldFact = factsDb.getById(classification.targetId);
                      if (oldFact) {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const newEntry = factsDb.store({
                          text,
                          category,
                          importance: 0.7,
                          entity: entity ?? oldFact.entity,
                          key: opts.key ?? extracted.key ?? oldFact.key ?? null,
                          value: opts.value ?? extracted.value ?? oldFact.value ?? null,
                          source: "cli",
                          sourceDate,
                          tags: tags ?? extractTags(text, entity),
                          validFrom: sourceDate ?? nowSec,
                          supersedesId: classification.targetId,
                        });
                        factsDb.supersede(classification.targetId, newEntry.id);
                        try {
                          if (!(await vectorDb.hasDuplicate(vector))) {
                            await vectorDb.store({ text, vector, importance: 0.7, category, id: newEntry.id });
                          }
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                        }
                        console.log(`Updated: superseded ${classification.targetId} with ${newEntry.id}. ${classification.reason}`);
                        return;
                      }
                    }
                  } catch (err) {
                    api.logger.warn(`memory-hybrid: CLI store classification failed: ${err}`);
                  }
                }
              }
            }

            const entry = factsDb.store({
              text,
              category,
              importance: 0.7,
              entity,
              key: opts.key ?? extracted.key ?? null,
              value: opts.value ?? extracted.value ?? null,
              source: "cli",
              sourceDate,
              tags: tags ?? extractTags(text, entity),
            });
            try {
              const vector = await embeddings.embed(text);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({ text, vector, importance: 0.7, category: opts.category ?? "other", id: entry.id });
              }
            } catch (err) {
              api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
            }
            console.log(`Stored: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" [id: ${entry.id}]`);
          });

        mem
          .command("classify")
          .description("Auto-classify 'other' facts using LLM (uses autoClassify config). Runs category discovery first when enabled.")
          .option("--dry-run", "Show classifications without applying")
          .option("--limit <n>", "Max facts to classify", "500")
          .option("--model <model>", "Override LLM model")
          .action(async (opts: { dryRun?: boolean; limit?: string; model?: string }) => {
            const classifyModel = opts.model || cfg.autoClassify.model;
            const limit = parseInt(opts.limit || "500");
            const logger = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };

            console.log(`Auto-classify config:`);
            console.log(`  Model: ${classifyModel}`);
            console.log(`  Batch size: ${cfg.autoClassify.batchSize}`);
            console.log(`  Suggest categories: ${cfg.autoClassify.suggestCategories !== false}`);
            console.log(`  Categories: ${getMemoryCategories().join(", ")}`);
            console.log(`  Limit: ${limit}`);
            console.log(`  Dry run: ${!!opts.dryRun}\n`);

            let others = factsDb.getByCategory("other").slice(0, limit);
            if (others.length === 0) {
              console.log("No 'other' facts to classify.");
              return;
            }

            // Run category discovery first (when not dry-run and enough "other" facts)
            if (!opts.dryRun && cfg.autoClassify.suggestCategories && others.length >= MIN_OTHER_FOR_DISCOVERY) {
              const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
              await discoverCategoriesFromOther(
                factsDb,
                openaiClient,
                { ...cfg.autoClassify, model: classifyModel },
                logger,
                discoveredPath,
              );
              others = factsDb.getByCategory("other").slice(0, limit);
            }

            console.log(`Classifying ${others.length} "other" facts\n`);

            let totalReclassified = 0;

            for (let i = 0; i < others.length; i += cfg.autoClassify.batchSize) {
              const batch = others.slice(i, i + cfg.autoClassify.batchSize).map((e) => ({
                id: e.id,
                text: e.text,
              }));

              const results = await classifyBatch(
                openaiClient,
                classifyModel,
                batch,
                getMemoryCategories(),
              );

              for (const [id, newCat] of results) {
                const fact = batch.find((f) => f.id === id);
                if (opts.dryRun) {
                  console.log(`  [${newCat}] ${fact?.text?.slice(0, 80)}...`);
                } else {
                  factsDb.updateCategory(id, newCat);
                }
                totalReclassified++;
              }

              process.stdout.write(`  Processed ${Math.min(i + cfg.autoClassify.batchSize, others.length)}/${others.length}\r`);

              if (i + cfg.autoClassify.batchSize < others.length) {
                await new Promise((r) => setTimeout(r, 500));
              }
            }

            console.log(`\n\nResult: ${totalReclassified}/${others.length} reclassified${opts.dryRun ? " (dry run)" : ""}`);

            // Show updated stats
            if (!opts.dryRun) {
              const breakdown = factsDb.statsBreakdown();
              console.log("\nUpdated category breakdown:");
              for (const [cat, count] of Object.entries(breakdown)) {
                console.log(`  ${cat}: ${count}`);
              }
            }
          });

        mem
          .command("categories")
          .description("List all configured memory categories")
          .action(() => {
            const cats = getMemoryCategories();
            console.log(`Memory categories (${cats.length}):`);
            for (const cat of cats) {
              const count = factsDb.getByCategory(cat).length;
              console.log(`  ${cat}: ${count} facts`);
            }
          });

        mem
          .command("find-duplicates")
          .description("Report pairs of facts with embedding similarity ≥ threshold (2.2); no merge")
          .option("--threshold <n>", "Similarity threshold 0–1 (default 0.92)", "0.92")
          .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
          .option("--limit <n>", "Max facts to consider (default 300)", "300")
          .action(async (opts: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
            const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.92")));
            const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
            const result = await runFindDuplicates(
              factsDb,
              embeddings,
              { threshold, includeStructured: !!opts.includeStructured, limit },
              api.logger,
            );
            console.log(`Candidates: ${result.candidatesCount} (skipped identifier-like: ${result.skippedStructured})`);
            console.log(`Pairs with similarity ≥ ${threshold}: ${result.pairs.length}`);
            const trim = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + "…");
            for (const p of result.pairs) {
              console.log(`  ${p.idA} <-> ${p.idB} (${p.score.toFixed(3)})`);
              console.log(`    A: ${trim(p.textA, 80)}`);
              console.log(`    B: ${trim(p.textB, 80)}`);
            }
          });

        mem
          .command("consolidate")
          .description("Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster (2.4)")
          .option("--threshold <n>", "Cosine similarity threshold 0–1 (default 0.96; higher = fewer merges)", "0.96")
          .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
          .option("--dry-run", "Report clusters and would-merge only; do not store or delete")
          .option("--limit <n>", "Max facts to consider (default 300)", "300")
          .option("--model <model>", "LLM for merge (default gpt-4o-mini)", "gpt-4o-mini")
          .action(async (opts: { threshold?: string; includeStructured?: boolean; dryRun?: boolean; limit?: string; model?: string }) => {
            const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.96")));
            const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
            const result = await runConsolidate(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              {
                threshold,
                includeStructured: !!opts.includeStructured,
                dryRun: !!opts.dryRun,
                limit,
                model: opts.model || "gpt-4o-mini",
              },
              api.logger,
            );
            console.log(`Clusters found: ${result.clustersFound}`);
            console.log(`Merged: ${result.merged}`);
            console.log(`Deleted: ${result.deleted}${opts.dryRun ? " (dry run)" : ""}`);
          });

        mem
          .command("reflect")
          .description("FR-011: Analyze recent facts, extract behavioral patterns, store as pattern-category facts")
          .option("--window <days>", "Time window in days (default: config or 14)", "14")
          .option("--dry-run", "Show extracted patterns without storing")
          .option("--model <model>", "LLM for reflection (default: config or gpt-4o-mini)", "gpt-4o-mini")
          .option("--force", "Run even if reflection is disabled in config")
          .action(async (opts: { window?: string; dryRun?: boolean; model?: string; force?: boolean }) => {
            const reflectionCfg = cfg.reflection;
            if (!opts.force && !reflectionCfg.enabled) {
              console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
              return;
            }
            const window = Math.min(90, Math.max(1, parseInt(opts.window || String(reflectionCfg.defaultWindow)) || 14));
            const result = await runReflection(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              { defaultWindow: reflectionCfg.defaultWindow, minObservations: reflectionCfg.minObservations },
              { window, dryRun: !!opts.dryRun, model: opts.model || reflectionCfg.model },
              api.logger,
            );
            console.log(`Facts analyzed: ${result.factsAnalyzed}`);
            console.log(`Patterns extracted: ${result.patternsExtracted}`);
            console.log(`Patterns stored: ${result.patternsStored}${opts.dryRun ? " (dry run)" : ""}`);
            console.log(`Window: ${result.window} days`);
          });

        mem
          .command("reflect-rules")
          .description("FR-011 optional: Synthesize patterns into actionable one-line rules (category rule)")
          .option("--dry-run", "Show extracted rules without storing")
          .option("--model <model>", "LLM (default: config or gpt-4o-mini)", "gpt-4o-mini")
          .option("--force", "Run even if reflection is disabled in config")
          .action(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
            const reflectionCfg = cfg.reflection;
            if (!opts.force && !reflectionCfg.enabled) {
              console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
              return;
            }
            const result = await runReflectionRules(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              { dryRun: !!opts.dryRun, model: opts.model || reflectionCfg.model },
              api.logger,
            );
            console.log(`Rules extracted: ${result.rulesExtracted}`);
            console.log(`Rules stored: ${result.rulesStored}${opts.dryRun ? " (dry run)" : ""}`);
          });

        mem
          .command("reflect-meta")
          .description("FR-011 optional: Synthesize patterns into 1-3 higher-level meta-patterns")
          .option("--dry-run", "Show extracted meta-patterns without storing")
          .option("--model <model>", "LLM (default: config or gpt-4o-mini)", "gpt-4o-mini")
          .option("--force", "Run even if reflection is disabled in config")
          .action(async (opts: { dryRun?: boolean; model?: string; force?: boolean }) => {
            const reflectionCfg = cfg.reflection;
            if (!opts.force && !reflectionCfg.enabled) {
              console.log("Reflection is disabled in config. Set reflection.enabled to true, or use --force.");
              return;
            }
            const result = await runReflectionMeta(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              { dryRun: !!opts.dryRun, model: opts.model || reflectionCfg.model },
              api.logger,
            );
            console.log(`Meta-patterns extracted: ${result.metaExtracted}`);
            console.log(`Meta-patterns stored: ${result.metaStored}${opts.dryRun ? " (dry run)" : ""}`);
          });

        mem
          .command("install")
          .description("Apply full recommended config, prompts, and optional jobs (idempotent). Run after first plugin setup for best defaults.")
          .option("--dry-run", "Print what would be merged without writing")
          .action(async (opts: { dryRun?: boolean }) => {
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const configPath = join(openclawDir, "openclaw.json");
            mkdirSync(openclawDir, { recursive: true });
            const memoryDir = join(openclawDir, "memory");
            mkdirSync(memoryDir, { recursive: true });

            const fullDefaults = {
              memory: { backend: "builtin" as const, citations: "auto" as const },
              plugins: {
                slots: { memory: PLUGIN_ID },
                entries: {
                  "memory-core": { enabled: true },
                  [PLUGIN_ID]: {
                    enabled: true,
                    config: {
                      embedding: { apiKey: "YOUR_OPENAI_API_KEY", model: "text-embedding-3-small" },
                      autoCapture: true,
                      autoRecall: true,
                      captureMaxChars: 5000,
                      store: { fuzzyDedupe: false },
                      autoClassify: { enabled: true, model: "gpt-4o-mini", batchSize: 20 },
                      categories: [] as string[],
                      credentials: { enabled: false, store: "sqlite" as const, encryptionKey: "", autoDetect: false, expiryWarningDays: 7 },
                    },
                  },
                },
              },
              agents: {
                defaults: {
                  bootstrapMaxChars: 15000,
                  bootstrapTotalMaxChars: 50000,
                  memorySearch: {
                    enabled: true,
                    sources: ["memory"],
                    provider: "openai",
                    model: "text-embedding-3-small",
                    sync: { onSessionStart: true, onSearch: true, watch: true },
                    chunking: { tokens: 500, overlap: 50 },
                    query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
                  },
                  compaction: {
                    mode: "default",
                    memoryFlush: {
                      enabled: true,
                      softThresholdTokens: 4000,
                      systemPrompt: "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
                      prompt: "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
                    },
                  },
                  pruning: { ttl: "30m" },
                },
              },
              jobs: [
                {
                  name: "nightly-memory-sweep",
                  schedule: "0 2 * * *",
                  channel: "system",
                  message: "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
                  isolated: true,
                  model: "gemini",
                },
              ],
            };

            function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
              for (const key of Object.keys(source)) {
                const srcVal = source[key];
                const tgtVal = target[key];
                if (srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
                  deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
                } else if (key === "jobs" && Array.isArray(srcVal)) {
                  const arr = (Array.isArray(tgtVal) ? [...tgtVal] : []) as unknown[];
                  const hasNightly = arr.some((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                  if (!hasNightly) {
                    const nightly = (srcVal as unknown[]).find((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                    if (nightly) arr.push(nightly);
                  }
                  (target as Record<string, unknown>)[key] = arr;
                } else if (tgtVal === undefined && !Array.isArray(srcVal)) {
                  (target as Record<string, unknown>)[key] = srcVal;
                }
              }
            }

            let config: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              try {
                config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
              } catch (e) {
                console.error(`Could not read ${configPath}: ${e}`);
                return;
              }
            }
            const existingApiKey = (config?.plugins as Record<string, unknown>)?.["entries"] && ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] && (((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>)?.config && ((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>)?.embedding && (((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>).embedding as Record<string, unknown>)?.apiKey;
            const isRealKey = typeof existingApiKey === "string" && existingApiKey.length >= 10 && existingApiKey !== "YOUR_OPENAI_API_KEY" && existingApiKey !== "<OPENAI_API_KEY>";

            if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
            if (!(config.agents && typeof config.agents === "object")) config.agents = { defaults: {} };
            deepMerge(config, fullDefaults as unknown as Record<string, unknown>);
            if (isRealKey) {
              const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
              const mh = entries[PLUGIN_ID] as Record<string, unknown>;
              const cfg = mh?.config as Record<string, unknown>;
              const emb = cfg?.embedding as Record<string, unknown>;
              if (emb) emb.apiKey = existingApiKey;
            }
            const after = JSON.stringify(config, null, 2);

            if (opts.dryRun) {
              console.log("Would merge into " + configPath + ":");
              console.log(after);
              return;
            }
            writeFileSync(configPath, after, "utf-8");
            console.log("Config written: " + configPath);
            console.log(`Applied: plugins.slots.memory=${PLUGIN_ID}, ${PLUGIN_ID} config (all features), memorySearch, compaction prompts, bootstrap limits, pruning, autoClassify, nightly-memory-sweep job.`);
            console.log("\nNext steps:");
            console.log(`  1. Set embedding.apiKey in plugins.entries["${PLUGIN_ID}"].config (or use env:OPENAI_API_KEY in config).`);
            console.log("  2. Restart the gateway: openclaw gateway stop && openclaw gateway start");
            console.log("  3. Run: openclaw hybrid-mem verify [--fix]");
          });

        mem
          .command("verify")
          .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
          .option("--fix", "Print or apply default config for missing items")
          .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
          .action(async (opts: { fix?: boolean; logFile?: string }) => {
            const issues: string[] = [];
            const fixes: string[] = [];
            let configOk = true;
            let sqliteOk = false;
            let lanceOk = false;
            let embeddingOk = false;

            const loadBlocking: string[] = [];
            if (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10) {
              issues.push("embedding.apiKey is missing, placeholder, or too short");
              loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
              fixes.push(`LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ~/.openclaw/openclaw.json or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`);
              configOk = false;
            }
            if (!cfg.embedding.model) {
              issues.push("embedding.model is missing");
              loadBlocking.push("embedding.model is missing");
              fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
              configOk = false;
            }
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const defaultConfigPath = join(openclawDir, "openclaw.json");
            if (configOk) console.log("Config: embedding.apiKey and model present");
            else console.log("Config: issues found");

            try {
              const n = factsDb.count();
              sqliteOk = true;
              console.log(`SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
            } catch (e) {
              issues.push(`SQLite: ${String(e)}`);
              fixes.push(`SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`);
              console.log(`SQLite: FAIL — ${String(e)}`);
            }

            try {
              const n = await vectorDb.count();
              lanceOk = true;
              console.log(`LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
            } catch (e) {
              issues.push(`LanceDB: ${String(e)}`);
              fixes.push(`LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`);
              console.log(`LanceDB: FAIL — ${String(e)}`);
            }

            try {
              await embeddings.embed("verify test");
              embeddingOk = true;
              console.log("Embedding API: OK");
            } catch (e) {
              issues.push(`Embedding API: ${String(e)}`);
              fixes.push(`Embedding API: Check key at platform.openai.com; ensure it has access to the embedding model (${cfg.embedding.model}). Set plugins.entries[\"openclaw-hybrid-memory\"].config.embedding.apiKey and restart. 401/403 = invalid or revoked key.`);
              console.log(`Embedding API: FAIL — ${String(e)}`);
            }

            // Features summary
            console.log("\nFeatures:");
            console.log(`  autoCapture: ${cfg.autoCapture}`);
            console.log(`  autoRecall: ${cfg.autoRecall.enabled}`);
            console.log(`  autoClassify: ${cfg.autoClassify.enabled ? cfg.autoClassify.model : "off"}`);
            console.log(`  credentials: ${cfg.credentials.enabled ? "enabled" : "disabled"}`);
            console.log(`  store.fuzzyDedupe: ${cfg.store.fuzzyDedupe}`);

            // Credentials: enabled?, key defined?, vault accessible?
            let credentialsOk = true;
            if (cfg.credentials.enabled) {
              const keyDefined = !!cfg.credentials.encryptionKey && cfg.credentials.encryptionKey.length >= 16;
              if (!keyDefined) {
                issues.push("credentials.enabled but encryption key missing or too short (min 16 chars or env:VAR)");
                loadBlocking.push("credentials enabled but encryption key missing or too short");
                fixes.push("LOAD-BLOCKING: Set credentials.encryptionKey to env:OPENCLAW_CRED_KEY and export OPENCLAW_CRED_KEY (min 16 chars), or set a 16+ character secret in plugin config. See docs/CREDENTIALS.md.");
                credentialsOk = false;
                console.log("\nCredentials: enabled — key missing or too short (set OPENCLAW_CRED_KEY or credentials.encryptionKey)");
              } else if (credentialsDb) {
                try {
                  const items = credentialsDb.list();
                  if (items.length > 0) {
                    const first = items[0];
                    credentialsDb.get(first.service, first.type as CredentialType);
                  }
                  console.log(`\nCredentials: enabled — key set, vault OK (${items.length} stored)`);
                } catch (e) {
                  issues.push(`Credentials vault: ${String(e)} (wrong key or corrupted DB)`);
                  fixes.push(`Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the same key used when credentials were stored, or disable credentials in config. See docs/CREDENTIALS.md.`);
                  credentialsOk = false;
                  console.log(`\nCredentials: enabled — vault FAIL — ${String(e)} (check OPENCLAW_CRED_KEY / encryptionKey)`);
                }
              } else {
                console.log("\nCredentials: enabled — key set (vault not opened in this process)");
              }
            } else {
              console.log("\nCredentials: disabled");
            }

            // Session distillation: last run (optional file)
            const memoryDir = dirname(resolvedSqlitePath);
            const distillLastRunPath = join(memoryDir, ".distill_last_run");
            if (existsSync(distillLastRunPath)) {
              try {
                const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
                console.log(`\nSession distillation: last run recorded ${line ? `— ${line}` : "(empty file)"}`);
              } catch {
                console.log("\nSession distillation: last run file present but unreadable");
              }
            } else {
              console.log("\nSession distillation: last run not recorded (optional).");
              console.log("  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill");
              console.log("  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.");
              console.log("  If you don't use it, ignore this.");
            }

            // Optional / suggested jobs (e.g. nightly session distillation)
            // Check OpenClaw cron store first (~/.openclaw/cron/jobs.json), then legacy openclaw.json "jobs"
            let nightlySweepDefined = false;
            let nightlySweepEnabled = true;
            const cronStorePath = join(openclawDir, "cron", "jobs.json");
            if (existsSync(cronStorePath)) {
              try {
                const raw = readFileSync(cronStorePath, "utf-8");
                const store = JSON.parse(raw) as Record<string, unknown>;
                const jobs = store.jobs;
                if (Array.isArray(jobs)) {
                  const nightly = jobs.find((j: unknown) => {
                    if (typeof j !== "object" || j === null) return false;
                    const name = String((j as Record<string, unknown>).name ?? "").toLowerCase();
                    const pl = (j as Record<string, unknown>).payload as Record<string, unknown> | undefined;
                    const msg = String(pl?.message ?? (j as Record<string, unknown>).message ?? "").toLowerCase();
                    return /nightly-memory-sweep|memory distillation.*nightly|nightly.*memory.*distill/.test(name) || /nightly memory distillation|memory distillation pipeline/.test(msg);
                  }) as Record<string, unknown> | undefined;
                  if (nightly) {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = nightly.enabled !== false;
                  }
                }
              } catch {
                // ignore parse or read errors
              }
            }
            if (!nightlySweepDefined && existsSync(defaultConfigPath)) {
              try {
                const raw = readFileSync(defaultConfigPath, "utf-8");
                const root = JSON.parse(raw) as Record<string, unknown>;
                const jobs = root.jobs;
                if (Array.isArray(jobs)) {
                  const nightly = jobs.find((j: unknown) => typeof j === "object" && j !== null && (j as Record<string, unknown>).name === "nightly-memory-sweep") as Record<string, unknown> | undefined;
                  if (nightly) {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = nightly.enabled !== false;
                  }
                } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
                  const nightly = (jobs as Record<string, unknown>)["nightly-memory-sweep"];
                  if (nightly && typeof nightly === "object") {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = (nightly as Record<string, unknown>).enabled !== false;
                  }
                }
              } catch {
                // ignore
              }
            }
            console.log("\nOptional / suggested jobs (cron store or openclaw.json):");
            if (nightlySweepDefined) {
              console.log(`  nightly-memory-sweep (session distillation): defined, ${nightlySweepEnabled ? "enabled" : "disabled"}`);
            } else {
              console.log("  nightly-memory-sweep (session distillation): not defined");
              fixes.push("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs (e.g. cron store or UI) or system cron. See docs/SESSION-DISTILLATION.md § Nightly Cron Setup.");
            }

            console.log("\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.");
            if (opts.logFile && existsSync(opts.logFile)) {
              const content = readFileSync(opts.logFile, "utf-8");
              const lines = content.split("\n").filter((l) => /memory-hybrid|prune|auto-classify|periodic|failed/.test(l));
              const errLines = lines.filter((l) => /error|fail|warn/i.test(l));
              if (errLines.length > 0) {
                console.log(`\nRecent log lines mentioning memory-hybrid/errors (last ${errLines.length}):`);
                errLines.slice(-10).forEach((l) => console.log(`  ${l.slice(0, 120)}`));
              } else if (lines.length > 0) {
                console.log(`\nLog file: ${lines.length} relevant lines (no errors in sample)`);
              }
            } else if (opts.logFile) {
              console.log(`\nLog file not found: ${opts.logFile}`);
            }

            const allOk = configOk && sqliteOk && lanceOk && embeddingOk && (!cfg.credentials.enabled || credentialsOk);
            if (allOk) {
              console.log("\nAll checks passed.");
              if (!nightlySweepDefined) {
                console.log("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.");
              }
            } else {
              console.log("\n--- Issues ---");
              if (loadBlocking.length > 0) {
                console.log("Load-blocking (prevent OpenClaw / plugin from loading):");
                loadBlocking.forEach((i) => console.log(`  - ${i}`));
              }
              const other = issues.filter((i) => !loadBlocking.includes(i));
              if (other.length > 0) {
                console.log(other.length > 0 && loadBlocking.length > 0 ? "Other:" : "Issues:");
                other.forEach((i) => console.log(`  - ${i}`));
              }
              console.log("\n--- Fixes for detected issues ---");
              fixes.forEach((f) => console.log(`  • ${f}`));
              console.log("\nEdit config: " + defaultConfigPath + " (or OPENCLAW_HOME/openclaw.json). Restart gateway after changing plugin config.");
            }

            if (opts.fix) {
              const applied: string[] = [];
              if (existsSync(defaultConfigPath)) {
                try {
                  const raw = readFileSync(defaultConfigPath, "utf-8");
                  const fixConfig = JSON.parse(raw) as Record<string, unknown>;
                  let changed = false;
                  if (!fixConfig.plugins || typeof fixConfig.plugins !== "object") fixConfig.plugins = {};
                  const plugins = fixConfig.plugins as Record<string, unknown>;
                  if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
                  const entries = plugins.entries as Record<string, unknown>;
                  if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
                  const mh = entries[PLUGIN_ID] as Record<string, unknown>;
                  if (!mh.config || typeof mh.config !== "object") mh.config = {};
                  const cfg = mh.config as Record<string, unknown>;
                  if (!cfg.embedding || typeof cfg.embedding !== "object") cfg.embedding = {};
                  const emb = cfg.embedding as Record<string, unknown>;
                  const curKey = emb.apiKey;
                  const placeholder = typeof curKey !== "string" || curKey.length < 10 || curKey === "YOUR_OPENAI_API_KEY" || curKey === "<OPENAI_API_KEY>";
                  if (placeholder) {
                    emb.apiKey = process.env.OPENAI_API_KEY || "YOUR_OPENAI_API_KEY";
                    emb.model = emb.model || "text-embedding-3-small";
                    changed = true;
                    applied.push("Set embedding.apiKey and model (replace YOUR_OPENAI_API_KEY with your key if not using env)");
                  }
                  // Add nightly-memory-sweep job if missing (same as install), so upgrade/snippet-only users get it without running full install.
                  const jobs = Array.isArray(fixConfig.jobs) ? fixConfig.jobs : [];
                  const hasNightly = jobs.some((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                  if (!hasNightly) {
                    jobs.push({
                      name: "nightly-memory-sweep",
                      schedule: "0 2 * * *",
                      channel: "system",
                      message:
                        "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
                      isolated: true,
                      model: "gemini",
                    });
                    (fixConfig as Record<string, unknown>).jobs = jobs;
                    changed = true;
                    applied.push("Added nightly-memory-sweep job for session distillation");
                  }
                  const memoryDirPath = dirname(resolvedSqlitePath);
                  if (!existsSync(memoryDirPath)) {
                    mkdirSync(memoryDirPath, { recursive: true });
                    applied.push("Created memory directory: " + memoryDirPath);
                  }
                  if (changed) {
                    writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
                  }
                  if (applied.length > 0) {
                    console.log("\n--- Applied fixes ---");
                    applied.forEach((a) => console.log("  • " + a));
                    if (changed) console.log("Config written: " + defaultConfigPath + ". Restart the gateway and run verify again.");
                  }
                } catch (e) {
                  console.log("\nCould not apply fixes to config: " + String(e));
                  const snippet = {
                    embedding: { apiKey: process.env.OPENAI_API_KEY || "<set your key>", model: "text-embedding-3-small" },
                    autoCapture: true,
                    autoRecall: true,
                    captureMaxChars: 5000,
                    store: { fuzzyDedupe: false },
                  };
                  console.log(`Minimal config snippet to merge into plugins.entries["${PLUGIN_ID}"].config:`);
                  console.log(JSON.stringify(snippet, null, 2));
                }
              } else {
                console.log("\n--- Fix (--fix) ---");
                console.log("Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.");
              }
            }
          });

        const cred = mem
          .command("credentials")
          .description("Credentials vault commands");
        cred
          .command("migrate-to-vault")
          .description("Move credential facts from memory into vault and redact originals (idempotent)")
          .action(async () => {
            if (!credentialsDb) {
              console.error("Credentials vault is disabled. Enable it in plugin config (credentials.encryptionKey) and restart.");
              return;
            }
            const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
            const result = await migrateCredentialsToVault({
              factsDb,
              vectorDb,
              embeddings,
              credentialsDb,
              migrationFlagPath,
              markDone: true,
            });
            console.log(`Migrated: ${result.migrated}, skipped: ${result.skipped}`);
            if (result.errors.length > 0) {
              console.error("Errors:");
              result.errors.forEach((e) => console.error(`  - ${e}`));
            }
          });

        /** Full distillation: max days of history to process when .distill_last_run is missing (avoids unbounded first run). */
        const FULL_DISTILL_MAX_DAYS = 90;
        /** Incremental: process at least this many days when last run exists (overlap window). */
        const INCREMENTAL_MIN_DAYS = 3;

        mem
          .command("distill-window")
          .description("Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process; end the job with record-distill.")
          .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
          .action(async (opts: { json?: boolean }) => {
            const memoryDir = dirname(resolvedSqlitePath);
            const distillLastRunPath = join(memoryDir, ".distill_last_run");
            const now = new Date();
            const today = now.toISOString().slice(0, 10);

            let mode: "full" | "incremental";
            let startDate: string;
            let endDate: string = today;
            let mtimeDays: number;

            if (!existsSync(distillLastRunPath)) {
              mode = "full";
              const start = new Date(now);
              start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
              startDate = start.toISOString().slice(0, 10);
              mtimeDays = FULL_DISTILL_MAX_DAYS;
            } else {
              try {
                const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
                if (!line) {
                  mode = "full";
                  const start = new Date(now);
                  start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                  startDate = start.toISOString().slice(0, 10);
                  mtimeDays = FULL_DISTILL_MAX_DAYS;
                } else {
                  const lastRun = new Date(line);
                  if (Number.isNaN(lastRun.getTime())) {
                    mode = "full";
                    const start = new Date(now);
                    start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                    startDate = start.toISOString().slice(0, 10);
                    mtimeDays = FULL_DISTILL_MAX_DAYS;
                  } else {
                    mode = "incremental";
                    const lastRunDate = lastRun.toISOString().slice(0, 10);
                    const threeDaysAgo = new Date(now);
                    threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
                    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
                    startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
                    const start = new Date(startDate);
                    mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
                    if (mtimeDays < 1) mtimeDays = 1;
                  }
                }
              } catch {
                mode = "full";
                const start = new Date(now);
                start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                startDate = start.toISOString().slice(0, 10);
                mtimeDays = FULL_DISTILL_MAX_DAYS;
              }
            }

            if (opts.json) {
              console.log(JSON.stringify({ mode, startDate, endDate, mtimeDays }));
              return;
            }
            console.log(`Distill window: ${mode}`);
            console.log(`  startDate: ${startDate}`);
            console.log(`  endDate: ${endDate}`);
            console.log(`  mtimeDays: ${mtimeDays} (use find ... -mtime -${mtimeDays} for session files)`);
            console.log("Process sessions from that window; then run: openclaw hybrid-mem record-distill");
          });

        mem
          .command("record-distill")
          .description("Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)")
          .action(async () => {
            const memoryDir = dirname(resolvedSqlitePath);
            mkdirSync(memoryDir, { recursive: true });
            const path = join(memoryDir, ".distill_last_run");
            const ts = new Date().toISOString();
            writeFileSync(path, ts + "\n", "utf-8");
            console.log(`Recorded distillation run: ${ts}`);
            console.log(`Written to ${path}. Run 'openclaw hybrid-mem verify' to see it.`);
          });

        mem
          .command("uninstall")
          .description("Revert to OpenClaw default memory (memory-core). Safe: OpenClaw works normally; your data is kept unless you use --clean-all.")
          .option("--clean-all", "Remove SQLite and LanceDB data (irreversible)")
          .option("--force-cleanup", "Same as --clean-all")
          .option("--leave-config", "Do not modify openclaw.json; only print instructions")
          .action(async (opts: { cleanAll?: boolean; forceCleanup?: boolean; leaveConfig?: boolean }) => {
            const doClean = !!opts.cleanAll || !!opts.forceCleanup;
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const configPath = join(openclawDir, "openclaw.json");

            if (!opts.leaveConfig && existsSync(configPath)) {
              try {
                const raw = readFileSync(configPath, "utf-8");
                const config = JSON.parse(raw) as Record<string, unknown>;
                if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
                const plugins = config.plugins as Record<string, unknown>;
                if (!plugins.slots || typeof plugins.slots !== "object") plugins.slots = {};
                (plugins.slots as Record<string, string>).memory = "memory-core";
                if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
                const entries = plugins.entries as Record<string, unknown>;
                if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") {
                  entries[PLUGIN_ID] = {};
                }
                (entries[PLUGIN_ID] as Record<string, boolean>).enabled = false;
                writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
                console.log(`Config updated: plugins.slots.memory = "memory-core", ${PLUGIN_ID} disabled.`);
                console.log("OpenClaw will use the default memory manager. Restart the gateway. Your hybrid data is kept unless you run with --clean-all.");
              } catch (e) {
                console.error(`Could not update config (${configPath}): ${e}`);
                console.log("Apply these changes manually:");
                console.log("  1. Set plugins.slots.memory to \"memory-core\"");
                console.log(`  2. Set plugins.entries["${PLUGIN_ID}"].enabled to false`);
                console.log("  3. Restart the gateway.");
              }
            } else if (!opts.leaveConfig) {
              console.log(`Config file not found at ${configPath}. Apply these changes manually:`);
              console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
              console.log("  2. Set plugins.slots.memory to \"memory-core\".");
              console.log(`  3. Set plugins.entries["${PLUGIN_ID}"].enabled to false.`);
              console.log("  4. Restart the gateway.");
            } else {
              console.log("To use the default OpenClaw memory manager instead of hybrid:");
              console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
              console.log("  2. Set plugins.slots.memory to \"memory-core\".");
              console.log(`  3. Set plugins.entries["${PLUGIN_ID}"].enabled to false.`);
              console.log("  4. Restart the gateway.");
            }

            if (!doClean) {
              console.log("\nMemory data (SQLite and LanceDB) was left in place. To remove it: openclaw hybrid-mem uninstall --clean-all");
              return;
            }
            console.log("\nRemoving hybrid-memory data...");
            const toRemove: string[] = [];
            if (existsSync(resolvedSqlitePath)) {
              try {
                rmSync(resolvedSqlitePath, { force: true });
                toRemove.push(resolvedSqlitePath);
              } catch (e) {
                console.error(`Failed to remove SQLite file: ${e}`);
              }
            }
            if (existsSync(resolvedLancePath)) {
              try {
                rmSync(resolvedLancePath, { recursive: true, force: true });
                toRemove.push(resolvedLancePath);
              } catch (e) {
                console.error(`Failed to remove LanceDB dir: ${e}`);
              }
            }
            if (toRemove.length > 0) {
              console.log("Removed: " + toRemove.join(", "));
            } else {
              console.log("No hybrid data files found at configured paths.");
            }
          });
      },
      { commands: ["hybrid-mem", "hybrid-mem install", "hybrid-mem stats", "hybrid-mem prune", "hybrid-mem checkpoint", "hybrid-mem backfill-decay", "hybrid-mem extract-daily", "hybrid-mem search", "hybrid-mem lookup", "hybrid-mem store", "hybrid-mem classify", "hybrid-mem categories", "hybrid-mem find-duplicates", "hybrid-mem consolidate", "hybrid-mem reflect", "hybrid-mem reflect-rules", "hybrid-mem reflect-meta", "hybrid-mem verify", "hybrid-mem credentials migrate-to-vault", "hybrid-mem distill-window", "hybrid-mem record-distill", "hybrid-mem uninstall"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall.enabled) {
      api.on("before_agent_start", async (event: unknown) => {
        const e = event as { prompt?: string };
        if (!e.prompt || e.prompt.length < 5) return;

        try {
          // FR-009: Use configurable candidate pool for progressive disclosure
          const fmt = cfg.autoRecall.injectionFormat;
          const isProgressive = fmt === "progressive" || fmt === "progressive_hybrid";
          const searchLimit = isProgressive
            ? (cfg.autoRecall.progressiveMaxCandidates ?? Math.max(cfg.autoRecall.limit, 15))
            : cfg.autoRecall.limit;
          const { minScore } = cfg.autoRecall;
          const limit = searchLimit;
          const ftsResults = factsDb.search(e.prompt, limit);
          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(e.prompt);
            lanceResults = await vectorDb.search(vector, limit, minScore);
          } catch (err) {
            api.logger.warn(
              `memory-hybrid: vector recall failed: ${err}`,
            );
          }

          let candidates = mergeResults(ftsResults, lanceResults, limit, factsDb);

          const { entityLookup } = cfg.autoRecall;
          if (entityLookup.enabled && entityLookup.entities.length > 0) {
            const promptLower = e.prompt.toLowerCase();
            const seenIds = new Set(candidates.map((c) => c.entry.id));
            for (const entity of entityLookup.entities) {
              if (!promptLower.includes(entity.toLowerCase())) continue;
              const entityResults = factsDb.lookup(entity).slice(0, entityLookup.maxFactsPerEntity);
              for (const r of entityResults) {
                if (!seenIds.has(r.entry.id)) {
                  seenIds.add(r.entry.id);
                  candidates.push(r);
                }
              }
            }
            candidates.sort((a, b) => {
              const s = b.score - a.score;
              if (s !== 0) return s;
              const da = a.entry.sourceDate ?? a.entry.createdAt;
              const db = b.entry.sourceDate ?? b.entry.createdAt;
              return db - da;
            });
            candidates = candidates.slice(0, limit);
          }

          if (candidates.length === 0) return;

          {
            const nowSec = Math.floor(Date.now() / 1000);
            const NINETY_DAYS_SEC = 90 * 24 * 3600;
            const boosted = candidates.map((r) => {
              let s = r.score;
              if (cfg.autoRecall.preferLongTerm) {
                s *=
                  r.entry.decayClass === "permanent"
                    ? 1.2
                    : r.entry.decayClass === "stable"
                      ? 1.1
                      : 1;
              }
              if (cfg.autoRecall.useImportanceRecency) {
                const importanceFactor = 0.7 + 0.3 * r.entry.importance;
                const recencyFactor =
                  r.entry.lastConfirmedAt === 0
                    ? 1
                    : 0.8 +
                      0.2 *
                        Math.max(
                          0,
                          1 - (nowSec - r.entry.lastConfirmedAt) / NINETY_DAYS_SEC,
                        );
                s *= importanceFactor * recencyFactor;
              }
              // FR-005: Access-count salience boost — frequently recalled facts score higher
              const recallCount = r.entry.recallCount ?? 0;
              if (recallCount > 0) {
                s *= 1 + 0.1 * Math.log(recallCount + 1);
              }
              return { ...r, score: s };
            });
            boosted.sort((a, b) => b.score - a.score);
            candidates = boosted;
          }

          const {
            maxTokens,
            maxPerMemoryChars,
            injectionFormat,
            useSummaryInInjection,
            summarizeWhenOverBudget,
            summarizeModel,
          } = cfg.autoRecall;

          // FR-009: Progressive disclosure — inject a lightweight index, let the agent decide what to fetch
          const indexCap = cfg.autoRecall.progressiveIndexMaxTokens ?? maxTokens;
          const groupByCategory = cfg.autoRecall.progressiveGroupByCategory === true;

          function buildProgressiveIndex(
            list: typeof candidates,
            cap: number,
            startPosition: number,
          ): { lines: string[]; ids: string[]; usedTokens: number } {
            const totalTokens = list.reduce((sum, r) => {
              const t = r.entry.summary || r.entry.text;
              return sum + estimateTokensForDisplay(t);
            }, 0);
            const header = `Available memories (${list.length} matches, ~${totalTokens} tokens total):\n`;
            let usedTokens = estimateTokens(header);
            const indexEntries: { line: string; id: string; category: string; position: number }[] = [];
            for (let i = 0; i < list.length; i++) {
              const r = list[i];
              const title = r.entry.key
                ? `${r.entry.entity ? r.entry.entity + ": " : ""}${r.entry.key}`
                : (r.entry.summary || r.entry.text.slice(0, 60).trim() + (r.entry.text.length > 60 ? "…" : ""));
              const tokenCost = estimateTokensForDisplay(r.entry.summary || r.entry.text);
              const pos = startPosition + indexEntries.length;
              const line = `  ${pos}. [${r.entry.category}] ${title} (${tokenCost} tok)`;
              const lineTokens = estimateTokens(line + "\n");
              if (usedTokens + lineTokens > cap) break;
              indexEntries.push({ line, id: r.entry.id, category: r.entry.category, position: pos });
              usedTokens += lineTokens;
            }
            const ids = indexEntries.map((e) => e.id);
            let lines: string[];
            if (groupByCategory) {
              const byCat = new Map<string, typeof indexEntries>();
              for (const e of indexEntries) {
                const arr = byCat.get(e.category) ?? [];
                arr.push(e);
                byCat.set(e.category, arr);
              }
              const sortedCats = [...byCat.keys()].sort();
              lines = [header.trimEnd()];
              for (const cat of sortedCats) {
                const entries = byCat.get(cat)!;
                lines.push(`  ${cat} (${entries.length}):`);
                for (const e of entries) {
                  // Keep numeric position for memory_recall(id: N) to work
                  lines.push(e.line.replace(/^(\s+)(\d+\.)/, "  $2"));
                }
              }
            } else {
              lines = [header.trimEnd(), ...indexEntries.map((e) => e.line)];
            }
            return { lines, ids, usedTokens };
          }

          if (injectionFormat === "progressive_hybrid") {
            // Hybrid: pinned (permanent or high recall count) in full, rest as index
            const pinnedRecallThreshold = cfg.autoRecall.progressivePinnedRecallCount ?? 3;
            const pinned: SearchResult[] = [];
            const rest: SearchResult[] = [];
            for (const r of candidates) {
              const recallCount = r.entry.recallCount ?? 0;
              if (
                r.entry.decayClass === "permanent" ||
                recallCount >= pinnedRecallThreshold
              ) {
                pinned.push(r);
              } else {
                rest.push(r);
              }
            }
            const pinnedHeader = "<relevant-memories format=\"progressive_hybrid\">\n";
            const pinnedPart: string[] = [];
            let pinnedTokens = estimateTokens(pinnedHeader);
            const pinnedBudget = Math.min(maxTokens, Math.floor(maxTokens * 0.6));
            for (const r of pinned) {
              let text =
                useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
              if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
                text = text.slice(0, maxPerMemoryChars).trim() + "…";
              }
              const line = `- [${r.backend}/${r.entry.category}] ${text}`;
              const lineTokens = estimateTokens(line + "\n");
              if (pinnedTokens + lineTokens > pinnedBudget) break;
              pinnedPart.push(line);
              pinnedTokens += lineTokens;
            }
            const indexIntro = pinnedPart.length > 0
              ? `\nOther memories (index — use memory_recall(id: N) or memory_recall("query") to fetch):\n`
              : `<relevant-memories format="index">\nAvailable memories (${rest.length} matches):\n`;
            const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
            const indexBudget = indexCap - estimateTokens(pinnedHeader + pinnedPart.join("\n") + indexIntro + indexFooter);
            const { lines: indexLines, ids: indexIds } = buildProgressiveIndex(
              rest,
              Math.max(100, indexBudget),
              1,
            );
            lastProgressiveIndexIds = indexIds;
            if (pinnedPart.length > 0) {
              factsDb.refreshAccessedFacts(pinned.map((r) => r.entry.id));
            }
            if (indexIds.length > 0) {
              factsDb.refreshAccessedFacts(indexIds);
            }
            const indexContent = indexLines.join("\n");
            const fullContent =
              pinnedPart.length > 0
                ? `${pinnedHeader}${pinnedPart.join("\n")}${indexIntro}${indexContent}${indexFooter}`
                : `${indexIntro}${indexContent}${indexFooter}`;
            api.logger.info?.(
              `memory-hybrid: progressive_hybrid — ${pinnedPart.length} pinned in full, index of ${indexIds.length} (~${pinnedTokens + estimateTokens(indexContent)} tokens)`,
            );
            return { prependContext: fullContent };
          }

          if (injectionFormat === "progressive") {
            const indexHeader = `<relevant-memories format="index">\n`;
            const indexFooter = `\n→ Use memory_recall("query"), memory_recall(id: N), or entity/key to fetch full details.\n</relevant-memories>`;
            const { lines: indexLines, ids: indexIds, usedTokens: indexTokens } = buildProgressiveIndex(
              candidates,
              indexCap - estimateTokens(indexHeader + indexFooter),
              1,
            );
            if (indexLines.length === 0) return;
            lastProgressiveIndexIds = indexIds;
            const includedIds = indexIds;
            factsDb.refreshAccessedFacts(includedIds);
            const indexContent = indexLines.join("\n");
            api.logger.info?.(
              `memory-hybrid: progressive disclosure — injecting index of ${indexLines.length} memories (~${indexTokens} tokens)`,
            );
            return {
              prependContext: `${indexHeader}${indexContent}${indexFooter}`,
            };
          }

          const header = "<relevant-memories>\nThe following memories may be relevant:\n";
          const footer = "\n</relevant-memories>";
          let usedTokens = estimateTokens(header + footer);

          const lines: string[] = [];
          for (const r of candidates) {
            let text =
              useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
            if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
              text = text.slice(0, maxPerMemoryChars).trim() + "…";
            }
            const line =
              injectionFormat === "minimal"
                ? `- ${text}`
                : injectionFormat === "short"
                  ? `- ${r.entry.category}: ${text}`
                  : `- [${r.backend}/${r.entry.category}] ${text}`;
            const lineTokens = estimateTokens(line + "\n");
            if (usedTokens + lineTokens > maxTokens) break;
            lines.push(line);
            usedTokens += lineTokens;
          }

          if (lines.length === 0) return;

          let memoryContext = lines.join("\n");

          if (summarizeWhenOverBudget && lines.length < candidates.length) {
            const fullBullets = candidates
              .map((r) => {
                let text =
                  useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
                if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
                  text = text.slice(0, maxPerMemoryChars).trim() + "…";
                }
                return injectionFormat === "minimal"
                  ? `- ${text}`
                  : injectionFormat === "short"
                    ? `- ${r.entry.category}: ${text}`
                    : `- [${r.backend}/${r.entry.category}] ${text}`;
              })
              .join("\n");
            try {
              const resp = await openaiClient.chat.completions.create({
                model: summarizeModel,
                messages: [
                  {
                    role: "user",
                    content: `Summarize these memories into 2-3 short sentences. Preserve key facts.\n\n${fullBullets.slice(0, 4000)}`,
                  },
                ],
                temperature: 0,
                max_tokens: 200,
              });
              const summary = (resp.choices[0]?.message?.content ?? "").trim();
              if (summary) {
                memoryContext = summary;
                usedTokens = estimateTokens(header + memoryContext + footer);
                api.logger.info?.(
                  `memory-hybrid: over budget — injected LLM summary (~${usedTokens} tokens)`,
                );
              }
            } catch (err) {
              api.logger.warn(`memory-hybrid: summarize-when-over-budget failed: ${err}`);
            }
          }

          if (!memoryContext) return;

          if (!summarizeWhenOverBudget || lines.length >= candidates.length) {
            api.logger.info?.(
              `memory-hybrid: injecting ${lines.length} memories (sqlite: ${ftsResults.length}, lance: ${lanceResults.length}, ~${usedTokens} tokens)`,
            );
          }

          return {
            prependContext: `${header}${memoryContext}${footer}`,
          };
        } catch (err) {
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event: unknown) => {
        const ev = event as { success?: boolean; messages?: unknown[] };
        if (!ev.success || !ev.messages || ev.messages.length === 0) {
          return;
        }

        try {
          const texts: string[] = [];
          for (const msg of ev.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push(
                    (block as Record<string, unknown>).text as string,
                  );
                }
              }
            }
          }

          const toCapture = texts.filter((t) => t && shouldCapture(t));
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            let textToStore = text;
            textToStore = truncateForStorage(textToStore, cfg.captureMaxChars);

            // Heuristic classification only — "other" facts are reclassified
            // by the daily auto-classify timer (no LLM calls on the hot path)
            const category: MemoryCategory = detectCategory(textToStore);
            const extracted = extractStructuredFields(textToStore, category);

            if (factsDb.hasDuplicate(textToStore)) continue;

            const summaryThreshold = cfg.autoRecall.summaryThreshold;
            const summary =
              summaryThreshold > 0 && textToStore.length > summaryThreshold
                ? textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim() + "…"
                : undefined;

            // Generate vector once (used for FR-008 classification by embedding similarity and for storage)
            let vector: number[] | undefined;
            try {
              vector = await embeddings.embed(textToStore);
            } catch (err) {
              api.logger.warn(`memory-hybrid: auto-capture embedding failed: ${err}`);
            }

            // FR-008: Classify before auto-capture using embedding similarity (issue #8)
            if (cfg.store.classifyBeforeWrite && vector) {
              let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 3);
              if (similarFacts.length === 0) {
                similarFacts = factsDb.findSimilarForClassification(
                  textToStore, extracted.entity, extracted.key, 3,
                );
              }
              if (similarFacts.length > 0) {
                try {
                  const classification = await classifyMemoryOperation(
                    textToStore, extracted.entity, extracted.key, similarFacts,
                    openaiClient, cfg.store.classifyModel ?? "gpt-4o-mini", api.logger,
                  );
                  if (classification.action === "NOOP") continue;
                  if (classification.action === "DELETE" && classification.targetId) {
                    factsDb.supersede(classification.targetId, null);
                    api.logger.info?.(`memory-hybrid: auto-capture DELETE — retracted ${classification.targetId}`);
                    continue;
                  }
                  if (classification.action === "UPDATE" && classification.targetId) {
                    const oldFact = factsDb.getById(classification.targetId);
                    if (oldFact) {
                      const finalImportance = Math.max(0.7, oldFact.importance);
                      // vector already computed above for classification

                      // WAL: Write pending UPDATE operation
                      const walEntryId = randomUUID();
                      if (wal) {
                        try {
                          wal.write({
                            id: walEntryId,
                            timestamp: Date.now(),
                            operation: "update",
                            data: {
                              text: textToStore,
                              category,
                              importance: finalImportance,
                              entity: extracted.entity || oldFact.entity,
                              key: extracted.key || oldFact.key,
                              value: extracted.value || oldFact.value,
                              source: "auto-capture",
                              decayClass: oldFact.decayClass,
                              summary,
                              tags: extractTags(textToStore, extracted.entity),
                              vector,
                            },
                          });
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: auto-capture WAL write failed: ${err}`);
                        }
                      }

                      const nowSec = Math.floor(Date.now() / 1000);
                      const newEntry = factsDb.store({
                        text: textToStore,
                        category,
                        importance: finalImportance,
                        entity: extracted.entity || oldFact.entity,
                        key: extracted.key || oldFact.key,
                        value: extracted.value || oldFact.value,
                        source: "auto-capture",
                        decayClass: oldFact.decayClass,
                        summary,
                        tags: extractTags(textToStore, extracted.entity),
                        validFrom: nowSec,
                        supersedesId: classification.targetId,
                      });
                      factsDb.supersede(classification.targetId, newEntry.id);
                      try {
                        if (vector && !(await vectorDb.hasDuplicate(vector))) {
                          await vectorDb.store({ text: textToStore, vector, importance: finalImportance, category, id: newEntry.id });
                        }
                      } catch (err) {
                        api.logger.warn(`memory-hybrid: vector capture failed: ${err}`);
                      }

                      // WAL: Remove entry after successful commit
                      if (wal) {
                        try {
                          wal.remove(walEntryId);
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: auto-capture WAL cleanup failed: ${err}`);
                        }
                      }

                      api.logger.info?.(
                        `memory-hybrid: auto-capture UPDATE — superseded ${classification.targetId} with ${newEntry.id}`,
                      );
                      stored++;
                      continue;
                    }
                  }
                  // ADD: fall through to normal store
                } catch (err) {
                  api.logger.warn(`memory-hybrid: auto-capture classification failed: ${err}`);
                  // fall through to normal store on error
                }
              }
            }

            // WAL: Write pending operation before committing to storage (vector already computed above)
            const walEntryId = randomUUID();
            if (wal) {
              try {
                wal.write({
                  id: walEntryId,
                  timestamp: Date.now(),
                  operation: "store",
                  data: {
                    text: textToStore,
                    category,
                    importance: 0.7,
                    entity: extracted.entity,
                    key: extracted.key,
                    value: extracted.value,
                    source: "auto-capture",
                    summary,
                    tags: extractTags(textToStore, extracted.entity),
                    vector,
                  },
                });
              } catch (err) {
                api.logger.warn(`memory-hybrid: auto-capture WAL write failed: ${err}`);
              }
            }

            // Now commit to actual storage (include tags to match WAL entry)
            const storedEntry = factsDb.store({
              text: textToStore,
              category,
              importance: 0.7,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: "auto-capture",
              summary,
              tags: extractTags(textToStore, extracted.entity),
            });

            try {
              if (vector && !(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({ text: textToStore, vector, importance: 0.7, category, id: storedEntry.id });
              }
            } catch (err) {
              api.logger.warn(
                `memory-hybrid: vector capture failed: ${err}`,
              );
            }

            // WAL: Remove entry after successful commit
            if (wal) {
              try {
                wal.remove(walEntryId);
              } catch (err) {
                api.logger.warn(`memory-hybrid: auto-capture WAL cleanup failed: ${err}`);
              }
            }

            stored++;
          }

          if (stored > 0) {
            api.logger.info(
              `memory-hybrid: auto-captured ${stored} memories`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
        }
      });
    }

    // Credential auto-detect: when patterns found in conversation, persist hint for next turn
    if (cfg.credentials.enabled && cfg.credentials.autoDetect) {
      const pendingPath = join(dirname(resolvedSqlitePath), "credentials-pending.json");
      const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

      api.on("agent_end", async (event: unknown) => {
        const ev = event as { messages?: unknown[] };
        if (!ev.messages || ev.messages.length === 0) return;
        try {
          const texts: string[] = [];
          for (const msg of ev.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const content = msgObj.content;
            if (typeof content === "string") texts.push(content);
            else if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && "type" in block && (block as Record<string, unknown>).type === "text" && "text" in block) {
                  const t = (block as Record<string, unknown>).text;
                  if (typeof t === "string") texts.push(t);
                }
              }
            }
          }
          const allText = texts.join("\n");
          const detected = detectCredentialPatterns(allText);
          if (detected.length === 0) return;
          mkdirSync(dirname(pendingPath), { recursive: true });
          writeFileSync(
            pendingPath,
            JSON.stringify({
              hints: detected.map((d) => d.hint),
              at: Date.now(),
            }),
            "utf-8",
          );
          api.logger.info(`memory-hybrid: credential patterns detected (${detected.map((d) => d.hint).join(", ")}) — will prompt next turn`);
        } catch (err) {
          api.logger.warn(`memory-hybrid: credential auto-detect failed: ${err}`);
        }
      });

      api.on("before_agent_start", async () => {
        try {
          if (!existsSync(pendingPath)) return;
          const raw = readFileSync(pendingPath, "utf-8");
          const data = JSON.parse(raw) as { hints?: string[]; at?: number };
          const at = typeof data.at === "number" ? data.at : 0;
          if (Date.now() - at > PENDING_TTL_MS) {
            rmSync(pendingPath, { force: true });
            return;
          }
          const hints = Array.isArray(data.hints) ? data.hints : [];
          if (hints.length === 0) {
            rmSync(pendingPath, { force: true });
            return;
          }
          rmSync(pendingPath, { force: true });
          const hintText = hints.join(", ");
          return {
            prependContext: `\n<credential-hint>\nA credential may have been shared in the previous exchange (${hintText}). Consider asking the user if they want to store it securely with credential_store.\n</credential-hint>\n`,
          };
        } catch {
          try { rmSync(pendingPath, { force: true }); } catch { /* ignore */ }
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: PLUGIN_ID,
      start: () => {
        const sqlCount = factsDb.count();
        const expired = factsDb.countExpired();
        api.logger.info(
          `memory-hybrid: initialized v${versionInfo.pluginVersion} (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
        );

        if (expired > 0) {
          const pruned = factsDb.pruneExpired();
          api.logger.info(`memory-hybrid: startup prune removed ${pruned} expired facts`);
        }

        // WAL Recovery: replay uncommitted operations from previous session
        if (wal) {
          const pendingEntries = wal.getValidEntries();
          if (pendingEntries.length > 0) {
            api.logger.info(`memory-hybrid: WAL recovery starting — found ${pendingEntries.length} pending operation(s)`);
            let recovered = 0;
            let failed = 0;

            for (const entry of pendingEntries) {
              try {
                if (entry.operation === "store" || entry.operation === "update") {
                  const { text, category, importance, entity, key, value, source, decayClass, summary, tags } = entry.data;
                  
                  // Check if already stored (idempotency)
                  if (!factsDb.hasDuplicate(text)) {
                    // Store to SQLite
                    const stored = factsDb.store({
                      text,
                      category: (category as MemoryCategory) || "other",
                      importance: importance ?? 0.7,
                      entity: entity || null,
                      key: key || null,
                      value: value || null,
                      source: source || "wal-recovery",
                      decayClass,
                      summary,
                      tags,
                    });

                    // Store to LanceDB (async, best effort) with same fact id for FR-008
                    if (entry.data.vector) {
                      void vectorDb.store({
                        text,
                        vector: entry.data.vector,
                        importance: importance ?? 0.7,
                        category: category || "other",
                        id: stored.id,
                      }).catch((err) => {
                        api.logger.warn(`memory-hybrid: WAL recovery vector store failed for entry ${entry.id}: ${err}`);
                      });
                    }

                    recovered++;
                  }
              } else {
                // Known but unhandled operation type (e.g., "delete")
                api.logger.warn(`memory-hybrid: WAL recovery skipping unsupported operation "${entry.operation}" (entry ${entry.id})`);
              }
                
                // Remove successfully processed entry
                wal.remove(entry.id);
              } catch (err) {
                api.logger.warn(`memory-hybrid: WAL recovery failed for entry ${entry.id}: ${err}`);
                failed++;
              }
            }

            if (recovered > 0 || failed > 0) {
              api.logger.info(`memory-hybrid: WAL recovery completed — recovered ${recovered} operation(s), ${failed} failed`);
            }

            // Prune any remaining stale entries
            const pruned = wal.pruneStale();
            if (pruned > 0) {
              api.logger.info(`memory-hybrid: WAL pruned ${pruned} stale entries`);
            }
          }
        }

        pruneTimer = setInterval(() => {
          try {
            const hardPruned = factsDb.pruneExpired();
            const softPruned = factsDb.decayConfidence();
            if (hardPruned > 0 || softPruned > 0) {
              api.logger.info(
                `memory-hybrid: periodic prune — ${hardPruned} expired, ${softPruned} decayed`,
              );
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: periodic prune failed: ${err}`);
          }
        }, 60 * 60_000); // every hour

        // Daily auto-classify: reclassify "other" facts using LLM (if enabled)
        if (cfg.autoClassify.enabled) {
          const CLASSIFY_INTERVAL = 24 * 60 * 60_000; // 24 hours
          const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");

          // Run once shortly after startup (5 min delay to let things settle)
          classifyStartupTimeout = setTimeout(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger, {
                discoveredCategoriesPath: discoveredPath,
              });
            } catch (err) {
              api.logger.warn(`memory-hybrid: startup auto-classify failed: ${err}`);
            }
          }, 5 * 60_000);

          classifyTimer = setInterval(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger, {
                discoveredCategoriesPath: discoveredPath,
              });
            } catch (err) {
              api.logger.warn(`memory-hybrid: daily auto-classify failed: ${err}`);
            }
          }, CLASSIFY_INTERVAL);

          api.logger.info(
            `memory-hybrid: auto-classify enabled (model: ${cfg.autoClassify.model}, interval: 24h, batch: ${cfg.autoClassify.batchSize})`,
          );
        }
      },
      stop: () => {
        if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
        if (classifyStartupTimeout) { clearTimeout(classifyStartupTimeout); classifyStartupTimeout = null; }
        if (classifyTimer) { clearInterval(classifyTimer); classifyTimer = null; }
        if (proposalsPruneTimer) { clearInterval(proposalsPruneTimer); proposalsPruneTimer = null; }
        factsDb.close();
        vectorDb.close();
        if (credentialsDb) { credentialsDb.close(); credentialsDb = null; }
        if (proposalsDb) { proposalsDb.close(); proposalsDb = null; }
        api.logger.info("memory-hybrid: stopped");
      },
    });
  },
};

// Export internal functions and classes for testing
export const _testing = {
  // Utility functions
  normalizeTextForDedupe,
  normalizedHash,
  truncateText,
  truncateForStorage,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
  parseSourceDate,
  estimateTokens,
  estimateTokensForDisplay,
  classifyDecay,
  calculateExpiry,
  extractStructuredFields,
  detectCategory,
  detectCredentialPatterns,
  extractCredentialMatch,
  isCredentialLike,
  inferServiceFromText,
  isStructuredForConsolidation,
  normalizeSuggestedLabel,
  unionFind,
  getRoot,
  mergeResults,
  safeEmbed,
  // Encryption primitives (used by CredentialsDB)
  deriveKey,
  encryptValue,
  decryptValue,
  // Classes for testing
  FactsDB,
  CredentialsDB,
  ProposalsDB,
  VectorDB,
  Embeddings,
  WriteAheadLog,
  // FR-008 classification (for tests)
  findSimilarByEmbedding,
};

export { versionInfo } from "./versionInfo.js";
export default memoryHybridPlugin;