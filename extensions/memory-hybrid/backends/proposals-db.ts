/**
 * Persona Proposals Database
 * Stores LLM-generated suggestions for persona file updates.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capturePluginError } from "../services/error-reporter.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

interface ProposalRow {
  id: string;
  target_file: string;
  title: string;
  observation: string;
  suggested_change: string;
  confidence: number;
  evidence_sessions: string;
  status: string;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  applied_at: number | null;
  expires_at: number | null;
  rejection_reason: string | null;
  target_mtime_ms: number | null;
  target_hash: string | null;
}

interface CountRow {
  count: number;
}

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
  targetMtimeMs: number | null;
  targetHash: string | null;
};

export class ProposalsDB extends BaseSqliteStore {
  protected readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.dbPath = dbPath;

    this.liveDb.exec(`
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
        rejection_reason TEXT,
        target_mtime_ms REAL,
        target_hash TEXT
      )
    `);

    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);
    `);

    this.migrateRejectionReasonColumn();
    this.migrateTargetSnapshotColumns();
    this.migrateProposalRunsTable();
  }

  private migrateProposalRunsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS proposal_runs (
        id TEXT PRIMARY KEY,
        run_at INTEGER NOT NULL,
        insights_count INTEGER NOT NULL DEFAULT 0,
        parsed_count INTEGER NOT NULL DEFAULT 0,
        created_count INTEGER NOT NULL DEFAULT 0,
        semantic_empty INTEGER NOT NULL DEFAULT 0,
        identity_gap_score REAL,
        model TEXT,
        zero_reason TEXT
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_proposal_runs_run_at ON proposal_runs(run_at)");
  }

  recordRun(entry: {
    runAt: number;
    insightsCount: number;
    parsedCount: number;
    createdCount: number;
    semanticEmpty: boolean;
    identityGapScore: number;
    model: string | null;
    zeroReason: string | null;
  }): void {
    this.liveDb
      .prepare(
        `INSERT INTO proposal_runs (id, run_at, insights_count, parsed_count, created_count, semantic_empty, identity_gap_score, model, zero_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entry.runAt,
        entry.insightsCount,
        entry.parsedCount,
        entry.createdCount,
        entry.semanticEmpty ? 1 : 0,
        entry.identityGapScore,
        entry.model,
        entry.zeroReason,
      );
  }

  protected getSubsystemName(): string {
    return "proposals-db";
  }

  private migrateRejectionReasonColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "rejection_reason")) return;
    this.liveDb.exec("ALTER TABLE proposals ADD COLUMN rejection_reason TEXT");
  }

  private migrateTargetSnapshotColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "target_mtime_ms")) {
      this.liveDb.exec("ALTER TABLE proposals ADD COLUMN target_mtime_ms REAL");
    }
    if (!cols.some((c) => c.name === "target_hash")) {
      this.liveDb.exec("ALTER TABLE proposals ADD COLUMN target_hash TEXT");
    }
  }

  create(entry: {
    targetFile: string;
    title: string;
    observation: string;
    suggestedChange: string;
    confidence: number;
    evidenceSessions: string[];
    expiresAt?: number | null;
    targetMtimeMs?: number | null;
    targetHash?: string | null;
  }): ProposalEntry {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const evidenceJson = JSON.stringify(entry.evidenceSessions);

    this.liveDb
      .prepare(
        `INSERT INTO proposals (id, target_file, title, observation, suggested_change, confidence, evidence_sessions, status, created_at, expires_at, target_mtime_ms, target_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
        entry.targetMtimeMs ?? null,
        entry.targetHash ?? null,
      );

    // biome-ignore lint/style/noNonNullAssertion: Known to exist
    return this.get(id)!;
  }

  get(id: string): ProposalEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as
      | ProposalRow
      | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  /** Targeted duplicate check for pipeline proposal creation (avoids full-table list scans). */
  findPendingOrAppliedDuplicate(targetFile: string, suggestedChange: string, excludeId?: string): ProposalEntry | null {
    const normalized = suggestedChange.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const rows = this.liveDb
      .prepare("SELECT * FROM proposals WHERE target_file = ? AND status IN ('pending', 'applied')")
      .all(targetFile) as unknown as ProposalRow[];
    for (const row of rows) {
      const entry = this.rowToEntry(row);
      if (excludeId && entry.id === excludeId) continue;
      const candidate = entry.suggestedChange.toLowerCase().replace(/\s+/g, " ").trim();
      if (candidate === normalized) return entry;
    }
    return null;
  }

  list(filters?: { status?: string; targetFile?: string }): ProposalEntry[] {
    let query = "SELECT * FROM proposals WHERE 1=1";
    const params: string[] = [];

    if (filters?.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.targetFile) {
      query += " AND target_file = ?";
      params.push(filters.targetFile);
    }

    query += " ORDER BY created_at DESC";

    const rows = this.liveDb.prepare(query).all(...params) as unknown as ProposalRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  updateStatus(id: string, status: string, reviewedBy?: string, rejectionReason?: string): ProposalEntry | null {
    if (status === "pending") {
      this.liveDb
        .prepare(
          "UPDATE proposals SET status = ?, reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL WHERE id = ?",
        )
        .run(status, id);
      return this.get(id);
    }
    const now = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare("UPDATE proposals SET status = ?, reviewed_at = ?, reviewed_by = ?, rejection_reason = ? WHERE id = ?")
      .run(status, now, reviewedBy ?? null, rejectionReason ?? null, id);
    return this.get(id);
  }

  /** Atomically transition status only when the proposal is in `expectedStatus`. */
  updateStatusIf(
    id: string,
    status: string,
    expectedStatus: string,
    reviewedBy?: string,
    rejectionReason?: string,
  ): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    const result =
      status === "pending"
        ? this.liveDb
            .prepare(
              `UPDATE proposals SET status = ?, reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL
               WHERE id = ? AND status = ?`,
            )
            .run(status, id, expectedStatus)
        : this.liveDb
            .prepare(
              `UPDATE proposals SET status = ?, reviewed_at = ?, reviewed_by = ?, rejection_reason = ?
               WHERE id = ? AND status = ?`,
            )
            .run(status, now, reviewedBy ?? null, rejectionReason ?? null, id, expectedStatus);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  updateSuggestedChange(
    id: string,
    suggestedChange: string,
    snapshot?: { targetMtimeMs: number | null; targetHash: string | null; confidence?: number },
  ): ProposalEntry | null {
    if (snapshot) {
      this.liveDb
        .prepare(
          `UPDATE proposals SET suggested_change = ?, target_mtime_ms = ?, target_hash = ?, confidence = COALESCE(?, confidence)
           WHERE id = ? AND status = 'pending'`,
        )
        .run(suggestedChange, snapshot.targetMtimeMs, snapshot.targetHash, snapshot.confidence ?? null, id);
    } else {
      this.liveDb
        .prepare("UPDATE proposals SET suggested_change = ? WHERE id = ? AND status = 'pending'")
        .run(suggestedChange, id);
    }
    return this.get(id);
  }

  markApplied(id: string): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    this.liveDb.prepare("UPDATE proposals SET status = 'applied', applied_at = ? WHERE id = ?").run(now, id);
    return this.get(id);
  }

  markAppliedIfApproved(id: string): ProposalEntry | null {
    const now = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare("UPDATE proposals SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'approved'")
      .run(now, id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  countRecentProposals(daysBack: number, opts?: { excludeSelfCorrection?: boolean }): number {
    const cutoff = Math.floor(Date.now() / 1000) - daysBack * 24 * 3600;
    const excludeSC = opts?.excludeSelfCorrection === true;
    const sql = excludeSC
      ? "SELECT COUNT(*) as count FROM proposals WHERE created_at >= ? AND title NOT LIKE 'Self-correction: %'"
      : "SELECT COUNT(*) as count FROM proposals WHERE created_at >= ?";
    const row = this.liveDb.prepare(sql).get(cutoff) as unknown as CountRow | undefined;
    return row?.count ?? 0;
  }

  pruneExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare("DELETE FROM proposals WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'pending'")
      .run(now);
    return Number(result.changes);
  }

  private rowToEntry(row: ProposalRow): ProposalEntry {
    // Parse evidence_sessions with error handling for corrupted data
    let evidenceSessions: string[] = [];
    try {
      evidenceSessions = JSON.parse(row.evidence_sessions);
      if (!Array.isArray(evidenceSessions)) {
        evidenceSessions = [];
      }
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "json-parse-evidence",
        severity: "info",
        subsystem: "proposals",
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
      targetMtimeMs: row.target_mtime_ms ?? null,
      targetHash: row.target_hash ?? null,
    };
  }
}
