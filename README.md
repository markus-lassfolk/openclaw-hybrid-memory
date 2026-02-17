# OpenClaw Hybrid Memory

Your OpenClaw agent forgets between sessions. You repeat preferences, decisions, and context—and the agent can't build on past conversations.

The **Hybrid Memory Manager** gives your agent **durable memory**: it automatically captures what matters (preferences, facts, decisions), recalls it when relevant, and keeps it organized with TTL-based decay and optional credential storage. One deployment flow, one system—structured facts (SQLite + FTS5), semantic search (LanceDB), hierarchical file memory (MEMORY.md + drill-down), session distillation from old logs, and a full CLI to verify, classify, and maintain.

**Repository:** [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory) · **Documentation:** [v3 deployment guide](docs/hybrid-memory-manager-v3.md) · [Quick Start](#quick-start) below

## Quick Start (NPM)

```bash
openclaw plugins install openclaw-hybrid-memory
```

Then set your [embedding API key](#prerequisites), run `openclaw hybrid-mem install` for full defaults, restart the gateway, and run `openclaw hybrid-mem verify [--fix]`.

Other options: [Autonomous setup (AI)](#2-autonomous-setup-ai) · [Manual install](#3-manual-install) · [v3 deployment guide](docs/hybrid-memory-manager-v3.md)

## Prerequisites

- **OpenAI API key** — Required for the memory-hybrid plugin. It is used for:
  - **Embeddings** (default model: `text-embedding-3-small`) — vector search, auto-recall, storing facts, and optional features like find-duplicates and consolidate. The plugin will not load without a valid `embedding.apiKey` in config.
  - **Optional LLM features** (default model: `gpt-4o-mini`) — auto-classify, summarize-when-over-budget, and consolidate; these use the same key with configurable chat models.
- **memorySearch** (semantic search over `memory/**/*.md`) also requires an OpenAI embedding config if enabled; it can share the same key and model.
- **Google (Gemini) API** — Optional, for the **session distillation** pipeline. Processing and indexing **old session logs and historical memories** uses Gemini (recommended for its **1M+ token context window**). You need Gemini configured in OpenClaw and use `--model gemini` when running [scripts/distill-sessions/](scripts/distill-sessions/) (bulk sweep and nightly incremental). See [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md).

See [v3 §4 and §12](docs/hybrid-memory-manager-v3.md) for config and troubleshooting (invalid key, missing key, env vars).

## Installation

### 1. NPM (recommended)

1. **`openclaw plugins install openclaw-hybrid-memory`** — OpenClaw installs the plugin and its deps.
2. **`openclaw hybrid-mem install`** — Merges full defaults (memory slot, compaction prompts, nightly session-distillation job) into `~/.openclaw/openclaw.json`. Use `--dry-run` to preview. Preserves your existing API key if already set.
3. Set **`plugins.entries["openclaw-hybrid-memory"].config.embedding.apiKey`** to your OpenAI key (edit the config file or set it before step 2).
4. **Restart the gateway**, then run **`openclaw hybrid-mem verify [--fix]`** to confirm everything is working.

### 2. Autonomous setup (AI)

Point an OpenClaw agent at **[docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)**. The agent will autonomously install the plugin, configure it, run backfill if needed, and verify the setup. Best if you prefer to have the AI handle the steps for you.

### 3. Manual install

Copy `extensions/memory-hybrid/` into your OpenClaw extensions directory and run `npm install` there. Then run **`node scripts/install-hybrid-config.mjs`** (or set `OPENCLAW_HOME`) to write config with defaults, set your API key, start the gateway, and run **`openclaw hybrid-mem verify [--fix]`**. For full control (workspace dirs, bootstrap files, config merge by hand), follow [v3 §3 and §8](docs/hybrid-memory-manager-v3.md).

---

If something fails, **`openclaw hybrid-mem verify [--fix]`** reports issues and can add missing config (embedding block, nightly job, memory dir). To revert to default OpenClaw memory: **`openclaw hybrid-mem uninstall`** — your data is kept unless you use `--clean-all`.

**Duplicate or “id mismatch” in logs?** Use the plugin **id** in config: `plugins.slots.memory` = `"openclaw-hybrid-memory"` and `plugins.entries["openclaw-hybrid-memory"]`. Remove any backup extension folders (e.g. `memory-hybrid.bak-*`) so only one copy loads.

## Docs & reference

| Path | Description |
|------|-------------|
| **[docs/hybrid-memory-manager-v3.md](docs/hybrid-memory-manager-v3.md)** | Full deployment reference: architecture, config, MEMORY.md template, AGENTS.md Memory Protocol, manual flow (§8), verification, troubleshooting, CLI, upgrades. |
| **[docs/GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md)** | Graph-based spreading activation (FR-007): typed relationships, zero-LLM recall via graph traversal, auto-linking, configuration, and usage guide. |
| **[docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md)** | Write-Ahead Log (WAL) for crash resilience: architecture, configuration, recovery process, testing, and troubleshooting. |
| **[docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)** | Autonomous setup: point an OpenClaw agent at this file to install, configure, backfill, and verify (option 2 above). |
| **[deploy/](deploy/)** | Merge-ready `openclaw.memory-snippet.json` (memory-hybrid + memorySearch) and deploy README. |
| **extensions/memory-hybrid/** | Plugin source: SQLite+FTS5+LanceDB ([README](extensions/memory-hybrid/README.md)). |
| **[scripts/](scripts/)** | Upgrade helpers (post-upgrade reinstall, `openclaw-upgrade`). Session distillation: [scripts/distill-sessions/](scripts/distill-sessions/), [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md). |

---

## Credits & attribution

This project builds on the work of two authors from the OpenClaw community:

### Clawdboss.ai

**[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (February 13, 2026)

The memory-hybrid plugin in `extensions/memory-hybrid/` is based on the plugin architecture described in this article. The original design introduced: SQLite + FTS5 for structured fact storage, LanceDB for semantic vector search, decay tiers with TTL-based expiry, checkpoints, and the dual-backend approach. The full article text is in [docs/archive/](docs/archive/) for reference.

### ucsandman

**[OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)**

The hierarchical file memory layout (lightweight `MEMORY.md` index + drill-down detail files under `memory/`) originates from ucsandman's system. The original concept introduced: the index-plus-detail-files pattern, token-budget math for bootstrap files, and the directory structure (`memory/people/`, `memory/projects/`, `memory/technical/`, etc.). See [docs/archive/](docs/archive/) for the original material.

### What this repo adds

This repo combines both approaches into a unified system (v3.0) and adds:

**Deployment & operations**
- Single deployment flow that works on new or existing systems
- **Session distillation pipeline** ([docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md), [scripts/distill-sessions/](scripts/distill-sessions/)) — batch fact extraction from historical conversation logs; bulk one-time sweep + optional nightly incremental sweep to catch facts missed by auto-capture
- Dynamic backfill script (no hardcoded dates or section names; reads workspace and config)
- Upgrade helpers for post–OpenClaw-upgrade LanceDB reinstall ([scripts/](scripts/))
- **Verify CLI** (`openclaw hybrid-mem verify [--fix] [--log-file <path>]`) — checks config, SQLite, LanceDB, embedding API; optional fix suggestions and log scan
- **Uninstall CLI** (`openclaw hybrid-mem uninstall`) — restores default memory manager in config; optional `--clean-all` to remove data
- AI-friendly autonomous setup ([SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)) and full reference ([v3 guide](docs/hybrid-memory-manager-v3.md))

**Capture & recall**
- Auto-capture and auto-recall lifecycle hooks
- **Graph-based spreading activation (FR-007)** — typed relationships (SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON) between facts enable zero-LLM recall via graph traversal; finds conceptually/causally related items that vector search misses. See [GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md).
- **Token control:** configurable auto-recall token cap (`maxTokens`), per-memory truncation (`maxPerMemoryChars`), shorter injection format (`full` / `short` / `minimal`)
- **Summarize when over budget:** optional LLM summary of candidate memories when over token cap (2–3 sentences injected instead of a long list)
- Configurable recall limit and vector min score
- **Decay-class–aware recall** — boost permanent/stable facts when scores are close
- **Importance and recency** in composite score (optional)
- **Entity-centric recall** — when the prompt mentions an entity (e.g. user, owner), merge in lookup facts for that entity
- **Chunked long facts** — store a short summary for long facts; inject summary at recall to save tokens (full text still in DB and tools)

**Quality & deduplication**
- LLM-based auto-classification of “other” facts into categories (on a schedule and via CLI)
- Custom categories via config
- **Fuzzy text deduplication** — optional normalized-text hash so near-identical facts are not stored twice (`store.fuzzyDedupe`)
- **Find-duplicates CLI** — report pairs of facts with high embedding similarity (no merge; use before consolidate)
- **Consolidation job** — cluster similar facts, LLM-merge each cluster into one fact, store and delete cluster (`openclaw hybrid-mem consolidate`)

**Persistence & robustness**
- **Write-Ahead Log (WAL)** for crash resilience — pre-flight commit of memory operations with automatic recovery on startup (see [WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md))
- Confidence decay and automatic pruning (periodic job; no external cron)
- SQLite safeguards for concurrent access (`busy_timeout`, WAL checkpointing)
- Timestamp migration for database consistency across schema versions
- Pre-compaction memory flush prompts so the model saves to **both** `memory_store` and daily files before context is truncated

