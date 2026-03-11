/**
 * Mission Control Dashboard — Issue #309
 *
 * Serves a web dashboard via a small HTTP server registered as a plugin service.
 * Routes:
 *   GET /           — HTML dashboard (vanilla JS/CSS, no framework)
 *   GET /api/status — JSON data for all dashboard sections
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { getDirSize } from "../utils/fs.js";

const execFile = promisify(execFileCb);

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
}

export interface MemoryStats {
  activeFacts: number;
  expiredFacts: number;
  vectorCount: number;
  sqliteSizeBytes: number;
  lanceSizeBytes: number;
  totalSizeBytes: number;
}

export interface CronJobStatus {
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

export interface TaskQueueItem {
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

export interface ForgeTaskItem {
  task: string;
  workdir?: string;
  pid?: number;
  started_at?: string;
  status?: string;
}

export interface GitActivity {
  prs: Array<{ number: number; title: string; state: string; url: string; createdAt: string }>;
  issues: Array<{ number: number; title: string; state: string; url: string; createdAt: string }>;
  gitError?: string;
}

export interface CostRow {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface CostStats {
  features: CostRow[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  days: number;
  enabled: boolean;
}

export interface DashboardStatus {
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
}

// ---------------------------------------------------------------------------
// Data collection helpers
// ---------------------------------------------------------------------------

/** Cached LanceDB dir size keyed by resolved path to avoid repeated traversal on every poll */
const _lanceSizeCache = new Map<string, { size: number; ts: number }>();
const LANCE_CACHE_TTL_MS = 300_000; // 5 minutes

function getFileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch { return null; }
}

async function collectMemoryStats(ctx: DashboardContext): Promise<MemoryStats> {
  const activeFacts = ctx.factsDb.count();
  const expiredFacts = ctx.factsDb.countExpired();
  let vectorCount = 0;
  try { vectorCount = await ctx.vectorDb.count(); } catch { /* non-fatal */ }
  const sqliteSizeBytes = getFileSize(ctx.resolvedSqlitePath);

  // Use cached LanceDB size to avoid blocking on large directory traversals
  const now = Date.now();
  const cachedEntry = _lanceSizeCache.get(ctx.resolvedLancePath);
  if (!cachedEntry || now - cachedEntry.ts > LANCE_CACHE_TTL_MS) {
    _lanceSizeCache.set(ctx.resolvedLancePath, { size: await getDirSize(ctx.resolvedLancePath), ts: now });
  }
  const lanceSizeBytes = _lanceSizeCache.get(ctx.resolvedLancePath)!.size;

  return {
    activeFacts,
    expiredFacts,
    vectorCount,
    sqliteSizeBytes,
    lanceSizeBytes,
    totalSizeBytes: sqliteSizeBytes + lanceSizeBytes,
  };
}

function collectCronJobs(): CronJobStatus[] {
  const openclawDir = join(homedir(), ".openclaw");
  const cronStorePath = join(openclawDir, "cron", "jobs.json");
  if (!existsSync(cronStorePath)) return [];
  try {
    const store = readJsonFile<{ jobs?: unknown[] }>(cronStorePath);
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
          lastRunAt: typeof state.lastRunAtMs === "number"
            ? new Date(state.lastRunAtMs).toISOString() : null,
          nextRunAt: typeof state.nextRunAtMs === "number"
            ? new Date(state.nextRunAtMs).toISOString() : null,
          lastStatus: typeof state.lastStatus === "string" ? state.lastStatus
            : typeof state.lastRunStatus === "string" ? state.lastRunStatus : null,
          lastError: typeof state.lastError === "string" ? state.lastError : null,
          consecutiveErrors: typeof state.consecutiveErrors === "number" ? state.consecutiveErrors : 0,
          agentId: String(job.agentId ?? ""),
          model: typeof payload?.model === "string" ? payload.model : undefined,
        };
      });
  } catch { return []; }
}

function collectTaskQueue(): { current: TaskQueueItem | null; history: TaskQueueItem[] } {
  const stateDir = join(homedir(), ".openclaw", "workspace", "state", "task-queue");
  const currentPath = join(stateDir, "current.json");
  const historyDir = join(stateDir, "history");

  const current = readJsonFile<TaskQueueItem>(currentPath);

  let history: TaskQueueItem[] = [];
  if (existsSync(historyDir)) {
    try {
      const files = readdirSync(historyDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, 10);
      history = files
        .map((f) => readJsonFile<TaskQueueItem>(join(historyDir, f)))
        .filter((item): item is TaskQueueItem => item !== null);
    } catch { /* non-fatal */ }
  }

  return { current, history };
}

function collectForgeState(): ForgeTaskItem[] {
  const forgeDir = join(homedir(), ".openclaw", "workspace", "state", "forge");
  if (!existsSync(forgeDir)) return [];
  try {
    const files = readdirSync(forgeDir).filter((f) => f.endsWith(".json"));
    // Limit to the 20 most recently modified files to avoid unbounded sync reads
    const withMtime = files.map((f) => {
      const fullPath = join(forgeDir, f);
      try { return { name: f, mtime: statSync(fullPath).mtimeMs }; } catch { return null; }
    }).filter((e): e is { name: string; mtime: number } => e !== null);
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.slice(0, 20)
      .map((e) => readJsonFile<ForgeTaskItem>(join(forgeDir, e.name)))
      .filter((item): item is ForgeTaskItem => item !== null);
  } catch { return []; }
}

async function collectGitActivity(repo?: string): Promise<GitActivity> {
  try {
    const repoArgs = repo ? ["--repo", repo] : [];
    const [prResult, issueResult] = await Promise.all([
      execFile("gh", ["pr", "list", "--limit", "10", "--json", "number,title,state,url,createdAt", ...repoArgs], { timeout: 8000, encoding: "utf-8" }),
      execFile("gh", ["issue", "list", "--limit", "10", "--json", "number,title,state,url,createdAt", ...repoArgs], { timeout: 8000, encoding: "utf-8" }),
    ]);
    type GitItem = { number: number; title: string; state: string; url: string; createdAt: string };
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
  try {
    const db = ctx.factsDb.getRawDb();
    const days = 7;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    // Check if cost tracking table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cost_log'")
      .get() as { name: string } | undefined;

    if (!tableExists) {
      return { features: [], totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCostUsd: 0, days, enabled: false };
    }

    const rows = db
      .prepare(
        `SELECT feature,
                COUNT(*) AS calls,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
         FROM llm_cost_log
         WHERE timestamp >= ?
         GROUP BY feature
         ORDER BY estimatedCostUsd DESC`
      )
      .all(cutoff) as Array<{ feature: string; calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number }>;

    const allFeatures: CostRow[] = rows.map((r) => ({
      feature: r.feature,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      estimatedCostUsd: Number(r.estimatedCostUsd),
    }));

    const totalCalls = allFeatures.reduce((s, r) => s + r.calls, 0);
    const totalInputTokens = allFeatures.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutputTokens = allFeatures.reduce((s, r) => s + r.outputTokens, 0);
    const totalEstimatedCostUsd = allFeatures.reduce((s, r) => s + r.estimatedCostUsd, 0);

    return { features: allFeatures.slice(0, 20), totalCalls, totalInputTokens, totalOutputTokens, totalEstimatedCostUsd, days, enabled: true };
  } catch {
    return { features: [], totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCostUsd: 0, days: 7, enabled: false };
  }
}

export async function collectStatus(ctx: DashboardContext): Promise<DashboardStatus> {
  return {
    generatedAt: new Date().toISOString(),
    memory: await collectMemoryStats(ctx),
    cronJobs: collectCronJobs(),
    taskQueue: collectTaskQueue(),
    forge: collectForgeState(),
    git: await collectGitActivity(ctx.gitRepo),
    costs: collectCostStats(ctx),
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
  <span id="last-updated">Loading…</span>
</header>
<main>
  <div class="grid" id="grid">
    <div class="card"><div class="empty">Loading…</div></div>
  </div>
</main>
<script>
const AGENT_AVATARS = { Maeve: '🦊', Forge: '⚒️', Scholar: '📚', Hearth: '🏠', Warden: '🛡️', Reaver: '🔧' };
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
  return STATUS_BADGE[s] || \`<span class="badge badge-muted">\${escHtml(status || 'unknown')}</span>\`;
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
        <div class="task-title">\${escHtml(c.title || c.issue || 'Current Task')}</div>
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
      const name = f.task || 'unknown';
      html += \`<div class="agent-row">
        <div class="agent-avatar">\${getAvatar(name)}</div>
        <div class="agent-info">
          <div class="agent-name">\${escHtml(name)}</div>
          <div class="agent-task">\${escHtml(f.workdir || '')}</div>
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
          <div class="pr-title"><a href="\${escHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer">\${escHtml(item.kind === 'PR' ? '#' : '')}\${escHtml(String(item.number))} \${escHtml(item.title)}</a></div>
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

    if (pathname === "/api/status") {
      collectStatus(ctx).then((status) => {
        const body = JSON.stringify(status);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(body);
      }).catch((err: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    } else if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: boundPort,
        close() {
          server.close();
        },
      });
    });
  });
}
