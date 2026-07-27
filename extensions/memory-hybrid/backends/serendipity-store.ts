/**
 * Serendipity Store — SQLite backend for the Serendipity Protocol (Issue #2119).
 *
 * Persists structured proactive findings (with a status state-machine + TTL
 * backlog) and scoped engagement levels. Cloned from the IssueStore pattern.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../services/error-reporter.js";
import type {
  CreateSerendipityFindingInput,
  ListActionableDeferredOptions,
  ListFindingsFilter,
  SerendipityAdjacency,
  SerendipityFinding,
  SerendipityFindingType,
  SerendipityLinkKind,
  SerendipityLoadReduction,
  SerendipityPref,
  SerendipityReversibility,
  SerendipityRiskLevel,
  SerendipityScope,
  SerendipityScopeContext,
  SerendipityStatus,
  SerendipitySuggestedAction,
} from "../types/serendipity-types.js";
import {
  SERENDIPITY_ACTIONABLE_ACTIONS,
  SERENDIPITY_BACKLOG_STATUSES,
  SERENDIPITY_TRANSITIONS,
} from "../types/serendipity-types.js";
import { toArrayFilter } from "../utils/array-filter.js";
import { addDaysUtcIso, cutoffIsoDaysAgo, nowIso } from "../utils/dates.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { normalizedHash } from "../utils/tags.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import { readSchemaVersion, runVersionedSchemaMigration } from "./sqlite-schema-meta.js";

const SERENDIPITY_STORE_SCHEMA_VERSION = 2;

/** Statuses that mean a finding has graduated out of the pure-noticing inbox (#2149 Loom alignment). */
const PROMOTED_STATUSES: ReadonlySet<SerendipityStatus> = new Set(["fixed", "filed", "proposed"]);

/** Finding types treated as "safety" — surfaced even at level < 1. */
const SAFETY_FINDING_TYPES: ReadonlySet<SerendipityFindingType> = new Set([
  "unsafe_default",
  "missing_validation",
  "packaging_defect",
]);

interface FindingRow {
  id: string;
  title: string;
  description: string;
  finding_type: string;
  suggested_action: string;
  status: string;
  risk_level: string;
  reversibility: string;
  adjacency: string;
  load_reduction: string;
  confidence: number;
  source_task: string | null;
  source_session: string | null;
  repo: string | null;
  entity: string | null;
  evidence: string;
  related_facts: string;
  related_issues: string;
  related_procedures: string;
  related_skills: string;
  external: number;
  destructive: number;
  privacy_sensitive: number;
  action_taken: string | null;
  metadata: string;
  dedup_hash: string | null;
  expires_at: string | null;
  last_surfaced_at: string | null;
  created_at: string;
  updated_at: string;
  related_claims: string;
  related_loops: string;
  related_drift_findings: string;
  leverage: number;
  risk_reduction: number;
  time_saved: number;
  cognitive_load_reduction: number;
  not_an_active_task: number;
}

interface PrefRow {
  scope: string;
  scope_target: string;
  level: number;
  enabled: number;
  updated_at: string;
}

const RISK_WEIGHT: Record<SerendipityRiskLevel, number> = { low: 1, medium: 2, high: 3 };
const LOAD_WEIGHT: Record<SerendipityLoadReduction, number> = { none: 0, small: 1, medium: 2, large: 3 };

/** Deferred-backlog ranking: urgency (risk) + leverage (load reduction) + confidence. */
export function scoreFinding(f: SerendipityFinding): number {
  return RISK_WEIGHT[f.riskLevel] + LOAD_WEIGHT[f.estimatedHumanLoadReduction] + f.confidence;
}

/** Stable dedup key for a finding (repo/entity/type/normalized-title). */
export function serendipityDedupHash(input: {
  repo?: string | null;
  entity?: string | null;
  findingType: string;
  title: string;
}): string {
  return normalizedHash([input.repo ?? "", input.entity ?? "", input.findingType, input.title].join(" "));
}

export class SerendipityStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.migrate();
  }

  protected getSubsystemName(): string {
    return "serendipity-store";
  }

  private migrate(): void {
    let v = readSchemaVersion(this.liveDb, "serendipity");
    while (v < SERENDIPITY_STORE_SCHEMA_VERSION) {
      const next = v + 1;
      if (next === 1) {
        runVersionedSchemaMigration(this.liveDb, "serendipity", next, () => this.migrateV1());
      } else if (next === 2) {
        runVersionedSchemaMigration(this.liveDb, "serendipity", next, () => this.migrateV2());
      }
      v = next;
    }
  }

  /** Loom alignment (#2149): links to claims/loops/drift findings + leverage-style scoring + notAnActiveTask. */
  private migrateV2(): void {
    this.liveDb.exec(`
      ALTER TABLE serendipity_findings ADD COLUMN related_claims TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE serendipity_findings ADD COLUMN related_loops TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE serendipity_findings ADD COLUMN related_drift_findings TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE serendipity_findings ADD COLUMN leverage REAL NOT NULL DEFAULT 0;
      ALTER TABLE serendipity_findings ADD COLUMN risk_reduction REAL NOT NULL DEFAULT 0;
      ALTER TABLE serendipity_findings ADD COLUMN time_saved REAL NOT NULL DEFAULT 0;
      ALTER TABLE serendipity_findings ADD COLUMN cognitive_load_reduction REAL NOT NULL DEFAULT 0;
      ALTER TABLE serendipity_findings ADD COLUMN not_an_active_task INTEGER NOT NULL DEFAULT 1;
    `);
    this.liveDb.exec(
      `UPDATE serendipity_findings SET not_an_active_task = 0 WHERE status IN ('fixed', 'filed', 'proposed')`,
    );
  }

  private migrateV1(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS serendipity_findings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        finding_type TEXT NOT NULL DEFAULT 'other',
        suggested_action TEXT NOT NULL DEFAULT 'remember',
        status TEXT NOT NULL DEFAULT 'observed',
        risk_level TEXT NOT NULL DEFAULT 'low',
        reversibility TEXT NOT NULL DEFAULT 'easy',
        adjacency TEXT NOT NULL DEFAULT 'near',
        load_reduction TEXT NOT NULL DEFAULT 'none',
        confidence REAL NOT NULL DEFAULT 0.5,
        source_task TEXT,
        source_session TEXT,
        repo TEXT,
        entity TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        related_facts TEXT NOT NULL DEFAULT '[]',
        related_issues TEXT NOT NULL DEFAULT '[]',
        related_procedures TEXT NOT NULL DEFAULT '[]',
        related_skills TEXT NOT NULL DEFAULT '[]',
        external INTEGER NOT NULL DEFAULT 0,
        destructive INTEGER NOT NULL DEFAULT 0,
        privacy_sensitive INTEGER NOT NULL DEFAULT 0,
        action_taken TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        dedup_hash TEXT,
        expires_at TEXT,
        last_surfaced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_serendipity_status ON serendipity_findings(status);
      CREATE INDEX IF NOT EXISTS idx_serendipity_type ON serendipity_findings(finding_type);
      CREATE INDEX IF NOT EXISTS idx_serendipity_risk ON serendipity_findings(risk_level);
      CREATE INDEX IF NOT EXISTS idx_serendipity_repo ON serendipity_findings(repo);
      CREATE INDEX IF NOT EXISTS idx_serendipity_dedup ON serendipity_findings(dedup_hash);
      CREATE INDEX IF NOT EXISTS idx_serendipity_expires ON serendipity_findings(expires_at);

      CREATE TABLE IF NOT EXISTS serendipity_prefs (
        scope TEXT NOT NULL,
        scope_target TEXT NOT NULL DEFAULT '',
        level REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_target)
      );
    `);
  }

  // --- Findings CRUD --------------------------------------------------------

  create(input: CreateSerendipityFindingInput, opts?: { defaultTtlDays?: number }): SerendipityFinding {
    const id = randomUUID();
    const now = nowIso();
    const dedupHash = serendipityDedupHash({
      repo: input.repo,
      entity: input.entity,
      findingType: input.findingType,
      title: input.title,
    });
    const ttlDays = input.ttlDays === undefined ? opts?.defaultTtlDays : input.ttlDays;
    const expiresAt = ttlDays == null || ttlDays <= 0 ? null : this.futureIso(ttlDays);

    this.liveDb
      .prepare(
        `INSERT INTO serendipity_findings (
           id, title, description, finding_type, suggested_action, status,
           risk_level, reversibility, adjacency, load_reduction, confidence,
           source_task, source_session, repo, entity,
           evidence, related_facts, related_issues, related_procedures, related_skills,
           related_claims, related_loops, related_drift_findings,
           leverage, risk_reduction, time_saved, cognitive_load_reduction, not_an_active_task,
           external, destructive, privacy_sensitive, action_taken, metadata,
           dedup_hash, expires_at, last_surfaced_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.description ?? "",
        input.findingType,
        input.suggestedAction ?? "remember",
        input.riskLevel ?? "low",
        input.reversibility ?? "easy",
        input.adjacency ?? "near",
        input.estimatedHumanLoadReduction ?? "none",
        clampConfidence(input.confidence),
        input.sourceTask ?? null,
        input.sourceSession ?? null,
        input.repo ?? null,
        input.entity ?? null,
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.relatedFacts ?? []),
        JSON.stringify(input.relatedIssues ?? []),
        JSON.stringify(input.relatedProcedures ?? []),
        JSON.stringify(input.relatedSkills ?? []),
        JSON.stringify(input.relatedClaims ?? []),
        JSON.stringify(input.relatedLoops ?? []),
        JSON.stringify(input.relatedDriftFindings ?? []),
        clampUnit(input.leverage),
        clampUnit(input.riskReduction),
        clampUnit(input.timeSaved),
        clampUnit(input.cognitiveLoadReduction),
        input.external ? 1 : 0,
        input.destructive ? 1 : 0,
        input.privacySensitive ? 1 : 0,
        JSON.stringify(input.metadata ?? {}),
        dedupHash,
        expiresAt,
        now,
        now,
      );

    return this.get(id) as SerendipityFinding;
  }

  get(id: string): SerendipityFinding | null {
    const row = this.liveDb.prepare("SELECT * FROM serendipity_findings WHERE id = ?").get(id) as unknown as
      | FindingRow
      | undefined;
    if (!row) return null;
    return this.rowToFinding(row);
  }

  /**
   * Resolve a short id-prefix or exact id to a single finding. Returns null when
   * nothing matches and throws only on an ambiguous prefix.
   */
  resolve(idOrPrefix: string): SerendipityFinding | null {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const rows = this.liveDb
      .prepare("SELECT * FROM serendipity_findings WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2")
      .all(`${idOrPrefix}%`) as unknown as FindingRow[];
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error(`Ambiguous finding id prefix "${idOrPrefix}" — provide more characters.`);
    return this.rowToFinding(rows[0] as FindingRow);
  }

  update(id: string, patch: Partial<Omit<SerendipityFinding, "id" | "createdAt">>): SerendipityFinding {
    const existing = this.get(id);
    if (!existing) throw new Error(`Finding not found: ${id}`);

    const now = nowIso();
    const sets: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [now];

    const setCol = (col: string, val: SQLInputValue) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.title !== undefined) setCol("title", patch.title);
    if (patch.description !== undefined) setCol("description", patch.description);
    if (patch.findingType !== undefined) setCol("finding_type", patch.findingType);
    if (patch.suggestedAction !== undefined) setCol("suggested_action", patch.suggestedAction);
    if (patch.status !== undefined) setCol("status", patch.status);
    if (patch.riskLevel !== undefined) setCol("risk_level", patch.riskLevel);
    if (patch.reversibility !== undefined) setCol("reversibility", patch.reversibility);
    if (patch.adjacency !== undefined) setCol("adjacency", patch.adjacency);
    if (patch.estimatedHumanLoadReduction !== undefined) setCol("load_reduction", patch.estimatedHumanLoadReduction);
    if (patch.confidence !== undefined) setCol("confidence", clampConfidence(patch.confidence));
    if (patch.sourceTask !== undefined) setCol("source_task", patch.sourceTask ?? null);
    if (patch.sourceSession !== undefined) setCol("source_session", patch.sourceSession ?? null);
    if (patch.repo !== undefined) setCol("repo", patch.repo ?? null);
    if (patch.entity !== undefined) setCol("entity", patch.entity ?? null);
    if (patch.evidence !== undefined) setCol("evidence", JSON.stringify(patch.evidence));
    if (patch.relatedFacts !== undefined) setCol("related_facts", JSON.stringify(patch.relatedFacts));
    if (patch.relatedIssues !== undefined) setCol("related_issues", JSON.stringify(patch.relatedIssues));
    if (patch.relatedProcedures !== undefined) setCol("related_procedures", JSON.stringify(patch.relatedProcedures));
    if (patch.relatedSkills !== undefined) setCol("related_skills", JSON.stringify(patch.relatedSkills));
    if (patch.relatedClaims !== undefined) setCol("related_claims", JSON.stringify(patch.relatedClaims));
    if (patch.relatedLoops !== undefined) setCol("related_loops", JSON.stringify(patch.relatedLoops));
    if (patch.relatedDriftFindings !== undefined)
      setCol("related_drift_findings", JSON.stringify(patch.relatedDriftFindings));
    if (patch.leverage !== undefined) setCol("leverage", clampUnit(patch.leverage));
    if (patch.riskReduction !== undefined) setCol("risk_reduction", clampUnit(patch.riskReduction));
    if (patch.timeSaved !== undefined) setCol("time_saved", clampUnit(patch.timeSaved));
    if (patch.cognitiveLoadReduction !== undefined)
      setCol("cognitive_load_reduction", clampUnit(patch.cognitiveLoadReduction));
    if (patch.notAnActiveTask !== undefined) setCol("not_an_active_task", patch.notAnActiveTask ? 1 : 0);
    if (patch.external !== undefined) setCol("external", patch.external ? 1 : 0);
    if (patch.destructive !== undefined) setCol("destructive", patch.destructive ? 1 : 0);
    if (patch.privacySensitive !== undefined) setCol("privacy_sensitive", patch.privacySensitive ? 1 : 0);
    if (patch.actionTaken !== undefined) setCol("action_taken", patch.actionTaken ?? null);
    if (patch.metadata !== undefined) setCol("metadata", JSON.stringify(patch.metadata));
    if (patch.expiresAt !== undefined) setCol("expires_at", patch.expiresAt ?? null);
    if (patch.lastSurfacedAt !== undefined) setCol("last_surfaced_at", patch.lastSurfacedAt ?? null);

    params.push(id);
    this.liveDb.prepare(`UPDATE serendipity_findings SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id) as SerendipityFinding;
  }

  transition(id: string, newStatus: SerendipityStatus, data?: Partial<SerendipityFinding>): SerendipityFinding {
    const existing = this.get(id);
    if (!existing) throw new Error(`Finding not found: ${id}`);
    const allowed = SERENDIPITY_TRANSITIONS[existing.status];
    if (!allowed) {
      throw new Error(`Unknown finding status "${existing.status}". Cannot transition to "${newStatus}".`);
    }
    if (existing.status !== newStatus && !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${existing.status} → ${newStatus}. Allowed: ${allowed.join(", ") || "none"}`,
      );
    }
    // Loom alignment (#2149): a finding stops being "just noticing" once it graduates into real,
    // tracked work (fixed/filed/proposed) — not just "remembered" or "dismissed".
    const notAnActiveTask = data?.notAnActiveTask ?? !PROMOTED_STATUSES.has(newStatus);
    return this.update(id, { ...data, status: newStatus, notAnActiveTask });
  }

  list(filter?: ListFindingsFilter): SerendipityFinding[] {
    let query = "SELECT * FROM serendipity_findings WHERE 1=1";
    const params: SQLInputValue[] = [];
    // toArrayFilter guards against a bare scalar (e.g. a non-tool caller passing one of these
    // fields directly) the same way the tool layer does, so this store is safe on its own
    // (issue #2185).
    const status = toArrayFilter(filter?.status);
    if (status && status.length > 0) {
      query += ` AND status IN (${status.map(() => "?").join(", ")})`;
      params.push(...status);
    }
    const findingType = toArrayFilter(filter?.findingType);
    if (findingType && findingType.length > 0) {
      query += ` AND finding_type IN (${findingType.map(() => "?").join(", ")})`;
      params.push(...findingType);
    }
    const riskLevel = toArrayFilter(filter?.riskLevel);
    if (riskLevel && riskLevel.length > 0) {
      query += ` AND risk_level IN (${riskLevel.map(() => "?").join(", ")})`;
      params.push(...riskLevel);
    }
    const suggestedAction = toArrayFilter(filter?.suggestedAction);
    if (suggestedAction && suggestedAction.length > 0) {
      query += ` AND suggested_action IN (${suggestedAction.map(() => "?").join(", ")})`;
      params.push(...suggestedAction);
    }
    if (filter?.repo) {
      query += " AND repo = ?";
      params.push(filter.repo);
    }
    query += " ORDER BY created_at DESC";
    if (filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }
    const rows = this.liveDb.prepare(query).all(...params) as unknown as FindingRow[];
    return rows.map((r) => this.rowToFinding(r));
  }

  search(query: string): SerendipityFinding[] {
    const term = `%${query}%`;
    const rows = this.liveDb
      .prepare(
        "SELECT * FROM serendipity_findings WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT 50",
      )
      .all(term, term) as unknown as FindingRow[];
    return rows.map((r) => this.rowToFinding(r));
  }

  /**
   * Most recent backlog finding sharing this dedup key within `windowDays`.
   * Used by serendipity_record to avoid filing the same finding repeatedly.
   */
  findByDedupHash(dedupHash: string, windowDays: number): SerendipityFinding | null {
    const cutoff = windowDays > 0 ? cutoffIsoDaysAgo(windowDays) : "";
    const backlog = SERENDIPITY_BACKLOG_STATUSES;
    const params: SQLInputValue[] = [dedupHash, ...backlog];
    let query = `SELECT * FROM serendipity_findings WHERE dedup_hash = ? AND status IN (${backlog
      .map(() => "?")
      .join(", ")})`;
    if (cutoff) {
      query += " AND created_at >= ?";
      params.push(cutoff);
    }
    query += " ORDER BY created_at DESC LIMIT 1";
    const row = this.liveDb.prepare(query).get(...params) as unknown as FindingRow | undefined;
    return row ? this.rowToFinding(row) : null;
  }

  /** Ranked, level-gated, non-expired backlog for resurfacing / sweeps. */
  listActionableDeferred(opts: ListActionableDeferredOptions): SerendipityFinding[] {
    const now = nowIso();
    const backlog = SERENDIPITY_BACKLOG_STATUSES;
    const actionable = SERENDIPITY_ACTIONABLE_ACTIONS;
    const params: SQLInputValue[] = [...backlog, ...actionable];
    let query = `SELECT * FROM serendipity_findings
      WHERE status IN (${backlog.map(() => "?").join(", ")})
        AND suggested_action IN (${actionable.map(() => "?").join(", ")})
        AND (expires_at IS NULL OR expires_at > ?)`;
    params.push(now);
    if (opts.repo) {
      query += " AND repo = ?";
      params.push(opts.repo);
    }
    const rows = this.liveDb.prepare(query).all(...params) as unknown as FindingRow[];
    const findings = rows.map((r) => this.rowToFinding(r)).filter((f) => this.eligibleAtLevel(f, opts.level));
    findings.sort((a, b) => scoreFinding(b) - scoreFinding(a) || a.createdAt.localeCompare(b.createdAt));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : findings.length;
    return findings.slice(0, limit);
  }

  /** Whether a finding is eligible to be surfaced at the given engagement level. */
  private eligibleAtLevel(f: SerendipityFinding, level: number): boolean {
    if (level < 1) return SAFETY_FINDING_TYPES.has(f.findingType);
    if (level < 4) return f.adjacency !== "broad" && f.adjacency !== "unrelated";
    return true;
  }

  markSurfaced(id: string, at: string = nowIso()): void {
    this.liveDb.prepare("UPDATE serendipity_findings SET last_surfaced_at = ? WHERE id = ?").run(at, id);
  }

  /** Append evidence + bump confidence on an existing finding (dedup merge). */
  mergeEvidence(id: string, evidence: string[], confidenceBoost = 0.05): SerendipityFinding {
    const existing = this.get(id);
    if (!existing) throw new Error(`Finding not found: ${id}`);
    const merged = Array.from(new Set([...existing.evidence, ...evidence]));
    return this.update(id, {
      evidence: merged,
      confidence: clampConfidence(existing.confidence + confidenceBoost),
    });
  }

  linkRecord(id: string, kind: SerendipityLinkKind, refId: string): void {
    const column = LINK_COLUMN[kind];
    const linkAtomic = createTransaction(
      this.liveDb,
      () => {
        const finding = this.get(id);
        if (!finding) throw new Error(`Finding not found: ${id}`);
        const current = this.relatedByKind(finding, kind);
        if (!current.includes(refId)) {
          current.push(refId);
          this.liveDb
            .prepare(`UPDATE serendipity_findings SET ${column} = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(current), nowIso(), id);
        }
      },
      "IMMEDIATE",
    );
    linkAtomic();
  }

  /** Delete findings past their TTL. Returns the number removed. */
  archiveExpired(now: string = nowIso()): number {
    const result = this.liveDb
      .prepare("DELETE FROM serendipity_findings WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  /** Delete resolved (terminal) findings older than `olderThanDays`. */
  archive(olderThanDays: number): number {
    const cutoff = cutoffIsoDaysAgo(olderThanDays);
    const result = this.liveDb
      .prepare(
        "DELETE FROM serendipity_findings WHERE status IN ('fixed', 'dismissed', 'remembered') AND updated_at < ?",
      )
      .run(cutoff);
    return Number(result.changes);
  }

  // --- Scoped policy levels -------------------------------------------------

  setLevel(scope: SerendipityScope, scopeTarget: string | null, level: number, enabled = true): SerendipityPref {
    const target = scopeTarget ?? "";
    const now = nowIso();
    this.liveDb
      .prepare(
        `INSERT INTO serendipity_prefs (scope, scope_target, level, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_target) DO UPDATE SET level = excluded.level, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(scope, target, clampLevel(level), enabled ? 1 : 0, now);
    return this.getLevelPref(scope, target) as SerendipityPref;
  }

  getLevelPref(scope: SerendipityScope, scopeTarget: string | null): SerendipityPref | null {
    const target = scopeTarget ?? "";
    const row = this.liveDb
      .prepare("SELECT * FROM serendipity_prefs WHERE scope = ? AND scope_target = ?")
      .get(scope, target) as unknown as PrefRow | undefined;
    if (!row) return null;
    return {
      scope: row.scope as SerendipityScope,
      scopeTarget: row.scope_target === "" ? null : row.scope_target,
      level: row.level,
      enabled: row.enabled !== 0,
      updatedAt: row.updated_at,
    };
  }

  listLevelPrefs(): SerendipityPref[] {
    const rows = this.liveDb
      .prepare("SELECT * FROM serendipity_prefs ORDER BY scope, scope_target")
      .all() as unknown as PrefRow[];
    return rows.map((row) => ({
      scope: row.scope as SerendipityScope,
      scopeTarget: row.scope_target === "" ? null : row.scope_target,
      level: row.level,
      enabled: row.enabled !== 0,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Effective engagement level for the caller. Precedence (most specific first):
   * session > agent > user > channel > repo > global-pref > config default.
   * An explicitly disabled pref at the winning scope yields level 0 (off).
   */
  resolveLevel(ctx: SerendipityScopeContext, defaultLevel: number): number {
    const lookups: Array<[SerendipityScope, string | null | undefined]> = [
      ["session", ctx.sessionId],
      ["agent", ctx.agentId],
      ["user", ctx.userId],
      ["channel", ctx.channel],
      ["repo", ctx.repo],
    ];
    for (const [scope, target] of lookups) {
      if (!target) continue;
      const pref = this.getLevelPref(scope, target);
      if (pref) return pref.enabled ? pref.level : 0;
    }
    const globalPref = this.getLevelPref("global", null);
    if (globalPref) return globalPref.enabled ? globalPref.level : 0;
    return defaultLevel;
  }

  // --- helpers --------------------------------------------------------------

  private futureIso(days: number): string {
    return addDaysUtcIso(days);
  }

  private relatedByKind(f: SerendipityFinding, kind: SerendipityLinkKind): string[] {
    switch (kind) {
      case "fact":
        return [...f.relatedFacts];
      case "issue":
        return [...f.relatedIssues];
      case "procedure":
        return [...f.relatedProcedures];
      case "skill":
        return [...f.relatedSkills];
      case "claim":
        return [...f.relatedClaims];
      case "loop":
        return [...f.relatedLoops];
      case "drift_finding":
        return [...f.relatedDriftFindings];
    }
  }

  private rowToFinding(row: FindingRow): SerendipityFinding {
    const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
      if (!value) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse",
          subsystem: "serendipity-store",
          severity: "info",
        });
        return fallback;
      }
    };
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      findingType: row.finding_type as SerendipityFindingType,
      suggestedAction: row.suggested_action as SerendipitySuggestedAction,
      status: row.status as SerendipityStatus,
      riskLevel: row.risk_level as SerendipityRiskLevel,
      reversibility: row.reversibility as SerendipityReversibility,
      adjacency: row.adjacency as SerendipityAdjacency,
      estimatedHumanLoadReduction: row.load_reduction as SerendipityLoadReduction,
      confidence: row.confidence,
      sourceTask: row.source_task ?? undefined,
      sourceSession: row.source_session ?? undefined,
      repo: row.repo ?? undefined,
      entity: row.entity ?? undefined,
      evidence: parseJson<string[]>(row.evidence, []),
      relatedFacts: parseJson<string[]>(row.related_facts, []),
      relatedIssues: parseJson<string[]>(row.related_issues, []),
      relatedProcedures: parseJson<string[]>(row.related_procedures, []),
      relatedSkills: parseJson<string[]>(row.related_skills, []),
      relatedClaims: parseJson<string[]>(row.related_claims, []),
      relatedLoops: parseJson<string[]>(row.related_loops, []),
      relatedDriftFindings: parseJson<string[]>(row.related_drift_findings, []),
      leverage: row.leverage,
      riskReduction: row.risk_reduction,
      timeSaved: row.time_saved,
      cognitiveLoadReduction: row.cognitive_load_reduction,
      notAnActiveTask: row.not_an_active_task !== 0,
      external: row.external !== 0,
      destructive: row.destructive !== 0,
      privacySensitive: row.privacy_sensitive !== 0,
      actionTaken: row.action_taken ?? undefined,
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      expiresAt: row.expires_at ?? null,
      lastSurfacedAt: row.last_surfaced_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const LINK_COLUMN: Record<SerendipityLinkKind, string> = {
  fact: "related_facts",
  issue: "related_issues",
  procedure: "related_procedures",
  skill: "related_skills",
  claim: "related_claims",
  loop: "related_loops",
  drift_finding: "related_drift_findings",
};

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Clamp a 0-1 leverage/risk-reduction/time-saved/cognitive-load-reduction score, default 0 (#2149). */
function clampUnit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampLevel(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, value));
}
