# Release notes — 2026.3.91 (2026-03-09)

This release follows **2026.3.90** (2026-03-09). It adds the **Memory Dashboard**: a web UI for inspecting hybrid-memory data, plus a shared REST API and a structure to compare dashboards generated from the same brief by different tools (Lovable, GPT, Gemini, Claude).

---

## Summary

**2026.3.91** adds:

- **Memory Dashboard (Lovable)** — A full React + Vite + shadcn UI in `dashboard/lovable/`: overview stats, facts explorer, interactive memory graph, issue tracker, knowledge clusters, cost & usage, feature config, and workflow patterns. Uses mock data by default; optional REST API for live data.
- **Dashboard REST API** — Standalone HTTP server in `extensions/memory-hybrid/scripts/dashboard-api.ts` serving `GET /api/stats`, `/api/facts`, `/api/facts/:id`, `/api/graph`, `/api/issues`, `/api/clusters`, `/api/cost`, `/api/config`, `/api/workflows` from your OpenClaw config and SQLite/LanceDB. Run with `npm run dashboard-api` from the extension (port 18790).
- **Multi-dashboard layout** — `dashboard/lovable/`, plus placeholders `dashboard/gpt/`, `dashboard/gemini/`, `dashboard/claude/` so you can add and compare dashboards generated from the same brief by different tools.
- **Docs** — `dashboard/README.md` (shared API, how to run each dashboard, how to add new ones); main README updated with Memory Dashboard section.

---

## What changed since 2026.3.90

### New in 2026.3.91

#### Memory Dashboard (Lovable)

- **Location:** `dashboard/lovable/` (React 18, TypeScript, Vite, Tailwind, shadcn/ui, Recharts, react-force-graph-2d).
- **Pages:** Dashboard overview (metric cards, facts-by-category/tier/decay, recent facts), Memory Graph (force-directed graph, filters, node detail), Facts Explorer (table with filters and pagination), Issue Tracker, Knowledge Clusters, Cost & Usage (daily/model/feature charts), Feature Configuration (read-only toggles from plugin config), Workflow Patterns.
- **Data:** Uses mock data when no API is configured; set `VITE_API_BASE` (e.g. `http://localhost:8080` in dev with proxy) to use the dashboard API for live data.
- **Build:** `cd dashboard/lovable && npm install && npm run build`; output under `dist/` with base path `/plugins/memory-dashboard/lovable/` for hosting (e.g. `http://localhost:18789/plugins/memory-dashboard/lovable/`).

#### Dashboard REST API

- **Script:** `extensions/memory-hybrid/scripts/dashboard-api.ts`.
- **Run:** From `extensions/memory-hybrid`: `npm run dashboard-api` (listens on port 18790; override with `PORT`). Reads `OPENCLAW_HOME` or `~/.openclaw` and `openclaw.json` to resolve plugin config and DB paths.
- **Backends:** Uses existing FactsDB (facts, memory_links, clusters, llm_cost_log), IssueStore (issues.db), CostTracker, WorkflowStore (workflow-traces.db). No new dependencies beyond the extension’s existing ones; runs with `npx tsx` (tsx added as devDependency).
- **Endpoints:**
  - `GET /api/stats` — totalFacts, activeFacts, categories, links, openIssues, costThisMonth, byCategory, byTier, byDecayClass, lastFactAt, avgImportance.
  - `GET /api/facts` — paginated facts (query: limit, offset, category, tier, decay_class, entity, search).
  - `GET /api/facts/:id` — single fact plus outgoing links (target text/category).
  - `GET /api/graph` — nodes (id, text, category, entity, importance) and edges (source, target, link_type, strength); query: limit, category, entity.
  - `GET /api/issues` — list issues (query: status, severity).
  - `GET /api/clusters` — clusters with member facts (id, label, fact_count, created_at, updated_at, members).
  - `GET /api/cost` — daily cost/tokens, byModel, byFeature, summary (totalMonth, totalToday, avgDaily, topModel); query: range=7d|30d|90d.
  - `GET /api/config` — feature toggles derived from plugin config (Hybrid Memory, Auto Capture, Auto Recall, etc.).
  - `GET /api/workflows` — workflow patterns (goal, tool_sequence, outcome, tool_count, duration_ms).
- **CORS:** Responses include `Access-Control-Allow-Origin: *` for local dashboard use.

#### Multi-dashboard layout

- **Structure:** `dashboard/README.md` describes one shared API and multiple dashboard UIs: `dashboard/lovable/` (Lovable), `dashboard/gpt/`, `dashboard/gemini/`, `dashboard/claude/` (placeholders with READMEs). Same API contract for all so you can compare which brief produced the best UI.
- **Adding dashboards:** Create a new subdir, point the app at the API (proxy or `VITE_API_BASE`), optionally set base path (e.g. `/plugins/memory-dashboard/gpt/`).

#### Documentation

- **dashboard/README.md** — Layout table (lovable, gpt, gemini, claude), shared API run instructions, how to run each dashboard (mock vs real data), how to add GPT/Gemini/Claude dashboards.
- **dashboard/lovable/README.md** — Lovable-specific quick start (dev with mock, dev with API, production build), API endpoints table, tech stack, project structure.
- **dashboard/gpt/README.md**, **dashboard/gemini/README.md**, **dashboard/claude/README.md** — Placeholder instructions for adding each dashboard and using the same API.
- **README.md (root)** — “Memory Dashboard” bullet under Developer experience updated: one shared API, multiple dashboards (lovable, gpt, gemini, claude) for comparing briefs; link to dashboard/README.md.

#### Other

- **Extension package.json:** New script `dashboard-api` (`npx tsx scripts/dashboard-api.ts`); devDependency `tsx` added for running the API script.

---

## Upgrade

From a previous OpenClaw Hybrid Memory install:

```bash
openclaw hybrid-mem upgrade 2026.3.91
```

Clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.91
```

Restart the gateway after upgrading. To use the dashboard with live data, start the API from the extension directory (`npm run dashboard-api`), then run the Lovable app from `dashboard/lovable` with `VITE_API_BASE=http://localhost:8080 npm run dev` (or build and serve the `dist/` output).

---

## References

- **Changelog:** [CHANGELOG.md](../CHANGELOG.md) — full history and links.
- **Compare:** [v2026.3.90...v2026.3.91](https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.90...v2026.3.91).
