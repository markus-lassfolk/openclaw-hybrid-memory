# Hybrid Memory — Phases Roadmap

This document tracks the phased cleanup and improvement plan from the combined recommendations report. Phase 1 and Phase 2 are done; Phase 3 is planned.

---

## Phase 1: Cleanup & Stabilization (done)

- **Domain converters removed from builtin**  
  Home Assistant, ESPHome, Victron VRM, and Zigbee2MQTT converters are no longer shipped with the memory plugin. Use a separate plugin (e.g. `openclaw-ha-converters`) and `registerConverter()` to add them back.

- **HyDE / query expansion removed from use (Phase 1)**  
  HyDE was a major source of timeouts (1,491/day). In 2026.3.140+ the Phase 1 migration **forces** `queryExpansion.enabled: false` for all configs — you cannot turn it back on in this version. The code path remains for a future opt-in; config and recall paths still check `queryExpansion.enabled` and skip the LLM call when false.

- **Non-core features disabled by default**  
  Frustration detection, Hebbian link strengthening on recall, and all optional modules (nightly cycle, passive observer, workflow tracking, self-extension, crystallization, verification, provenance, aliases, cross-agent learning, reranking, contextual variants, documents) are off in every preset. Enable only what you need.

- **Hebbian on read path is opt-in**  
  New config: `graph.strengthenOnRecall` (default `false`). When `true`, facts recalled together get RELATED_TO links strengthened; when `false`, the read path no longer mutates the graph.

- **VectorDB single long-lived connection**  
  The plugin no longer calls `open()` / `removeSession()` per agent session. The VectorDB connection is kept open until plugin `stop()`, reducing reconnects and refcount issues.

---

## Phase 2: Performance & Stability (done)

Focus: **performance and stability** without large structural changes.

| Priority | Task | Rationale | Status |
|----------|------|-----------|--------|
| 1 | **Hard degradation mode** | When main-lane queue depth &gt; 10 or recall latency &gt; 5s, skip enrichment and use FTS-only + HOT facts. Add a `degraded` flag to recall result for observability. | **Done** — `recallInFlightRef`, `degradationQueueDepth`/`degradationMaxLatencyMs`, FTS-only+HOT path, `<!-- recall degraded: queue|latency -->` marker. |
| 2 | **Per-stage timing in recall pipeline** | Wrap each stage (FTS, embed, vector, graph, rerank, pack) in a timer and log totals at debug. Essential for finding bottlenecks. | **Done** — FTS, embed, vector, merge timed in auto-recall path; debug log with totals. |
| 3 | **Decompose `hooks.ts` into staged pipeline** | Replace the monolithic hook with 5 named stages (setup, recall, injection, capture, cleanup), each in its own file with config toggle and timeout. Dispatcher stays &lt;200 lines. | **Done** — All stages in `lifecycle/stage-*.ts` (setup, recall, injection, capture, cleanup); session state in `session-state.ts`; active-task, auth-failure, credential-hint, frustration in separate stage modules. Dispatcher `hooks.ts` &lt;200 lines. |
| 4 | **Reduce prompt injections to max 3 blocks** | Merge recalled context into one `<recalled-context>` block; keep `<active-task>` if present; allow one optional warning block. Everything else tool-accessible only. | **Done** — Single `<recalled-context>` via `wrapRecalledContext`; active-task and one optional warning remain separate. |
| 5 | **Agent detection: downgrade to debug or fix** | If `agentId` is missing, log at debug (not warn) to cut noise; separately fix payload so agentId is present where expected. | **Done** — Both agent-detection messages log at `api.logger.debug`. |
| 6 | **Replace module-level mutable state with PluginContext** | Pass a `PluginContext` object into subsystems instead of relying on 16+ module-level variables in `index.ts`. Prepares for concurrency and testing. | **Done** — Single `pluginContext` built in `index.ts`, passed to `registerLifecycleHooks` and `registerTools`. |
| 7 | **Cleanup cron jobs for removed/disabled features** | Remove or disable scheduled jobs that only served functionality that has been removed or is now off by default (e.g. nightly cycle, passive observer, cross-agent learning), so they do not run unnecessarily. Can be done in Phase 2 or 3. | **Done** — `nightly-dream-cycle` gated by `featureGate: "nightlyCycle.enabled"`; not installed when disabled. |

---

## Phase 3: Modularization (suggested)

Focus: **optional features as modules or separate plugins**.

| Area | Suggested action | Status |
|------|------------------|--------|
| **Domain converters** | Already removed from builtin. Ship as optional plugin `openclaw-ha-converters` (or similar). | **Done** — Built-in registry is empty; implementations remain in-tree for tests; use `registerConverter()` to add back. |
| **Analysis & maintenance** | Dream cycle, monthly review, topic clusters, knowledge gaps, cross-agent learning, retrieval-aliases generation → optional “analysis” module, triggered by cron/CLI only. | — |
| **Learning & procedures** | Procedure extraction, workflow tracking, pattern detection, trajectory tracking, reinforcement extraction → optional “learning” module; procedure injection in core stays but capped and off by default. | — |
| **Self-extension** | Skill crystallization, tool proposals, self-correction extraction, persona proposals, contextual variants → optional “self-extension” module, batch/CLI only. | — |
| **Observability** | Issue store, verification store, provenance, memory diagnostics, context audit, cost tracking, health dashboard → optional “observability” module. | — |
| **Stable internal API** | Define a well-typed `MemoryPluginAPI` that optional modules depend on, to avoid circular deps and make modules testable. | **Done** — `api/memory-plugin-api.ts` defines `MemoryPluginAPI`; index builds one implementation; `registerTools` and `registerLifecycleHooks` accept it; optional modules can depend on this type only. |

---

## Success metrics (from recommendations)

After Phase 1+2, targets:

| Metric | Before Phase 1 | Target |
|--------|----------------|--------|
| HyDE timeouts/day | 1,491 | 0 (Phase 1: forced off in 2026.3.140+) |
| Recall pipeline timeouts/day | 808 | &lt;50 |
| VectorDB reconnects/day | 490 | &lt;10 |
| VectorDB refcount underflows/day | 148 | 0 |
| Main-lane waits &gt;60s | 1,748 | &lt;100 |
| Agent detection warnings/day | 2,296 | &lt;50 or debug-only |
| Prompt injection blocks per turn | Up to 11 | Max 3 |
| `hooks.ts` lines | 2,580 | &lt;200 (dispatcher) + stage files |

After Phase 3: core plugin ~35–40 source files, ~15K–20K lines; non-core features cannot cause recall failure.

---

## Recall hot path (default / tight ship)

The reports called out **overlapping recall features** causing delays, lag, and diminishing returns. After Phase 1+2 the default path is optimized:

**Always off (forced or default):**
- **HyDE / query expansion** — forced off (2026.3.140+). No LLM call on recall.
- **Ambient multi-query** — default off (no preset enables it). Topic-shift multi-query and issue retrieval only run if user enables `ambient.enabled`.
- **Frustration detection** — forced off. No frustration hint injection.
- **Hebbian on read** — forced off. No graph mutation during recall.
- **Reranking, cross-agent learning, contextual variants, etc.** — forced off.

**When overloaded (hard degradation):**
- If queue depth &gt; 10 or recall latency &gt; 5s → **FTS-only + HOT facts** only. No vector, graph, procedures, or ambient.

**Capped / bounded:**
- **Procedure injection** — `procedures.maxInjectionTokens` (default 500). Cannot dominate the prompt.
- **Prompt blocks** — max 3: one `<recalled-context>`, optional `<active-task>`, one optional warning.

**Still on by preset (user can turn off):**
- **Entity lookup** — enhanced/complete presets set `autoRecall.entityLookup.enabled: true`. Local/minimal keep it off.
- **Graph in recall** — minimal+ have `graph.useInRecall: true` (zero-LLM expansion from seeds).
- **Procedures** — minimal+ have procedures enabled (but capped).
- **HOT tier** — minimal+ have memory tiering (bounded by `hotMaxTokens`).

**Essential mode = local-only, zero LLM/API calls.**  
Local preset sets `retrieval.strategies: ["fts5"]`. Recall and capture then use **only** SQLite FTS and local files — no embedding, no vector search, no HyDE, no chat LLM. You get persistent structured memory, auto-capture, auto-recall by keyword, and WAL — still well above vanilla OpenClaw (which has no durable memory). Minimal/enhanced/complete add semantic (embedding + LanceDB) and the optional layers above; Minimal uses only nano/flash-tier LLM for distill and auto-classify. The worst latency sources (HyDE, ambient, frustration, Hebbian) remain removed or default-off.

---

## Recommendations alignment (combined report)

Compared with `hybrid-memory-combined-recommendations.md`:

**Phase 1 (all done):** 1.1 HyDE → forced off. 1.2 Hard degradation → done (Phase 2). 1.3 Ambient by default → default off (no preset enables it). 1.4 Frustration by default → forced off. 1.5 Hebbian by default → `strengthenOnRecall: false`. 1.6 Agent detection → debug log. 1.7 Per-stage timing → done.

**Phase 2 (all done):** 2.1 Decompose hooks → staged pipeline. 2.2 Max 3 blocks → single `<recalled-context>`. 2.3 VectorDB lifecycle → single long-lived connection. 2.4 PluginContext → single `pluginContext` + Phase 3 `MemoryPluginAPI`.

**Optional fast fixes (done):**
- **Credential auto-detect:** Forced `credentials.autoDetect: false` in Phase 1 migration (2026.3.140+). User must set explicitly to enable; aligns with "make auto-detect opt-in".
- **Procedure injection cap:** Added `procedures.maxInjectionTokens` (default 500). Procedure block is trimmed from the end until within cap before injection so procedure context cannot dominate recall.
