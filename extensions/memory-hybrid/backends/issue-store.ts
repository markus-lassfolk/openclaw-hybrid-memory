/**
 * Issue Store — SQLite backend for issue lifecycle tracking (Issue #137).
 *
 * Tracks problems from detection through resolution with structured state
 * machine transitions.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { Issue, CreateIssueInput, IssueStatus, IssueSeverity } from "../types/issue-types.js";
import { ISSUE_TRANSITIONS } from "../types/issue-types.js";

export type { Issue, CreateIssueInput, IssueStatus } from "../types/issue-types.js";

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

export class IssueStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    this.db.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
    `);
  }

  create(input: CreateIssueInput): Issue {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
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

    return this.get(id)!;
  }

  get(id: string): Issue | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as unknown as IssueRow | undefined;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  update(id: string, patch: Partial<Omit<Issue, "id" | "createdAt">>): Issue {
    const existing = this.get(id);
    if (!existing) throw new Error(`Issue not found: ${id}`);

    const now = new Date().toISOString();
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
    this.db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    return this.get(id)!;
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

    const now = new Date().toISOString();
    const patch: Partial<Issue> = { ...data, status: newStatus };

    if (newStatus === "resolved" && !patch.resolvedAt) {
      patch.resolvedAt = now;
    }
    if (newStatus === "verified" && !patch.verifiedAt) {
      patch.verifiedAt = now;
    }

    return this.update(id, patch);
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

    query += " ORDER BY created_at DESC";
    // When no tag filter, push LIMIT into SQL to avoid loading all rows
    const hasTagFilter = filter?.tags && filter.tags.length > 0;
    if (!hasTagFilter && filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.prepare(query).all(...params) as unknown as IssueRow[];
    let results = rows.map((r) => this.rowToIssue(r));

    // Tags filtering (JSON array — done in-memory for simplicity)
    if (filter?.tags && filter.tags.length > 0) {
      const filterTags = filter.tags.map((t) => t.toLowerCase());
      results = results.filter((issue) => filterTags.some((ft) => issue.tags.map((t) => t.toLowerCase()).includes(ft)));
    }

    // Apply limit after all filtering is complete
    if (filter?.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  search(query: string): Issue[] {
    const term = `%${query}%`;
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE title LIKE ? OR symptoms LIKE ? ORDER BY created_at DESC LIMIT 50`)
      .all(term, term) as unknown as IssueRow[];
    return rows.map((r) => this.rowToIssue(r));
  }

  linkFact(issueId: string, factId: string): void {
    const issue = this.get(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);

    const related = issue.relatedFacts;
    if (!related.includes(factId)) {
      related.push(factId);
      this.db
        .prepare("UPDATE issues SET related_facts = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(related), new Date().toISOString(), issueId);
    }
  }

  archive(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        subsystem: "issue-store",
        severity: "info",
      });
    }
  }

  isOpen(): boolean {
    return !this.closed;
  }
}
