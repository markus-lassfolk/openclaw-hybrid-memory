# OpenClaw Hybrid Memory

[**Documentation**](https://markus-lassfolk.github.io/openclaw-hybrid-memory/) · [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory)

Your OpenClaw agent forgets everything between sessions. Preferences, decisions, technical context - all gone. You repeat yourself, and the agent can't build on past conversations.

**Hybrid Memory** fixes this. It gives your agent **durable, structured, searchable memory** that persists across sessions, auto-captures what matters, and recalls it when relevant - without you lifting a finger.

---

## Why use this?

| Without hybrid memory | With hybrid memory |
|----------------------|-------------------|
| Agent forgets everything between sessions | Agent remembers preferences, decisions, facts |
| You repeat context every time | Auto-recall injects relevant memories each turn |
| No structured knowledge base | SQLite + FTS5 for instant structured lookups |
| No semantic search over past conversations | LanceDB vector search finds fuzzy/contextual matches |
| Manual note-taking in files | Auto-capture from conversations + file-based memory |
| Stale memories never cleaned up | TTL-based decay automatically expires old facts |
| No crash protection for memory ops | Write-ahead log ensures nothing is lost |

---

## Features

### Core memory system
- **Auto-capture** - automatically extracts preferences, decisions, facts, and entities from conversations
- **Auto-recall** - injects relevant memories into context each turn (configurable token budget)
- **Dual backend** - SQLite + FTS5 for fast structured lookups; LanceDB for semantic vector search
- **Hierarchical files** - `memory/` directory with drill-down files indexed by semantic search (memorySearch)
- **MEMORY.md index** - lightweight root index loaded every session; detail files loaded on demand

### Intelligence
- **Auto-classify** — background LLM reclassifies facts into proper categories (7 built-in + custom)
- **Category discovery** — LLM suggests new categories from your data patterns
- **Auth failure auto-recall** — reactive memory trigger detects SSH/HTTP/API auth failures and automatically injects credentials ([docs/AUTH-FAILURE-AUTO-RECALL.md](docs/AUTH-FAILURE-AUTO-RECALL.md))
- **Reflection layer** — synthesizes behavioral patterns and rules from accumulated facts ([docs/REFLECTION.md](docs/REFLECTION.md))
- **Graph memory** — typed relationships between facts enable zero-LLM recall via graph traversal ([docs/GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md))
- **Session distillation** — batch-extracts durable facts from old conversation logs ([docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md))
- **Procedural memory** — extracts tool-call procedures from sessions, injects "last time this worked" in recall, auto-generates skills ([docs/PROCEDURAL-MEMORY.md](docs/PROCEDURAL-MEMORY.md))

### Reliability
- **Write-ahead log (WAL)** - crash-resilient memory operations with automatic recovery ([docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md))
- **Decay & pruning** - TTL-based expiry (permanent / stable / active / session / checkpoint); automatic hourly prune ([DECAY-AND-PRUNING.md](docs/DECAY-AND-PRUNING.md))
- **Deduplication** - fuzzy text hashing + embedding similarity detection + LLM-powered consolidation
- **Compaction flush** - saves to both `memory_store` and daily files before context is truncated

### Developer experience
- **Full CLI** - 34 commands for stats, search, classify, consolidate, reflect, verify, install, uninstall, and more ([docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md))
- **One-command setup** - `openclaw hybrid-mem install` applies all recommended config
- **Verify & fix** - `openclaw hybrid-mem verify --fix` diagnoses issues and applies safe fixes
- **Clean uninstall** - `openclaw hybrid-mem uninstall` reverts to default memory; data kept unless `--clean-all`

### Optional features
- **Credential vault** - opt-in encrypted storage for API keys, tokens, passwords ([docs/CREDENTIALS.md](docs/CREDENTIALS.md))
- **Persona proposals** - agent self-evolution with human approval (proposes identity file changes; human reviews via CLI)
- **Auto-tagging** - regex-inferred topic tags for filtered queries ([AUTO-TAGGING.md](docs/AUTO-TAGGING.md))
- **Source dates** - preserve when facts originated, not just when they were stored

---

## Quick Start

```bash
# 1. Install the plugin
openclaw plugins install openclaw-hybrid-memory

# 2. Apply recommended config (memory slot, compaction prompts, nightly job)
openclaw hybrid-mem install

# 3. Configure embedding (required) and optionally LLM preferences in ~/.openclaw/openclaw.json
#    See docs/LLM-AND-PROVIDERS.md — any provider the OpenClaw gateway supports works.

# 4. Restart and verify
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the full walkthrough.

**Other install options:**
- [Autonomous setup](docs/SETUP-AUTONOMOUS.md) - let an OpenClaw agent install it for you
- [Manual install](docs/QUICKSTART.md) - copy extension files and configure by hand

**If "plugin not found" blocks install:** Use `npx -y openclaw-hybrid-memory-install` or the [curl installer](https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh). See [UPGRADE-PLUGIN.md](docs/UPGRADE-PLUGIN.md#when-plugin-not-found-blocks-install).

---

## Prerequisites

- **Embedding access** (required) — for semantic search (auto-recall, store, ingest). Configure `embedding.apiKey` and `embedding.model` (e.g. `text-embedding-3-small`). The plugin will not load without valid embedding config.
- **Chat/completion access** (optional for basic memory) — required for distillation, reflection, auto-classify, and other LLM-backed features. All LLM calls go through the **OpenClaw gateway**; any provider the gateway supports works (OpenAI, Gemini, Claude, Groq, OpenRouter, Ollama, etc.). No provider-specific keys in the plugin; optional **`llm`** config defines model preference lists and fallback.

See [docs/LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md) for what LLMs are used for and how to configure them.

---

## Documentation

### Getting started

| Document | Description |
|----------|-------------|
| **[QUICKSTART.md](docs/QUICKSTART.md)** | Install, configure, verify - get running in 10 minutes |
| **[HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** | What happens each turn: auto-recall, auto-capture, background jobs, costs |
| **[DEEP-DIVE.md](docs/DEEP-DIVE.md)** | Storage internals, search algorithms, tags, links, supersession, deduplication |
| **[EXAMPLES.md](docs/EXAMPLES.md)** | Real-world recipes: project setup, tuning, tags, backfilling, maintenance routines |
| **[FAQ.md](docs/FAQ.md)** | Common questions: cost, providers, backups, resets, troubleshooting quick answers |

### Reference

| Document | Description |
|----------|-------------|
| **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Four-part hybrid architecture, workspace layout, bootstrap files |
| **[CONFIGURATION.md](docs/CONFIGURATION.md)** | Full `openclaw.json` reference |
| **[LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md)** | Prerequisites, what LLMs are used for, gateway routing, `llm` config |
| **[FEATURES.md](docs/FEATURES.md)** | Categories, decay, tags, auto-classify, source dates; index of [per-feature docs](docs/FEATURES.md#feature-documentation-by-topic) |
| **[CLI-REFERENCE.md](docs/CLI-REFERENCE.md)** | All 34 `openclaw hybrid-mem` commands |
| **[MEMORY-PROTOCOL.md](docs/MEMORY-PROTOCOL.md)** | Paste-ready AGENTS.md block |

### Operations

| Document | Description |
|----------|-------------|
| **[OPERATIONS.md](docs/OPERATIONS.md)** | Background jobs, cron, scripts, upgrading OpenClaw and the plugin |
| **[UNINSTALL.md](docs/UNINSTALL.md)** | How to uninstall: revert to default memory, optional data removal |
| **[UPGRADE-OPENCLAW.md](docs/UPGRADE-OPENCLAW.md)** | What to do after every OpenClaw upgrade (native deps, post-upgrade script) |
| **[UPGRADE-PLUGIN.md](docs/UPGRADE-PLUGIN.md)** | Upgrading the hybrid-memory plugin: NPM/manual, migrations, config |
| **[BACKUP.md](docs/BACKUP.md)** | What to back up (SQLite, LanceDB, vault, etc.) and how to restore |
| **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** | Common issues, API key behaviour, diagnostics |
| **[MAINTENANCE.md](docs/MAINTENANCE.md)** | File hygiene, periodic review |

### Feature deep-dives

| Document | Description |
|----------|-------------|
| [PERSONA-PROPOSALS.md](docs/PERSONA-PROPOSALS.md) | Persona proposals: agent self-evolution with human approval |
| [AUTO-TAGGING.md](docs/AUTO-TAGGING.md) | Auto-tagging: patterns, storage, tag-filtered search and recall |
| [DECAY-AND-PRUNING.md](docs/DECAY-AND-PRUNING.md) | Decay classes, TTLs, refresh-on-access, hard/soft prune |
| [CONFLICTING-MEMORIES.md](docs/CONFLICTING-MEMORIES.md) | Conflicting memories: classify-before-write, supersession, bi-temporal |
| [AUTOMATIC-CATEGORIES.md](docs/AUTOMATIC-CATEGORIES.md) | Automatic category discovery from "other" facts |
| [DYNAMIC-DERIVED-DATA.md](docs/DYNAMIC-DERIVED-DATA.md) | Index of dynamic/derived data: tags, categories, decay, supersession |

### Specialized

| Document | Description |
|----------|-------------|
| [CREDENTIALS.md](docs/CREDENTIALS.md) | Credential vault (opt-in encrypted store) |
| [SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md) | Extracting facts from session logs |
| [PROCEDURAL-MEMORY.md](docs/PROCEDURAL-MEMORY.md) | Auto-generated skills from learned tool-call patterns (issue #23) |
| [GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md) | Graph-based fact linking |
| [WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md) | Write-ahead log design |
| [REFLECTION.md](docs/REFLECTION.md) | Reflection layer (pattern synthesis) |
| [SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md) | AI-friendly autonomous setup |

---

## Persona Proposals (opt-in)

**Agent self-evolution with human approval** - agents propose changes to identity files based on observed patterns; humans review and approve via CLI. Enable with `"personaProposals": { "enabled": true }`. Agent tools: `persona_propose`, `persona_proposals_list`. Human-only CLI: `openclaw proposals review <id> <approve|reject>`, `openclaw proposals apply <id>`.

→ Full doc: [PERSONA-PROPOSALS.md](docs/PERSONA-PROPOSALS.md) (config, safety, workflow).

---

## Credits & Attribution

### Clawdboss.ai

**[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (February 13, 2026)

The memory-hybrid plugin is based on this article's plugin architecture: SQLite + FTS5 for structured facts, LanceDB for semantic vector search, decay tiers with TTL-based expiry, checkpoints, and the dual-backend approach.

### ucsandman

**[OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)**

The hierarchical file memory layout (lightweight `MEMORY.md` index + drill-down detail files under `memory/`) originates from this system: the index-plus-detail-files pattern, token-budget math, and the directory structure.

### What this repo adds

This repo combines both approaches into a **unified system (v3.0)** and adds: auto-capture/recall lifecycle hooks, graph-based spreading activation, reflection layer, session distillation pipeline, WAL crash resilience, auto-classification with category discovery, consolidation, deduplication, credential vault, persona proposals, full CLI (34 commands), verify/fix diagnostics, one-command install, clean uninstall, and upgrade helpers.
