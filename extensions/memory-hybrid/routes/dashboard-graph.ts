/**
 * Memory graph API + explorer page (Issue #788).
 */

import type { FactsDB } from "../backends/facts-db.js";

export interface MemoryGraphNode {
  id: string;
  label: string;
  category: string;
  importance: number;
  decayClass: string;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  link_type: string;
  strength: number;
}

export interface GraphPayload {
  generatedAt: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface GraphRecallPayload extends GraphPayload {
  activated: string[];
}

export function collectGraphPayload(factsDb: FactsDB, days: number, maxNodes: number): GraphPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * 86400;
  const capped = Math.min(2000, Math.max(20, maxNodes));
  const db = factsDb.getRawDb();
  const rows = db
    .prepare(
      "SELECT id, text, category, importance, decay_class FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(nowSec, cutoff, capped) as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    decay_class: string | null;
  }>;
  const idSet = new Set(rows.map((r) => r.id));
  const allEdges = factsDb.getAllEdges(12000);
  const edges = allEdges.filter((e) => idSet.has(e.source) && idSet.has(e.target)).slice(0, 2000);
  const nodes: MemoryGraphNode[] = rows.map((r) => ({
    id: r.id,
    label: r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text,
    category: r.category,
    importance: r.importance,
    decayClass: r.decay_class ?? "stable",
  }));
  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      link_type: e.link_type,
      strength: e.strength,
    })),
  };
}

export function collectGraphRecallPayload(factsDb: FactsDB, query: string): GraphRecallPayload {
  const q = query.trim();
  if (!q) {
    return { generatedAt: new Date().toISOString(), nodes: [], edges: [], activated: [] };
  }
  const results = factsDb.search(q, 12, {
    includeSuperseded: false,
    reinforcementBoost: 0.1,
    diversityWeight: 1,
  });
  const seeds = results.map((r) => r.entry.id);
  const expanded = new Set<string>(factsDb.getConnectedFactIds(seeds, 3));
  const ids = [...expanded].slice(0, 2000);
  const entryMap = factsDb.getByIds(ids);
  const nodes: MemoryGraphNode[] = [];
  for (const id of ids) {
    const f = entryMap.get(id);
    if (!f) continue;
    nodes.push({
      id: f.id,
      label: f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text,
      category: f.category,
      importance: f.importance,
      decayClass: f.decayClass ?? "stable",
    });
  }
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const allEdges = factsDb.getAllEdges(10000);
  const edges = allEdges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)).slice(0, 2000);
  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      link_type: e.link_type,
      strength: e.strength,
    })),
    activated: seeds,
  };
}

export function getGraphExplorerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Memory Graph</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
  :root { --bg:#0f1117; --surface:#1a1d27; --border:#2a2d3a; --text:#e2e8f0; --muted:#8892a4; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; font-size:13px; }
  header { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  h1 { margin:0; font-size:16px; color:#3b82f6; }
  #graph { width:100%; height:calc(100vh - 56px); }
  .panel { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:8px; max-width:420px; font-size:12px; max-height:160px; overflow:auto; }
  input[type="search"] { background:#0b0d12; border:1px solid var(--border); color:var(--text); padding:6px 10px; border-radius:6px; min-width:200px; }
  button { background:#2563eb; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  .legend { font-size:11px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Memory graph</h1>
  <input type="search" id="q" placeholder="Recall subgraph (FTS search)…" />
  <button type="button" id="go">Highlight recall</button>
  <span class="legend">SUPERSEDES · RELATED_TO · PART_OF · CAUSED_BY · DEPENDS_ON · edges colored · drag nodes</span>
</header>
<div id="detail" class="panel" style="margin:8px;display:none"></div>
<svg id="graph"></svg>
<script>
const LINK_COLORS = { SUPERSEDES:'#ef4444', RELATED_TO:'#6b7280', PART_OF:'#3b82f6', CAUSED_BY:'#a855f7', DEPENDS_ON:'#f97316', INSTANCE_OF:'#22c55e', CONTRADICTS:'#f43f5e', DERIVED_FROM:'#94a3b8' };
const CAT_COLORS = { fact:'#3b82f6', preference:'#22c55e', decision:'#eab308', entity:'#a855f7', episode:'#c084fc', procedure:'#f97316', pattern:'#14b8a6', rule:'#f59e0b', other:'#64748b' };

let sim, svg, link, node, pulse;

async function loadBase() {
  const res = await fetch('/api/graph?days=30&maxNodes=400');
  if (!res.ok) {
    throw new Error(\`Failed to load graph: \${res.status} \${res.statusText}\`);
  }
  return res.json();
}

async function loadRecall(q) {
  const res = await fetch('/api/graph/recall?' + new URLSearchParams({ query: q }));
  if (!res.ok) {
    throw new Error(\`Failed to load recall graph: \${res.status} \${res.statusText}\`);
  }
  return res.json();
}

function buildGraph(data) {
  if (sim) sim.stop();
  const width = window.innerWidth;
  const height = window.innerHeight - 56;
  d3.select('#graph').selectAll('*').remove();
  svg = d3.select('#graph').attr('width', width).attr('height', height);
  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoom);

  const nodes = data.nodes.map(d => ({...d}));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const links = data.edges.map(d => ({
    source: nodeById.get(d.source),
    target: nodeById.get(d.target),
    link_type: d.link_type,
    strength: d.strength
  })).filter(l => l.source && l.target);

  sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(45).strength(0.35))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(width/2, height/2))
    .force('collide', d3.forceCollide().radius(d => 6 + (d.importance || 0.5) * 10));

  link = g.append('g').attr('stroke', '#555').selectAll('line')
    .data(links).join('line')
    .attr('stroke-width', d => 0.5 + (d.strength || 0.5))
    .attr('stroke', d => LINK_COLORS[d.link_type] || '#6b7280');

  node = g.append('g').selectAll('circle')
    .data(nodes).join('circle')
    .attr('r', d => 5 + (d.importance || 0.5) * 8)
    .attr('fill', d => CAT_COLORS[d.category] || CAT_COLORS.other)
    .attr('opacity', d => {
      const dc = (d.decayClass || '').toLowerCase();
      if (dc.includes('ephemeral') || dc.includes('short')) return 0.55;
      return 0.92;
    })
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('click', (e, d) => {
      const el = document.getElementById('detail');
      el.style.display = 'block';
      el.textContent = d.label;
    });

  pulse = new Set((data.activated || []).filter(Boolean));
  if (pulse.size) {
    node.attr('stroke', d => pulse.has(d.id) ? '#fff' : 'none').attr('stroke-width', d => pulse.has(d.id) ? 2 : 0);
  }

  sim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
  });
}

(async () => {
  try {
    const data = await loadBase();
    buildGraph(data);
    document.getElementById('go').onclick = async () => {
      const q = document.getElementById('q').value.trim();
      try {
        if (!q) {
          buildGraph(await loadBase());
          return;
        }
        buildGraph(await loadRecall(q));
      } catch (err) {
        const el = document.getElementById('detail');
        el.style.display = 'block';
        el.style.color = '#ef4444';
        el.textContent = 'Error: ' + (err.message || String(err));
      }
    };
  } catch (err) {
    const el = document.getElementById('detail');
    el.style.display = 'block';
    el.style.color = '#ef4444';
    el.textContent = 'Error loading graph: ' + (err.message || String(err));
  }
})();
</script>
</body>
</html>`;
}
