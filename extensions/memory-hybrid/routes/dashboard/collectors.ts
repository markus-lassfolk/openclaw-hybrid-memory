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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentHealthView, mergeAgentHealthDashboard } from "../../backends/agent-health-store.js";
import type { AuditStore } from "../../backends/audit-store.js";
import type { EdictStore } from "../../backends/edict-store.js";
import type { FactsDB } from "../../backends/facts-db.js";
import type { ProposalsDB } from "../../backends/proposals-db.js";
import type { CrystallizationStore } from "../../backends/crystallization-store.js";
import type { ToolProposalStore } from "../../backends/tool-proposal-store.js";
import type { HybridMemoryConfig } from "../../config.js";
import { escapeLikeLiteralForBackslashEscape } from "../../backends/facts-db/entity-layer.js";
import type { IssueStore } from "../../backends/issue-store.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { WorkflowStore } from "../../backends/workflow-store.js";
import type { EvolutionStats } from "../../services/evolution-stats.js";
import { collectEvolutionStats } from "../../services/evolution-stats.js";
import { readOpenClawCronStore } from "../../services/openclaw-cron-store.js";
import type { ProvenanceService } from "../../services/provenance.js";
import type { VerificationStore } from "../../services/verification-store.js";
import { getDirSize, getFileSizeAsync, readJsonFile } from "../../utils/fs.js";
import { formatTimestampUtc, nowIso } from "../../utils/dates.js";
import { pluginLogger } from "../../utils/logger.js";
import { deleteVectorForFactId } from "../../services/vector-maintenance.js";
import { isValidGhRepoArg } from "../../utils/gh-repo-arg.js";
import {
  isErrorReporterActive,
  resolvePendingErrorReportCount,
} from "../../services/error-reporter.js";
import { listQuarantinedGoalIds, resolveGoalsDir } from "../../services/goal-registry.js";
import { getEnv } from "../../utils/env-manager.js";
import { execFile as execFileCb } from "../../utils/process-runner.js";

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);

const _MAX_DASHBOARD_JSON_BODY_BYTES = 64 * 1024;
const VERIFIED_FACT_SET_TTL_MS = 5000;
const verifiedFactIdCacheByStore = new WeakMap<VerificationStore, { at: number; ids: Set<string> }>();

function clearVerifiedFactIdCache(ctx: DashboardContext): void {
  const store = ctx.verificationStore;
  if (!store) return;
  verifiedFactIdCacheByStore.delete(store);
}

export function getVerifiedFactIdSet(ctx: DashboardContext): Set<string> {
  const store = ctx.verificationStore;
  if (!store) return new Set();
  const now = Date.now();
  const cached = verifiedFactIdCacheByStore.get(store);
  if (cached && now - cached.at < VERIFIED_FACT_SET_TTL_MS) {
    return cached.ids;
  }
  try {
    const ids = new Set<string>();
    for (const v of store.listLatestVerified()) {
      ids.add(v.factId);
    }
    verifiedFactIdCacheByStore.set(store, { at: now, ids });
    return ids;
  } catch {
    return new Set();
  }
}

export function parseUrlPathSegment(input: string): string | null {
  try {
    const trimmed = input.trim();
    if (!trimmed) return null;
    return decodeURIComponent(trimmed);
  } catch {
    return null;
  }
}

export function readJsonBody(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const resolveOnce = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf-8");
      if (sizeBytes + chunkBytes > maxBytes) {
        rejectOnce(new Error("Request body too large"));
        try {
          req.resume();
        } catch {
          /* ignore */
        }
        return;
      }
      sizeBytes += chunkBytes;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8"));
    };

    const onEnd = () => {
      if (chunks.length === 0) return resolveOnce({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return resolveOnce({});
        resolveOnce(parsed as Record<string, unknown>);
      } catch (err) {
        rejectOnce(err);
      }
    };

    const onError = (err: unknown) => {
      rejectOnce(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  /** Optional owner/repo for GitHub queries (e.g. "markus-lassfolk/openclaw-hybrid-memory") */
  gitRepo?: string;
  /** Optional plugin config exposed to GraphQL context. */
  cfg?: unknown;
  /** Optional embedding service exposed to GraphQL context. */
  embeddings?: unknown;
  /** Optional embedding registry exposed to GraphQL context. */
  embeddingRegistry?: unknown;
  /** Optional CostTracker instance — delegates cost stats to the established abstraction. */
  costTracker?: import("../../backends/cost-tracker.js").CostTracker | null;
  /** Optional logger for structured logging of server errors */
  logger?: { error?: (msg: string) => void };
  /** Cross-agent audit trail (Issue #790). */
  auditStore?: AuditStore | null;
  /** Per-agent health store (Issue #789). */
  agentHealthStore?: import("../../backends/agent-health-store.js").AgentHealthStore | null;
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
  /** Mirrors `graph.hubDegreeCap` for dashboard graph recall (Issue #1192). */
  graphHubDegreeCap?: number | null;
  /** Mirrors `graph.hubScorePenalty` for dashboard graph recall (#1192). */
  graphHubScorePenalty?: number | null;
  /** Workshop tab: full plugin config. */
  hybridCfg?: HybridMemoryConfig;
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  /** Dream-cycle stage artifact directory for workshop log view. */
  dreamCycleLogDir?: string;
  /** Live change feed for workshop approve/reject/undo sync. */
  changeFeed?: import("../../services/change-feed.js").ChangeFeed | null;
}

interface MemoryStats {
  activeFacts: number;
  expiredFacts: number;
  vectorCount: number;
  sqliteSizeBytes: number;
  lanceSizeBytes: number;
  totalSizeBytes: number;
  evolution: EvolutionStats | null;
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
  infrastructure: InfrastructureSnapshot;
}

export interface InfrastructureSnapshot {
  pendingErrorReports: number;
  errorReporterActive: boolean;
  quarantinedGoalIds: string[];
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

export interface MemoryViewerFact {
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

  // Use cached LanceDB size to avoid blocking on large directory traversals.
  // TOCTOU guard: write to cache inside .then() — before .finally() clears the
  // in-flight entry — so any concurrent caller that sees no in-flight promise
  // will always find the cache already populated.
  const cachedEntry = _lanceSizeCache.get(ctx.resolvedLancePath);
  const now = Date.now();
  if (!cachedEntry || now - cachedEntry.ts > LANCE_CACHE_TTL_MS) {
    let inFlightPromise = _lanceInFlight.get(ctx.resolvedLancePath);
    if (!inFlightPromise) {
      inFlightPromise = getDirSize(ctx.resolvedLancePath)
        .then((size) => {
          _lanceSizeCache.set(ctx.resolvedLancePath, { size, ts: Date.now() });
          return size;
        })
        .finally(() => {
          _lanceInFlight.delete(ctx.resolvedLancePath);
        });
      _lanceInFlight.set(ctx.resolvedLancePath, inFlightPromise);
    }
    try {
      await inFlightPromise;
    } catch (err) {
      pluginLogger.error(
        `[dashboard-server] lance size traversal failed for ${ctx.resolvedLancePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const lanceSizeBytes = _lanceSizeCache.get(ctx.resolvedLancePath)?.size ?? 0;

  return {
    activeFacts,
    expiredFacts,
    vectorCount,
    sqliteSizeBytes,
    lanceSizeBytes,
    totalSizeBytes: sqliteSizeBytes + lanceSizeBytes,
    evolution: collectEvolutionStats(ctx.factsDb.getRawDb()),
  };
}

async function collectCronJobs(): Promise<CronJobStatus[]> {
  const openclawDir = join(homedir(), ".openclaw");
  try {
    const { store } = readOpenClawCronStore(openclawDir);
    if (!Array.isArray(store.jobs)) return [];
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
          lastRunAt:
            typeof state.lastRunAtMs === "number" ? formatTimestampUtc(Math.floor(state.lastRunAtMs / 1000)) : null,
          nextRunAt:
            typeof state.nextRunAtMs === "number" ? formatTimestampUtc(Math.floor(state.nextRunAtMs / 1000)) : null,
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

export async function collectAgentHealth(
  ctx: DashboardContext,
  forgeState?: ForgeTaskItem[],
): Promise<AgentHealthPayload> {
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

export function collectAuditSummary(ctx: DashboardContext): AuditSummaryPayload {
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
    const { DatabaseSync: DBSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DBSync(path, { readOnly: true });
    return db;
  } catch {
    return null;
  }
}

/** Collect Memory Viewer overview stats. */
export async function collectMemoryViewerStats(ctx: DashboardContext): Promise<MemoryViewerStats> {
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

/** Collect recent episodes — reads from the episodes table within the facts DB. */
export function collectMemoryViewerEpisodes(ctx: DashboardContext, limit = 50): MemoryViewerEpisode[] {
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
export function collectMemoryViewerNarratives(ctx: DashboardContext, limit = 20): MemoryViewerNarrative[] {
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
export function collectMemoryViewerIssues(ctx: DashboardContext): MemoryViewerIssue[] {
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
export function collectMemoryViewerWorkflows(ctx: DashboardContext, limit = 100): MemoryViewerWorkflow[] {
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
export function collectMemoryViewerEdicts(ctx: DashboardContext): MemoryViewerEdict[] {
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
export function collectMemoryViewerVerified(ctx: DashboardContext, limit = 100): MemoryViewerVerification[] {
  try {
    if (!ctx.verificationStore) return [];
    const verified = ctx.verificationStore.listLatestVerified().slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
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
export function collectMemoryViewerEntities(ctx: DashboardContext, limit = 50): MemoryViewerEntity[] {
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
export function collectMemoryViewerProvenance(ctx: DashboardContext, factId: string): MemoryViewerProvenance | null {
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
      edges: chain.edges.map((e: (typeof chain.edges)[number]) => ({
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

/** Collect unified entity → facts → issues → episodes correlation view (#1802). */
export type MemoryViewerCorrelation = {
  entityKey: string;
  facts: Array<{ id: string; text: string; category: string; entity: string | null }>;
  issues: Array<{ id: string; title: string; status: string; severity: string }>;
  episodes: Array<{ id: string; event: string; outcome: string }>;
  links: Array<{ from: string; to: string; type: string }>;
};

export function collectMemoryViewerCorrelation(ctx: DashboardContext, entityKey: string): MemoryViewerCorrelation {
  const key = entityKey.trim().toLowerCase();
  const empty: MemoryViewerCorrelation = { entityKey: key, facts: [], issues: [], episodes: [], links: [] };
  if (!key) return empty;

  try {
    const roDb = openFactsDbReadonly(ctx.resolvedSqlitePath);
    if (!roDb) return empty;

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const factRows = roDb
        .prepare(
          `SELECT id, text, category, entity FROM facts
             WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
               AND (lower(entity) = ? OR id IN (
                 SELECT fact_id FROM fact_entity_mentions WHERE normalized_surface = ?
               ))
             ORDER BY importance DESC, created_at DESC LIMIT 30`,
        )
        .all(nowSec, key, key) as Array<{ id: string; text: string; category: string; entity: string | null }>;

      const factIds = factRows.map((r) => r.id);
      let links: MemoryViewerCorrelation["links"] = [];
      if (factIds.length > 0) {
        const placeholders = factIds.map(() => "?").join(",");
        const linkRows = roDb
          .prepare(
            `SELECT source_fact_id, target_fact_id, link_type FROM memory_links
               WHERE source_fact_id IN (${placeholders}) OR target_fact_id IN (${placeholders})
               LIMIT 100`,
          )
          .all(...factIds, ...factIds) as Array<{ source_fact_id: string; target_fact_id: string; link_type: string }>;
        links = linkRows.map((r) => ({ from: r.source_fact_id, to: r.target_fact_id, type: r.link_type }));
      }

      const issues: MemoryViewerCorrelation["issues"] = [];
      if (ctx.issueStore) {
        const matched = ctx.issueStore.search(key).slice(0, 20);
        for (const issue of matched) {
          issues.push({
            id: issue.id,
            title: issue.title,
            status: issue.status,
            severity: issue.severity,
          });
        }
      }

      let episodes: MemoryViewerCorrelation["episodes"] = [];
      try {
        const likeKey = `%${escapeLikeLiteralForBackslashEscape(key)}%`;
        const epRows = roDb
          .prepare(
            `SELECT id, event, outcome FROM episodes
               WHERE lower(event) LIKE ? ESCAPE '\\' OR lower(context) LIKE ? ESCAPE '\\'
               ORDER BY timestamp DESC LIMIT 15`,
          )
          .all(likeKey, likeKey) as Array<{ id: string; event: string; outcome: string }>;
        episodes = epRows;
      } catch {
        /* episodes table may be absent on older stores */
      }

      return { entityKey: key, facts: factRows, issues, episodes, links };
    } finally {
      try {
        roDb.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return empty;
  }
}

/** Collect fact links from the memory_links table. */
export function collectMemoryViewerLinks(ctx: DashboardContext, limit = 5000): MemoryViewerLinks[] {
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
export async function performFactAction(
  ctx: DashboardContext,
  action: "verify" | "forget",
  factId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const factsDb = ctx.factsDb;
    const fact = factsDb.getById(factId);
    if (!fact) return { ok: false, message: `Fact not found: ${factId}` };

    if (action === "verify") {
      if (!ctx.verificationStore) return { ok: false, message: "Verification store not available" };
      const verifiedBy = (body.verifiedBy as "agent" | "user" | "system") ?? "agent";
      ctx.verificationStore.verify(factId, fact.text, verifiedBy);
      clearVerifiedFactIdCache(ctx);
      return { ok: true, message: `Fact ${factId} verified as ${verifiedBy}` };
    }
    // forget: supersede with null to mark the fact as superseded (soft-delete).
    // superseded_at IS NOT NULL filters it out of all recall paths.
    try {
      const ok = factsDb.supersede(factId, null);
      if (!ok) return { ok: false, message: `Could not supersede fact ${factId}` };
      if (ctx.vectorDb) {
        await deleteVectorForFactId({
          vectorDb: ctx.vectorDb,
          factId,
          logger: pluginLogger,
          context: "dashboard-forget",
        });
      }
    } catch {
      return { ok: false, message: `Could not forget fact ${factId}` };
    }
    clearVerifiedFactIdCache(ctx);
    return { ok: true, message: `Fact ${factId} forgotten` };
  } catch {
    return { ok: false, message: "Fact action failed" };
  }
}

export function collectInfrastructureSnapshot(ctx: DashboardContext): InfrastructureSnapshot {
  const pendingErrorReports = resolvePendingErrorReportCount(ctx.resolvedSqlitePath);
  let quarantinedGoalIds: string[] = [];
  if (ctx.hybridCfg?.goalStewardship?.enabled) {
    const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
    const goalsDir = resolveGoalsDir(workspaceRoot, ctx.hybridCfg.goalStewardship.goalsDir);
    quarantinedGoalIds = listQuarantinedGoalIds(goalsDir);
  }
  return {
    pendingErrorReports,
    errorReporterActive: isErrorReporterActive(),
    quarantinedGoalIds,
  };
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
    generatedAt: nowIso(),
    memory,
    cronJobs,
    taskQueue,
    forge,
    git,
    costs: collectCostStats(ctx),
    audit: collectAuditSummary(ctx),
    agentHealth,
    infrastructure: collectInfrastructureSnapshot(ctx),
  };
}

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------
