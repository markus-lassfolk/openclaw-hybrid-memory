# Release Notes — OpenClaw Hybrid Memory 2026.4.10

**Date:** 2026-04-01  
**Previous baseline:** 2026.3.310

## Summary

**2026.4.10** is a **stability and clarity** release: interactive auto-recall is **time-bounded** and easier to tune, lifecycle hooks match **OpenClaw’s real hook names**, **entity-based recall** can pull names from your fact store when you have not listed any entities, and **documentation / tests** help keep mode presets and Phase 1 behavior from drifting apart.

---

## 1) Safer, more predictable interactive auto-recall

**What was wrong before:** Long-running or stuck recall work could keep a turn “busy” longer than you expect, and several toggles (HyDE-style expansion vs ambient multi-query) were hard to reason about together.

**What we changed:**

- The **interactive recall stage** now has a clear **wall-clock cap (~32 seconds)**. If time runs out, the stage **aborts cleanly** so bookkeeping (like in-flight counters) always resets — you should not get stuck in “recall forever” on the hot path.
- Inside that stage, the **vector step** (HyDE when allowed, embedding, Lance search) still uses a **separate ~26 second** budget in policy, so FTS and merge work are not starved.
- New config: **`autoRecall.interactiveEnrichment`** — **`fast`** | **`balanced`** | **`full`**
  - **`fast`**: skips HyDE on the interactive hot path and disables ambient multi-query — **shortest waits**, good default for chat turns when you care about latency.
  - **`balanced`**: previous-style behavior (respects query expansion and ambient settings).
  - **`full`**: more enrichment when your config allows it.
- **Mode presets** (`local`, `minimal`, `enhanced`, `complete`) that turn auto-recall on now default **`interactiveEnrichment: "fast"`** so presets stay **cost- and latency-conscious** out of the box.

**Docs:** [CONFIGURATION.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION.md) (auto-recall), [TROUBLESHOOTING.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TROUBLESHOOTING.md) (timeouts and **debug timing lines**).

---

## 2) OpenClaw hook alignment (issue #966)

**What was wrong before:** The plugin tried to use hook names that **OpenClaw does not dispatch**, which produced noise and could miss real subagent lifecycle events.

**What we changed:**

- **Subagents:** handlers now use **`subagent_spawned`** and **`subagent_ended`**, with flexible parsing of payload fields across core versions.
- **`before_consolidation`** is **no longer registered** — it is not part of OpenClaw’s supported hook set. Work that belongs before compaction continues to run on **`before_compaction`** (including WAL flush).

---

## 3) Entity lookup: auto-fill from facts (#952)

**What it does:** If **entity-based merge / lookup** is enabled but your **`entities`** list is **empty**, the plugin can **fill candidate names from facts already in SQLite** (`getKnownEntities`), capped by **`maxAutoEntities`** (default **500**, max **2000**). You can turn this off with **`autoFromFacts: false`**.

**Why it matters:** You get useful entity-scoped recall and merge behavior **without maintaining a duplicate entity list** by hand when the store already knows who appears in memory.

**Docs:** [CONFIGURATION.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION.md), [CONFIGURATION-MODES.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION-MODES.md), [EXAMPLES.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/EXAMPLES.md).

---

## 4) Documentation and guardrails

- **[CONFIGURATION-MODES.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION-MODES.md)** — Clarifies what **presets** intend vs what **Phase 1** forces at parse time, and points to the **preset sync test** so the doc and code do not drift.
- **New test:** `extensions/memory-hybrid/tests/config-presets-doc-sync.test.ts` — encodes those expectations in CI.
- **[TROUBLESHOOTING.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TROUBLESHOOTING.md)** — How to read **`memory-hybrid: … timing (ms) — FTS: … embed: … vector: …`** under **`OPENCLAW_LOG_LEVEL=debug`**, and how to interpret huge **FTS** times vs small **embed/vector** times.

---

## 5) CI and tests

- GitHub Actions updated (**checkout v6**, **paths-filter v4**, Node **24**-friendly JS action behavior).
- **Facts DB** test: reinforcement ranking case stabilized when **`diversityWeight`** is **0**.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.10
```

Restart the gateway after upgrading. If you rely on **balanced** or **full** interactive enrichment, set **`autoRecall.interactiveEnrichment`** explicitly — presets now bias toward **`fast`** where auto-recall is enabled.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)
- Issues: [#966](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/966) (hooks), [#952](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/952) (entity lookup)
