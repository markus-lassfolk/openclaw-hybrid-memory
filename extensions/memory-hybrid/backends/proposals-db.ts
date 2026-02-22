/**
 * Persona Proposals Database
 * Stores LLM-generated suggestions for persona file updates.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

export type ProposalEntry = {
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
  rejectionReason: string | null;
};

export class ProposalsDB {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

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
        expires_at INTEGER,
        rejection_reason TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);
    `);

    this.migrateRejectionReasonColumn();
  }

  private migrateRejectionReasonColumn(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(proposals)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "rejection_reason")) return;
    this.db.exec(`ALTER TABLE proposals ADD COLUMN rejection_reason TEXT`);
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
    rejectionReason?: string,
  ): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "UPDATE proposals SET status = ?, reviewed_at = ?, reviewed_by = ?, rejection_reason = ? WHERE id = ?",
      )
      .run(status, now, reviewedBy ?? null, rejectionReason ?? null, id);
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
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'json-parse-evidence',
        severity: 'info',
        subsystem: 'proposals'
      });
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
      rejectionReason: row.rejection_reason,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'db-close',
        severity: 'info',
        subsystem: 'proposals'
      });
      /* already closed */
    }
  }
}
