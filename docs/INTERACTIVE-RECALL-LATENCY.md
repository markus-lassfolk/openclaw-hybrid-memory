# Interactive recall latency (FTS) and session context

This note is for operators and OpenClaw core contributors debugging **long `before_agent_start` / auto-recall** stalls (e.g. WhatsApp **408 / Connection Closed** while the embedded run has not started).

## Why FTS can report 30–50s even with ~12k indexed rows

Row count alone does not cap work. Several factors stack:

1. **`facts.db` size** — Large files (e.g. tens of MB+) often mean **large `text` / `summary` / `why` columns** and **`fact_embeddings` BLOBs** in SQLite, not “millions of rows.” Full-row reads and joins are expensive.
2. **FTS `MATCH` expression size** — Long prompts are turned into **many OR‑joined terms**; a huge `MATCH` can dominate CPU and I/O.
3. **`busy_timeout`** — SQLite may wait up to the configured busy timeout (see plugin `SQLITE_BUSY_TIMEOUT_MS`) when another statement holds the connection; wall time can look like “FTS took 50s” when it is **wait + query**.
4. **Synchronous `node:sqlite` on the gateway thread** — Heavy SQLite work blocks the same process as the WebSocket / channel client; **stage timeouts** (`INTERACTIVE_RECALL_STAGE_TIMEOUT_MS`) abort the async recall stage but **cannot cancel** an in-flight synchronous query.
5. **Disk / AV / WSL** — Real-time antivirus or sync on the DB path, or slow I/O under WSL2, multiplies any of the above.

**Mitigations in hybrid-memory (plugin):** `interactiveFtsFastPath` on `FactsDB.search()` (auto-recall) caps OR terms and uses a two-phase id fetch to avoid loading full rows until the top FTS matches are chosen. **Operational:** `PRAGMA optimize`, backup + `VACUUM` if fragmentation is suspected, exclude `~/.openclaw` from aggressive real-time scanning on Windows.

**Workaround:** `plugins.entries.openclaw-hybrid-memory.config.autoRecall.enabled = false` disables recall on the hot path (confirms recall overlap with channel timeouts).

## Agent id on routed channels (e.g. WhatsApp)

If logs show **`Agent detection failed - no agentId in event payload or api.context`**, the plugin fell back to the **orchestrator** id for `currentAgentIdRef`, which can confuse **scope**, **event log**, and **session cleanup** (“main” vs routed agent).

**Preferred fix (OpenClaw gateway):** populate **`api.context.agentId`** (and related session fields) for every `before_agent_start` invocation on routed channels.

**Plugin-side:** `resolveAgentIdFromHookEvent()` in `lifecycle/resolve-agent-id.ts` also checks common event shapes (`session.agentId`, `session.agent`, `session.routedAgentId`, `run.agentId`, `context.agentId`, nested `activeAgent.id`). If your gateway uses a different key, add it there or align the payload with one of these.
