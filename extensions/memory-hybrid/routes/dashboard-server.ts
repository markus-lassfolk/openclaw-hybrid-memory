/**
 * Mission Control Dashboard — Issue #309
 *
 * Serves a web dashboard via a small HTTP server registered as a plugin service.
 * Routes:
 *   GET /           — HTML dashboard (vanilla JS/CSS, no framework)
 *   GET /api/status — JSON data for all dashboard sections
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentHealthView, mergeAgentHealthDashboard } from "../backends/agent-health-store.js";
import type { AuditStore } from "../backends/audit-store.js";
import { type EventLogEntry, EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { VerificationStore } from "../services/verification-store.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { ProvenanceService } from "../services/provenance.js";
import { getDirSize, getFileSizeAsync, readJsonFile } from "../utils/fs.js";
import { isValidGhRepoArg } from "../utils/gh-repo-arg.js";
import { pluginLogger } from "../utils/logger.js";
import { execFile as execFileCb } from "../utils/process-runner.js";
import { collectGraphPayload, collectGraphRecallPayload, getGraphExplorerHtml } from "./dashboard-graph.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  /** Optional owner/repo for GitHub queries (e.g. "markus-lassfolk/openclaw-hybrid-memory") */
  gitRepo?: string;
  /** Optional CostTracker instance — delegates cost stats to the established abstraction. */
  costTracker?: import("../backends/cost-tracker.js").CostTracker | null;
  /** Optional logger for structured logging of server errors */
  logger?: { error?: (msg: string) => void };
  /** Cross-agent audit trail (Issue #790). */
  auditStore?: AuditStore | null;
  /** Per-agent health store (Issue #789). */
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
  /** Edict store for verified ground-truth facts. */
  edictStore?: EdictStore | null;
  /** Verification store for critical facts. */
  verificationStore?: VerificationStore | null;
  /** Issue store for tracked problems. */
  issueStore?: IssueStore | null;
  /** Workflow store for tool-sequence patterns. */
  workflowStore?: WorkflowStore | null;
  /** Narratives store for session summaries. */
  narrativesDb?: NarrativesDB | null;
  /** Provenance service for fact-to-source tracing. */
  provenanceService?: ProvenanceService | null;
  /** Episodic event log (Issue #1025). */
  eventLog?: EventLog | null;
}

interface MemoryStats {
  activeFacts: number;
  expiredFacts: number;
  vectorCount: number;
  sqliteSizeBytes: number;
  lanceSizeBytes: number;
  totalSizeBytes: number;
}

interface CronJobStatus {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  agentId: string;
  model?: string;
}

interface TaskQueueItem {
  issue?: number;
  title?: string;
  branch?: string;
  pid?: number;
  started?: string;
  status?: string;
  completed?: string;
  exit_code?: number;
  details?: string;
}

interface ForgeTaskItem {
  agent?: string;
  task: string;
  workdir?: string;
  pid?: number;
  started_at?: string;
  status?: string;
}

interface GitActivity {
  prs: Array<{
    number: number;
    title: string;
    state: string;
    url: string;
    createdAt: string;
  }>;
  issues: Array<{
    number: number;
    title: string;
    state: string;
    url: string;
    createdAt: string;
  }>;
  gitError?: string;
}

interface CostRow {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface CostStats {
  features: CostRow[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  days: number;
  enabled: boolean;
}

interface AgentHealthPayload {
  enabled: boolean;
  agents: AgentHealthView[];
  alerts: string[];
}

interface AuditSummaryPayload {
  enabled: boolean;
  total24h: number;
  byOutcome: { success: number; partial: number; failed: number };
  byAgent: Record<string, number>;
  recentFailures: Array<{
    timestamp: number;
    agentId: string;
    action: string;
    target: string | null;
    error: string | null;
  }>;
}

interface DashboardStatus {
  generatedAt: string;
  memory: MemoryStats;
  cronJobs: CronJobStatus[];
  taskQueue: {
    current: TaskQueueItem | null;
    history: TaskQueueItem[];
  };
  forge: ForgeTaskItem[];
  git: GitActivity;
  costs: CostStats;
  audit: AuditSummaryPayload;
  agentHealth: AgentHealthPayload;
}

// ---------------------------------------------------------------------------
// Memory Viewer types (Issue #1023)
// ---------------------------------------------------------------------------

interface MemoryViewerStats {
  totalFacts: number;
  totalExpired: number;
  totalSuperseded: number;
  totalVerified: number;
  totalEdicts: number;
  totalIssues: number;
  totalProcedures: number;
  totalEpisodes: number;
  totalLinks: number;
  vectorCount: number;
  byCategory: Record<string, number>;
  byTier: Record<string, number>;
  byDecayClass: Record<string, number>;
  bySource: Record<string, number>;
  entityCount: number;
}

interface MemoryViewerEpisode {
  id: string;
  event: string;
  outcome: string;
  timestamp: number;
  duration?: number;
  context?: string;
  agentId?: string;
  sessionId?: string;
  importance: number;
  tags: string[];
}

interface MemoryViewerFact {
  id: string;
  text: string;
  why?: string | null;
  category: string;
  importance: number;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  createdAt: number;
  decayClass: string;
  expiresAt: number | null;
  confidence: number;
  summary?: string | null;
  tags: string[];
  supersededAt?: number | null;
  supersededBy?: string | null;
  verified?: boolean;
  edict?: boolean;
  scope?: string;
  provenanceSession?: string | null;
  reinforcedCount?: number;
}

interface MemoryViewerEntity {
  entity: string;
  factCount: number;
  categories: string[];
  tags: string[];
  lastUpdated: number;
}

interface MemoryViewerEdict {
  id: string;
  text: string;
  source?: string | null;
  tags: string[];
  verifiedAt: number | null;
  expiresAt: string | null;
  ttl: string;
  createdAt: number;
}

interface MemoryViewerIssue {
  id: string;
  title: string;
  status: string;
  severity: string;
  symptoms: string[];
  rootCause?: string | null;
  fix?: string | null;
  tags: string[];
  detectedAt: string;
  resolvedAt?: string | null;
  verifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryViewerWorkflow {
  id: string;
  goal: string;
  toolSequence: string[];
  outcome: string;
  toolCount: number;
  durationMs: number;
  successRate: number;
  sessionId: string;
  createdAt: string;
}

/**
 * Session Timeline — per-session summary for observability (Issue #1025).
 * Shows what was captured, recalled, injected, and suppressed during sessions.
 */
interface SessionTimelineSummary {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  eventTypeCounts: Record<string, number>;
  totalEvents: number;
  unconsolidatedEvents: number;
  capturedFacts: number;
  injectedFacts: number;
  auditEvents: number;
  auditFailures: number;
  episodesRecorded: number;
  narrativesStored: number;
  workflowTraces: number;
}

interface TimelineSessions {
  sessions: SessionTimelineSummary[];
  allEventTypes: string[];
  totals: {
    totalSessions: number;
    totalEvents: number;
    totalCapturedFacts: number;
    totalInjectedFacts: number;
    totalAuditEvents: number;
    totalAuditFailures: number;
    totalEpisodes: number;
    totalNarratives: number;
    totalWorkflowTraces: number;
  };
}

interface SessionTimelineDetail {
  sessionId: string;
  events: Array<{
    id: string;
    timestamp: string;
    eventType: string;
    content: Record<string, unknown>;
    entities: string[] | null;
    consolidatedInto: string | null;
  }>;
  auditEvents: Array<{
    id: string;
    timestamp: number;
    agentId: string;
    action: string;
    target: string | null;
    outcome: string;
    durationMs: number | null;
    error: string | null;
  }>;
  episodes: Array<{
    id: string;
    event: string;
    outcome: string;
    timestamp: number;
    duration: number | null;
    context: string | null;
    importance: number;
    tags: string[];
  }>;
  narratives: Array<{
    id: string;
    tag: string;
    periodStart: number;
    periodEnd: number;
    narrativeText: string;
    createdAt: number;
  }>;
}

interface MemoryViewerNarrative {
  id: string;
  sessionId: string;
  periodStart: number;
  periodEnd: number;
  tag: string;
  narrativeText: string;
  createdAt: number;
}

interface MemoryViewerVerification {
  factId: string;
  canonicalText: string;
  verifiedAt: string;
  verifiedBy: string;
  nextVerification: string | null;
  version: number;
}

interface MemoryViewerProvenance {
  factId: string;
  text: string;
  confidence: number;
  provenanceSession?: string | null;
  sourceTurn?: number | null;
  edges: Array<{
    edgeType: string;
    sourceType: string;
    sourceId: string;
    sourceText?: string | null;
    createdAt: string;
  }>;
}

interface MemoryViewerLinks {
  from: string;
  to: string;
  type: string;
  strength: number;
}

// ---------------------------------------------------------------------------
// Data collection helpers
// ---------------------------------------------------------------------------

/** Cached LanceDB dir size keyed by resolved path to avoid repeated traversal on every poll */
const _lanceSizeCache = new Map<string, { size: number; ts: number }>();
const _lanceInFlight = new Map<string, Promise<number>>();
const LANCE_CACHE_TTL_MS = 300_000; // 5 minutes

async function collectMemoryStats(ctx: DashboardContext): Promise<MemoryStats> {
  const activeFacts = ctx.factsDb.count();
  const expiredFacts = ctx.factsDb.countExpired();
  let vectorCount = 0;
  try {
    vectorCount = await ctx.vectorDb.count();
  } catch {
    /* non-fatal */
  }
  const sqliteSize = await getFileSizeAsync(ctx.resolvedSqlitePath);
  const sqliteWalSize = await getFileSizeAsync(`${ctx.resolvedSqlitePath}-wal`);
  const sqliteShmSize = await getFileSizeAsync(`${ctx.resolvedSqlitePath}-shm`);
  const sqliteSizeBytes = sqliteSize + sqliteWalSize + sqliteShmSize;

  // Use cached LanceDB size to avoid blocking on large directory traversals
  const cachedEntry = _lanceSizeCache.get(ctx.resolvedLancePath);
  const now = Date.now();
  if (!cachedEntry || now - cachedEntry.ts > LANCE_CACHE_TTL_MS) {
    let inFlightPromise = _lanceInFlight.get(ctx.resolvedLancePath);
    if (!inFlightPromise) {
      inFlightPromise = getDirSize(ctx.resolvedLancePath).finally(() => {
        _lanceInFlight.delete(ctx.resolvedLancePath);
      });
      _lanceInFlight.set(ctx.resolvedLancePath, inFlightPromise);
    }
    const size = await inFlightPromise;
    _lanceSizeCache.set(ctx.resolvedLancePath, {
      size,
      ts: Date.now(),
    });
  }
  const lanceSizeBytes = _lanceSizeCache.get(ctx.resolvedLancePath)?.size ?? 0;

  return {
    activeFacts,
    expiredFacts,
    vectorCount,
    sqliteSizeBytes,
    lanceSizeBytes,
    totalSizeBytes: sqliteSizeBytes + lanceSizeBytes,
  };
}

async function collectCronJobs(): Promise<CronJobStatus[]> {
  const openclawDir = join(homedir(), ".openclaw");
  const cronStorePath = join(openclawDir, "cron", "jobs.json");
  if (!existsSync(cronStorePath)) return [];
  try {
    const store = await readJsonFile<{ jobs?: unknown[] }>(cronStorePath);
    if (!store || !Array.isArray(store.jobs)) return [];
    return store.jobs
      .filter((j): j is Record<string, unknown> => typeof j === "object" && j !== null)
      .map((job) => {
        const state = (typeof job.state === "object" && job.state !== null ? job.state : {}) as Record<string, unknown>;
        const schedule = job.schedule as Record<string, unknown> | undefined;
        const payload = job.payload as Record<string, unknown> | undefined;
        return {
          id: String(job.id ?? ""),
          name: String(job.name ?? ""),
          schedule: typeof schedule?.expr === "string" ? schedule.expr : "",
          enabled: job.enabled !== false,
          lastRunAt: typeof state.lastRunAtMs === "number" ? new Date(state.lastRunAtMs).toISOString() : null,
          nextRunAt: typeof state.nextRunAtMs === "number" ? new Date(state.nextRunAtMs).toISOString() : null,
          lastStatus:
            typeof state.lastStatus === "string"
              ? state.lastStatus
              : typeof state.lastRunStatus === "string"
                ? state.lastRunStatus
                : null,
          lastError: typeof state.lastError === "string" ? state.lastError : null,
          consecutiveErrors: typeof state.consecutiveErrors === "number" ? state.consecutiveErrors : 0,
          agentId: String(job.agentId ?? ""),
          model: typeof payload?.model === "string" ? payload.model : undefined,
        };
      });
  } catch {
    return [];
  }
}

async function collectTaskQueue(): Promise<{
  current: TaskQueueItem | null;
  history: TaskQueueItem[];
}> {
  const stateDir = join(homedir(), ".openclaw", "workspace", "state", "task-queue");
  const currentPath = join(stateDir, "current.json");
  const historyDir = join(stateDir, "history");

  const current = await readJsonFile<TaskQueueItem>(currentPath);

  let history: TaskQueueItem[] = [];
  if (existsSync(historyDir)) {
    try {
      const files = (await readdir(historyDir))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, 10);
      history = (await Promise.all(files.map((f) => readJsonFile<TaskQueueItem>(join(historyDir, f))))).filter(
        (item): item is TaskQueueItem => item !== null,
      );
    } catch {
      /* non-fatal */
    }
  }

  return { current, history };
}

export async function collectForgeState(): Promise<ForgeTaskItem[]> {
  const forgeDir = join(homedir(), ".openclaw", "workspace", "state", "forge");
  if (!existsSync(forgeDir)) return [];
  try {
    const files = (await readdir(forgeDir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 50);
    const withMtime = (
      await Promise.all(
        files.map(async (f) => {
          const fullPath = join(forgeDir, f);
          try {
            return { name: f, mtime: (await stat(fullPath)).mtimeMs };
          } catch {
            return null;
          }
        }),
      )
    ).filter((e): e is { name: string; mtime: number } => e !== null);
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return (
      await Promise.all(
        withMtime.slice(0, 20).map(async (e) => {
          const item = await readJsonFile<ForgeTaskItem>(join(forgeDir, e.name));
          if (item) {
            item.agent = e.name.replace(/\.json$/, "");
          }
          return item;
        }),
      )
    ).filter((item): item is ForgeTaskItem => item !== null);
  } catch {
    return [];
  }
}

async function collectGitActivity(repo?: string): Promise<GitActivity> {
  try {
    const safeRepo = repo && isValidGhRepoArg(repo) ? repo : undefined;
    const repoArgs = safeRepo ? ["--repo", safeRepo] : [];
    const [prResult, issueResult] = await Promise.all([
      execFile("gh", ["pr", "list", "--limit", "10", "--json", "number,title,state,url,createdAt", ...repoArgs], {
        timeout: 8000,
        encoding: "utf-8",
      }),
      execFile("gh", ["issue", "list", "--limit", "10", "--json", "number,title,state,url,createdAt", ...repoArgs], {
        timeout: 8000,
        encoding: "utf-8",
      }),
    ]);
    type GitItem = {
      number: number;
      title: string;
      state: string;
      url: string;
      createdAt: string;
    };
    const prJson = prResult.stdout.trim();
    const issueJson = issueResult.stdout.trim();
    return {
      prs: prJson ? (JSON.parse(prJson) as GitItem[]) : [],
      issues: issueJson ? (JSON.parse(issueJson) as GitItem[]) : [],
    };
  } catch (err) {
    return { prs: [], issues: [], gitError: String(err) };
  }
}

function collectCostStats(ctx: DashboardContext): CostStats {
  const days = 7;
  const empty: CostStats = {
    features: [],
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    days,
    enabled: false,
  };

  // Prefer the established CostTracker abstraction when available to avoid duplicating SQL.
  if (ctx.costTracker) {
    try {
      const report = ctx.costTracker.getReport({ days });
      return {
        features: report.features.slice(0, 20),
        totalCalls: report.total.calls,
        totalInputTokens: report.total.inputTokens,
        totalOutputTokens: report.total.outputTokens,
        totalEstimatedCostUsd: report.total.estimatedCostUsd,
        days,
        enabled: true,
      };
    } catch {
      return empty;
    }
  }

  // Fallback: query the DB directly (e.g. in tests where CostTracker is not injected).
  try {
    const db = ctx.factsDb.getRawDb();
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cost_log'").get() as
      | { name: string }
      | undefined;

    if (!tableExists) return empty;

    const rows = db
      .prepare(
        `SELECT feature,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
         FROM llm_cost_log
         WHERE timestamp >= ?
         GROUP BY feature
         ORDER BY estimatedCostUsd DESC`,
      )
      .all(cutoff) as Array<{
      feature: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }>;

    const allFeatures: CostRow[] = rows.map((r) => ({
      feature: r.feature,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      estimatedCostUsd: Number(r.estimatedCostUsd),
    }));

    return {
      features: allFeatures.slice(0, 20),
      totalCalls: allFeatures.reduce((s, r) => s + r.calls, 0),
      totalInputTokens: allFeatures.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: allFeatures.reduce((s, r) => s + r.outputTokens, 0),
      totalEstimatedCostUsd: allFeatures.reduce((s, r) => s + r.estimatedCostUsd, 0),
      days,
      enabled: true,
    };
  } catch {
    return empty;
  }
}

async function collectAgentHealth(ctx: DashboardContext, forgeState?: ForgeTaskItem[]): Promise<AgentHealthPayload> {
  if (!ctx.agentHealthStore) {
    return { enabled: false, agents: [], alerts: [] };
  }
  try {
    const forge = forgeState ?? (await collectForgeState());
    const db = ctx.agentHealthStore.listAll();
    const agents = mergeAgentHealthDashboard(forge, db);
    const alerts: string[] = [];
    for (const a of agents) {
      if (a.status === "stale") alerts.push(`${a.agentId}: no activity > 4h — check dispatch`);
      if (a.status === "degraded") alerts.push(`${a.agentId}: score ${a.score.toFixed(0)} (degraded)`);
    }
    return { enabled: true, agents, alerts };
  } catch {
    return { enabled: false, agents: [], alerts: [] };
  }
}

function collectAuditSummary(ctx: DashboardContext): AuditSummaryPayload {
  if (!ctx.auditStore) {
    return {
      enabled: false,
      total24h: 0,
      byOutcome: { success: 0, partial: 0, failed: 0 },
      byAgent: {},
      recentFailures: [],
    };
  }
  try {
    const s = ctx.auditStore.summary24h();
    const failed = ctx.auditStore.query({ sinceMs: Date.now() - 24 * 3600 * 1000, outcome: "failed", limit: 8 });
    return {
      enabled: true,
      total24h: s.total,
      byOutcome: s.byOutcome,
      byAgent: s.byAgent,
      recentFailures: failed.map((r) => ({
        timestamp: r.timestamp,
        agentId: r.agentId,
        action: r.action,
        target: r.target,
        error: r.error,
      })),
    };
  } catch {
    return {
      enabled: false,
      total24h: 0,
      byOutcome: { success: 0, partial: 0, failed: 0 },
      byAgent: {},
      recentFailures: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Memory Viewer collectors (Issue #1023)
// ---------------------------------------------------------------------------

/** Open a read-only handle to the facts DB for internal dashboard use. */
function openFactsDbReadonly(path: string): import("node:sqlite").DatabaseSync | null {
  try {
    const { DatabaseSync: DBSync } = require("node:sqlite");
    const db = new DBSync(path, { readOnly: true });
    return db;
  } catch {
    return null;
  }
}

/** Collect Memory Viewer overview stats. */
async function collectMemoryViewerStats(ctx: DashboardContext): Promise<MemoryViewerStats> {
  const factsDb = ctx.factsDb;
  const totalFacts = factsDb.count();
  const totalExpired = factsDb.countExpired();

  // Use a read-only connection to the facts DB for counts not exposed by the public API
  const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
  let totalSuperseded = 0;
  let totalVerified = 0;
  let totalEdicts = 0;
  let totalEpisodes = 0;
  if (roDb) {
    try {
      const sr = roDb.prepare("SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NOT NULL").get() as
        | { cnt: number }
        | undefined;
      totalSuperseded = sr?.cnt ?? 0;
    } catch {
      /* non-fatal */
    }
    try {
      const vr = roDb.prepare("SELECT COUNT(*) as cnt FROM verified_facts").get() as { cnt: number } | undefined;
      totalVerified = vr?.cnt ?? 0;
    } catch {
      /* non-fatal */
    }
    try {
      const er = roDb.prepare("SELECT COUNT(*) as cnt FROM edicts").get() as { cnt: number } | undefined;
      totalEdicts = er?.cnt ?? 0;
    } catch {
      /* non-fatal */
    }
    try {
      const ar = roDb.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number } | undefined;
      totalEpisodes = ar?.cnt ?? 0;
    } catch {
      /* non-fatal */
    }
    try {
      roDb.close();
    } catch {
      /* ignore */
    }
  }

  const totalIssues = (() => {
    try {
      if (!ctx.issueStore) return 0;
      return ctx.issueStore.list({}).length;
    } catch {
      return 0;
    }
  })();
  const totalProcedures = (() => {
    try {
      return factsDb.proceduresCount();
    } catch {
      return 0;
    }
  })();
  const totalLinks = (() => {
    try {
      return factsDb.linksCount();
    } catch {
      return 0;
    }
  })();
  let vectorCount = 0;
  try {
    vectorCount = await ctx.vectorDb.count();
  } catch {
    /* non-fatal */
  }

  return {
    totalFacts,
    totalExpired,
    totalSuperseded,
    totalVerified,
    totalEdicts,
    totalIssues,
    totalProcedures,
    totalEpisodes,
    totalLinks,
    vectorCount,
    byCategory: factsDb.statsBreakdownByCategory(),
    byTier: factsDb.statsBreakdownByTier(),
    byDecayClass: factsDb.statsBreakdownByDecayClass(),
    bySource: factsDb.statsBreakdownBySource(),
    entityCount: factsDb.entityCount(),
  };
}

/**
 * Collect a summary of session timelines (Issue #1025).
 * Joins across event_log, audit_log, episodes, narratives, and workflow_traces
 * to give a single coherent view of what happened in each recent session.
 */
function collectSessionTimeline(
  ctx: DashboardContext,
  opts: {
    days?: number;
    sessionLimit?: number;
  } = {},
): TimelineSessions {
  const days = Math.min(90, Math.max(1, opts.days ?? 30));
  const sessionLimit = Math.min(500, Math.max(1, opts.sessionLimit ?? 50));
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;

  const allEventTypes = new Set<string>();
  const summaries: SessionTimelineSummary[] = [];
  let totalCapturedFacts = 0;
  let totalInjectedFacts = 0;
  let totalAuditEvents = 0;
  let totalAuditFailures = 0;
  let totalEpisodes = 0;
  let totalNarratives = 0;
  let totalWorkflowTraces = 0;

  // Collect session IDs from event_log
  const eventLogSessions = new Map<
    string,
    {
      startedAt: string | null;
      endedAt: string | null;
      eventTypeCounts: Record<string, number>;
      totalEvents: number;
      unconsolidatedEvents: number;
      capturedFacts: number;
    }
  >();

  if (ctx.eventLog) {
    try {
      const aggregates = ctx.eventLog.getSessionAggregates(new Date(sinceMs).toISOString(), new Date().toISOString());
      for (const agg of aggregates) {
        let capturedFacts = 0;
        for (const [eventType, count] of Object.entries(agg.eventTypeCounts)) {
          allEventTypes.add(eventType);
          if (eventType === "fact_learned" || eventType === "decision_made" || eventType === "correction") {
            capturedFacts += count;
          }
        }
        eventLogSessions.set(agg.sessionId, {
          startedAt: agg.startedAt,
          endedAt: agg.endedAt,
          eventTypeCounts: agg.eventTypeCounts,
          totalEvents: agg.totalEvents,
          unconsolidatedEvents: agg.unconsolidatedEvents,
          capturedFacts,
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  // Collect audit counts per session
  const auditSessions = new Map<string, { events: number; failures: number }>();
  const injectedSessions = new Map<string, number>();
  if (ctx.auditStore) {
    try {
      const auditEvents = ctx.auditStore.query({ sinceMs, limit: 5000 });
      for (const ev of auditEvents) {
        if (!ev.sessionId) continue;
        let s = auditSessions.get(ev.sessionId);
        if (!s) {
          s = { events: 0, failures: 0 };
          auditSessions.set(ev.sessionId, s);
        }
        s.events++;
        if (ev.outcome === "failed") s.failures++;
        if (ev.action === "memory_recall" && ev.outcome === "success") {
          injectedSessions.set(ev.sessionId, (injectedSessions.get(ev.sessionId) ?? 0) + 1);
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  // Collect episodes per session (from facts DB directly)
  const episodeSessions = new Map<string, number>();
  try {
    const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
    if (roDb) {
      try {
        const sinceSec = Math.floor(sinceMs / 1000);
        const rows = roDb
          .prepare("SELECT session_id, COUNT(*) as cnt FROM episodes WHERE timestamp >= ? GROUP BY session_id")
          .all(sinceSec) as Array<{ session_id: string; cnt: number }>;
        for (const r of rows) {
          if (r.session_id) episodeSessions.set(r.session_id, Number(r.cnt));
        }
      } finally {
        try {
          roDb.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // Collect narratives per session
  const narrativeSessions = new Map<string, number>();
  if (ctx.narrativesDb) {
    try {
      const narratives = ctx.narrativesDb.listRecent(200, "all");
      for (const n of narratives) {
        const ms = n.createdAt * 1000;
        if (ms < sinceMs) continue;
        narrativeSessions.set(n.sessionId, (narrativeSessions.get(n.sessionId) ?? 0) + 1);
      }
    } catch {
      /* non-fatal */
    }
  }

  // Collect workflow traces per session
  const workflowSessions = new Map<string, number>();
  if (ctx.workflowStore) {
    try {
      const traces = ctx.workflowStore.list({ limit: 500 });
      for (const t of traces) {
        const createdMs = new Date(t.createdAt).getTime();
        if (createdMs < sinceMs) continue;
        workflowSessions.set(t.sessionId, (workflowSessions.get(t.sessionId) ?? 0) + 1);
      }
    } catch {
      /* non-fatal */
    }
  }

  // Merge all session IDs and build summaries
  const allSessions = new Set([
    ...eventLogSessions.keys(),
    ...auditSessions.keys(),
    ...episodeSessions.keys(),
    ...narrativeSessions.keys(),
    ...workflowSessions.keys(),
  ]);

  // Sort by most recent activity (prefer event log endedAt, fall back to sessionId hash order)
  const sorted = [...allSessions]
    .sort((a, b) => {
      const aEnded = eventLogSessions.get(a)?.endedAt ?? "";
      const bEnded = eventLogSessions.get(b)?.endedAt ?? "";
      return bEnded.localeCompare(aEnded) || a.localeCompare(b);
    })
    .slice(0, sessionLimit);

  for (const sessionId of sorted) {
    const ev = eventLogSessions.get(sessionId);
    const aud = auditSessions.get(sessionId);
    const eps = episodeSessions.get(sessionId) ?? 0;
    const nar = narrativeSessions.get(sessionId) ?? 0;
    const wf = workflowSessions.get(sessionId) ?? 0;
    const inj = injectedSessions.get(sessionId) ?? 0;

    const capturedFacts = ev?.capturedFacts ?? 0;

    const summary: SessionTimelineSummary = {
      sessionId,
      startedAt: ev?.startedAt ?? null,
      endedAt: ev?.endedAt ?? null,
      eventTypeCounts: ev?.eventTypeCounts ?? {},
      totalEvents: ev?.totalEvents ?? 0,
      unconsolidatedEvents: ev?.unconsolidatedEvents ?? 0,
      capturedFacts,
      injectedFacts: inj,
      auditEvents: aud?.events ?? 0,
      auditFailures: aud?.failures ?? 0,
      episodesRecorded: eps,
      narrativesStored: nar,
      workflowTraces: wf,
    };
    summaries.push(summary);

    totalCapturedFacts += capturedFacts;
    totalInjectedFacts += inj;
    totalAuditEvents += aud?.events ?? 0;
    totalAuditFailures += aud?.failures ?? 0;
    totalEpisodes += eps;
    totalNarratives += nar;
    totalWorkflowTraces += wf;
  }

  return {
    sessions: summaries,
    allEventTypes: [...allEventTypes].sort(),
    totals: {
      totalSessions: summaries.length,
      totalEvents: summaries.reduce((sum, s) => sum + s.totalEvents, 0),
      totalCapturedFacts,
      totalInjectedFacts,
      totalAuditEvents,
      totalAuditFailures,
      totalEpisodes,
      totalNarratives,
      totalWorkflowTraces,
    },
  };
}

/**
 * Collect detailed event + audit + episode + narrative data for one session (Issue #1025).
 */
function collectSessionTimelineDetail(ctx: DashboardContext, sessionId: string): SessionTimelineDetail | null {
  const events: SessionTimelineDetail["events"] = [];
  const auditEvents: SessionTimelineDetail["auditEvents"] = [];
  const episodes: SessionTimelineDetail["episodes"] = [];
  const narratives: SessionTimelineDetail["narratives"] = [];

  if (ctx.eventLog) {
    try {
      for (const ev of ctx.eventLog.getBySession(sessionId, 500)) {
        events.push({
          id: ev.id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          content: ev.content,
          entities: ev.entities ?? null,
          consolidatedInto: ev.consolidatedInto ?? null,
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  if (ctx.auditStore) {
    try {
      for (const ev of ctx.auditStore.query({ sessionId, limit: 500 })) {
        auditEvents.push({
          id: ev.id,
          timestamp: ev.timestamp,
          agentId: ev.agentId,
          action: ev.action,
          target: ev.target,
          outcome: ev.outcome,
          durationMs: ev.durationMs,
          error: ev.error,
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  try {
    const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
    if (roDb) {
      try {
        const sinceSec = Math.floor(Date.now() / 1000) - 90 * 24 * 3600; // wide window for detail view
        const rows = roDb
          .prepare("SELECT * FROM episodes WHERE session_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 200")
          .all(sessionId, sinceSec) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const tagsRaw = r.tags as string | null;
          episodes.push({
            id: r.id as string,
            event: r.event as string,
            outcome: r.outcome as string,
            timestamp: r.timestamp as number,
            duration: r.duration as number | null,
            context: r.context as string | null,
            importance: r.importance as number,
            tags: tagsRaw ? (JSON.parse(tagsRaw) as string[]) : [],
          });
        }
      } finally {
        try {
          roDb.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  if (ctx.narrativesDb) {
    try {
      for (const n of ctx.narrativesDb.listBySession(sessionId, 10, "all")) {
        narratives.push({
          id: n.id,
          tag: n.tag,
          periodStart: n.periodStart,
          periodEnd: n.periodEnd,
          narrativeText: n.narrativeText,
          createdAt: n.createdAt,
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  if (events.length === 0 && auditEvents.length === 0 && episodes.length === 0 && narratives.length === 0) {
    return null;
  }

  return { sessionId, events, auditEvents, episodes, narratives };
}

/** Collect recent episodes — reads from the episodes table within the facts DB. */
function collectMemoryViewerEpisodes(ctx: DashboardContext, limit = 50): MemoryViewerEpisode[] {
  try {
    const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
    if (!roDb) return [];
    try {
      const rows = roDb.prepare("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?").all(limit) as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => ({
        id: String(r.id ?? ""),
        event: String(r.event ?? ""),
        outcome: String(r.outcome ?? ""),
        timestamp: Number(r.timestamp ?? 0),
        duration: r.duration != null ? Number(r.duration) : undefined,
        context: r.context != null ? String(r.context) : undefined,
        agentId: r.agent_id != null ? String(r.agent_id) : undefined,
        sessionId: r.session_id != null ? String(r.session_id) : undefined,
        importance: Number(r.importance ?? 0.5),
        tags: (() => {
          try {
            return JSON.parse(String(r.tags ?? "[]"));
          } catch {
            return [];
          }
        })(),
      }));
    } finally {
      try {
        roDb.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return [];
  }
}

/** Collect recent narratives. */
function collectMemoryViewerNarratives(ctx: DashboardContext, limit = 20): MemoryViewerNarrative[] {
  try {
    if (!ctx.narrativesDb) return [];
    return ctx.narrativesDb.listRecent(limit, "all").map((n) => ({
      id: n.id,
      sessionId: n.sessionId,
      periodStart: n.periodStart,
      periodEnd: n.periodEnd,
      tag: n.tag,
      narrativeText: n.narrativeText,
      createdAt: n.createdAt,
    }));
  } catch {
    return [];
  }
}

/** Collect recent issues. */
function collectMemoryViewerIssues(ctx: DashboardContext): MemoryViewerIssue[] {
  try {
    if (!ctx.issueStore) return [];
    return ctx.issueStore.list({}).map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      severity: issue.severity,
      symptoms: issue.symptoms,
      rootCause: issue.rootCause,
      fix: issue.fix,
      tags: issue.tags,
      detectedAt: issue.detectedAt,
      resolvedAt: issue.resolvedAt,
      verifiedAt: issue.verifiedAt,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }));
  } catch {
    return [];
  }
}

/** Collect workflow patterns / recent traces. */
function collectMemoryViewerWorkflows(ctx: DashboardContext, limit = 100): MemoryViewerWorkflow[] {
  try {
    if (!ctx.workflowStore) return [];
    const traces = ctx.workflowStore.list({ limit });
    const patterns = ctx.workflowStore.getPatterns({ limit: 20 });
    const result: MemoryViewerWorkflow[] = traces.map((t) => ({
      id: t.id,
      goal: t.goal,
      toolSequence: t.toolSequence,
      outcome: t.outcome,
      toolCount: t.toolCount,
      durationMs: t.durationMs,
      successRate:
        patterns.find((p) => JSON.stringify(p.toolSequence) === JSON.stringify(t.toolSequence))?.successRate ?? 0,
      sessionId: t.sessionId,
      createdAt: t.createdAt,
    }));
    return result;
  } catch {
    return [];
  }
}

/** Collect recent edicts. */
function collectMemoryViewerEdicts(ctx: DashboardContext): MemoryViewerEdict[] {
  try {
    if (!ctx.edictStore) return [];
    return ctx.edictStore.list({}).map((e) => ({
      id: e.id,
      text: e.text,
      source: e.source,
      tags: e.tags,
      verifiedAt: e.verifiedAt,
      expiresAt: e.expiresAt,
      ttl: String(e.ttl),
      createdAt: e.createdAt,
    }));
  } catch {
    return [];
  }
}

/** Collect verified facts using the public listLatestVerified API. */
function collectMemoryViewerVerified(ctx: DashboardContext, limit = 100): MemoryViewerVerification[] {
  try {
    if (!ctx.verificationStore) return [];
    const verified = ctx.verificationStore.listLatestVerified();
    return verified.map((v) => ({
      factId: v.factId,
      canonicalText: v.canonicalText,
      verifiedAt: v.verifiedAt ?? "",
      verifiedBy: v.verifiedBy ?? "",
      nextVerification: v.nextVerification ?? null,
      version: v.version,
    }));
  } catch {
    return [];
  }
}

/** Collect top entities. */
function collectMemoryViewerEntities(ctx: DashboardContext, limit = 50): MemoryViewerEntity[] {
  try {
    const raw = ctx.factsDb.getRawDb();
    const rows = raw
      .prepare(
        `SELECT entity, COUNT(*) as cnt, GROUP_CONCAT(DISTINCT category) as cats, GROUP_CONCAT(DISTINCT tags) as tgs, MAX(created_at) as last_updated
         FROM facts WHERE entity IS NOT NULL AND entity != '' AND superseded_at IS NULL
         GROUP BY entity ORDER BY cnt DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let cats: string[] = [];
      try {
        cats = [...new Set(String(r.cats ?? "").split(","))];
      } catch {}
      let tgs: string[] = [];
      try {
        const allTags = String(r.tgs ?? "").split(",");
        tgs = [...new Set(allTags.filter(Boolean))];
      } catch {}
      return {
        entity: String(r.entity ?? ""),
        factCount: Number(r.cnt ?? 0),
        categories: cats,
        tags: tgs,
        lastUpdated: Number(r.last_updated ?? 0),
      };
    });
  } catch {
    return [];
  }
}

/** Collect provenance edges for a fact. */
function collectMemoryViewerProvenance(ctx: DashboardContext, factId: string): MemoryViewerProvenance | null {
  try {
    if (!ctx.provenanceService) return null;
    // Note: getProvenance accepts an optional factsDb param for fact text enrichment.
    // We pass the open FactsDB instance directly for this read-only access.
    const chain = ctx.provenanceService.getProvenance(factId);
    return {
      factId: chain.fact.id,
      text: chain.fact.text,
      confidence: chain.fact.confidence,
      provenanceSession: chain.source.sessionId,
      sourceTurn: chain.source.turn,
      edges: chain.edges.map((e) => ({
        edgeType: e.edgeType,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        sourceText: e.sourceText,
        createdAt: e.createdAt,
      })),
    };
  } catch {
    return null;
  }
}

/** Collect fact links from the memory_links table. */
function collectMemoryViewerLinks(ctx: DashboardContext, limit = 5000): MemoryViewerLinks[] {
  try {
    const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
    if (!roDb) return [];
    try {
      const rows = roDb.prepare("SELECT * FROM memory_links LIMIT ?").all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        from: String(r.source_fact_id ?? ""),
        to: String(r.target_fact_id ?? ""),
        type: String(r.link_type ?? ""),
        strength: Number(r.strength ?? 1),
      }));
    } finally {
      try {
        roDb.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return [];
  }
}

/** Perform a fact action (verify / forget) and return result. */
function performFactAction(
  ctx: DashboardContext,
  action: "verify" | "forget",
  factId: string,
  body: Record<string, unknown>,
): { ok: boolean; message: string } {
  try {
    const factsDb = ctx.factsDb;
    const fact = factsDb.getById(factId);
    if (!fact) return { ok: false, message: `Fact not found: ${factId}` };

    if (action === "verify") {
      if (!ctx.verificationStore) return { ok: false, message: "Verification store not available" };
      const verifiedBy = (body.verifiedBy as "agent" | "user" | "system") ?? "agent";
      ctx.verificationStore.verify(factId, fact.text, verifiedBy);
      return { ok: true, message: `Fact ${factId} verified as ${verifiedBy}` };
    } else {
      // forget: supersede with null to mark the fact as superseded (soft-delete).
      // superseded_at IS NOT NULL filters it out of all recall paths.
      try {
        const ok = factsDb.supersede(factId, null);
        if (!ok) return { ok: false, message: `Could not supersede fact ${factId}` };
      } catch (err) {
        return { ok: false, message: `Could not forget fact ${factId}: ${String(err)}` };
      }
      return { ok: true, message: `Fact ${factId} forgotten` };
    }
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

export async function collectStatus(ctx: DashboardContext): Promise<DashboardStatus> {
  const [memory, cronJobs, taskQueue, forge, git] = await Promise.all([
    collectMemoryStats(ctx),
    collectCronJobs(),
    collectTaskQueue(),
    collectForgeState(),
    collectGitActivity(ctx.gitRepo),
  ]);
  const agentHealth = await collectAgentHealth(ctx, forge);
  return {
    generatedAt: new Date().toISOString(),
    memory,
    cronJobs,
    taskQueue,
    forge,
    git,
    costs: collectCostStats(ctx),
    audit: collectAuditSummary(ctx),
    agentHealth,
  };
}

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mission Control</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e2e8f0;
    --muted: #8892a4;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --blue: #3b82f6;
    --purple: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 18px; font-weight: 700; letter-spacing: 0.05em; color: var(--blue); }
  #last-updated { font-size: 12px; color: var(--muted); }
  main { padding: 16px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-title { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
  .card-title .icon { font-size: 16px; }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--muted); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-green { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-yellow { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-red { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-blue { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge-muted { background: rgba(136,146,164,0.15); color: var(--muted); }
  .job-row { padding: 6px 0; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
  .job-row:last-child { border-bottom: none; }
  .job-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .job-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .task-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .task-row:last-child { border-bottom: none; }
  .task-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .pr-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .pr-row:last-child { border-bottom: none; }
  .pr-title { font-size: 13px; font-weight: 500; }
  .pr-title a { color: var(--text); text-decoration: none; }
  .pr-title a:hover { color: var(--blue); }
  .pr-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .cost-row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .cost-row:last-child { border-bottom: none; }
  .cost-feature { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cost-calls { font-size: 12px; color: var(--muted); }
  .cost-usd { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--green); }
  .empty { color: var(--muted); font-size: 13px; text-align: center; padding: 16px 0; }
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .agent-row:last-child { border-bottom: none; }
  .agent-avatar { font-size: 18px; flex-shrink: 0; }
  .agent-info { flex: 1; min-width: 0; }
  .agent-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-task { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section-full { grid-column: 1 / -1; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } main { padding: 8px; } }
</style>
</head>
<body>
<header>
  <h1>⚡ Mission Control</h1>
  <div style="display:flex;align-items:center;gap:14px">
    <a href="/graph" style="color:var(--muted);text-decoration:none;font-size:12px">Memory graph →</a>
    <span id="last-updated">Loading…</span>
  </div>
</header>
<main>
  <div class="grid" id="grid">
    <div class="card"><div class="empty">Loading…</div></div>
  </div>
</main>
<script>
const AGENT_AVATARS = { Forge: '⚒️', Scholar: '📚', Hearth: '🏠', Warden: '🛡️', Reaver: '🔧' };
const STATUS_BADGE = {
  running: '<span class="badge badge-green">running</span>',
  active: '<span class="badge badge-green">active</span>',
  idle: '<span class="badge badge-muted">idle</span>',
  done: '<span class="badge badge-blue">done</span>',
  completed: '<span class="badge badge-blue">done</span>',
  partial: '<span class="badge badge-yellow">partial</span>',
  failed: '<span class="badge badge-red">failed</span>',
  error: '<span class="badge badge-red">error</span>',
  success: '<span class="badge badge-green">ok</span>',
  ok: '<span class="badge badge-green">ok</span>',
};

function badge(status) {
  const s = String(status ?? '').toLowerCase();
  return Object.hasOwn(STATUS_BADGE, s) ? STATUS_BADGE[s] : \`<span class="badge badge-muted">\${escHtml(status || 'unknown')}</span>\`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffH = diffMs / 3600000;
  if (diffH < 1) return Math.round(diffMs/60000) + 'm ago';
  if (diffH < 24) return diffH.toFixed(0) + 'h ago';
  if (diffH < 168) return Math.round(diffH/24) + 'd ago';
  return d.toLocaleDateString();
}

function getAvatar(name) {
  for (const [k, v] of Object.entries(AGENT_AVATARS)) {
    if (name && name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '🤖';
}

function renderMemory(m) {
  return \`<div class="card">
  <div class="card-title"><span class="icon">🧠</span> Memory Stats</div>
  <div class="stat-row"><span class="stat-label">Active facts</span><span class="stat-value">\${m.activeFacts.toLocaleString()}</span></div>
  <div class="stat-row"><span class="stat-label">Expired facts</span><span class="stat-value">\${m.expiredFacts.toLocaleString()}</span></div>
  <div class="stat-row"><span class="stat-label">Vector index</span><span class="stat-value">\${m.vectorCount.toLocaleString()}</span></div>
  <div class="stat-row"><span class="stat-label">SQLite size</span><span class="stat-value">\${fmtBytes(m.sqliteSizeBytes)}</span></div>
  <div class="stat-row"><span class="stat-label">LanceDB size</span><span class="stat-value">\${fmtBytes(m.lanceSizeBytes)}</span></div>
  <div class="stat-row"><span class="stat-label">Total storage</span><span class="stat-value">\${fmtBytes(m.totalSizeBytes)}</span></div>
</div>\`;
}

function renderTaskQueue(tq) {
  let html = '<div class="card"><div class="card-title"><span class="icon">📋</span> Task Queue</div>';
  if (tq.current) {
    const c = tq.current;
    html += \`<div class="task-row">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="task-title">\${escHtml(c.title || (c.issue != null ? '#' + c.issue : 'Current Task'))}</div>
        \${badge(c.status)}
      </div>
      <div class="task-meta">\${c.branch ? '#' + escHtml(c.branch) + ' · ' : ''}\${fmtDate(c.started)}</div>
    </div>\`;
  } else {
    html += '<div class="stat-row"><span class="stat-label">Current</span><span class="badge badge-muted">idle</span></div>';
  }
  if (tq.history && tq.history.length > 0) {
    html += '<div style="margin-top:8px;font-size:11px;color:var(--muted);margin-bottom:4px">Recent</div>';
    tq.history.slice(0, 5).forEach(h => {
      html += \`<div class="task-row">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="task-title" style="font-size:12px">\${escHtml(h.title || (h.issue != null ? '#' + h.issue : '?'))}</div>
          \${badge(h.status)}
        </div>
        <div class="task-meta">\${fmtDate(h.completed || h.started)}</div>
      </div>\`;
    });
  }
  html += '</div>';
  return html;
}

function renderForge(forge) {
  let html = '<div class="card"><div class="card-title"><span class="icon">⚒️</span> Agent Status</div>';
  if (!forge || forge.length === 0) {
    html += '<div class="empty">No active agents</div>';
  } else {
    forge.forEach(f => {
      const name = f.agent || 'unknown';
      html += \`<div class="agent-row">
        <div class="agent-avatar">\${getAvatar(name)}</div>
        <div class="agent-info">
          <div class="agent-name">\${escHtml(name)}</div>
          <div class="agent-task">\${escHtml(f.task || f.workdir || '')}</div>
        </div>
        <div>\${badge(f.status)}</div>
      </div>\`;
    });
  }
  html += '</div>';
  return html;
}

function renderCronJobs(jobs) {
  let html = '<div class="card"><div class="card-title"><span class="icon">⏰</span> Cron Jobs</div>';
  if (!jobs || jobs.length === 0) {
    html += '<div class="empty">No cron jobs</div>';
  } else {
    jobs.forEach(j => {
      const status = j.consecutiveErrors > 0 ? 'error' : (j.lastStatus || (j.enabled ? 'ok' : 'disabled'));
      html += \`<div class="job-row">
        <div>
          <div class="job-name">\${escHtml(j.name)}</div>
          <div class="job-meta">\${escHtml(j.schedule)} · last: \${fmtDate(j.lastRunAt)}</div>
          \${j.lastError ? '<div class="job-meta" style="color:var(--red);">' + escHtml(j.lastError.slice(0,80)) + '</div>' : ''}
        </div>
        <div>\${badge(status)}</div>
      </div>\`;
    });
  }
  html += '</div>';
  return html;
}

function renderGit(git) {
  let html = '<div class="card"><div class="card-title"><span class="icon">🔀</span> Git Activity</div>';
  if (git.gitError) {
    html += \`<div class="empty">gh CLI unavailable</div>\`;
  } else {
    const items = [...(git.prs || []).map(p => ({...p, kind:'PR'})), ...(git.issues || []).map(i => ({...i, kind:'Issue'}))];
    items.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (items.length === 0) {
      html += '<div class="empty">No recent activity</div>';
    } else {
      items.slice(0, 8).forEach(item => {
        const statColor = item.state === 'OPEN' ? 'green' : (item.state === 'MERGED' ? 'blue' : 'muted');
        html += \`<div class="pr-row">
          <div class="pr-title"><a href="\${escHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer">#\${escHtml(String(item.number))} \${escHtml(item.title)}</a></div>
          <div class="pr-meta"><span class="badge badge-\${statColor}" style="font-size:10px">\${escHtml(item.state)}</span> \${escHtml(item.kind)} · \${fmtDate(item.createdAt)}</div>
        </div>\`;
      });
    }
  }
  html += '</div>';
  return html;
}

function renderCosts(c) {
  let html = '<div class="card"><div class="card-title"><span class="icon">💰</span> Cost Tracking (7d)</div>';
  if (!c.enabled) {
    html += '<div class="empty">Cost tracking disabled</div>';
  } else if (c.features.length === 0) {
    html += '<div class="empty">No LLM calls in last 7 days</div>';
  } else {
    html += \`<div class="stat-row"><span class="stat-label">Total calls</span><span class="stat-value">\${c.totalCalls.toLocaleString()}</span></div>\`;
    html += \`<div class="stat-row"><span class="stat-label">Tokens in/out</span><span class="stat-value">\${c.totalInputTokens.toLocaleString()} / \${c.totalOutputTokens.toLocaleString()}</span></div>\`;
    html += \`<div class="stat-row" style="margin-bottom:8px"><span class="stat-label">Est. cost</span><span class="stat-value" style="color:var(--green)">\$\${c.totalEstimatedCostUsd.toFixed(4)}</span></div>\`;
    c.features.slice(0, 6).forEach(f => {
      html += \`<div class="cost-row">
        <div class="cost-feature">\${escHtml(f.feature)}</div>
        <div class="cost-calls">\${f.calls} calls</div>
        <div class="cost-usd">\$\${f.estimatedCostUsd.toFixed(4)}</div>
      </div>\`;
    });
  }
  html += '</div>';
  return html;
}

function renderAgentHealth(ah) {
  let html = '<div class="card section-full"><div class="card-title"><span class="icon">🩺</span> Agent Health</div>';
  if (!ah || !ah.enabled) {
    html += '<div class="empty">Agent health store unavailable</div></div>';
    return html;
  }
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">';
  (ah.agents || []).slice(0, 12).forEach(function (a) {
    const st = String(a.status || 'unknown');
    const badge = st === 'healthy' ? 'badge-green' : st === 'idle' ? 'badge-muted' : st === 'stale' ? 'badge-yellow' : st === 'degraded' ? 'badge-red' : 'badge-muted';
    html += '<div class="agent-row" style="flex-direction:column;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:8px">';
    html += '<div style="display:flex;justify-content:space-between;width:100%;align-items:center"><span class="agent-name">' + escHtml(a.agentId) + '</span><span class="badge ' + badge + '">' + escHtml(st) + '</span></div>';
    html += '<div class="task-meta">score ' + (typeof a.score === 'number' ? a.score.toFixed(1) : '—') + ' · ' + fmtDate(new Date(a.lastSeen).toISOString()) + '</div>';
    html += '<div class="agent-task">' + escHtml((a.lastTask || '').slice(0, 120)) + '</div></div>';
  });
  html += '</div>';
  if (ah.alerts && ah.alerts.length > 0) {
    html += '<div style="margin-top:10px;font-size:12px;color:var(--yellow)">';
    ah.alerts.slice(0, 4).forEach(function (m) { html += '<div>⚠ ' + escHtml(m) + '</div>'; });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderAudit(a) {
  let html = '<div class="card section-full"><div class="card-title"><span class="icon">📜</span> Audit Trail (24h)</div>';
  if (!a || !a.enabled) {
    html += '<div class="empty">Audit log unavailable</div></div>';
    return html;
  }
  html += \`<div class="stat-row"><span class="stat-label">Total events</span><span class="stat-value">\${a.total24h.toLocaleString()}</span></div>\`;
  html += \`<div class="stat-row"><span class="stat-label">Outcomes</span><span class="stat-value">ok \${a.byOutcome.success} · partial \${a.byOutcome.partial} · failed \${a.byOutcome.failed}</span></div>\`;
  const agents = Object.entries(a.byAgent || {}).sort((x,y) => y[1] - x[1]).slice(0, 8);
  if (agents.length > 0) {
    html += '<div style="margin-top:8px;font-size:11px;color:var(--muted)">By agent</div>';
    agents.forEach(([name, cnt]) => {
      html += \`<div class="stat-row"><span class="stat-label">\${escHtml(name)}</span><span class="stat-value">\${cnt}</span></div>\`;
    });
  }
  if (a.recentFailures && a.recentFailures.length > 0) {
    html += '<div style="margin-top:8px;font-size:11px;color:var(--red)">Recent failures</div>';
    a.recentFailures.slice(0, 5).forEach(f => {
      html += \`<div class="task-row"><div class="task-title" style="font-size:12px">\${escHtml(f.agentId)} / \${escHtml(f.action)}</div><div class="task-meta">\${escHtml(f.target || '')} \${f.error ? escHtml(f.error.slice(0,120)) : ''}</div></div>\`;
    });
  }
  html += '</div>';
  return html;
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Server error');
    }
    const grid = document.getElementById('grid');
    grid.innerHTML = [
      renderMemory(data.memory),
      renderTaskQueue(data.taskQueue),
      renderForge(data.forge),
      renderCronJobs(data.cronJobs),
      renderGit(data.git),
      renderCosts(data.costs),
      renderAgentHealth(data.agentHealth),
      renderAudit(data.audit),
    ].join('');
    document.getElementById('last-updated').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleTimeString();
  } catch (err) {
    document.getElementById('last-updated').textContent = 'Error: ' + err.message;
  }
}

refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export interface DashboardServer {
  server: Server;
  port: number;
  close(): void;
}

export async function createDashboardServer(ctx: DashboardContext, port: number): Promise<DashboardServer> {
  const html = getDashboardHtml();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    let searchParams: URLSearchParams;
    try {
      searchParams = new URL(url, "http://127.0.0.1").searchParams;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    if (pathname === "/graph" || pathname === "/graph.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(getGraphExplorerHtml());
      return;
    }

    if (pathname === "/api/graph") {
      try {
        const days = Math.min(365, Math.max(1, Number.parseInt(searchParams.get("days") ?? "30", 10) || 30));
        const maxNodes = Math.min(
          2000,
          Math.max(20, Number.parseInt(searchParams.get("maxNodes") ?? "400", 10) || 400),
        );
        const body = JSON.stringify(collectGraphPayload(ctx.factsDb, days, maxNodes));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/graph: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/graph/recall") {
      try {
        const q = searchParams.get("query") ?? searchParams.get("q") ?? "";
        const body = JSON.stringify(collectGraphRecallPayload(ctx.factsDb, q));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/graph/recall: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/agents/health") {
      collectAgentHealth(ctx)
        .then((payload) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(JSON.stringify(payload));
        })
        .catch((_err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "InternalServerError" }));
        });
      return;
    }

    if (pathname === "/api/audit/summary") {
      try {
        const body = JSON.stringify(collectAuditSummary(ctx));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(body);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(
          `[dashboard-server] /api/audit/summary: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    if (pathname === "/api/audit/events") {
      if (!ctx.auditStore) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "audit store unavailable" }));
        return;
      }
      try {
        const hours = Math.min(720, Math.max(1, Number.parseInt(searchParams.get("hours") ?? "24", 10) || 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const agentId = searchParams.get("agent") ?? undefined;
        const outcome = searchParams.get("outcome") as "success" | "partial" | "failed" | null;
        const targetContains = searchParams.get("targetContains") ?? searchParams.get("target") ?? undefined;
        const rows = ctx.auditStore.query({
          sinceMs,
          agentId,
          outcome: outcome === "success" || outcome === "partial" || outcome === "failed" ? outcome : undefined,
          targetContains,
          limit: 2000,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ events: rows }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        pluginLogger.error(`[dashboard-server] /api/audit/events: ${err instanceof Error ? err.message : String(err)}`);
        res.end(JSON.stringify({ error: "InternalServerError" }));
      }
      return;
    }

    // Memory Viewer routes (Issue #1023)
    // GET /api/viewer/stats
    if (pathname === "/api/viewer/stats") {
      collectMemoryViewerStats(ctx)
        .then((stats) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
          res.end(JSON.stringify(stats));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Session Timeline routes (Issue #1025)
    // GET /api/viewer/timeline/sessions?days=30&limit=50
    if (pathname === "/api/viewer/timeline/sessions") {
      try {
        const days = Math.min(90, Math.max(1, Number.parseInt(searchParams.get("days") ?? "30", 10) || 30));
        const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10) || 50));
        const timeline = collectSessionTimeline(ctx, { days, sessionLimit: limit });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(timeline));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/timeline/sessions/:sessionId  (detail view)
    if (req.method === "GET" && pathname.startsWith("/api/viewer/timeline/sessions/")) {
      const sessionId = decodeURIComponent(pathname.replace("/api/viewer/timeline/sessions/", ""));
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session ID is required" }));
        return;
      }
      try {
        const detail = collectSessionTimelineDetail(ctx, sessionId);
        if (!detail) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found or no activity recorded" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(detail));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/timeline/stats  — high-level timeline stats (no session breakdown)
    if (pathname === "/api/viewer/timeline/stats") {
      try {
        // Get aggregate stats across all sessions in the window
        const fullTimeline = collectSessionTimeline(ctx, { days: 30, sessionLimit: 500 });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ totals: fullTimeline.totals, allEventTypes: fullTimeline.allEventTypes }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/facts?limit=50&offset=0&category=&tier=&entity=&search=
    if (pathname === "/api/viewer/facts") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10)));
        // Use the public FactsDB.list() API with filters for the dashboard facts endpoint
        const categoryFilter = searchParams.get("category") || undefined;
        const entityFilter = searchParams.get("entity") || undefined;
        const allFacts = ctx.factsDb.list(limit, { category: categoryFilter, entity: entityFilter });
        const verifiedFactIds = new Set<string>();
        try {
          if (ctx.verificationStore) {
            const verified = ctx.verificationStore.listLatestVerified();
            verified.forEach((v) => verifiedFactIds.add(v.factId));
          }
        } catch {
          /* non-fatal */
        }
        const facts: MemoryViewerFact[] = allFacts.map((f) => {
          const record = f as Record<string, unknown>;
          return {
            id: String(record.id ?? ""),
            text: String(record.text ?? ""),
            why: (record.why as string | null) ?? null,
            category: String(record.category ?? ""),
            importance: Number(record.importance ?? 0.5),
            entity: (record.entity as string | null) ?? null,
            key: (record.key as string | null) ?? null,
            value: (record.value as string | null) ?? null,
            source: String(record.source ?? ""),
            createdAt: Number(record.created_at ?? 0),
            decayClass: String(record.decay_class ?? ""),
            expiresAt: record.expires_at != null ? Number(record.expires_at) : null,
            confidence: Number(record.confidence ?? 0.5),
            summary: (record.summary as string | null) ?? null,
            tags: (() => {
              try {
                return JSON.parse(String(record.tags ?? "[]"));
              } catch {
                return [];
              }
            })(),
            supersededAt: record.superseded_at != null ? Number(record.superseded_at) : null,
            supersededBy: (record.superseded_by as string | null) ?? null,
            verified: verifiedFactIds.has(String(record.id ?? "")),
            scope: record.scope as string | undefined,
            provenanceSession: (record.provenance_session as string | null) ?? null,
            reinforcedCount: record.reinforced_count != null ? Number(record.reinforced_count) : undefined,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify({ facts, total: allFacts.length }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/facts/:id
    if (req.method === "GET" && pathname.startsWith("/api/viewer/facts/")) {
      const factId = pathname.replace("/api/viewer/facts/", "");
      if (!factId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fact id" }));
        return;
      }
      try {
        const fact = ctx.factsDb.getById(factId);
        if (!fact) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fact not found" }));
          return;
        }
        const verifiedFactIds = new Set<string>();
        try {
          if (ctx.verificationStore) {
            const verified = ctx.verificationStore.listLatestVerified();
            verified.forEach((v) => verifiedFactIds.add(v.factId));
          }
        } catch {
          /* non-fatal */
        }
        const f: MemoryViewerFact = {
          id: fact.id,
          text: fact.text,
          why: fact.why,
          category: fact.category,
          importance: fact.importance,
          entity: fact.entity,
          key: fact.key,
          value: fact.value,
          source: fact.source,
          createdAt: fact.createdAt,
          decayClass: fact.decayClass,
          expiresAt: fact.expiresAt,
          confidence: fact.confidence,
          summary: fact.summary ?? null,
          tags: fact.tags ?? [],
          supersededAt: fact.supersededAt ?? null,
          supersededBy: fact.supersededBy ?? null,
          verified: verifiedFactIds.has(fact.id),
          scope: fact.scope,
          provenanceSession: fact.provenanceSession ?? null,
          reinforcedCount: fact.reinforcedCount,
        };
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(f));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/entities
    if (pathname === "/api/viewer/entities") {
      try {
        const limit = Math.min(200, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10)));
        const entities = collectMemoryViewerEntities(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(entities));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/episodes
    if (pathname === "/api/viewer/episodes") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10)));
        const episodes = collectMemoryViewerEpisodes(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(episodes));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/narratives
    if (pathname === "/api/viewer/narratives") {
      try {
        const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10)));
        const narratives = collectMemoryViewerNarratives(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(narratives));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/issues
    if (pathname === "/api/viewer/issues") {
      try {
        const issues = collectMemoryViewerIssues(ctx);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(issues));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/workflows
    if (pathname === "/api/viewer/workflows") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10)));
        const workflows = collectMemoryViewerWorkflows(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(workflows));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/edicts
    if (pathname === "/api/viewer/edicts") {
      try {
        const edicts = collectMemoryViewerEdicts(ctx);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(edicts));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/verified
    if (pathname === "/api/viewer/verified") {
      try {
        const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10)));
        const verified = collectMemoryViewerVerified(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(verified));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/links
    if (pathname === "/api/viewer/links") {
      try {
        const limit = Math.min(10000, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "5000", 10)));
        const links = collectMemoryViewerLinks(ctx, limit);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(links));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/viewer/provenance/:factId
    if (pathname.startsWith("/api/viewer/provenance/")) {
      const factId = pathname.replace("/api/viewer/provenance/", "");
      try {
        const prov = collectMemoryViewerProvenance(ctx, factId);
        if (!prov) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provenance not available" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(prov));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // POST /api/viewer/facts/:id/verify
    if (req.method === "POST" && pathname.match(/^\/api\/viewer\/facts\/[^/]+\/verify$/)) {
      const factId = pathname.split("/")[4];
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const result = performFactAction(ctx, "verify", factId, parsed);
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // POST /api/viewer/facts/:id/forget
    if (req.method === "POST" && pathname.match(/^\/api\/viewer\/facts\/[^/]+\/forget$/)) {
      const factId = pathname.split("/")[4];
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const result = performFactAction(ctx, "forget", factId, {});
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (pathname === "/api/status") {
      collectStatus(ctx)
        .then((status) => {
          const body = JSON.stringify(status);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          });
          res.end(body);
        })
        .catch((_err: unknown) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "InternalServerError" }));
        });
    } else if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  /** Attempt to bind `server` to the given port; resolves with the bound port. */
  function tryListen(targetPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      function onStartupError(err: NodeJS.ErrnoException) {
        reject(err);
      }
      server.once("error", onStartupError);

      server.listen(targetPort, "127.0.0.1", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : targetPort;
        server.removeAllListeners("error");
        resolve(boundPort);
      });
    });
  }

  let boundPort: number;
  try {
    boundPort = await tryListen(port);
  } catch (err: unknown) {
    const isAddrInUse = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!isAddrInUse) throw err;

    // Port is occupied (likely a previous instance that didn't shut down
    // cleanly). Fall back to an OS-assigned ephemeral port so the dashboard
    // remains available rather than failing entirely.
    const log = ctx.logger?.error ? (m: string) => ctx.logger?.error?.(m) : (m: string) => pluginLogger.warn(m);
    log(`[dashboard-server] Port ${port} in use (EADDRINUSE), falling back to OS-assigned port`);
    server.removeAllListeners("listening");
    boundPort = await tryListen(0);
  }

  // Install permanent error handler now that the server is bound.
  server.on("error", (err: NodeJS.ErrnoException) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (ctx.logger?.error) {
      ctx.logger.error(`[dashboard-server] Server error: ${errMsg}`);
    } else {
      pluginLogger.error(`[dashboard-server] Server error: ${errMsg}`);
    }
  });

  return {
    server,
    port: boundPort,
    close() {
      server.close();
    },
  };
}
