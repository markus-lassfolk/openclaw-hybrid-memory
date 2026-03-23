---
layout: default
title: Architecture Center
parent: Architecture & Internals
nav_order: 2
---
# Architecture Center: Core Runtime vs Adjacent Subsystems

This note defines the architectural center of `openclaw-hybrid-memory` so refactors can simplify around a stable core instead of treating every feature as equal-weight.

---

## Decision

The plugin is centered on a **memory runtime** for multi-agent continuity:

- capture durable memory from live interaction
- persist memory across multiple stores with explicit consistency semantics
- retrieve and inject relevant memory into active turns
- expose a minimal, stable memory tool/lifecycle API
- preserve provenance/trust signals required for safe memory behavior

Everything else is adjacent unless it is required for those behaviors.

---

## Core Runtime (Must Stay Core)

Core runtime is the set of modules that must remain cohesive and first-class:

| Capability | Primary ownership (module/files) | Why core |
|---|---|---|
| Plugin runtime boundary and context | `extensions/memory-hybrid/index.ts`, `extensions/memory-hybrid/api/plugin-runtime.ts`, `extensions/memory-hybrid/api/memory-plugin-api.ts`, `extensions/memory-hybrid/setup/plugin-service.ts` | Defines lifecycle, wiring, and runtime invariants |
| Storage core (facts + vectors + WAL) | `extensions/memory-hybrid/backends/facts-db.ts`, `extensions/memory-hybrid/backends/vector-db.ts`, `extensions/memory-hybrid/backends/wal.ts`, `extensions/memory-hybrid/services/wal-helpers.ts`, `extensions/memory-hybrid/utils/wal-replay.ts` | Durable write/read path and crash consistency |
| Retrieval core and orchestration | `extensions/memory-hybrid/services/retrieval-orchestrator.ts`, `extensions/memory-hybrid/services/recall-pipeline.ts`, `extensions/memory-hybrid/services/vector-search.ts`, `extensions/memory-hybrid/services/fts-search.ts`, `extensions/memory-hybrid/services/rrf-fusion.ts`, `extensions/memory-hybrid/services/reranker.ts` | Determines memory relevance and recall quality |
| Lifecycle integration | `extensions/memory-hybrid/setup/register-hooks.ts`, `extensions/memory-hybrid/lifecycle/hooks.ts`, `extensions/memory-hybrid/lifecycle/stage-capture.ts`, `extensions/memory-hybrid/lifecycle/stage-recall.ts`, `extensions/memory-hybrid/lifecycle/stage-injection.ts` | Connects memory runtime to agent turn flow |
| Primary memory tool API surface | `extensions/memory-hybrid/setup/register-tools.ts`, `extensions/memory-hybrid/tools/memory-tools.ts` | Stable external contract for memory operations |
| Core trust/provenance seams | `extensions/memory-hybrid/services/provenance.ts`, `extensions/memory-hybrid/tools/provenance-tools.ts`, `extensions/memory-hybrid/backends/event-log.ts` | Supports explainability/auditability for memory behavior |
| Core config/types | `extensions/memory-hybrid/config.ts`, `extensions/memory-hybrid/config/**`, `extensions/memory-hybrid/types/memory.ts` | Runtime behavior policy and compatibility surface |

---

## Adjacent Subsystems (Optional/Pluggable)

These are valuable, but they are not the architecture center and should evolve with looser coupling:

| Subsystem | Primary ownership (module/files) | Classification |
|---|---|---|
| Dashboard and HTTP routes | `extensions/memory-hybrid/routes/dashboard-server.ts`, `extensions/memory-hybrid/tools/dashboard-routes.ts`, `dashboard/` | Adjacent observability/UI surface |
| Workflow mining and pattern tracking | `extensions/memory-hybrid/backends/workflow-store.ts`, `extensions/memory-hybrid/services/workflow-tracker.ts`, `extensions/memory-hybrid/tools/workflow-tools.ts` | Adjacent learning/analytics layer |
| Issue tracking | `extensions/memory-hybrid/backends/issue-store.ts`, `extensions/memory-hybrid/tools/issue-tools.ts` | Adjacent operational state |
| Crystallization and self-extension | `extensions/memory-hybrid/backends/crystallization-store.ts`, `extensions/memory-hybrid/backends/tool-proposal-store.ts`, `extensions/memory-hybrid/services/crystallization-proposer.ts`, `extensions/memory-hybrid/services/skill-crystallizer.ts`, `extensions/memory-hybrid/services/tool-proposer.ts`, `extensions/memory-hybrid/tools/crystallization-tools.ts`, `extensions/memory-hybrid/tools/self-extension-tools.ts` | Adjacent autonomy/optimization features |
| ApiTap capture and tooling | `extensions/memory-hybrid/backends/apitap-store.ts`, `extensions/memory-hybrid/services/apitap-service.ts`, `extensions/memory-hybrid/tools/apitap-tools.ts` | Adjacent specialized ingestion |
| Advanced maintenance/analysis utilities | `extensions/memory-hybrid/services/reflection.ts`, `extensions/memory-hybrid/services/monthly-review.ts`, `extensions/memory-hybrid/services/continuous-verifier.ts`, `extensions/memory-hybrid/tools/verification-tools.ts`, `extensions/memory-hybrid/cli/cmd-verify.ts` | Adjacent maintenance plane |
| Optional document ingestion | `extensions/memory-hybrid/tools/document-tools.ts`, `extensions/memory-hybrid/services/document-chunker.ts`, `extensions/memory-hybrid/services/python-bridge.ts` | Adjacent opt-in ingestion pipeline |

---

## Explicit Constraints

1. **Multi-agent plugin first:** This runtime is primarily an OpenClaw multi-agent memory plugin, not a generic hostile multi-tenant SaaS backend.
2. **Multiple stores are intentional:** SQLite/FTS and LanceDB serve different retrieval modes; refactors must preserve this split and clarify consistency semantics rather than forcing naive consolidation.
3. **Consistency is explicit:** Any write/read path spanning stores must define ordering, idempotency, replay, and failure behavior (WAL + replay + reconciliation).
4. **Interactive vs deep retrieval differ:** Interactive turn-time recall prioritizes latency/predictability; deeper/offline retrieval can spend more latency/compute for completeness.
5. **Adjacent features must not back-drive core complexity:** Optional subsystems may consume core interfaces, but core runtime contracts should not become shaped by any one adjacent feature.
6. **Core contracts are stable:** Memory lifecycle hooks and primary memory tools are compatibility surfaces and should change conservatively.

---

## Subsystem Map

```text
openclaw-hybrid-memory
├── Core runtime (center)
│   ├── setup/ + api/ + index.ts           # runtime wiring and lifecycle boundaries
│   ├── backends/facts-db.ts               # structured memory store
│   ├── backends/vector-db.ts              # semantic memory store
│   ├── backends/wal.ts                    # cross-store durability
│   ├── lifecycle/stage-{capture,recall,injection}.ts
│   ├── services/retrieval-*.ts + recall-pipeline.ts
│   ├── tools/memory-tools.ts              # primary tool API
│   └── services/provenance.ts + event-log.ts
└── Adjacent subsystems
    ├── routes/ + dashboard/               # dashboard/UI
    ├── workflow/issue/crystallization/*   # learning and operations layers
    ├── self-extension/*                   # proposal and generation paths
    ├── apitap/*                           # browser capture specialization
    ├── verification/reflection/*          # analysis/maintenance layers
    └── document-tools + python-bridge     # optional ingestion
```

---

## Refactor Guardrails

- Changes that touch core runtime files should avoid importing adjacent stores/services directly; prefer narrow interfaces passed through `MemoryPluginAPI`.
- If an adjacent subsystem requires core data, add adapter/seam code in setup wiring instead of expanding core module responsibilities.
- If a proposal removes a store, it must replace current retrieval/latency/quality semantics and document migration + rollback.

