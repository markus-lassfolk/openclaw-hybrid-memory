# OpenClaw Hybrid Memory

This repo stores the **Clawdboss.ai** article and plugin for giving your OpenClaw Clawdbot permanent, hybrid memory (SQLite + FTS5 + LanceDB).

## What’s in this repo

| Path | Description |
|------|-------------|
| **[docs/clawdboss-permanent-memory-article.md](docs/clawdboss-permanent-memory-article.md)** | Full text of the article “Give Your Clawdbot Permanent Memory” (narrative, problem, attempts, hybrid design, decay, checkpoints, TLDR, installation, setup prompts). |
| **docs/SETUP-PROMPT-1-CREATE-PLUGIN-FILES.md** | Pasteable prompt to create the plugin files in your OpenClaw extensions directory. |
| **docs/SETUP-PROMPT-2-INSTALL-DEPENDENCIES.md** | Pasteable prompt to install npm dependencies (Windows + Linux). |
| **docs/SETUP-PROMPT-3-CONFIGURE-AND-START.md** | Pasteable prompt to configure `openclaw.json` and start the gateway. |
| **docs/SETUP-PROMPT-4-SEED-FROM-MEMORY-FILES.md** | Optional prompt to seed from existing MEMORY.md / daily files. |
| **extensions/memory-hybrid/** | Full plugin source: `package.json`, `openclaw.plugin.json`, `config.ts`, `index.ts`, and [README](extensions/memory-hybrid/README.md). |
| **[docs/ucsandman-hierarchical-memory-system.md](docs/ucsandman-hierarchical-memory-system.md)** | Hierarchical memory system (index + drill-down): prompt and implementation steps by **ucsandman** ([GitHub](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System)). |
| **hybrid-hierarchical-memory-guide.md** | Separate best-practice guide for OpenClaw’s built-in three-layer memory (memory-lancedb + memorySearch + hierarchical files). |

## Sources & credits

- **Clawdboss.ai** — [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): hybrid plugin (SQLite + FTS5 + LanceDB), decay tiers, checkpoints. Full article and setup prompts in `docs/`; plugin in `extensions/memory-hybrid/`.
- **ucsandman** — [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): hierarchical MEMORY.md (lightweight index + drill-down detail files), token math, implementation steps. Captured in [docs/ucsandman-hierarchical-memory-system.md](docs/ucsandman-hierarchical-memory-system.md).

## Quick start (plugin from this repo)

1. Copy the four files from `extensions/memory-hybrid/` into your OpenClaw extensions directory (see [Prompt 1](docs/SETUP-PROMPT-1-CREATE-PLUGIN-FILES.md)).
2. Run the install and configure steps using [Prompts 2–4](docs/SETUP-PROMPT-2-INSTALL-DEPENDENCIES.md) in `docs/`.

## Relation to the other guide

- **hybrid-hierarchical-memory-guide.md** — How to use OpenClaw’s **built-in** memory (memory-lancedb slot + memorySearch + hierarchical `memory/` files). No custom plugin.
- **This repo’s plugin and article** — **Custom** memory-hybrid plugin (SQLite+FTS5+LanceDB) as described on Clawdboss.ai; use the article and setup prompts here to install it.
