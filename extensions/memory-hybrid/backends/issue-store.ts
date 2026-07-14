/**
 * Issue Store — SQLite backend for issue lifecycle tracking (Issue #137).
 *
 * Tracks problems from detection through resolution with structured state
 * machine transitions.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { capturePluginError } from "../services/error-reporter.js";
import type { CreateIssueInput, Issue, IssueSeverity, IssueStatus } from "../types/issue-types.js";
import { ISSUE_TRANSITIONS } from "../types/issue-types.js";
import { nowIso, cutoffIsoDaysAgo } from "../utils/dates.js";
import { backfillIssueTextTimestamps } from "../utils/timestamp-migration.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

interface IssueRow {
  id: string;
  title: string;
  status: string;
  severity: string;
  symptoms: string;
  root_cause: string | null;
  fix: string | null;
  rollback: string | null;
  related_facts: string;
  detected_at: string;
  resolved_at: string | null;
  verified_at: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export class IssueStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        severity TEXT NOT NULL DEFAULT 'medium',
        symptoms TEXT NOT NULL DEFAULT '[]',
        root_cause TEXT,
        fix TEXT,
        rollback TEXT,
        related_facts TEXT DEFAULT '[]',
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        verified_at TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
    `);
    backfillIssueTextTimestamps(this.liveDb);
  }

  protected getSubsystemName(): string {
    return "issue-store";
  }

  create(input: CreateIssueInput): Issue {
    const id = randomUUID();
    const now = nowIso();

    this.liveDb
      .prepare(
        `INSERT INTO issues (id, title, status, severity, symptoms, related_facts, detected_at, tags, metadata, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, '[]', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.severity ?? "medium",
        JSON.stringify(input.symptoms),
        now,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );

    return this.get(id) as Issue;
  }

  get(id: string): Issue | null {
    const row = this.liveDb.prepare("SELECT * FROM issues WHERE id = ?").get(id) as unknown as IssueRow | undefined;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  update(id: string, patch: Partial<Omit<Issue, "id" | "createdAt">>, opts?: { expectedStatus?: IssueStatus }): Issue {
    const existing = this.get(id);
    if (!existing) throw new Error(`Issue not found: ${id}`);

    const now = nowIso();
    const sets: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [now];

    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.severity !== undefined) {
      sets.push("severity = ?");
      params.push(patch.severity);
    }
    if (patch.symptoms !== undefined) {
      sets.push("symptoms = ?");
      params.push(JSON.stringify(patch.symptoms));
    }
    if (patch.rootCause !== undefined) {
      sets.push("root_cause = ?");
      params.push(patch.rootCause);
    }
    if (patch.fix !== undefined) {
      sets.push("fix = ?");
      params.push(patch.fix);
    }
    if (patch.rollback !== undefined) {
      sets.push("rollback = ?");
      params.push(patch.rollback);
    }
    if (patch.relatedFacts !== undefined) {
      sets.push("related_facts = ?");
      params.push(JSON.stringify(patch.relatedFacts));
    }
    if (patch.resolvedAt !== undefined) {
      sets.push("resolved_at = ?");
      params.push(patch.resolvedAt);
    }
    if (patch.verifiedAt !== undefined) {
      sets.push("verified_at = ?");
      params.push(patch.verifiedAt);
    }
    if (patch.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(patch.metadata));
    }

    params.push(id);
    let sql = `UPDATE issues SET ${sets.join(", ")} WHERE id = ?`;
    // Compare-and-swap: transition() passes the status it read so the write only lands if
    // nothing else changed the status in between (cross-process race — this class's SQLite
    // calls are synchronous, so no other in-process caller can interleave). A concurrent writer
    // that already changed the status makes this UPDATE affect zero rows instead of silently
    // overwriting the other writer's transition.
    if (opts?.expectedStatus !== undefined) {
      sql += " AND status = ?";
      params.push(opts.expectedStatus);
    }
    const result = this.liveDb.prepare(sql).run(...params);
    if (opts?.expectedStatus !== undefined && result.changes === 0) {
      throw new Error(
        `Issue ${id} was modified concurrently (expected status "${opts.expectedStatus}"); refetch and retry.`,
      );
    }

    return this.get(id) as Issue;
  }

  transition(id: string, newStatus: IssueStatus, data?: Partial<Issue>): Issue {
    const existing = this.get(id);
    if (!existing) throw new Error(`Issue not found: ${id}`);

    const allowed = ISSUE_TRANSITIONS[existing.status as keyof typeof ISSUE_TRANSITIONS];
    if (!allowed) {
      throw new Error(`Unknown issue status in database: "${existing.status}". Cannot transition to "${newStatus}".`);
    }
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${existing.status} → ${newStatus}. Allowed: ${allowed.join(", ") || "none"}`,
      );
    }

    const now = nowIso();
    const patch: Partial<Issue> = { ...data, status: newStatus };

    if (newStatus === "resolved" && !patch.resolvedAt) {
      patch.resolvedAt = now;
    }
    if (newStatus === "verified" && !patch.verifiedAt) {
      patch.verifiedAt = now;
    }

    return this.update(id, patch, { expectedStatus: existing.status });
  }

  list(filter?: { status?: IssueStatus[]; severity?: string[]; tags?: string[]; limit?: number }): Issue[] {
    let query = "SELECT * FROM issues WHERE 1=1";
    const params: SQLInputValue[] = [];

    if (filter?.status && filter.status.length > 0) {
      query += ` AND status IN (${filter.status.map(() => "?").join(", ")})`;
      params.push(...filter.status);
    }
    if (filter?.severity && filter.severity.length > 0) {
      query += ` AND severity IN (${filter.severity.map(() => "?").join(", ")})`;
      params.push(...filter.severity);
    }

    if (filter?.tags && filter.tags.length > 0) {
      const lower = filter.tags.map((t) => t.toLowerCase());
      query += ` AND EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(tags) THEN tags ELSE '[]' END
        ) j
        WHERE lower(j.value) IN (${lower.map(() => "?").join(", ")})
      )`;
      params.push(...lower);
    }

    // When the caller already narrowed to specific severities, rank the most severe first
    // before applying LIMIT — otherwise a burst of newer lower-in-range issues (e.g. "high")
    // can push an older, more severe one (e.g. "critical") out of a capped result entirely.
    query +=
      filter?.severity && filter.severity.length > 0
        ? " ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END DESC, created_at DESC"
        : " ORDER BY created_at DESC";
    if (filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.liveDb.prepare(query).all(...params) as unknown as IssueRow[];
    return rows.map((r) => this.rowToIssue(r));
  }

  search(query: string): Issue[] {
    const term = `%${query}%`;
    const rows = this.liveDb
      .prepare("SELECT * FROM issues WHERE title LIKE ? OR symptoms LIKE ? ORDER BY created_at DESC LIMIT 50")
      .all(term, term) as unknown as IssueRow[];
    return rows.map((r) => this.rowToIssue(r));
  }

  linkFact(issueId: string, factId: string): void {
    // Read-modify-write the JSON related_facts column inside an IMMEDIATE transaction so two
    // concurrent linkFact() calls on the same issue can't both read the same array and overwrite
    // each other's addition (last write wins) — mirrors the same class of fix already applied to
    // facts-db/crud.ts's storeFact() and edict-store.ts's add().
    const linkAtomic = createTransaction(
      this.liveDb,
      () => {
        const issue = this.get(issueId);
        if (!issue) throw new Error(`Issue not found: ${issueId}`);

        const related = issue.relatedFacts;
        if (!related.includes(factId)) {
          related.push(factId);
          this.liveDb
            .prepare("UPDATE issues SET related_facts = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(related), nowIso(), issueId);
        }
      },
      "IMMEDIATE",
    );
    linkAtomic();
  }

  archive(olderThanDays: number): number {
    const cutoff = cutoffIsoDaysAgo(olderThanDays);
    const result = this.liveDb
      .prepare(`DELETE FROM issues WHERE status IN ('verified', 'wont-fix') AND updated_at < ?`)
      .run(cutoff);
    return Number(result.changes);
  }

  private rowToIssue(row: IssueRow): Issue {
    function parseJson<T>(value: string | null | undefined, fallback: T): T {
      if (!value) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "json-parse",
          subsystem: "issue-store",
          severity: "info",
        });
        return fallback;
      }
    }

    return {
      id: row.id,
      title: row.title,
      status: row.status as IssueStatus,
      severity: row.severity as IssueSeverity,
      symptoms: parseJson<string[]>(row.symptoms, []),
      rootCause: row.root_cause ?? undefined,
      fix: row.fix ?? undefined,
      rollback: row.rollback ?? undefined,
      relatedFacts: parseJson<string[]>(row.related_facts, []),
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at ?? undefined,
      verifiedAt: row.verified_at ?? undefined,
      tags: parseJson<string[]>(row.tags, []),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
