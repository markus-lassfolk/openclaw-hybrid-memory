/**
 * Crystallization Store — SQLite backend for workflow crystallization proposals (Issue #208).
 *
 * Stores pending/approved/rejected skill crystallization proposals derived from
 * workflow patterns. Human approval is required before any skill is written to disk.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { BaseSqliteStore } from "./base-sqlite-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CrystallizationStatus = "pending" | "approved" | "rejected";

export interface CrystallizationProposal {
  id: string;
  patternId: string;
  skillName: string;
  skillContent: string;
  status: CrystallizationStatus;
  /** JSON-encoded WorkflowPattern for reference */
  patternSnapshot: string;
  /** Reason provided when rejecting */
  rejectionReason?: string;
  /** Path where the skill was written on approval */
  outputPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProposalInput {
  patternId: string;
  skillName: string;
  skillContent: string;
  patternSnapshot: string;
}

export interface ProposalFilter {
  status?: CrystallizationStatus;
  skillName?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// CrystallizationStore
// ---------------------------------------------------------------------------

export class CrystallizationStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS crystallization_proposals (
        id               TEXT PRIMARY KEY,
        pattern_id       TEXT NOT NULL,
        skill_name       TEXT NOT NULL,
        skill_content    TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        pattern_snapshot TEXT NOT NULL DEFAULT '{}',
        rejection_reason TEXT,
        output_path      TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cp_status      ON crystallization_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_cp_pattern_id  ON crystallization_proposals(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_cp_skill_name  ON crystallization_proposals(skill_name);
    `);
  }

  protected getSubsystemName(): string {
    return "crystallization-store";
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  create(input: CreateProposalInput): CrystallizationProposal {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.liveDb
      .prepare(
        `INSERT INTO crystallization_proposals
           (id, pattern_id, skill_name, skill_content, status, pattern_snapshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, input.patternId, input.skillName, input.skillContent, input.patternSnapshot, now, now);

    // biome-ignore lint/style/noNonNullAssertion: Known to exist
    return this.getById(id)!;
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  getById(id: string): CrystallizationProposal | null {
    const row = this.liveDb.prepare("SELECT * FROM crystallization_proposals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToProposal(row);
  }

  // -------------------------------------------------------------------------
  // getByPatternId — find proposal for a given pattern id
  // -------------------------------------------------------------------------

  getByPatternId(patternId: string): CrystallizationProposal | null {
    const row = this.liveDb
      .prepare("SELECT * FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(patternId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToProposal(row);
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  list(filter?: ProposalFilter): CrystallizationProposal[] {
    let query = "SELECT * FROM crystallization_proposals WHERE 1=1";
    const params: SQLInputValue[] = [];

    if (filter?.status) {
      query += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.skillName) {
      query += " AND skill_name LIKE ?";
      params.push(`%${filter.skillName}%`);
    }

    query += " ORDER BY created_at DESC";

    if (filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.liveDb.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToProposal(r));
  }

  // -------------------------------------------------------------------------
  // approve — transition pending → approved, write outputPath
  // -------------------------------------------------------------------------

  approve(id: string, outputPath: string): CrystallizationProposal | null {
    const now = new Date().toISOString();
    const result = this.liveDb
      .prepare(
        `UPDATE crystallization_proposals
         SET status = 'approved', output_path = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(outputPath, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // reject — transition pending → rejected
  // -------------------------------------------------------------------------

  reject(id: string, reason?: string): CrystallizationProposal | null {
    const now = new Date().toISOString();
    const result = this.liveDb
      .prepare(
        `UPDATE crystallization_proposals
         SET status = 'rejected', rejection_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(reason ?? null, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  count(status?: CrystallizationStatus): number {
    if (status) {
      const row = this.liveDb
        .prepare("SELECT COUNT(*) as n FROM crystallization_proposals WHERE status = ?")
        .get(status) as { n: number };
      return row.n;
    }
    const row = this.liveDb.prepare("SELECT COUNT(*) as n FROM crystallization_proposals").get() as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // hasPendingOrApprovedForPattern — prevent duplicate proposals
  // -------------------------------------------------------------------------

  hasPendingOrApprovedForPattern(patternId: string): boolean {
    const row = this.liveDb
      .prepare(
        "SELECT COUNT(*) as n FROM crystallization_proposals WHERE pattern_id = ? AND status IN ('pending', 'approved')",
      )
      .get(patternId) as { n: number };
    return row.n > 0;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rowToProposal(row: Record<string, unknown>): CrystallizationProposal {
    return {
      id: row.id as string,
      patternId: row.pattern_id as string,
      skillName: row.skill_name as string,
      skillContent: row.skill_content as string,
      status: row.status as string as CrystallizationStatus,
      patternSnapshot: row.pattern_snapshot as string,
      rejectionReason: row.rejection_reason ? (row.rejection_reason as string) : undefined,
      outputPath: row.output_path ? (row.output_path as string) : undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
