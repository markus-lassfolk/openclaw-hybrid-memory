/**
 * Per-agent health snapshots (Issue #789) — local SQLite WAL.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import type { ForgeTaskItem } from "../types/dashboard-types.js";

export type AgentHealthOutcome = "success" | "partial" | "failed" | "idle";

export interface AgentHealthRecord {
  agentId: string;
  sessionId: string | null;
  lastSeen: number;
  lastTask: string;
  outcome: AgentHealthOutcome;
  latencyMs?: number;
  tokensUsed?: number;
  errorCount: number;
  anomalyScore: number;
  nextAgent: string[];
}

export type AgentHealthStatus = "healthy" | "unknown" | "stale" | "degraded" | "idle";

export interface AgentHealthView extends AgentHealthRecord {
  status: AgentHealthStatus;
  score: number;
}

const STALE_MS = 4 * 3600 * 1000;

export class AgentHealthStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_health (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT,
        last_seen_ms INTEGER NOT NULL,
        last_task TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failed','idle')),
        latency_ms INTEGER,
        tokens_used INTEGER,
        error_count INTEGER NOT NULL DEFAULT 0,
        anomaly_score REAL NOT NULL DEFAULT 0,
        next_agent_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  protected getSubsystemName(): string {
    return "agent-health-store";
  }

  upsert(input: AgentHealthRecord): void {
    const now = Date.now();
    const nextJson = JSON.stringify(input.nextAgent ?? []);
    this.liveDb
      .prepare(
        `INSERT INTO agent_health (agent_id, session_id, last_seen_ms, last_task, outcome, latency_ms, tokens_used, error_count, anomaly_score, next_agent_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_seen_ms = excluded.last_seen_ms,
           last_task = excluded.last_task,
           outcome = excluded.outcome,
           latency_ms = excluded.latency_ms,
           tokens_used = excluded.tokens_used,
           error_count = excluded.error_count,
           anomaly_score = excluded.anomaly_score,
           next_agent_json = excluded.next_agent_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        input.sessionId ?? null,
        input.lastSeen,
        input.lastTask,
        input.outcome,
        input.latencyMs ?? null,
        input.tokensUsed ?? null,
        input.errorCount,
        input.anomalyScore,
        nextJson,
        now,
      );
  }

  listAll(): AgentHealthRecord[] {
    const rows = this.liveDb
      .prepare(
        "SELECT agent_id, session_id, last_seen_ms, last_task, outcome, latency_ms, tokens_used, error_count, anomaly_score, next_agent_json FROM agent_health",
      )
      .all() as Array<{
      agent_id: string;
      session_id: string | null;
      last_seen_ms: number;
      last_task: string;
      outcome: string;
      latency_ms: number | null;
      tokens_used: number | null;
      error_count: number;
      anomaly_score: number;
      next_agent_json: string | null;
    }>;
    return rows.map((r) => ({
      agentId: r.agent_id,
      sessionId: r.session_id,
      lastSeen: r.last_seen_ms,
      lastTask: r.last_task,
      outcome: r.outcome as AgentHealthOutcome,
      latencyMs: r.latency_ms ?? undefined,
      tokensUsed: r.tokens_used ?? undefined,
      errorCount: r.error_count,
      anomalyScore: r.anomaly_score,
      nextAgent: r.next_agent_json ? (JSON.parse(r.next_agent_json) as string[]) : [],
    }));
  }

  get(agentId: string): AgentHealthRecord | null {
    const row = this.liveDb
      .prepare(
        "SELECT agent_id, session_id, last_seen_ms, last_task, outcome, latency_ms, tokens_used, error_count, anomaly_score, next_agent_json FROM agent_health WHERE agent_id = ?",
      )
      .get(agentId) as
      | {
          agent_id: string;
          session_id: string | null;
          last_seen_ms: number;
          last_task: string;
          outcome: string;
          latency_ms: number | null;
          tokens_used: number | null;
          error_count: number;
          anomaly_score: number;
          next_agent_json: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      sessionId: row.session_id,
      lastSeen: row.last_seen_ms,
      lastTask: row.last_task,
      outcome: row.outcome as AgentHealthOutcome,
      latencyMs: row.latency_ms ?? undefined,
      tokensUsed: row.tokens_used ?? undefined,
      errorCount: row.error_count,
      anomalyScore: row.anomaly_score,
      nextAgent: row.next_agent_json ? (JSON.parse(row.next_agent_json) as string[]) : [],
    };
  }

  prune(retentionDays = 30): number {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const r = this.liveDb.prepare("DELETE FROM agent_health WHERE updated_at < ?").run(cutoff);
    return Number(r.changes ?? 0);
  }
}

export function agentHealthDbPathForMemorySqlite(memorySqlitePath: string): string | null {
  if (!memorySqlitePath || memorySqlitePath === ":memory:") return null;
  return `${dirname(memorySqlitePath)}/agent-health.db`;
}

export const DEFAULT_AGENT_IDS = ["forge", "scholar", "hearth", "warden", "ralph", "builder", "reaver"] as const;

function mapForgeStatus(s?: string): AgentHealthOutcome {
  const x = (s ?? "").toLowerCase();
  if (x.includes("fail") || x.includes("error")) return "failed";
  if (x.includes("partial")) return "partial";
  if (x.includes("idle")) return "idle";
  return "success";
}

/**
 * Merge persisted health rows with live Forge agent JSON files for Mission Control / CLI.
 */
export function mergeAgentHealthDashboard(forge: ForgeTaskItem[], dbRows: AgentHealthRecord[]): AgentHealthView[] {
  const byId = new Map<string, AgentHealthRecord>();
  for (const r of dbRows) {
    byId.set(r.agentId.toLowerCase(), r);
  }
  for (const f of forge) {
    const id = (f.agent ?? "unknown").toLowerCase();
    const started = f.started_at ? Date.parse(f.started_at) : Date.now();
    const syn: AgentHealthRecord = {
      agentId: id,
      sessionId: null,
      lastSeen: Number.isFinite(started) ? started : Date.now(),
      lastTask: f.task ?? "",
      outcome: mapForgeStatus(f.status),
      errorCount: byId.get(id)?.errorCount ?? 0,
      anomalyScore: byId.get(id)?.anomalyScore ?? 0,
      nextAgent: byId.get(id)?.nextAgent ?? [],
    };
    const prev = byId.get(id);
    if (!prev || syn.lastSeen >= prev.lastSeen) {
      byId.set(id, {
        ...prev,
        ...syn,
        errorCount: prev?.errorCount ?? syn.errorCount,
        anomalyScore: prev?.anomalyScore ?? syn.anomalyScore,
        nextAgent: prev?.nextAgent?.length ? prev.nextAgent : syn.nextAgent,
      });
    }
  }
  const ids = new Set<string>([...DEFAULT_AGENT_IDS.map((a) => a.toLowerCase()), ...byId.keys()]);
  const out: AgentHealthView[] = [];
  for (const id of ids) {
    const raw =
      byId.get(id) ??
      ({
        agentId: id,
        sessionId: null,
        lastSeen: 0,
        lastTask: "",
        outcome: "idle",
        errorCount: 0,
        anomalyScore: 0,
        nextAgent: [],
      } satisfies AgentHealthRecord);
    out.push(computeHealthView(raw));
  }
  out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return out;
}

export function computeHealthView(r: AgentHealthRecord, nowMs: number = Date.now()): AgentHealthView {
  const age = nowMs - r.lastSeen;
  let status: AgentHealthStatus = "healthy";
  if (r.lastSeen <= 0 || !r.agentId) {
    status = "unknown";
  } else if (r.outcome === "idle") {
    status = "idle";
  } else if (r.outcome === "failed" || r.outcome === "partial") {
    status = "degraded";
  } else if (age > STALE_MS) {
    status = "stale";
  }
  const wasDegradedFromStale = status === "stale" && (r.errorCount >= 2 || r.anomalyScore >= 0.6);
  if (status !== "unknown" && (r.errorCount >= 2 || r.anomalyScore >= 0.6)) {
    status = "degraded";
  }

  let score = 75;
  if (status === "healthy") score = 88 + Math.min(12, Math.floor((1 - r.anomalyScore) * 12));
  if (status === "idle") score = 70;
  if (status === "stale") score = 45;
  if (status === "degraded") {
    const degradedScore = Math.max(20, 55 - Math.floor(r.anomalyScore * 40));
    score = wasDegradedFromStale ? Math.min(45, degradedScore) : degradedScore;
  }
  if (status === "unknown") score = 0;

  return { ...r, status, score };
}
