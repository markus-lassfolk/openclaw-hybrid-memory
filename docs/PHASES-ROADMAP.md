# Hybrid Memory — Phases Roadmap

This document tracks the phased cleanup and improvement plan from the [combined recommendations](hybrid-memory-combined-recommendations). Phase 1 is implemented; Phase 2 and 3 are planned.

---

## Phase 1: Cleanup & Stabilization (done)

- **Domain converters removed from builtin**  
  Home Assistant, ESPHome, Victron VRM, and Zigbee2MQTT converters are no longer shipped with the memory plugin. Use a separate plugin (e.g. `openclaw-ha-converters`) and `registerConverter()` to add them back.

- **HyDE / query expansion disabled by default**  
  `queryExpansion.enabled` defaults to `false` in all presets. Set `queryExpansion: { enabled: true }` explicitly if you want HyDE-style query expansion.

- **Non-core features disabled by default**  
  Frustration detection, Hebbian link strengthening on recall, and all optional modules (nightly cycle, passive observer, workflow tracking, self-extension, crystallization, verification, provenance, aliases, cross-agent learning, reranking, contextual variants, documents) are off in every preset. Enable only what you need.

- **Hebbian on read path is opt-in**  
  New config: `graph.strengthenOnRecall` (default `false`). When `true`, facts recalled together get RELATED_TO links strengthened; when `false`, the read path no longer mutates the graph.

- **VectorDB single long-lived connection**  
  The plugin no longer calls `open()` / `removeSession()` per agent session. The VectorDB connection is kept open until plugin `stop()`, reducing reconnects and refcount issues.

---

## Phase 2: Performance & Stability (suggested)

Focus: **performance and stability** without large structural changes.

| Priority | Task | Rationale |
|----------|------|-----------|
| 1 | **Hard degradation mode** | When main-lane queue depth &gt; 10 or recall latency &gt; 5s, skip enrichment and use FTS-only + HOT facts. Add a `degraded` flag to recall result for observability. |
| 2 | **Per-stage timing in recall pipeline** | Wrap each stage (FTS, embed, vector, graph, rerank, pack) in a timer and log totals at debug. Essential for finding bottlenecks. |
| 3 | **Decompose `hooks.ts` into staged pipeline** | Replace the monolithic hook with 5 named stages (setup, recall, injection, capture, cleanup), each in its own file with config toggle and timeout. Dispatcher stays &lt;200 lines. |
| 4 | **Reduce prompt injections to max 3 blocks** | Merge recalled context into one `<recalled-context>` block; keep `<active-task>` if present; allow one optional warning block. Everything else tool-accessible only. |
| 5 | **Agent detection: downgrade to debug or fix** | If `agentId` is missing, log at debug (not warn) to cut noise; separately fix payload so agentId is present where expected. |
| 6 | **Replace module-level mutable state with PluginContext** | Pass a `PluginContext` object into subsystems instead of relying on 16+ module-level variables in `index.ts`. Prepares for concurrency and testing. |

---

## Phase 3: Modularization (suggested)

Focus: **optional features as modules or separate plugins**.

| Area | Suggested action |
|------|------------------|
| **Domain converters** | Already removed from builtin. Ship as optional plugin `openclaw-ha-converters` (or similar). |
| **Analysis & maintenance** | Dream cycle, monthly review, topic clusters, knowledge gaps, cross-agent learning, retrieval-aliases generation → optional “analysis” module, triggered by cron/CLI only. |
| **Learning & procedures** | Procedure extraction, workflow tracking, pattern detection, trajectory tracking, reinforcement extraction → optional “learning” module; procedure injection in core stays but capped and off by default. |
| **Self-extension** | Skill crystallization, tool proposals, memory-to-skills, self-correction extraction, persona proposals, contextual variants → optional “self-extension” module, batch/CLI only. |
| **Observability** | Issue store, verification store, provenance, memory diagnostics, context audit, cost tracking, health dashboard → optional “observability” module. |
| **Stable internal API** | Define a well-typed `MemoryPluginAPI` that optional modules depend on, to avoid circular deps and make modules testable. |

---

## Success metrics (from recommendations)

After Phase 1+2, targets:

| Metric | Before Phase 1 | Target |
|--------|----------------|--------|
| HyDE timeouts/day | 1,491 | 0 (disabled by default) |
| Recall pipeline timeouts/day | 808 | &lt;50 |
| VectorDB reconnects/day | 490 | &lt;10 |
| VectorDB refcount underflows/day | 148 | 0 |
| Main-lane waits &gt;60s | 1,748 | &lt;100 |
| Agent detection warnings/day | 2,296 | &lt;50 or debug-only |
| Prompt injection blocks per turn | Up to 11 | Max 3 |
| `hooks.ts` lines | 2,580 | &lt;200 (dispatcher) + stage files |

After Phase 3: core plugin ~35–40 source files, ~15K–20K lines; non-core features cannot cause recall failure.
