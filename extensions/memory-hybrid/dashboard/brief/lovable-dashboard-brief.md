# Lovable Brief: OpenClaw Hybrid Memory Dashboard

## What I'm Building

A **memory dashboard web app** for an AI agent system called OpenClaw. The dashboard visualizes the agent's long-term memory: facts it has learned, relationships between them, issue tracking, knowledge clusters, and cost data. Think of it as a "brain inspector" for an AI assistant.

The app will be served as a standalone SPA at `http://localhost:18789/plugins/memory-dashboard/` — but for now, just build a beautiful, functional frontend that fetches data from a REST API. I'll wire up the backend later.

## Tech Stack

- **React + TypeScript** (Lovable default is fine)
- **Tailwind CSS** for styling
- **Recharts** for charts (cost over time, category breakdowns)
- **D3.js or react-force-graph** for the memory graph visualization
- **shadcn/ui** components (Lovable default)
- Dark theme by default (the host app uses a dark UI)

## Pages / Sections

### 1. Dashboard Overview (Home)

A summary page with key metrics cards at the top, then detail sections below.

**Top metric cards (horizontal row):**
- **Total Facts**: 7,493 active facts (large number, small "active" label)
- **Categories**: 12 categories
- **Links**: 44,172 relationships
- **Issues**: count of open issues (with severity color coding)
- **Cost**: estimated cost this month (dollar amount)

**Below the cards:**
- **Facts by Category** — horizontal bar chart or treemap showing distribution:
  - technical: 2,429
  - fact: 2,010
  - project: 709
  - rule: 622
  - preference: 461
  - decision: 391
  - entity: 245
  - place: 230
  - pattern: 224
  - person: 132
  - monitoring: 39
  - other: 1
- **Facts by Tier** — small donut/pie chart: warm (7,101), cold (392)
- **Facts by Decay Class** — small donut/pie chart: stable (5,374), permanent (1,193), session (701), active (225)
- **Recent Facts** — table showing the 10 most recently created facts (text truncated, category badge, importance bar, created date as relative time)

### 2. Memory Graph

An interactive force-directed graph visualization.

- **Nodes** = facts (colored by category, sized by importance 0.0-1.0)
- **Edges** = memory_links (currently all RELATED_TO type, but the schema supports: SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON, CONTRADICTS, INSTANCE_OF, DERIVED_FROM)
- Edge thickness = link strength (0.0-1.0)
- Click a node to see its details in a sidebar panel
- Filter by category (checkboxes)
- Filter by entity (search/autocomplete)
- Search nodes by text
- Zoom, pan, drag nodes
- Color legend for categories

**Important:** With 7,493 nodes and 44,172 edges, the full graph is too large. Default to showing a subset:
- Start with a search/entity filter
- Or show "top 100 most connected nodes"
- Or show nodes within N hops of a selected node
- Provide a slider: "Show top N nodes by connection count"

### 3. Facts Explorer

A searchable, filterable table of all facts.

**Columns:**
- Text (truncated, expandable on click)
- Category (colored badge)
- Entity (if present)
- Importance (0.0-1.0, shown as small colored bar)
- Tier (HOT/WARM/COLD badge)
- Decay Class (permanent/stable/active/session)
- Scope (global/user/agent/session)
- Tags (comma-separated, shown as pills)
- Created (relative time, tooltip shows absolute)
- Confidence (0.0-1.0)

**Filters (sidebar or top bar):**
- Category dropdown (multi-select)
- Tier filter
- Decay class filter
- Scope filter
- Entity search (text input)
- Full-text search
- Importance range slider (0.0-1.0)
- Date range picker

**Row actions:**
- Click to expand full text
- Show linked facts (fetches from graph)
- Show fact metadata (all fields)

### 4. Issue Tracker

Table of tracked issues with lifecycle status.

**Columns:**
- Title
- Status (open → diagnosed → fix-attempted → resolved → verified → wont-fix) — shown as colored badge with status flow indicator
- Severity (low/medium/high/critical) — color coded
- Symptoms (list, expandable)
- Root Cause (if diagnosed)
- Fix (if attempted)
- Tags
- Detected At
- Resolved At / Verified At

**Filters:**
- Status multi-select
- Severity multi-select
- Tag filter
- Search by title/symptoms

### 5. Knowledge Clusters

Visual display of topic clusters — groups of densely connected facts.

- **Card layout**: Each cluster is a card showing:
  - Cluster label (title)
  - Fact count
  - Created/updated dates
  - Click to expand and see member facts
- **Visualization option**: Bubble chart where bubble size = fact count

(Note: currently 0 clusters in DB — the UI should handle empty state gracefully with a "No clusters detected yet. Run cluster analysis to discover topic groups." message)

### 6. Cost & Usage

Charts showing LLM cost data over time.

**Charts:**
- **Daily cost** over last 30 days (line/area chart)
- **Cost by model** (bar chart or stacked area)
- **Cost by feature** — which memory features are consuming LLM calls (pie chart)
- **Token usage** — input vs output tokens over time

**Summary cards:**
- Total cost this month
- Total cost today
- Most expensive model
- Average cost per day

**Date range selector** at the top (last 7d / 30d / 90d / custom)

### 7. Feature Configuration

Display current feature toggles for the hybrid memory system. Read-only for V1 (editing features would require API calls to change config — future work).

Show as a grid of toggle cards:
- Feature name
- Enabled/disabled status (green/red indicator)
- Brief description of what it does

**Features to display (from config):**
- Hybrid Memory (enabled/disabled)
- Auto Capture
- Auto Recall
- Auto Classify
- Distill (summarization)
- Reflection
- Self-Correction
- Passive Observer
- Nightly Cycle
- Extraction Passes
- Self Extension
- Crystallization
- Language Keywords
- Credentials Store
- Error Reporting

### 8. Workflow Patterns (bonus page)

Table of recorded workflow patterns — which tool sequences succeed for which goals.

**Columns:**
- Goal (text)
- Tool Sequence (shown as a pipeline: `tool1 → tool2 → tool3`)
- Outcome (success/failure/unknown — color coded)
- Tool Count
- Duration
- Created At

## API Endpoints (Mock these for now)

The app should fetch from these endpoints. Use mock data that matches the schemas below for development. I'll wire up the real backend later.

```
GET /api/stats
→ { totalFacts, activeFacts, categories, avgImportance, lastFactAt, byCategory: [{category, count}], byTier: [{tier, count}], byDecayClass: [{decay_class, count}] }

GET /api/facts?limit=50&category=technical&search=forge&tier=warm&offset=0
→ { facts: [{id, text, category, importance, entity, key, value, tags, tier, decay_class, scope, confidence, created_at, recall_count}], total: number }

GET /api/facts/:id
→ { fact: {...allFields}, links: [{id, target_id, link_type, strength, target_text, target_category}] }

GET /api/graph?limit=100&category=technical&entity=OpenClaw
→ { nodes: [{id, text, category, entity, importance}], edges: [{source, target, link_type, strength}] }

GET /api/issues?status=open&severity=high
→ { issues: [{id, title, status, severity, symptoms, root_cause, fix, rollback, tags, detected_at, resolved_at, verified_at}] }

GET /api/clusters
→ { clusters: [{id, label, fact_count, created_at, updated_at, members?: [{id, text, category}]}] }

GET /api/cost?range=30d
→ { daily: [{date, cost, tokens_in, tokens_out}], byModel: [{model, cost, calls}], byFeature: [{feature, cost, calls}], summary: {totalMonth, totalToday, avgDaily, topModel} }

GET /api/config
→ { features: [{name, enabled, description}] }

GET /api/workflows?limit=20&minSuccessRate=0.5
→ { patterns: [{goal, tool_sequence, outcome, tool_count, duration_ms, created_at}] }
```

## Design Guidelines

### Theme
- **Dark mode** by default (dark gray/charcoal background, not pure black)
- Accent color: **amber/orange** (#f59e0b or similar) — matches the 🦊 fox branding
- Secondary accent: **blue** (#3b82f6) for links and interactive elements
- Success: green, Warning: amber, Error: red, Info: blue
- Card backgrounds: slightly lighter than page background (e.g., zinc-800 on zinc-900)
- Text: white for primary, gray-400 for secondary

### Typography
- Clean sans-serif (Inter or system font stack)
- Monospace for IDs, technical values, timestamps

### Navigation
- **Left sidebar** with icon + text for each section
- Collapsible to icons-only
- Active page highlighted with accent color
- Header shows "🧠 Memory Dashboard" with a refresh button

### Responsive
- Works well on desktop (primary use case)
- Sidebar collapses to hamburger on mobile
- Tables scroll horizontally on small screens
- Graph view uses available space

### Empty States
- Every section should handle 0 results gracefully
- Show helpful message + illustration/icon
- Example: "No issues tracked yet. Issues are created when problems are detected during agent operation."

### Loading States
- Skeleton loaders for cards and tables
- Spinner for graph rendering
- "Fetching data..." message with subtle animation

## Real Data Samples (for realistic mock data)

### Sample Facts
```json
[
  {"id": "a1b2c3d4", "text": "System event hardening deployed 2026-03-09: config patched with tools.exec.notifyOnExit", "category": "technical", "importance": 0.95, "entity": "system-event-hardening", "tags": "system-events,gateway,reliability", "tier": "warm", "decay_class": "stable", "created_at": 1773036000},
  {"id": "e5f6g7h8", "text": "Markus prefers posh British, slightly sarcastic tone", "category": "preference", "importance": 0.85, "entity": "Markus", "tags": "communication,tone", "tier": "warm", "decay_class": "permanent", "created_at": 1771200000},
  {"id": "i9j0k1l2", "text": "Villa Polly smart home uses HA, Zigbee, Hue, Plejd, Apollo sensors", "category": "place", "importance": 0.8, "entity": "Villa Polly", "tags": "smart-home,home-assistant", "tier": "warm", "decay_class": "permanent", "created_at": 1770000000},
  {"id": "m3n4o5p6", "text": "PR #272 council review round 2 completed: all 3 reviewers confirmed 6/6 requirements MET", "category": "project", "importance": 0.9, "entity": "PR #272", "tags": "pr-272,council-review", "tier": "warm", "decay_class": "active", "created_at": 1773035000},
  {"id": "q7r8s9t0", "text": "Keep exec+PTY for Forge/Claude Code rather than switching to sessions_spawn", "category": "decision", "importance": 0.9, "entity": null, "tags": "forge,reliability,architecture", "tier": "warm", "decay_class": "stable", "created_at": 1773034000}
]
```

### Sample Issues
```json
[
  {"id": "iss-001", "title": "Forge completion events silently dropped", "status": "diagnosed", "severity": "high", "symptoms": ["Claude Code ignores shell commands after task completion", "notifyOnExit event not visible for tidal-forest session", "Cron safety net reports disabled but event was delivered"], "root_cause": "Three-layer failure: CC behavioral issue, possible event consumption during compaction, cron run status misreports heartbeat skip as disabled", "tags": ["forge", "system-events", "reliability"]},
  {"id": "iss-002", "title": "Gemini subagent stalls without timeout", "status": "resolved", "severity": "medium", "symptoms": ["Scholar ran 38 minutes with no output after mkdir", "No timeout mechanism for model stalls"], "root_cause": "Gemini API model stall", "fix": "Use runTimeoutSeconds on sessions_spawn", "tags": ["gemini", "subagent"]}
]
```

### Category Colors (for consistent color coding)
```
technical  → blue (#3b82f6)
fact       → gray (#6b7280)
project    → purple (#8b5cf6)
rule       → amber (#f59e0b)
preference → pink (#ec4899)
decision   → emerald (#10b981)
entity     → cyan (#06b6d4)
place      → orange (#f97316)
pattern    → indigo (#6366f1)
person     → rose (#f43f5e)
monitoring → yellow (#eab308)
other      → slate (#64748b)
```

## What I DON'T Need

- No user authentication (this is a localhost-only tool)
- No data mutation endpoints (read-only V1)
- No real-time/WebSocket updates (polling with a refresh button is fine)
- No mobile-first design (desktop is primary)
- No complex state management (React Query or SWR for data fetching is fine)
- No internationalization

## What Makes This Special

This isn't a generic CRUD dashboard. The data represents an **AI agent's learned knowledge** — facts it has extracted from conversations, decisions it has recorded, patterns it has detected, and relationships it has discovered between concepts. The visualization should feel like you're looking into a mind — organic, interconnected, alive with information. The graph view especially should feel explorative and discovery-oriented.

Make the empty states encouraging rather than sterile — this is a system that grows and learns over time. When there are 0 clusters, the message should feel like "your agent hasn't discovered topic clusters yet" rather than "no data."
