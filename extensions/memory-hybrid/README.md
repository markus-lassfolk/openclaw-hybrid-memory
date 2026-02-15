# OpenClaw memory-hybrid plugin

Hybrid memory plugin: **SQLite + FTS5** for structured facts and **LanceDB** for semantic search.

- **Source article:** [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) (Clawdboss.ai)
- **Repo:** This repo stores the full article text, setup prompts, and plugin source for reference and local installation.

## Files in this directory

| File | Description |
|------|-------------|
| `package.json` | npm package and OpenClaw extension entry |
| `openclaw.plugin.json` | Plugin manifest and config schema |
| `config.ts` | Decay classes, TTL defaults, config parsing |
| `index.ts` | Full plugin implementation (SQLite+FTS5, LanceDB, CLI, lifecycle hooks) |

All files are complete. Copy this directory into your OpenClaw extensions folder and follow the setup prompts in `docs/`.

## Installation

Use the four setup prompts in `docs/` (same as in the article):

1. **Prompt 1:** Create the plugin files (copy from this repo into your OpenClaw extensions directory).
2. **Prompt 2:** Install dependencies (`npm install` in the plugin dir and `better-sqlite3` in `~/.openclaw`).
3. **Prompt 3:** Configure `openclaw.json` and start the gateway.
4. **Prompt 4 (optional):** Seed from existing MEMORY.md / daily files.

## Dependencies

- `better-sqlite3` ^11.0.0
- `@lancedb/lancedb` ^0.23.0
- `openai` ^6.16.0
- `@sinclair/typebox` 0.34.47

Build tools required for `better-sqlite3`: C++ toolchain (e.g. `build-essential` on Linux, Visual Studio Build Tools on Windows), Python 3.
