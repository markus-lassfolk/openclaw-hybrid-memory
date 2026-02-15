# OpenClaw Hybrid Memory

This repo stores everything needed to run and **reproduce** the **full hybrid memory system** : **Hybrid Memory Manager v3.0** — memory-hybrid (vector/DB) combined with file-based memory (memorySearch + hierarchical files) for the most capable setup. One deployment flow applies to any system (new or existing).

## Start here: Hybrid Memory Manager v3.0

| Path | Description |
|------|-------------|
| **[docs/hybrid-memory-manager-v3.md](docs/hybrid-memory-manager-v3.md)** | **Full deployment reference:** four-part architecture, plugin install, config, MEMORY.md template, AGENTS.md Memory Protocol, **one deployment flow for any system** (§8) with optional backfill (seed + extract-daily; safe on new systems), verification, troubleshooting, CLI, upgrades. |
| **[docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md)** | **AI-friendly setup prompt:** point an OpenClaw agent at this file and it will autonomously install, configure, backfill, and verify the full hybrid memory system. Includes sub-agent re-index step. |
| **[deploy/](deploy/)** | Merge-ready `openclaw.memory-snippet.json` (memory-hybrid + memorySearch, redacted) and deploy README. |
| **extensions/memory-hybrid/** | memory-hybrid plugin source (required for v3): SQLite+FTS5+LanceDB ([README](extensions/memory-hybrid/README.md)). |
| **[scripts/](scripts/)** | **Upgrade helpers:** after every OpenClaw upgrade, reinstall LanceDB in the extension dir and restart. Copy `post-upgrade.sh` and `upgrade.sh` to `~/.openclaw/scripts/`; use alias `openclaw-upgrade` for one-command upgrades (v3 §12, [scripts/README.md](scripts/README.md)). |

## What’s in this repo

| Path | Description |
|------|-------------|
| **hybrid-hierarchical-memory-guide.md** | Your v2.0 guide (built-in memory-lancedb + memorySearch + hierarchical files; pre–full-hybrid). |
| **[docs/clawdboss-permanent-memory-article.md](docs/clawdboss-permanent-memory-article.md)** | Full text of “Give Your Clawdbot Permanent Memory” (hybrid plugin, decay, checkpoints, setup prompts). |
| **docs/SETUP-PROMPT-1..4** | Pasteable prompts for memory-hybrid (create files, install deps, configure, seed). |
| **[docs/ucsandman-hierarchical-memory-system.md](docs/ucsandman-hierarchical-memory-system.md)** | ucsandman’s hierarchical index + drill-down prompt and steps. |

## Sources & credits

- **Clawdboss.ai** — [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): hybrid plugin (SQLite + FTS5 + LanceDB), decay tiers, checkpoints. Full article and setup prompts in `docs/`; plugin in `extensions/memory-hybrid/`.
- **ucsandman** — [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): hierarchical MEMORY.md (lightweight index + drill-down detail files), token math, implementation steps. Captured in [docs/ucsandman-hierarchical-memory-system.md](docs/ucsandman-hierarchical-memory-system.md).

## Quick start

Follow [v3 §8](docs/hybrid-memory-manager-v3.md): (1) workspace + memory dirs + bootstrap files, (2) install memory-hybrid plugin (§3 — copy `extensions/memory-hybrid/`, run `npm install` in the plugin dir only), (3) merge [deploy/openclaw.memory-snippet.json](deploy/openclaw.memory-snippet.json) into `~/.openclaw/openclaw.json`, (4) restart, (5) optional backfill (seed script + `openclaw hybrid-mem extract-daily`; safe on new systems), (6) verify (§9).
