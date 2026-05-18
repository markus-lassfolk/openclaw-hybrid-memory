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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentHealthView, mergeAgentHealthDashboard } from "../backends/agent-health-store.js";
import type { AuditStore } from "../backends/audit-store.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { VerificationStore } from "../services/verification-store.js";
import { getDirSize, getFileSizeAsync, readJsonFile } from "../utils/fs.js";
import { isValidGhRepoArg } from "../utils/gh-repo-arg.js";
import { pluginLogger } from "../utils/logger.js";
import { execFile as execFileCb } from "../utils/process-runner.js";
import { parseTags } from "../utils/tags.js";
import { collectGraphPayload, collectGraphRecallPayload, getGraphExplorerHtml } from "./dashboard-graph.js";

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);

const MAX_DASHBOARD_JSON_BODY_BYTES = 64 * 1024;
const VERIFIED_FACT_SET_TTL_MS = 5000;
const verifiedFactIdCacheByStore = new WeakMap<VerificationStore, { at: number; ids: Set<string> }>();

export function getDashboardHtml(): string {
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
