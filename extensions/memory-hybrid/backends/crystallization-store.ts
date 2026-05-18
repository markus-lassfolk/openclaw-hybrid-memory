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

import type { SkillProposalValidationResult } from "../services/generated-skill-validation.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import { readSchemaVersion, runVersionedSchemaMigration } from "./sqlite-schema-meta.js";

/** Increment when adding a new idempotent migration step in `runSchemaMigrations`. */
export const CRYSTALLIZATION_STORE_SCHEMA_VERSION = 2;

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
  | "quarantined"
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
  /** Stored generated-skill validation / eval snapshot (optional). */
  validationResult?: SkillProposalValidationResult;
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
  validationResult?: SkillProposalValidationResult;
}

interface ProposalFilter {
  status?: CrystallizationStatusFilter;
  skillName?: string;
  limit?: number;
}

type ApproveWithinCapResult =
  | { kind: "approved"; proposal: CrystallizationProposal }
  | { kind: "limit-reached" }
  | { kind: "not-approvable" };

type CreateApprovedWithinCapResult =
  | { kind: "approved"; proposal: CrystallizationProposal }
  | { kind: "limit-reached" };

// ---------------------------------------------------------------------------
// CrystallizationStore
// ---------------------------------------------------------------------------

export class CrystallizationStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db, { deferClose: true });
    this.registerSqlFunctions();

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
        validation_result TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cp_status      ON crystallization_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_cp_pattern_id  ON crystallization_proposals(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_cp_skill_name  ON crystallization_proposals(skill_name);
    `);

    this.runSchemaMigrations();
  }

  protected getSubsystemName(): string {
    return "crystallization-store";
  }

  private registerSqlFunctions(): void {
    this.liveDb.function("normalizedCrystallizationTimestamp", { deterministic: true }, (primary, fallback) => {
      return normalizeCrystallizationTimestamp(primary) ?? normalizeCrystallizationTimestamp(fallback) ?? 0;
    });
  }

  private runSchemaMigrations(): void {
    const namespace = "crystallization";
    let v = readSchemaVersion(this.liveDb, namespace);
    while (v < CRYSTALLIZATION_STORE_SCHEMA_VERSION) {
      const next = v + 1;
      if (next === 1) {
        runVersionedSchemaMigration(this.liveDb, namespace, next, () => migrateCrystallizationSchemaV1(this.liveDb));
      } else if (next === 2) {
        runVersionedSchemaMigration(this.liveDb, namespace, next, () => migrateCrystallizationSchemaV2(this.liveDb));
      } else {
        throw new Error(`crystallization-store: unsupported schema migration target ${next}`);
      }
      v = next;
    }
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
      this.insertProposalInternal(id, input, input.status ?? "drafted", now);

      // biome-ignore lint/style/noNonNullAssertion: Known to exist
      return this.getByIdInternal(id)!;
    });
  }

  createApprovedWithinCap(input: CreateProposalInput, maxCrystallized: number): CreateApprovedWithinCapResult {
    return this.runWithDb("createApprovedWithinCap", () => {
      const tx = createTransaction(
        this.liveDb,
        (): CreateApprovedWithinCapResult => {
          const row = this.liveDb
            .prepare("SELECT COUNT(*) as n FROM crystallization_proposals WHERE status IN ('approved', 'installed')")
            .get() as { n: number };
          if (row.n >= maxCrystallized) {
            return { kind: "limit-reached" };
          }

          const id = randomUUID();
          const now = new Date().toISOString();
          this.insertProposalInternal(id, input, "approved", now, now);
          const proposal = this.getByIdInternal(id);
          if (!proposal) {
            throw new Error("Failed to read created crystallization proposal");
          }
          return { kind: "approved", proposal };
        },
        "IMMEDIATE",
      );
      return tx();
    });
  }

  private insertProposalInternal(
    id: string,
    input: CreateProposalInput,
    status: CrystallizationStatus,
    now: string,
    approvedAt?: string,
  ): void {
    this.liveDb
      .prepare(
        `INSERT INTO crystallization_proposals
           (id, pattern_id, evidence_hash, skill_name, skill_content, status, pattern_snapshot, proposal_card_json, category, description, confidence, recommended_output, rejection_reason, validation_result, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.validationResult ? JSON.stringify(input.validationResult) : null,
        approvedAt ?? null,
        now,
        now,
      );
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
        .prepare(
          "SELECT * FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
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

  /**
   * List proposals for a single `pattern_id` (newest `created_at` first).
   * Used when pattern-scoped scans must not be truncated by the global `list({ limit })` cap.
   */
  listByPatternId(patternId: string, limit = 10_000): CrystallizationProposal[] {
    return this.runWithDb("listByPatternId", () => {
      const cap = limit > 0 ? limit : 10_000;
      const rows = this.liveDb
        .prepare(
          "SELECT * FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(patternId, cap) as Record<string, unknown>[];
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

  approveWithinCap(
    id: string,
    maxCrystallized: number,
    opts?: {
      skillName?: string;
      skillContent?: string;
      category?: string;
      description?: string;
      recommendedOutput?: SkillProposalRecommendedOutput;
      proposalCardJson?: string;
    },
  ): ApproveWithinCapResult {
    return this.runWithDb("approveWithinCap", () => {
      const tx = createTransaction(
        this.liveDb,
        (): ApproveWithinCapResult => {
          const row = this.liveDb
            .prepare("SELECT COUNT(*) as n FROM crystallization_proposals WHERE status IN ('approved', 'installed')")
            .get() as { n: number };
          if (row.n >= maxCrystallized) {
            return { kind: "limit-reached" };
          }

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

          if (result.changes === 0) {
            return { kind: "not-approvable" };
          }
          const proposal = this.getByIdInternal(id);
          if (!proposal) {
            return { kind: "not-approvable" };
          }
          return { kind: "approved", proposal };
        },
        "IMMEDIATE",
      );
      return tx();
    });
  }

  saveValidationResult(id: string, validationResult: SkillProposalValidationResult): CrystallizationProposal | null {
    return this.runWithDb("saveValidationResult", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
         SET validation_result = ?, updated_at = ?
         WHERE id = ?`,
        )
        .run(JSON.stringify(validationResult), now, id);
      if (result.changes === 0) return null;
      return this.getByIdInternal(id);
    });
  }

  // -------------------------------------------------------------------------
  // install — transition approved → installed + outputPath
  // -------------------------------------------------------------------------

  install(id: string, outputPath: string): CrystallizationProposal | null {
    return this.runWithDb("install", () => {
      const tx = createTransaction(
        this.liveDb,
        (): CrystallizationProposal | null => {
          const proposal = this.liveDb
            .prepare("SELECT id, pattern_id, status FROM crystallization_proposals WHERE id = ?")
            .get(id) as { id: string; pattern_id: string; status: CrystallizationStatus } | undefined;
          if (!proposal || proposal.status !== "approved") {
            return null;
          }

          const now = new Date().toISOString();
          this.liveDb
            .prepare(
              `UPDATE crystallization_proposals
                  SET status = 'superseded',
                      superseded_by = ?,
                      superseded_at = COALESCE(superseded_at, ?),
                      updated_at = ?
                WHERE pattern_id = ? AND id <> ? AND status = 'installed'`,
            )
            .run(id, now, now, proposal.pattern_id, id);

          const result = this.liveDb
            .prepare(
              `UPDATE crystallization_proposals
                  SET status = 'installed', output_path = ?, installed_at = COALESCE(installed_at, ?), updated_at = ?
                WHERE id = ? AND status = 'approved'`,
            )
            .run(outputPath, now, now, id);
          if (result.changes === 0) return null;
          return this.getByIdInternal(id);
        },
        "IMMEDIATE",
      );
      return tx();
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

  /** Mark an installed proposal as quarantined (failed re-validation of on-disk SKILL.md). */
  quarantine(id: string, reason?: string): CrystallizationProposal | null {
    return this.runWithDb("quarantine", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
           SET status = 'quarantined', rejection_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'installed'`,
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
   * Rejection / quarantine guard: returns true if the latest proposal for this pattern was rejected
   * or quarantined with the same evidence hash (no meaningful new evidence since suppression).
   */
  isRejectedWithSameEvidence(patternId: string, evidenceHash: string): boolean {
    return this.runWithDb("isRejectedWithSameEvidence", () => {
      const row = this.liveDb
        .prepare(
          "SELECT status, evidence_hash FROM crystallization_proposals WHERE pattern_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(patternId) as { status?: string; evidence_hash?: string } | undefined;
      if (!row) return false;
      const stored = row.evidence_hash ?? "";
      const same = stored === evidenceHash;
      if (!same) return false;
      return row.status === "rejected" || row.status === "quarantined";
    });
  }

  supersede(id: string, supersededBy: string): CrystallizationProposal | null {
    return this.runWithDb("supersede", () => {
      const now = new Date().toISOString();
      const result = this.liveDb
        .prepare(
          `UPDATE crystallization_proposals
           SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('installed', 'approved', 'quarantined')`,
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
      validationResult: parseValidationResult(row.validation_result),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

function migrateCrystallizationSchemaV1(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(crystallization_proposals)").all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);

  if (!has("evidence_hash")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN evidence_hash TEXT");
  }
  if (!has("proposal_card_json")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN proposal_card_json TEXT");
  }
  if (!has("category")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN category TEXT");
  }
  if (!has("description")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN description TEXT");
  }
  if (!has("confidence")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN confidence REAL");
  }
  if (!has("recommended_output")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN recommended_output TEXT");
  }
  if (!has("approved_at")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN approved_at TEXT");
  }
  if (!has("installed_at")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN installed_at TEXT");
  }
  if (!has("superseded_at")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN superseded_at TEXT");
  }
  if (!has("superseded_by")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN superseded_by TEXT");
  }
  if (!has("validation_result")) {
    db.exec("ALTER TABLE crystallization_proposals ADD COLUMN validation_result TEXT");
  }

  db.exec("UPDATE crystallization_proposals SET status = 'validated' WHERE status = 'pending' AND status IS NOT NULL");
  db.exec(
    "UPDATE crystallization_proposals SET status = 'installed', installed_at = COALESCE(installed_at, datetime('now')) WHERE status = 'approved' AND output_path IS NOT NULL AND TRIM(output_path) <> ''",
  );

  db.exec(
    "UPDATE crystallization_proposals SET evidence_hash = pattern_id WHERE (evidence_hash IS NULL OR evidence_hash = '') AND pattern_id IS NOT NULL",
  );

  db.exec("CREATE INDEX IF NOT EXISTS idx_cp_evidence_hash ON crystallization_proposals(evidence_hash)");

  const duplicates = db
    .prepare(
      "SELECT pattern_id FROM crystallization_proposals WHERE status = 'installed' GROUP BY pattern_id HAVING COUNT(*) > 1",
    )
    .all() as Array<{ pattern_id: string }>;
  for (const row of duplicates) {
    const installedRows = db
      .prepare(
        `SELECT id
           FROM crystallization_proposals
          WHERE pattern_id = ? AND status = 'installed'
          ORDER BY normalizedCrystallizationTimestamp(installed_at, created_at) DESC,
                   normalizedCrystallizationTimestamp(updated_at, created_at) DESC,
                   normalizedCrystallizationTimestamp(created_at, NULL) DESC,
                   id DESC`,
      )
      .all(row.pattern_id) as Array<{ id: string }>;
    const keepId = installedRows[0]?.id;
    if (!keepId) continue;
    db.prepare(
      `UPDATE crystallization_proposals
          SET status = 'superseded',
              superseded_by = ?,
              superseded_at = COALESCE(superseded_at, datetime('now')),
              updated_at = datetime('now')
        WHERE pattern_id = ? AND status = 'installed' AND id <> ?`,
    ).run(keepId, row.pattern_id, keepId);
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_one_installed_per_pattern ON crystallization_proposals(pattern_id) WHERE status = 'installed'",
  );
}

function migrateCrystallizationSchemaV2(db: DatabaseSync): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_cp_created_at ON crystallization_proposals(created_at)");
}

function parseValidationResult(value: unknown): SkillProposalValidationResult | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value) as SkillProposalValidationResult;
  } catch {
    return undefined;
  }
}

function normalizeCrystallizationTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value / 1000 : value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
  }
  const parsed = Date.parse(trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}
