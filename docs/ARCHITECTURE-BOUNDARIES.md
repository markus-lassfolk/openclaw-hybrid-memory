# Architecture Boundaries — Core Runtime vs Adjacent Subsystems

This note defines the architectural center of `openclaw-hybrid-memory` so future refactors preserve the right seams.

## Design intent

`openclaw-hybrid-memory` is primarily a **multi-agent memory plugin for OpenClaw**. It is not designed first as a generic hostile multi-tenant SaaS backend.

That design intent matters because it changes the optimization target:

- favor **agent usefulness and operator clarity** over platform abstraction for its own sake
- keep **interactive turn latency** tightly controlled on the hot path
- allow **deeper/offline/maintenance flows** to be richer and slower when they are explicitly requested
- preserve **multiple stores** where they serve distinct retrieval or durability purposes, instead of forcing premature consolidation

## The architectural center

The architectural center is the runtime needed to make agent memory work reliably inside OpenClaw:

1. **Storage core** — durable fact persistence and retrieval stores
2. **Retrieval core** — structured + semantic recall orchestration
3. **Lifecycle integration** — capture, recall, injection, cleanup, and setup hooks
4. **Primary tool API surface** — the memory tools agents actually use in normal operation
5. **Trust/provenance seams** — enough provenance, verification, and scope semantics to keep memory behavior reliable

If a subsystem does not directly support one of those five concerns, it should be treated as adjacent unless there is a strong reason otherwise.

## Core runtime (must-stay-core)

### 1) Storage core
Primary ownership:

- `backends/facts-db.ts`
- `backends/vector-db.ts`
- `backends/wal.ts`
- `services/wal-helpers.ts`
- `setup/init-databases.ts`
- `types/memory.ts`
- selected utility modules under `utils/`

Responsibilities:

- store current facts and historical/superseded facts
- support exact/structured lookup and semantic recall
- maintain durability and crash recovery expectations
- define consistency semantics between SQLite, LanceDB, and WAL-backed flows

Boundary:

- storage core owns persistence semantics
- it should not absorb unrelated product features just because those features also persist data

### 2) Retrieval core
Primary ownership:

- `services/recall-pipeline.ts`
- `services/retrieval-orchestrator.ts`
- `services/graph-retrieval.ts`
- `services/query-expander.ts`
- `services/reranker.ts`
- `services/rrf-fusion.ts`
- `services/ambient-retrieval.ts` (only where it directly affects runtime recall)
- retrieval-related config under `config/`

Responsibilities:

- select retrieval mode(s)
- merge structured, semantic, and graph-expanded results
- apply ranking/budgeting appropriate to the call context
- distinguish **interactive** retrieval from **deep/offline** retrieval

Boundary:

- retrieval core should be organized around explicit modes and budgets, not around ad hoc feature accumulation
- expensive expansion or analysis should not silently leak into the interactive hot path

### 3) Lifecycle integration
Primary ownership:

- `lifecycle/hooks.ts`
- `lifecycle/stage-*.ts`
- `setup/register-hooks.ts`
- `setup/plugin-service.ts`
- `setup/cli-context.ts`

Responsibilities:

- hook into OpenClaw request/session lifecycle
- stage recall, capture, injection, frustration/auth handling, and cleanup in a predictable order
- keep boot/setup logic understandable and bounded

Boundary:

- lifecycle integration wires the core runtime into OpenClaw
- it should not become the default landing zone for unrelated optional features

### 4) Primary tool API surface
Primary ownership:

- `tools/memory-tools.ts`
- `tools/credential-tools.ts`
- `tools/graph-tools.ts`
- `tools/provenance-tools.ts`
- `tools/verification-tools.ts`
- `setup/register-tools.ts`

Responsibilities:

- expose the main memory behaviors agents depend on: store, recall, promote, forget, provenance, verification, related graph ops
- keep schemas and tool boundaries stable enough for agent habits and docs to remain valid

Boundary:

- primary tools should stay focused on core memory behavior
- specialist/productivity features can exist, but should not blur the core tool contract

### 5) Trust / provenance seams
Primary ownership:

- `services/provenance.ts`
- `services/verification-store.ts`
- `utils/provenance.ts`
- scope/filtering helpers and verification-related tools

Responsibilities:

- capture where facts came from
- preserve scope semantics (global/user/agent/session)
- support verification tiers where correctness risk is materially different

Boundary:

- enough trust metadata to make memory safe and usable is core
- heavyweight analysis/reporting around trust can remain adjacent

## Adjacent subsystems (important, but not the center)

These subsystems are valid parts of the repo, but they should be treated as **adjacent capabilities** rather than as the core architectural center.

### Operator / platform surfaces
- dashboard and health views
  - `routes/dashboard-server.ts`
  - `tools/dashboard-routes.ts`
  - `tools/health-dashboard.ts`

### Workflow / mining / learning layers
- workflow mining and tool-effectiveness analysis
  - `services/workflow-tracker.ts`
  - `services/tool-effectiveness.ts`
  - `services/feedback-effectiveness.ts`
  - `backends/workflow-store.ts`
  - `tools/workflow-tools.ts`
- reflection, crystallization, self-extension
  - `services/reflection.ts`
  - `services/skill-crystallizer.ts`
  - `services/tool-proposer.ts`
  - `services/crystallization-proposer.ts`
  - `tools/crystallization-tools.ts`
  - `tools/self-extension-tools.ts`

### Operational tracking features
- issue tracking / tracked issue lifecycle
  - `backends/issue-store.ts`
  - `tools/issue-tools.ts`
- task queue watchdog / autonomous-factory helpers
  - `services/task-queue-watchdog.ts`
  - related tests and CLI helpers

### Capture / exploration extras
- ApiTap capture and endpoint-to-skill scaffolding
  - `services/apitap-service.ts`
  - `tools/apitap-tools.ts`

### Optional ingestion / document utilities
- document parsing and conversion helpers
  - `tools/document-tools.ts`
  - `tools/converters/*`
  - `services/document-chunker.ts`
  - `services/python-bridge.ts`

These subsystems may share storage, config, or tool registration with the core. That does **not** make them core by default.

## High-level subsystem map

| Subsystem | Primary directories/files | Role |
|---|---|---|
| Storage core | `backends/`, `setup/init-databases.ts`, `types/memory.ts` | Durable fact persistence, vector storage, WAL, migrations |
| Retrieval core | `services/retrieval-*`, `services/recall-pipeline.ts`, `services/graph-retrieval.ts` | Structured + semantic + graph recall orchestration |
| Lifecycle integration | `lifecycle/`, `setup/register-hooks.ts`, `setup/plugin-service.ts` | OpenClaw runtime wiring |
| Primary tools | `tools/memory-tools.ts` and closely related tool modules | Agent-facing memory API |
| Trust/provenance | provenance + verification services/tools | Scope, provenance, verification semantics |
| Adjacent platform surfaces | dashboard/routes/health | Operator visibility |
| Adjacent learning/mining | reflection, workflows, crystallization, tool proposals | Meta-learning and self-improvement |
| Adjacent ops tracking | issue/task-queue helpers | Operational workflow support |
| Adjacent capture/utilities | ApiTap, document tools, converters | Optional extended capabilities |

## Protected core seams

Future refactors should preserve these seams even if modules are split or renamed.

### 1) Store boundary
The code that defines persistence semantics between SQLite, LanceDB, and WAL should remain explicit and centralized.

Why protect it:
- prevents accidental divergence between exact and semantic state
- keeps crash-recovery and write-path reasoning possible

### 2) Retrieval-mode boundary
Interactive retrieval and deep/offline retrieval should remain distinct modes with explicit budgets and behavior.

Why protect it:
- prevents hot-path latency regressions
- keeps advanced retrieval features from leaking into normal turns by accident

### 3) Lifecycle-stage boundary
Capture, recall, injection, and cleanup stages should remain explicit staged operations rather than a single opaque hook blob.

Why protect it:
- makes the runtime easier to reason about and test
- limits accidental cross-coupling when optional features are added

### 4) Core-tool contract boundary
The main agent memory tools should remain stable and conceptually small even if adjacent tools expand.

Why protect it:
- agent habits, docs, and prompt guidance depend on a stable core API
- reduces regression risk when adjacent feature areas evolve quickly

### 5) Provenance/scope boundary
Provenance, scope filtering, and verification semantics should stay first-class and close to the core memory path.

Why protect it:
- correctness and trust degrade quickly when provenance becomes optional or inconsistent
- supports different memory scopes without pretending all data is equal

## Retrieval, bootstrap, storage, and tooling boundaries

### Retrieval boundary
Retrieval is core, but not all retrieval-related computation belongs on the interactive path. Query expansion, graph expansion, reranking, and summarization should operate under explicit mode/budget rules.

### Bootstrap boundary
Bootstrap/setup should assemble the runtime, not become the place where every capability is tightly coupled. Registration should favor composable slices with explicit ownership.

### Storage boundary
Multiple stores are intentional:
- SQLite/FTS serves structured and exact retrieval well
- LanceDB serves semantic recall well
- WAL/crash-resilience exists to protect durability and recovery expectations

The right question is not “why are there multiple stores?” but “what are the consistency guarantees and failure semantics between them?”

### Tooling boundary
Core memory tools are part of the center. Advanced operational, analysis, mining, and productivity tools are allowed, but should remain recognizable as adjacent capability clusters.

## Refactor guidance this note is meant to unlock

This note should guide follow-on work such as:

- breaking up `backends/facts-db.ts` without dissolving the storage boundary
- unifying retrieval around explicit modes and budgets
- slimming bootstrap/registration assembly around clearer ownership slices
- reducing wide context-bag sprawl in tool registration and feature wiring

## README / contributor guidance

When describing the project externally, prefer language like:

- “hybrid memory plugin with adjacent operator and learning subsystems”
- “core runtime plus optional/adjacent capability clusters”

Avoid describing the entire repo as if every subsystem is equally central to the core memory runtime.
