# OpenClaw Hybrid Memory

A **complete, ready-to-deploy memory system** for [OpenClaw](https://openclaw.ai) that combines two community approaches into one unified setup:

- **Structured + vector memory** (SQLite + FTS5 + LanceDB) from [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)
- **Hierarchical file memory** (MEMORY.md index + drill-down detail files) from [ucsandman](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)

This repo packages both into a single deployment flow (the **Hybrid Memory Manager v3.0**) with additional features: auto-capture, auto-recall, TTL-based decay, LLM auto-classification of facts, a backfill script, upgrade helpers, and comprehensive documentation.

**Repository:** [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory) · **Documentation:** [v3 deployment guide](docs/hybrid-memory-manager-v3.md) · [Quick Start](#quick-start) below

## Quick Start

```bash
openclaw plugins install openclaw-hybrid-memory
```

Then set your [embedding API key](#prerequisites), run `openclaw hybrid-mem install` for full defaults, restart the gateway, and run `openclaw hybrid-mem verify [--fix]`.

**Need more detail?** Step-by-step options (including from-source install): [First install (best experience)](#first-install-best-experience). Full reference: [v3 deployment guide](docs/hybrid-memory-manager-v3.md).

## Prerequisites

- **OpenAI API key** — Required for the memory-hybrid plugin. It is used for:
  - **Embeddings** (default model: `text-embedding-3-small`) — vector search, auto-recall, storing facts, and optional features like find-duplicates and consolidate. The plugin will not load without a valid `embedding.apiKey` in config.
  - **Optional LLM features** (default model: `gpt-4o-mini`) — auto-classify, summarize-when-over-budget, and consolidate; these use the same key with configurable chat models.
- **memorySearch** (semantic search over `memory/**/*.md`) also requires an OpenAI embedding config if enabled; it can share the same key and model.
- **Google (Gemini) API** — Optional, for the **session distillation** pipeline. Processing and indexing **old session logs and historical memories** uses Gemini (recommended for its **1M+ token context window**). You need Gemini configured in OpenClaw and use `--model gemini` when running [scripts/distill-sessions/](scripts/distill-sessions/) (bulk sweep and nightly incremental). See [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md).

See [v3 §4 and §12](docs/hybrid-memory-manager-v3.md) for config and troubleshooting (invalid key, missing key, env vars).

## First install (best experience)

For a **great setup in one go** (all features, compaction prompts, nightly session-distillation job):

**Option A — Before first gateway start (no plugin loaded yet)**  
1. Copy `extensions/memory-hybrid/` into your OpenClaw extensions directory ([v3 §3](docs/hybrid-memory-manager-v3.md)) and run **`npm install`** inside it.  
2. From this repo, run **`node scripts/install-hybrid-config.mjs`** (or set `OPENCLAW_HOME` if needed). This writes `~/.openclaw/openclaw.json` with full defaults and the nightly job.  
3. Edit the config and set **`plugins.entries["openclaw-hybrid-memory"].config.embedding.apiKey`** to your OpenAI key (replace `YOUR_OPENAI_API_KEY`).  
4. Start the gateway, then run **`openclaw hybrid-mem verify [--fix]`**.

**Option B — After the plugin is already loaded**  
1. Run **`openclaw hybrid-mem install`** to merge full defaults and the nightly job into your existing config (use `--dry-run` to preview). Preserves your existing API key if set.  
2. Restart the gateway and run **`openclaw hybrid-mem verify [--fix]`**.

If something fails, error messages point you to **`openclaw hybrid-mem verify [--fix]`** for guidance; **`--fix`** can add missing config keys, the nightly job, and the memory dir. To revert to the default OpenClaw memory: **`openclaw hybrid-mem uninstall`** — OpenClaw works normally again; your data is kept unless you use `--clean-all`.

**Duplicate or “id mismatch” in logs?** Use the plugin **id** in config, not the npm package name: `plugins.slots.memory` = `"openclaw-hybrid-memory"` and `plugins.entries["openclaw-hybrid-memory"]`. Remove any backup extension folders (e.g. `memory-hybrid.bak-*`) from OpenClaw’s extensions directory so only one copy of the plugin loads.

## Start here: Hybrid Memory Manager v3.0

| Path | Description |
|------|-------------|
| **[docs/hybrid-memory-manager-v3.md](docs/hybrid-memory-manager-v3.md)** | **Full deployment reference:** four-part architecture, plugin install, config, MEMORY.md template, AGENTS.md Memory Protocol, **one deployment flow for any system** (§8) with optional backfill (seed + extract-daily; safe on new systems), verification, troubleshooting, CLI, upgrades. |
| **[docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)** | **AI-friendly setup prompt:** point an OpenClaw agent at this file and it will autonomously install, configure, backfill, and verify the full hybrid memory system. Includes sub-agent re-index step. |
| **[deploy/](deploy/)** | Merge-ready `openclaw.memory-snippet.json` (memory-hybrid + memorySearch, redacted) and deploy README. |
| **extensions/memory-hybrid/** | memory-hybrid plugin source (required for v3): SQLite+FTS5+LanceDB ([README](extensions/memory-hybrid/README.md)). |
| **[scripts/](scripts/)** | **Upgrade helpers:** after every OpenClaw upgrade, reinstall LanceDB in the extension dir and restart. Copy `post-upgrade.sh` and `upgrade.sh` to `~/.openclaw/scripts/`; use alias `openclaw-upgrade` for one-command upgrades (v3 §14, [scripts/README.md](scripts/README.md)). **Session distillation:** [scripts/distill-sessions/](scripts/distill-sessions/) — batch fact extraction from conversation logs; see [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md). |

## Credits & attribution

This project builds on the work of two authors from the OpenClaw community:

### Clawdboss.ai

**[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (February 13, 2026)

The memory-hybrid plugin in `extensions/memory-hybrid/` is based on the plugin architecture described in this article. The original design introduced: SQLite + FTS5 for structured fact storage, LanceDB for semantic vector search, decay tiers with TTL-based expiry, checkpoints, and the dual-backend approach. The full article text and original setup prompts are preserved in **docs/archive/** for credit and historical reference only; do not use those prompts to install — they target an older version. Use the v3 guide or SETUP-AUTONOMOUS.md for installation.

### ucsandman

**[OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)**

The hierarchical file memory layout (lightweight `MEMORY.md` index + drill-down detail files under `memory/`) originates from ucsandman's system. The original concept introduced: the index-plus-detail-files pattern, token-budget math for bootstrap files, and the directory structure (`memory/people/`, `memory/projects/`, `memory/technical/`, etc.). The original prompt and implementation steps are preserved in [docs/archive/ucsandman-hierarchical-memory-system.md](docs/archive/ucsandman-hierarchical-memory-system.md).

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
- Confidence decay and automatic pruning (periodic job; no external cron)
- SQLite safeguards for concurrent access (`busy_timeout`, WAL checkpointing)
- Timestamp migration for database consistency across schema versions
- Pre-compaction memory flush prompts so the model saves to **both** `memory_store` and daily files before context is truncated

## Original source material (archive)

The following are in **docs/archive/** for credit and history. Do not use the setup prompts to install; they target an older plugin version. Use the v3 guide or SETUP-AUTONOMOUS.md instead.

| Path | Description |
|------|-------------|
| **[docs/archive/clawdboss-permanent-memory-article.md](docs/archive/clawdboss-permanent-memory-article.md)** | Full text of "Give Your Clawdbot Permanent Memory" by Clawdboss.ai (Feb 13, 2026). |
| **[docs/archive/ucsandman-hierarchical-memory-system.md](docs/archive/ucsandman-hierarchical-memory-system.md)** | ucsandman's hierarchical memory system prompt and implementation steps. |
| **[docs/archive/hybrid-hierarchical-memory-guide.md](docs/archive/hybrid-hierarchical-memory-guide.md)** | Earlier v2.0 guide (pre-hybrid, memorySearch + hierarchical files only). |
| **docs/archive/SETUP-PROMPT-1..4** | Original pasteable setup prompts from the Clawdboss.ai article (historical only). |

**Quick path:** [Quick Start](#quick-start) — install from npm, then configure and verify.

**Manual / from source:** Follow [v3 §8](docs/hybrid-memory-manager-v3.md): (1) workspace + memory dirs + bootstrap files, (2) install memory-hybrid plugin (§3), (3) merge [deploy/openclaw.memory-snippet.json](deploy/openclaw.memory-snippet.json) into `~/.openclaw/openclaw.json`, (4) set API key, (5) restart, (6) `openclaw hybrid-mem verify [--fix]`. Optional backfill: seed script + `openclaw hybrid-mem extract-daily`.
