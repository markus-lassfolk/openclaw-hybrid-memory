# OpenClaw Hybrid Memory

[**Documentation**](https://markus-lassfolk.github.io/openclaw-hybrid-memory/) · [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory)

Your OpenClaw agent forgets everything between sessions. Preferences, decisions, technical context — all gone. You repeat yourself, and the agent can't build on past conversations.

**Hybrid Memory** fixes this. It gives your agent **durable, structured, searchable memory** that persists across sessions, auto-captures what matters, and recalls it when relevant — without you lifting a finger.

---

## Why you’ll want this — in plain English

**Short-term:** From day one, the agent stops starting from zero. It pulls in relevant memories before each reply — your preferences, past decisions, project context, and who/what you’ve mentioned — so you don’t have to repeat yourself. It also learns from how you react: when you say “great” or “that was wrong,” it uses that to reinforce or correct what it did, so the next time it leans into what worked and avoids what didn’t.

**Long-term:** The more you use it, the more **personal and tuned** it gets. It learns your wording (praise and frustration), your style, your language, and your recurring topics. It distills old conversations into lasting facts, reflects on patterns, and keeps the right things in context. You get an agent that **remembers you** and gets **better at giving the right context** over time — not a generic bot that forgets after every session.

- **Remembers you** — preferences, decisions, projects, and how you like to work  
- **Recalls the right stuff** — injects relevant memories automatically so answers are grounded in your history  
- **Learns from your reactions** — “good job” and “no, do it differently” shape what it reinforces and corrects  
- **Gets more personal over time** — learns your phrases, your patterns, and keeps improving recall and behavior  
- **Multilingual** — works in your language; detection and feedback learning adapt to the languages you use (run `build-languages` to add more)

If you want an agent that feels like it knows you and gets better with use, this is the extension for you. The rest of this doc explains how it works under the hood.

---

## Why use this? (under the hood)

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
- **Auto-capture** — automatically extracts preferences, decisions, facts, and entities from conversations
- **Auto-recall** — injects relevant memories into context each turn (configurable token budget)
- **Dual backend** — SQLite + FTS5 for fast structured lookups; LanceDB for semantic vector search (RRF merge)
- **Memory tiering** — hot/warm/cold tiers keep the most relevant facts in scope; compaction on session end ([docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md))
- **Multi-agent scoping** — global, user, agent, or session scope so specialists and orchestrators share the right memories ([docs/MEMORY-SCOPING.md](docs/MEMORY-SCOPING.md))
- **Hierarchical files** — `memory/` directory with drill-down files indexed by semantic search (memorySearch)
- **MEMORY.md index** — lightweight root index loaded every session; detail files loaded on demand

### Intelligence
- **Auto-classify** — background LLM reclassifies facts into proper categories (7 built-in + custom)
- **Category discovery** — LLM suggests new categories from your data patterns
- **Retrieval directives** — targeted recall by entity mention, keywords, task type, or session start (config: `autoRecall.retrievalDirectives`)
- **Query expansion** — optional LLM-expanded query before embedding for better semantic recall (config: `queryExpansion.enabled`; replaces deprecated HyDE options)
- **Auth failure auto-recall** — reactive memory trigger detects SSH/HTTP/API auth failures and automatically injects credentials ([docs/AUTH-FAILURE-AUTO-RECALL.md](docs/AUTH-FAILURE-AUTO-RECALL.md))
- **Reflection layer** — synthesizes behavioral patterns and rules from accumulated facts ([docs/REFLECTION.md](docs/REFLECTION.md))
- **Graph memory** — typed relationships between facts enable zero-LLM recall via graph traversal ([docs/GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md))
- **Session distillation** — batch-extracts durable facts from old conversation logs ([docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md))
- **Procedural memory** — extracts tool-call procedures from sessions, injects "last time this worked" in recall, auto-generates skills ([docs/PROCEDURAL-MEMORY.md](docs/PROCEDURAL-MEMORY.md))
- **Workflow crystallization & self-extension** — tool-sequence patterns, skill proposals (`memory_crystallize`), and tool proposals from usage gaps (`memory_propose_tool`); human approval required ([docs/CONFIGURATION.md](docs/CONFIGURATION.md), release notes 2026.3.70)

### Reliability
- **Write-ahead log (WAL)** — crash-resilient memory operations with automatic recovery ([docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md))
- **Decay & pruning** — TTL-based expiry (permanent / stable / active / session / checkpoint); automatic hourly prune ([docs/DECAY-AND-PRUNING.md](docs/DECAY-AND-PRUNING.md))
- **Deduplication** — fuzzy text hashing + embedding similarity detection + LLM-powered consolidation
- **Compaction flush** — saves to both `memory_store` and daily files before context is truncated
- **Scope promote** — CLI and cron job promote high-importance session-scoped facts to global ([docs/MEMORY-SCOPING.md](docs/MEMORY-SCOPING.md))

### Developer experience
- **Full CLI** — commands for stats, search, classify, consolidate, reflect, dream-cycle, scope promote, verify, install, uninstall, and more ([docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md))
- **One-command setup** — `openclaw hybrid-mem install` applies recommended config and **9 maintenance cron jobs** (nightly distill, memory-to-skills, self-correction, dream-cycle, weekly reflection, extract-procedures, deep-maintenance, persona-proposals, monthly consolidation)
- **Verify & fix** — `openclaw hybrid-mem verify --fix` diagnoses issues and adds any missing cron jobs
- **Clean uninstall** — `openclaw hybrid-mem uninstall` reverts to default memory; data kept unless `--clean-all`

### More features (Full mode and opt-in)
- **Agent and shared memories** — keep facts **agent-scoped** (per persona), **user-scoped** (per user), or **shared (global)** so specialists and orchestrators see the right memories; session-scoped working memory can be promoted to global ([docs/MEMORY-SCOPING.md](docs/MEMORY-SCOPING.md)).
- **Credential vault** — opt-in storage for API keys, tokens, passwords; encrypted when you set `credentials.encryptionKey`, or plaintext if you enable the vault without a key ([docs/CREDENTIALS.md](docs/CREDENTIALS.md)). In Full mode, when the vault is on, auto-detect and tool-call capture are enabled.
- **Persona proposals** — agent self-evolution with human approval (proposes identity file changes; human reviews via CLI). **On in Expert and Full.**
- **Auto-tagging** — regex-inferred topic tags for filtered queries ([docs/AUTO-TAGGING.md](docs/AUTO-TAGGING.md)). **On in Full** (languageKeywords.autoBuild).
- **Source dates** — optional field when storing: preserve when facts originated, not just when they were stored.
- **Configuration presets** — `mode: essential | normal | expert | full` (default: **full**) for one-shot feature toggles ([docs/CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md)).

---

## Quick Start

```bash
# 1. Install the plugin
openclaw plugins install openclaw-hybrid-memory

# 2. Apply recommended config (memory slot, compaction prompts, 9 maintenance cron jobs)
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

- **OpenClaw v2026.3.8+** (required) — the plugin enforces this minimum version at startup to ensure CLI subcommands and config reloads work.
- **Embedding access** (required) — for semantic search (auto-recall, store, ingest). Configure `embedding.apiKey` and `embedding.model` (e.g. `text-embedding-3-small`). The plugin will not load without valid embedding config.
- **Chat/completion access** (optional for basic memory) — required for distillation, reflection, auto-classify, query expansion, and other LLM-backed features. The plugin can call provider APIs **directly** (recommended: configure the **`llm`** block with `nano` / `default` / `heavy` tiers and per-provider API keys) or use gateway-derived models. See [docs/LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md) for tiers and provider setup.

---

## Documentation

### Getting started

| Document | Description |
|----------|-------------|
| **[README § Why you'll want this](README.md#why-youll-want-this--in-plain-english)** | Benefits in plain English: why use this, what you get short- and long-term |
| **[QUICKSTART.md](docs/QUICKSTART.md)** | Install, configure, verify — get running in 10 minutes |
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
| **[CLI-REFERENCE.md](docs/CLI-REFERENCE.md)** | All `openclaw hybrid-mem` commands by category |
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
| [MEMORY-TIERING.md](docs/MEMORY-TIERING.md) | Hot/warm/cold tiers, compaction, session-end hooks |
| [MEMORY-SCOPING.md](docs/MEMORY-SCOPING.md) | Global, user, agent, session scope; multi-agent; scope promote |
| [PERSONA-PROPOSALS.md](docs/PERSONA-PROPOSALS.md) | Persona proposals: agent self-evolution with human approval |
| [AUTO-TAGGING.md](docs/AUTO-TAGGING.md) | Auto-tagging: patterns, storage, tag-filtered search and recall |
| [DECAY-AND-PRUNING.md](docs/DECAY-AND-PRUNING.md) | Decay classes, TTLs, refresh-on-access, hard/soft prune |
| [CONFLICTING-MEMORIES.md](docs/CONFLICTING-MEMORIES.md) | Conflicting memories: classify-before-write, supersession, bi-temporal |
| [SEARCH-RRF-INGEST.md](docs/SEARCH-RRF-INGEST.md) | RRF fusion, ingest-files, query expansion (formerly HyDE) |
| [AUTOMATIC-CATEGORIES.md](docs/AUTOMATIC-CATEGORIES.md) | Automatic category discovery from "other" facts |
| [DYNAMIC-DERIVED-DATA.md](docs/DYNAMIC-DERIVED-DATA.md) | Index of dynamic/derived data: tags, categories, decay, supersession |
| [event-log.md](extensions/memory-hybrid/docs/event-log.md) | Episodic event log (Layer 1): passive session capture, Dream Cycle input (#150) |

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

This repo combines both approaches into a **unified system (v3.0)** and adds: auto-capture/recall lifecycle hooks, **memory tiering** (hot/warm/cold) and **multi-agent scoping**, **retrieval directives** and **query expansion** (#160), **LLM re-ranking** (#161), **contextual variants at index time** (#159), **multi-model embedding registry with RRF merge** (#158), **local embedding providers** (Ollama/ONNX, #153), **future-date decay protection** (#144), **episodic event log Layer 1** (#150), **verification store** (#162), **provenance tracing** (#163), **document ingestion** (PDF/DOCX/HTML/images, #206), **workflow crystallization** (skill proposals) and **self-extension** (tool proposals), graph-based spreading activation, reflection layer, session distillation pipeline, WAL crash resilience, auto-classification with category discovery, consolidation, deduplication, credential vault, persona proposals, **scope promote** and 9 maintenance cron jobs, full CLI, verify/fix diagnostics, one-command install, clean uninstall, and upgrade helpers.
