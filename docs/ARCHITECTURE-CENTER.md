---
layout: default
title: Architecture Center
parent: Architecture & Internals
nav_order: 3
---
# Architecture Center — Core Runtime vs Adjacent Subsystems

This note defines the architecture center of `openclaw-hybrid-memory` so refactors can simplify around a stable core instead of treating all capabilities as equal.

## Scope statement

The plugin is primarily a **multi-agent memory runtime** for OpenClaw.

It is **not** a generic hostile multi-tenant SaaS backend. Design choices should optimize local-agent continuity, reliability, and recall quality first.

## Core runtime (must stay core)

Core runtime is the minimal set required to preserve durable memory behavior across turns and restarts.

### 1. Storage core
- `extensions/memory-hybrid/backends/facts-db.ts`
- `extensions/memory-hybrid/backends/vector-db.ts`
- `extensions/memory-hybrid/backends/wal.ts`
- `extensions/memory-hybrid/services/wal-helpers.ts`
- `extensions/memory-hybrid/setup/init-databases.ts`

Responsibilities:
- Durable write/read primitives for structured + vector memory.
- Crash safety and recovery semantics.
- Data integrity constraints needed for recall.

### 2. Retrieval core
- `extensions/memory-hybrid/services/retrieval-orchestrator.ts`
- `extensions/memory-hybrid/services/fts-search.ts`
- `extensions/memory-hybrid/services/vector-search.ts`
- `extensions/memory-hybrid/services/merge-results.ts`
- `extensions/memory-hybrid/services/rrf-fusion.ts`
- `extensions/memory-hybrid/services/recall-pipeline.ts`
- `extensions/memory-hybrid/services/embeddings.ts`

Responsibilities:
- Query-to-context path that delivers relevant memory within token budget.
- Deterministic ranking/merge behavior across stores.
- Cost/latency-aware fallback behavior.

### 3. Lifecycle integration
- `extensions/memory-hybrid/lifecycle/hooks.ts`
- `extensions/memory-hybrid/lifecycle/stage-recall.ts`
- `extensions/memory-hybrid/lifecycle/stage-capture.ts`
- `extensions/memory-hybrid/lifecycle/stage-injection.ts`
- `extensions/memory-hybrid/setup/register-hooks.ts`
- `extensions/memory-hybrid/setup/plugin-service.ts`

Responsibilities:
- Hooking core retrieval/capture into OpenClaw lifecycle events.
- Startup/shutdown sequencing, timers, WAL replay, and non-crashing degradation.

### 4. Primary tool API surface
- `extensions/memory-hybrid/tools/memory-tools.ts`
- `extensions/memory-hybrid/setup/register-tools.ts`
- `extensions/memory-hybrid/api/memory-plugin-api.ts`
- `extensions/memory-hybrid/types/memory.ts`

Responsibilities:
- Canonical memory contract (`store`, `recall`, `forget`, `lookup`).
- Stable internal API for lifecycle and optional modules.

### 5. Trust/provenance seams that directly support memory behavior
- `extensions/memory-hybrid/services/provenance.ts`
- `extensions/memory-hybrid/backends/event-log.ts`
- `extensions/memory-hybrid/services/error-reporter.ts`

Responsibilities:
- Explainability and traceability for memory writes/recall.
- Operational trust signals and failure visibility for core flows.

## Adjacent subsystems (optional/capability modules)

Adjacent modules may ship in the same repo, but they should remain optional, configuration-gated, and dependent on the core API rather than redefining core contracts.

### Product-adjacent capabilities
- Dashboard / HTTP routes:
  - `extensions/memory-hybrid/routes/dashboard-server.ts`
  - `extensions/memory-hybrid/tools/dashboard-routes.ts`
  - `extensions/memory-hybrid/tools/health-dashboard.ts`
- Workflow mining and usage analytics:
  - `extensions/memory-hybrid/backends/workflow-store.ts`
  - `extensions/memory-hybrid/services/workflow-tracker.ts`
  - `extensions/memory-hybrid/services/pattern-detector.ts`
  - `extensions/memory-hybrid/tools/workflow-tools.ts`
- Issue tracking:
  - `extensions/memory-hybrid/backends/issue-store.ts`
  - `extensions/memory-hybrid/tools/issue-tools.ts`
- Crystallization / self-extension:
  - `extensions/memory-hybrid/backends/crystallization-store.ts`
  - `extensions/memory-hybrid/backends/tool-proposal-store.ts`
  - `extensions/memory-hybrid/services/skill-crystallizer.ts`
  - `extensions/memory-hybrid/services/tool-proposer.ts`
  - `extensions/memory-hybrid/tools/crystallization-tools.ts`
  - `extensions/memory-hybrid/tools/self-extension-tools.ts`
- Advanced maintenance / analysis utilities:
  - `extensions/memory-hybrid/services/dream-cycle.ts`
  - `extensions/memory-hybrid/services/consolidation.ts`
  - `extensions/memory-hybrid/services/monthly-review.ts`
  - `extensions/memory-hybrid/services/continuous-verifier.ts`
  - `extensions/memory-hybrid/tools/utility-tools.ts`
- Optional ingestion/document utilities:
  - `extensions/memory-hybrid/services/document-chunker.ts`
  - `extensions/memory-hybrid/services/python-bridge.ts`
  - `extensions/memory-hybrid/services/ingest-utils.ts`
  - `extensions/memory-hybrid/tools/document-tools.ts`

## Design constraints (explicit)

### Multi-agent first, not hostile multi-tenant SaaS
- Scope controls (`global/user/agent/session`) are correctness features for multi-agent workflows.
- Hard multi-tenant isolation patterns are out-of-scope unless product direction changes.

### Multiple stores are intentional
- SQLite/FTS and vector storage exist for complementary retrieval modes, not accidental duplication.
- Refactors must preserve explicit cross-store semantics:
  - Write order and recovery behavior.
  - Dedupe/supersession behavior.
  - Ranking and merge semantics.
  - Failure-mode behavior when one store degrades.

### Interactive vs non-interactive retrieval paths can diverge
- Interactive turn-time path (lifecycle recall) is latency-sensitive and token-budget constrained.
- Non-interactive/deep paths (maintenance, audits, distillation, analysis) may prioritize throughput and completeness over latency.
- Do not force both paths into one abstraction if that harms either SLA.

## Subsystem map and ownership boundaries

| Subsystem | Boundary | Primary modules/files |
|-----------|----------|-----------------------|
| Runtime composition | Core | `extensions/memory-hybrid/index.ts`, `extensions/memory-hybrid/api/memory-plugin-api.ts`, `extensions/memory-hybrid/setup/register-tools.ts`, `extensions/memory-hybrid/setup/register-hooks.ts` |
| Durable storage | Core | `extensions/memory-hybrid/backends/facts-db.ts`, `extensions/memory-hybrid/backends/vector-db.ts`, `extensions/memory-hybrid/backends/wal.ts` |
| Recall and ranking | Core | `extensions/memory-hybrid/services/retrieval-orchestrator.ts`, `extensions/memory-hybrid/services/rrf-fusion.ts`, `extensions/memory-hybrid/services/merge-results.ts`, `extensions/memory-hybrid/services/fts-search.ts` |
| Lifecycle glue | Core | `extensions/memory-hybrid/lifecycle/hooks.ts`, `extensions/memory-hybrid/lifecycle/stage-recall.ts`, `extensions/memory-hybrid/lifecycle/stage-capture.ts` |
| Memory tool contract | Core | `extensions/memory-hybrid/tools/memory-tools.ts`, `extensions/memory-hybrid/types/memory.ts` |
| Provenance/trust seam | Core-adjacent seam supporting core | `extensions/memory-hybrid/services/provenance.ts`, `extensions/memory-hybrid/backends/event-log.ts`, `extensions/memory-hybrid/tools/provenance-tools.ts` |
| Dashboard | Adjacent | `extensions/memory-hybrid/routes/dashboard-server.ts`, `extensions/memory-hybrid/tools/dashboard-routes.ts` |
| Workflow intelligence | Adjacent | `extensions/memory-hybrid/backends/workflow-store.ts`, `extensions/memory-hybrid/services/workflow-tracker.ts`, `extensions/memory-hybrid/tools/workflow-tools.ts` |
| Issue lifecycle | Adjacent | `extensions/memory-hybrid/backends/issue-store.ts`, `extensions/memory-hybrid/tools/issue-tools.ts` |
| Crystallization/self-extension | Adjacent | `extensions/memory-hybrid/backends/crystallization-store.ts`, `extensions/memory-hybrid/backends/tool-proposal-store.ts`, `extensions/memory-hybrid/tools/crystallization-tools.ts`, `extensions/memory-hybrid/tools/self-extension-tools.ts` |
| Documents/ingestion | Adjacent | `extensions/memory-hybrid/services/document-chunker.ts`, `extensions/memory-hybrid/services/python-bridge.ts`, `extensions/memory-hybrid/tools/document-tools.ts` |

## Refactor guardrails

- Core runtime changes must preserve lifecycle recall/capture behavior and crash-safe writes.
- Adjacent modules should be removable behind config flags without breaking core memory flows.
- New features should integrate via `MemoryPluginAPI` seams, not by deep coupling into `index.ts` internals.
