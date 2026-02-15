# OpenClaw Hybrid Memory

A **complete, ready-to-deploy memory system** for [OpenClaw](https://openclaw.ai) that combines two community approaches into one unified setup:

- **Structured + vector memory** (SQLite + FTS5 + LanceDB) from [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)
- **Hierarchical file memory** (MEMORY.md index + drill-down detail files) from [ucsandman](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)

This repo packages both into a single deployment flow (the **Hybrid Memory Manager v3.0**) with additional features: auto-capture, auto-recall, TTL-based decay, LLM auto-classification of facts, a backfill script, upgrade helpers, and comprehensive documentation.

## Start here: Hybrid Memory Manager v3.0

| Path | Description |
|------|-------------|
| **[docs/hybrid-memory-manager-v3.md](docs/hybrid-memory-manager-v3.md)** | **Full deployment reference:** four-part architecture, plugin install, config, MEMORY.md template, AGENTS.md Memory Protocol, **one deployment flow for any system** (§8) with optional backfill (seed + extract-daily; safe on new systems), verification, troubleshooting, CLI, upgrades. |
| **[docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)** | **AI-friendly setup prompt:** point an OpenClaw agent at this file and it will autonomously install, configure, backfill, and verify the full hybrid memory system. Includes sub-agent re-index step. |
| **[deploy/](deploy/)** | Merge-ready `openclaw.memory-snippet.json` (memory-hybrid + memorySearch, redacted) and deploy README. |
| **extensions/memory-hybrid/** | memory-hybrid plugin source (required for v3): SQLite+FTS5+LanceDB ([README](extensions/memory-hybrid/README.md)). |
| **[scripts/](scripts/)** | **Upgrade helpers:** after every OpenClaw upgrade, reinstall LanceDB in the extension dir and restart. Copy `post-upgrade.sh` and `upgrade.sh` to `~/.openclaw/scripts/`; use alias `openclaw-upgrade` for one-command upgrades (v3 §14, [scripts/README.md](scripts/README.md)). |

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

- Single deployment flow that works on new or existing systems
- Auto-capture and auto-recall lifecycle hooks
- LLM-based auto-classification of facts into categories
- Custom categories via config
- Confidence decay and automatic pruning
- SQLite safeguards for concurrent access (`busy_timeout`, WAL checkpointing)
- Dynamic backfill script (no hardcoded dates or section names)
- Timestamp migration for database consistency
- Upgrade helpers for post-`npm update` LanceDB reinstall
- AI-friendly autonomous setup prompt ([SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md))
- Comprehensive reference documentation ([v3 guide](docs/hybrid-memory-manager-v3.md))

## Original source material (archive)

The following are in **docs/archive/** for credit and history. Do not use the setup prompts to install; they target an older plugin version. Use the v3 guide or SETUP-AUTONOMOUS.md instead.

| Path | Description |
|------|-------------|
| **[docs/archive/clawdboss-permanent-memory-article.md](docs/archive/clawdboss-permanent-memory-article.md)** | Full text of "Give Your Clawdbot Permanent Memory" by Clawdboss.ai (Feb 13, 2026). |
| **[docs/archive/ucsandman-hierarchical-memory-system.md](docs/archive/ucsandman-hierarchical-memory-system.md)** | ucsandman's hierarchical memory system prompt and implementation steps. |
| **[docs/archive/hybrid-hierarchical-memory-guide.md](docs/archive/hybrid-hierarchical-memory-guide.md)** | Earlier v2.0 guide (pre-hybrid, memorySearch + hierarchical files only). |
| **docs/archive/SETUP-PROMPT-1..4** | Original pasteable setup prompts from the Clawdboss.ai article (historical only). |

## Quick start

Follow [v3 §8](docs/hybrid-memory-manager-v3.md): (1) workspace + memory dirs + bootstrap files, (2) install memory-hybrid plugin (§3 -- copy `extensions/memory-hybrid/`, run `npm install` in the plugin dir only), (3) merge [deploy/openclaw.memory-snippet.json](deploy/openclaw.memory-snippet.json) into `~/.openclaw/openclaw.json`, (4) restart, (5) optional backfill (seed script + `openclaw hybrid-mem extract-daily`; safe on new systems), (6) verify (§9).
