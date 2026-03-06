/**
 * Workflow Store — SQLite backend for structured tool-sequence tracking (Issue #209).
 *
 * Records tool sequences per session so the agent can learn which workflows succeed
 * and surface patterns via the `memory_workflows` tool.
 *
 * Schema mirrors IssueStore conventions: snake_case columns, JSON blobs for arrays,
 * UUIDs for primary keys, ISO-8601 timestamps.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkflowTrace {
  id: string;
  goal: string;
  goalKeywords: string[];
  toolSequence: string[];
  argsHash: string;
  outcome: "success" | "failure" | "unknown";
  toolCount: number;
  durationMs: number;
  sessionId: string;
  createdAt: string;
}

export interface CreateWorkflowTraceInput {
  goal: string;
  goalKeywords?: string[];
  toolSequence: string[];
  /** Pre-computed SHA-256 of concatenated arg strings. If omitted, computed from toolSequence. */
  argsHash?: string;
  outcome?: "success" | "failure" | "unknown";
  durationMs?: number;
  sessionId?: string;
}

export interface WorkflowFilter {
  goal?: string;
  outcome?: "success" | "failure" | "unknown";
  minToolCount?: number;
  maxToolCount?: number;
  sessionId?: string;
  limit?: number;
}

export interface WorkflowPattern {
  toolSequence: string[];
  totalCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  exampleGoals: string[];
}

// ---------------------------------------------------------------------------
// Levenshtein sequence similarity helpers
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance between two string arrays (each element = one tool name).
 */
export function sequenceDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = edit distance between a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Normalised similarity: 1 = identical, 0 = completely different.
 */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - sequenceDistance(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Utility: extract keywords from a natural-language goal string
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "in", "on", "at", "of",
  "with", "by", "from", "is", "it", "this", "that", "me", "my", "i",
  "do", "use", "get", "set", "run", "show", "list", "please", "can", "you",
]);

export function extractGoalKeywords(goal: string): string[] {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 10); // cap at 10 keywords
}

// ---------------------------------------------------------------------------
// Utility: hash tool-sequence + args for deduplication fingerprint
// ---------------------------------------------------------------------------

export function hashToolSequence(toolSequence: string[]): string {
  return createHash("sha256").update(JSON.stringify(toolSequence)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// WorkflowStore
// ---------------------------------------------------------------------------

export class WorkflowStore {
  private db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_traces (
        id           TEXT PRIMARY KEY,
        goal         TEXT NOT NULL,
        goal_keywords TEXT NOT NULL DEFAULT '[]',
        tool_sequence TEXT NOT NULL DEFAULT '[]',
        args_hash    TEXT NOT NULL,
        outcome      TEXT NOT NULL DEFAULT 'unknown',
        tool_count   INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        session_id   TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wt_goal_keywords ON workflow_traces(goal_keywords);
      CREATE INDEX IF NOT EXISTS idx_wt_args_hash     ON workflow_traces(args_hash);
      CREATE INDEX IF NOT EXISTS idx_wt_outcome       ON workflow_traces(outcome);
      CREATE INDEX IF NOT EXISTS idx_wt_session_id    ON workflow_traces(session_id);
    `);
  }

  // -------------------------------------------------------------------------
  // record — insert a new workflow trace
  // -------------------------------------------------------------------------

  record(input: CreateWorkflowTraceInput): WorkflowTrace {
    const id = randomUUID();
    const now = new Date().toISOString();
    // Normalize explicit keywords the same way extractGoalKeywords does (lowercase, dedupe, filter)
    const keywords = input.goalKeywords
      ? [...new Set(input.goalKeywords.map(k => k.toLowerCase().trim()).filter(k => k.length > 0))]
      : extractGoalKeywords(input.goal);
    const argsHash = input.argsHash ?? hashToolSequence(input.toolSequence);
    const outcome = input.outcome ?? "unknown";
    const toolCount = input.toolSequence.length;
    const durationMs = Math.round(input.durationMs ?? 0);
    const sessionId = input.sessionId ?? "";

    this.db
      .prepare(
        `INSERT INTO workflow_traces
           (id, goal, goal_keywords, tool_sequence, args_hash, outcome, tool_count, duration_ms, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.goal,
        JSON.stringify(keywords),
        JSON.stringify(input.toolSequence),
        argsHash,
        outcome,
        toolCount,
        durationMs,
        sessionId,
        now,
      );

    return this.getById(id)!;
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  getById(id: string): WorkflowTrace | null {
    const row = this.db
      .prepare("SELECT * FROM workflow_traces WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTrace(row);
  }

  // -------------------------------------------------------------------------
  // list — filtered listing
  // -------------------------------------------------------------------------

  list(filter?: WorkflowFilter): WorkflowTrace[] {
    let query = "SELECT * FROM workflow_traces WHERE 1=1";
    const params: unknown[] = [];

    if (filter?.outcome) {
      query += " AND outcome = ?";
      params.push(filter.outcome);
    }
    if (filter?.sessionId) {
      query += " AND session_id = ?";
      params.push(filter.sessionId);
    }
    if (filter?.minToolCount !== undefined) {
      query += " AND tool_count >= ?";
      params.push(filter.minToolCount);
    }
    if (filter?.maxToolCount !== undefined) {
      query += " AND tool_count <= ?";
      params.push(filter.maxToolCount);
    }

    query += " ORDER BY created_at DESC";

    if (!filter?.goal && filter?.limit && filter.limit > 0) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    let results = rows.map((r) => this.rowToTrace(r));

    // Keyword filter (in-memory, JSON blob)
    if (filter?.goal) {
      const keywords = extractGoalKeywords(filter.goal);
      if (keywords.length > 0) {
        results = results.filter((t) =>
          keywords.some((kw) => t.goalKeywords.includes(kw)),
        );
      }
    }

    if (filter?.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // getByGoal — find traces whose keywords overlap with the given goal
  // -------------------------------------------------------------------------

  getByGoal(keywords: string[], limit = 20): WorkflowTrace[] {
    if (keywords.length === 0) return [];
    // Retrieve candidates via LIKE search on the JSON blob and filter in JS
    const candidates = this.db
      .prepare("SELECT * FROM workflow_traces ORDER BY created_at DESC LIMIT 500")
      .all() as Record<string, unknown>[];

    const kwSet = new Set(keywords.map((k) => k.toLowerCase()));
    const matched = candidates
      .map((r) => this.rowToTrace(r))
      .filter((t) => t.goalKeywords.some((k) => kwSet.has(k)));

    return matched.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // getSuccessRate — given a tool sequence, return success rate across traces
  // -------------------------------------------------------------------------

  getSuccessRate(toolSequence: string[], similarityThreshold = 0.8): number {
    const allRows = this.db
      .prepare("SELECT tool_sequence, outcome FROM workflow_traces")
      .all() as { tool_sequence: string; outcome: string }[];

    let total = 0;
    let successes = 0;

    for (const row of allRows) {
      let seq: string[];
      try {
        seq = JSON.parse(row.tool_sequence) as string[];
      } catch {
        continue;
      }
      if (sequenceSimilarity(toolSequence, seq) >= similarityThreshold) {
        total++;
        if (row.outcome === "success") successes++;
      }
    }

    return total === 0 ? 0 : successes / total;
  }

  // -------------------------------------------------------------------------
  // getPatterns — group similar sequences and compute aggregate stats
  // -------------------------------------------------------------------------

  getPatterns(options?: {
    minSuccessRate?: number;
    similarityThreshold?: number;
    limit?: number;
  }): WorkflowPattern[] {
    const threshold = options?.similarityThreshold ?? 0.8;
    const allRows = this.db
      .prepare("SELECT goal, tool_sequence, outcome, duration_ms FROM workflow_traces ORDER BY created_at DESC")
      .all() as { goal: string; tool_sequence: string; outcome: string; duration_ms: number }[];

    // Cluster by similarity
    const clusters: {
      representative: string[];
      goals: string[];
      outcomes: string[];
      durations: number[];
    }[] = [];

    for (const row of allRows) {
      let seq: string[];
      try {
        seq = JSON.parse(row.tool_sequence) as string[];
      } catch {
        continue;
      }

      // Find an existing cluster this sequence belongs to
      let found = false;
      for (const cluster of clusters) {
        if (sequenceSimilarity(seq, cluster.representative) >= threshold) {
          cluster.goals.push(row.goal);
          cluster.outcomes.push(row.outcome);
          cluster.durations.push(row.duration_ms);
          found = true;
          break;
        }
      }
      if (!found) {
        clusters.push({
          representative: seq,
          goals: [row.goal],
          outcomes: [row.outcome],
          durations: [row.duration_ms],
        });
      }
    }

    const patterns: WorkflowPattern[] = clusters.map((c) => {
      const totalCount = c.outcomes.length;
      const successCount = c.outcomes.filter((o) => o === "success").length;
      const failureCount = c.outcomes.filter((o) => o === "failure").length;
      const successRate = totalCount > 0 ? successCount / totalCount : 0;
      const avgDurationMs =
        c.durations.length > 0
          ? c.durations.reduce((a, b) => a + b, 0) / c.durations.length
          : 0;
      // Deduplicate example goals
      const uniqueGoals = [...new Set(c.goals)].slice(0, 3);

      return {
        toolSequence: c.representative,
        totalCount,
        successCount,
        failureCount,
        successRate,
        avgDurationMs: Math.round(avgDurationMs),
        exampleGoals: uniqueGoals,
      };
    });

    // Filter by min success rate
    const minRate = options?.minSuccessRate ?? 0;
    const filtered = patterns.filter((p) => p.successRate >= minRate);

    // Sort by total count desc
    filtered.sort((a, b) => b.totalCount - a.totalCount);

    const limit = options?.limit ?? 20;
    return filtered.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // prune — delete traces older than N days
  // -------------------------------------------------------------------------

  prune(olderThanDays: number): number {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM workflow_traces WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM workflow_traces")
      .get() as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // close / isOpen
  // -------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        subsystem: "workflow-store",
        severity: "info",
      });
    }
  }

  isOpen(): boolean {
    return !this.closed;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rowToTrace(row: Record<string, unknown>): WorkflowTrace {
    function parseJsonArray(value: unknown, fallback: string[]): string[] {
      if (!value) return fallback;
      try {
        const parsed = JSON.parse(value as string);
        return Array.isArray(parsed) ? (parsed as string[]) : fallback;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "workflow-store",
          operation: "parseJsonArray",
          severity: "info",
        });
        return fallback;
      }
    }

    return {
      id: row.id as string,
      goal: row.goal as string,
      goalKeywords: parseJsonArray(row.goal_keywords, []),
      toolSequence: parseJsonArray(row.tool_sequence, []),
      argsHash: row.args_hash as string,
      outcome: (row.outcome as string) as "success" | "failure" | "unknown",
      toolCount: row.tool_count as number,
      durationMs: row.duration_ms as number,
      sessionId: row.session_id as string,
      createdAt: row.created_at as string,
    };
  }
}
