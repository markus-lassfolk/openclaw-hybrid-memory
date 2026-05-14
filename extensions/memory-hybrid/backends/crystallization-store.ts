/**
 * Crystallization Store — SQLite backend for workflow crystallization proposals (Issue #208).
 *
 * Stores pending/approved/rejected skill crystallization proposals derived from
 * workflow patterns. Human approval is required before any skill is written to disk.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { BaseSqliteStore } from "./base-sqlite-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Proposal lifecycle.
 *
 * Notes:
 * - We keep compatibility aliases in filtering/counting ("pending"/"approved")
 *   to avoid breaking older CLI/digest code paths.
 */
export type CrystallizationStatus =
  | "candidate"
  | "drafted"
  | "validated"
  | "approved"
  | "installed"
  | "rejected"
  | "superseded";

type CrystallizationStatusFilter = CrystallizationStatus | "pending" | "approved";

export type SkillProposalRecommendedOutput = "SKILL.md only";

export type SkillProposalCard = {
  name: string;
  category: string;
  description: string;
  observed_runs: number;
  successful_runs: number;
  failed_runs: number;
  captures: string[];
  why_useful: string;
  risks: string[];
  confidence: number;
  recommended_output: SkillProposalRecommendedOutput;
  provenance: {
    source: "workflow-pattern";
    pattern_id: string;
    evidence_hash: string;
    tool_sequence: string[];
    example_goals: string[];
  };
};

export interface CrystallizationProposal {
  id: string;
  patternId: string;
  /** Stable hash of the non-metric evidence used to generate this proposal. */
  evidenceHash: string;
  skillName: string;
  skillContent: string;
  status: CrystallizationStatus;
  /** JSON-encoded WorkflowPattern for reference */
  patternSnapshot: string;
  /** JSON-encoded proposal card (see issue #208/#??? proposal lifecycle). */
  proposalCardJson?: string;
  category?: string;
  description?: string;
  confidence?: number;
  recommendedOutput?: SkillProposalRecommendedOutput;
  /** Reason provided when rejecting */
  rejectionReason?: string;
  /** Path where the skill was written on approval */
  outputPath?: string;
  approvedAt?: string;
  installedAt?: string;
  supersededAt?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateProposalInput {
  patternId: string;
  evidenceHash: string;
  skillName: string;
  skillContent: string;
  patternSnapshot: string;
  proposalCardJson?: string;
  category?: string;
  description?: string;
  confidence?: number;
  recommendedOutput?: SkillProposalRecommendedOutput;
  /** Initial state (default: drafted). */
  status?: CrystallizationStatus;
  /** Optional rejection reason when creating already-rejected records (validator gate). */
  rejectionReason?: string;
}

interface ProposalFilter {
  status?: CrystallizationStatusFilter;
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
    super(db, { deferClose: true });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crystallization_proposals (
        id               TEXT PRIMARY KEY,
        pattern_id       TEXT NOT NULL,
        evidence_hash    TEXT,
        skill_name       TEXT NOT NULL,
        skill_content    TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        pattern_snapshot TEXT NOT NULL DEFAULT '{}',
        proposal_card_json TEXT,
        category         TEXT,
        description      TEXT,
        confidence       REAL,
        recommended_output TEXT,
        rejection_reason TEXT,
        output_path      TEXT,
        approved_at      TEXT,
        installed_at     TEXT,
        superseded_at    TEXT,
        superseded_by    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cp_status      ON crystallization_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_cp_pattern_id  ON crystallization_proposals(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_cp_skill_name  ON crystallization_proposals(skill_name);
      CREATE INDEX IF NOT EXISTS idx_cp_evidence_hash ON crystallization_proposals(evidence_hash);
    `);

    this.migrateSchema();
  }

  protected getSubsystemName(): string {
    return "crystallization-store";
  }

  private migrateSchema(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(crystallization_proposals)").all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);

    if (!has("evidence_hash")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN evidence_hash TEXT");
    }
    if (!has("proposal_card_json")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN proposal_card_json TEXT");
    }
    if (!has("category")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN category TEXT");
    }
    if (!has("description")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN description TEXT");
    }
    if (!has("confidence")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN confidence REAL");
    }
    if (!has("recommended_output")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN recommended_output TEXT");
    }
    if (!has("approved_at")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN approved_at TEXT");
    }
    if (!has("installed_at")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN installed_at TEXT");
    }
    if (!has("superseded_at")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN superseded_at TEXT");
    }
    if (!has("superseded_by")) {
      this.liveDb.exec("ALTER TABLE crystallization_proposals ADD COLUMN superseded_by TEXT");
    }

    // Status migration: legacy values → lifecycle.
    // - pending (generated + awaiting human) → validated (already passed SkillValidator historically)
    // - approved (written) → installed
    // - rejected stays rejected
    this.liveDb.exec(
      "UPDATE crystallization_proposals SET status = 'validated' WHERE status = 'pending' AND status IS NOT NULL",
    );
    this.liveDb.exec("UPDATE crystallization_proposals SET status = 'installed' WHERE status = 'approved'");

    // Backfill evidence_hash for legacy rows so regeneration guards can work.
    // Use pattern_id as a conservative stable fallback.
    this.liveDb.exec(
      "UPDATE crystallization_proposals SET evidence_hash = pattern_id WHERE (evidence_hash IS NULL OR evidence_hash = '') AND pattern_id IS NOT NULL",
    );
  }

  private expandStatusFilter(status?: CrystallizationStatusFilter): CrystallizationStatus[] | undefined {
    if (!status) return undefined;
    if (status === "pending") return ["drafted", "validated"];
    if (status === "approved") return ["approved", "installed"];
    return [status as CrystallizationStatus];
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  create(input: CreateProposalInput): CrystallizationProposal {
    return this.runWithDb("create", () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const status = input.status ?? "drafted";

      this.liveDb
        .prepare(
          `INSERT INTO crystallization_proposals
           (id, pattern_id, evidence_hash, skill_name, skill_content, status, pattern_snapshot, proposal_card_json, category, description, confidence, recommended_output, rejection_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.patternId,
          input.evidenceHash,
          input.skillName,
          input.skillContent,
          status,
          input.patternSnapshot,
          input.proposalCardJson ?? null,
          input.category ?? null,
          input.description ?? null,
          input.confidence ?? null,
          input.recommendedOutput ?? null,
          input.rejectionReason ?? null,
          now,
          now,
        );

      // biome-ignore lint/style/noNonNullAssertion: Known to exist
      return this.getByIdInternal(id)!;
    });
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  getById(id: string): CrystallizationProposal | null {
    return this.runWithDb("getById", () => this.getByIdInternal(id));
  }

  private getByIdInternal(id: string): CrystallizationProposal | null {
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
    return this.runWithDb("getByPatternId", () => {
      const row = this.liveDb
        .prepare("SELECT * FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(patternId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return this.rowToProposal(row);
    });
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  list(filter?: ProposalFilter): CrystallizationProposal[] {
    return this.runWithDb("list", () => {
      let query = "SELECT * FROM crystallization_proposals WHERE 1=1";
      const params: SQLInputValue[] = [];

      if (filter?.status) {
        const statuses = this.expandStatusFilter(filter.status);
        if (statuses && statuses.length > 0) {
          query += ` AND status IN (${statuses.map(() => "?").join(",")})`;
          params.push(...statuses);
        }
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
    });
  }

  // -------------------------------------------------------------------------
  // approve — transition drafted/validated → approved
  // -------------------------------------------------------------------------

  approve(
    id: string,
    opts?: {
      skillName?: string;
      skillContent?: string;
      category?: string;
      description?: string;
      recommendedOutput?: SkillProposalRecommendedOutput;
      proposalCardJson?: string;
    },
  ): CrystallizationProposal | null {
    return this.runWithDb("approve", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
         SET status = 'approved',
             skill_name = COALESCE(?, skill_name),
             skill_content = COALESCE(?, skill_content),
             category = COALESCE(?, category),
             description = COALESCE(?, description),
             recommended_output = COALESCE(?, recommended_output),
             proposal_card_json = COALESCE(?, proposal_card_json),
             approved_at = COALESCE(approved_at, ?),
             updated_at = ?
         WHERE id = ? AND status IN ('drafted', 'validated')`,
        )
        .run(
          opts?.skillName ?? null,
          opts?.skillContent ?? null,
          opts?.category ?? null,
          opts?.description ?? null,
          opts?.recommendedOutput ?? null,
          opts?.proposalCardJson ?? null,
          now,
          now,
          id,
        );

      if (result.changes === 0) return null;
      return this.getByIdInternal(id);
    });
  }

  // -------------------------------------------------------------------------
  // install — transition approved → installed + outputPath
  // -------------------------------------------------------------------------

  install(id: string, outputPath: string): CrystallizationProposal | null {
    return this.runWithDb("install", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
         SET status = 'installed', output_path = ?, installed_at = COALESCE(installed_at, ?), updated_at = ?
         WHERE id = ? AND status = 'approved'`,
        )
        .run(outputPath, now, now, id);

      if (result.changes === 0) return null;
      return this.getByIdInternal(id);
    });
  }

  // -------------------------------------------------------------------------
  // reject — transition drafted/validated/approved → rejected
  // -------------------------------------------------------------------------

  reject(id: string, reason?: string): CrystallizationProposal | null {
    return this.runWithDb("reject", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
         SET status = 'rejected', rejection_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('drafted', 'validated', 'approved')`,
        )
        .run(reason ?? null, now, id);

      if (result.changes === 0) return null;
      return this.getByIdInternal(id);
    });
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  count(status?: CrystallizationStatusFilter): number {
    return this.runWithDb("count", () => {
      if (status) {
        const statuses = this.expandStatusFilter(status);
        if (!statuses || statuses.length === 0) return 0;
        const row = this.liveDb
          .prepare(
            `SELECT COUNT(*) as n FROM crystallization_proposals WHERE status IN (${statuses.map(() => "?").join(",")})`,
          )
          .get(...statuses) as { n: number };
        return row.n;
      }
      const row = this.liveDb.prepare("SELECT COUNT(*) as n FROM crystallization_proposals").get() as { n: number };
      return row.n;
    });
  }

  // -------------------------------------------------------------------------
  // hasPendingOrApprovedForPattern — prevent duplicate proposals (compat alias)
  // -------------------------------------------------------------------------

  hasPendingOrApprovedForPattern(patternId: string): boolean {
    return this.runWithDb("hasPendingOrApprovedForPattern", () => {
      const row = this.liveDb
        .prepare(
          "SELECT COUNT(*) as n FROM crystallization_proposals WHERE pattern_id = ? AND status IN ('candidate','drafted','validated','approved')",
        )
        .get(patternId) as { n: number };
      return row.n > 0;
    });
  }

  /**
   * Rejection guard: returns true if the latest proposal for this pattern was rejected
   * with the same evidence hash (i.e., no meaningful new evidence since rejection).
   */
  isRejectedWithSameEvidence(patternId: string, evidenceHash: string): boolean {
    return this.runWithDb("isRejectedWithSameEvidence", () => {
      const row = this.liveDb
        .prepare(
          "SELECT status, evidence_hash FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(patternId) as { status?: string; evidence_hash?: string } | undefined;
      if (!row) return false;
      return row.status === "rejected" && (row.evidence_hash ?? "") === evidenceHash;
    });
  }

  supersede(id: string, supersededBy: string): CrystallizationProposal | null {
    return this.runWithDb("supersede", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
           SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('installed', 'approved')`,
        )
        .run(supersededBy, now, now, id);
      if (result.changes === 0) return null;
      return this.getByIdInternal(id);
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rowToProposal(row: Record<string, unknown>): CrystallizationProposal {
    return {
      id: row.id as string,
      patternId: row.pattern_id as string,
      evidenceHash: (row.evidence_hash as string | null | undefined) ?? (row.pattern_id as string),
      skillName: row.skill_name as string,
      skillContent: row.skill_content as string,
      status: row.status as string as CrystallizationStatus,
      patternSnapshot: row.pattern_snapshot as string,
      proposalCardJson: row.proposal_card_json ? (row.proposal_card_json as string) : undefined,
      category: row.category ? (row.category as string) : undefined,
      description: row.description ? (row.description as string) : undefined,
      confidence: row.confidence !== null && row.confidence !== undefined ? (row.confidence as number) : undefined,
      recommendedOutput: row.recommended_output
        ? (row.recommended_output as SkillProposalRecommendedOutput)
        : undefined,
      rejectionReason: row.rejection_reason ? (row.rejection_reason as string) : undefined,
      outputPath: row.output_path ? (row.output_path as string) : undefined,
      approvedAt: row.approved_at ? (row.approved_at as string) : undefined,
      installedAt: row.installed_at ? (row.installed_at as string) : undefined,
      supersededAt: row.superseded_at ? (row.superseded_at as string) : undefined,
      supersededBy: row.superseded_by ? (row.superseded_by as string) : undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
