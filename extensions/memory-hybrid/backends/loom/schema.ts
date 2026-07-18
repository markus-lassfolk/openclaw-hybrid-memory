/** SQLite schema (v1) for the LoomStore (Epic #2150). One DB file, one table per Loom concept. */
import type { DatabaseSync } from "node:sqlite";

export function createLoomSchemaV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loom_evidence_capsules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claim TEXT NOT NULL,
      actor TEXT,
      session_id TEXT,
      evidence TEXT NOT NULL DEFAULT '[]',
      commands_run TEXT NOT NULL DEFAULT '[]',
      artifacts TEXT NOT NULL DEFAULT '[]',
      unverified_items TEXT NOT NULL DEFAULT '[]',
      risk_flags TEXT NOT NULL DEFAULT '[]',
      limits TEXT,
      redaction_status TEXT NOT NULL DEFAULT 'clean',
      redaction_count INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      linked_claim_ids TEXT NOT NULL DEFAULT '[]',
      linked_task_label TEXT,
      linked_goal_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loom_evidence_task ON loom_evidence_capsules(linked_task_label);
    CREATE INDEX IF NOT EXISTS idx_loom_evidence_goal ON loom_evidence_capsules(linked_goal_id);
    CREATE INDEX IF NOT EXISTS idx_loom_evidence_created ON loom_evidence_capsules(created_at);

    CREATE TABLE IF NOT EXISTS loom_claims (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      confidence REAL NOT NULL DEFAULT 0.5,
      why TEXT,
      source_fact_ids TEXT NOT NULL DEFAULT '[]',
      evidence_capsule_ids TEXT NOT NULL DEFAULT '[]',
      contradicts_claim_ids TEXT NOT NULL DEFAULT '[]',
      supersedes_claim_ids TEXT NOT NULL DEFAULT '[]',
      superseded_by_claim_id TEXT,
      invalidation_conditions TEXT NOT NULL DEFAULT '[]',
      live_check_required INTEGER NOT NULL DEFAULT 0,
      live_check_reason TEXT,
      suggested_checks TEXT NOT NULL DEFAULT '[]',
      operational_impact TEXT,
      created_at TEXT NOT NULL,
      last_verified_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loom_claims_entity ON loom_claims(entity);
    CREATE INDEX IF NOT EXISTS idx_loom_claims_status ON loom_claims(status);
    CREATE INDEX IF NOT EXISTS idx_loom_claims_scope ON loom_claims(scope);
    CREATE INDEX IF NOT EXISTS idx_loom_claims_live_check ON loom_claims(live_check_required);

    CREATE TABLE IF NOT EXISTS loom_live_check_events (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      satisfied_at TEXT NOT NULL,
      expires_at TEXT,
      evidence_capsule_id TEXT,
      note TEXT,
      satisfied_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loom_live_check_claim ON loom_live_check_events(claim_id);
    CREATE INDEX IF NOT EXISTS idx_loom_live_check_expires ON loom_live_check_events(expires_at);

    CREATE TABLE IF NOT EXISTS loom_open_loops (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      loop_type TEXT NOT NULL,
      scope TEXT,
      entity TEXT,
      repo TEXT,
      owner TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'open',
      next_action TEXT,
      closure_criteria TEXT,
      evidence_required INTEGER NOT NULL DEFAULT 0,
      linked_goal_ids TEXT NOT NULL DEFAULT '[]',
      linked_task_labels TEXT NOT NULL DEFAULT '[]',
      linked_claim_ids TEXT NOT NULL DEFAULT '[]',
      linked_evidence_capsule_ids TEXT NOT NULL DEFAULT '[]',
      resurface_at TEXT,
      urgency REAL NOT NULL DEFAULT 0.5,
      importance REAL NOT NULL DEFAULT 0.5,
      operator_load_risk REAL NOT NULL DEFAULT 0.3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT,
      close_evidence_capsule_id TEXT,
      superseded_by_loop_id TEXT,
      last_resurfaced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loom_loops_status ON loom_open_loops(status);
    CREATE INDEX IF NOT EXISTS idx_loom_loops_scope ON loom_open_loops(scope);
    CREATE INDEX IF NOT EXISTS idx_loom_loops_entity ON loom_open_loops(entity);
    CREATE INDEX IF NOT EXISTS idx_loom_loops_repo ON loom_open_loops(repo);
    CREATE INDEX IF NOT EXISTS idx_loom_loops_resurface ON loom_open_loops(resurface_at);

    CREATE TABLE IF NOT EXISTS loom_drift_findings (
      id TEXT PRIMARY KEY,
      drift_type TEXT NOT NULL,
      old_text TEXT NOT NULL,
      replacement_text TEXT,
      affected_ids TEXT NOT NULL DEFAULT '[]',
      severity TEXT NOT NULL DEFAULT 'medium',
      repairability TEXT NOT NULL DEFAULT 'human_review',
      suggested_repair TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      linked_claim_ids TEXT NOT NULL DEFAULT '[]',
      linked_evidence_capsule_ids TEXT NOT NULL DEFAULT '[]',
      snoozed_until TEXT,
      promoted_to TEXT,
      detected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dedup_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loom_drift_status ON loom_drift_findings(status);
    CREATE INDEX IF NOT EXISTS idx_loom_drift_type ON loom_drift_findings(drift_type);
    CREATE INDEX IF NOT EXISTS idx_loom_drift_dedup ON loom_drift_findings(dedup_hash);

    CREATE TABLE IF NOT EXISTS loom_attention_overrides (
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      snoozed_until TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (target_kind, target_id)
    );

    CREATE TABLE IF NOT EXISTS loom_lifecycle_audit (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      confirmed_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loom_lifecycle_target ON loom_lifecycle_audit(target_kind, target_id);

    CREATE TABLE IF NOT EXISTS loom_procedure_triage_decisions (
      cluster_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      rationale TEXT,
      decided_by TEXT,
      decided_at TEXT NOT NULL
    );
  `);
}
