# OpenClaw memory-hybrid plugin

Hybrid memory plugin: **SQLite + FTS5** for structured facts and **LanceDB** for semantic search. Part of the [OpenClaw Hybrid Memory](https://github.com/markus-lassfolk/openclaw-hybrid-memory) v3 deployment.

## Credits

Based on the design in **[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (Clawdboss.ai). The plugin has since been extended with auto-capture, auto-recall, decay/TTL, auto-classify, token caps, consolidation, verify/uninstall CLI, and more — see the repo root and [hybrid-memory-manager-v3.md](../../docs/hybrid-memory-manager-v3.md).

## Installation (use the v3 guide)

**Do not use the old setup prompts** in `docs/archive/` (SETUP-PROMPT-1..4). They target an older plugin version and do not match the current `index.ts` / `config.ts`. They are kept for **credit and history only**.

- **Install:** Follow the [Hybrid Memory Manager v3](../../docs/hybrid-memory-manager-v3.md) guide (§3, §8): copy this `memory-hybrid` directory into your OpenClaw extensions folder, run `npm install` in this directory, then configure and restart per v3.
- **Quick path:** See the repo root [README.md](../../README.md) and [SETUP-AUTONOMOUS.md](../../docs/SETUP-AUTONOMOUS.md) for the single deployment flow.

## Files in this directory

| File | Description |
|------|-------------|
| `package.json` | npm package and OpenClaw extension entry |
| `openclaw.plugin.json` | Plugin manifest and config schema |
| `config.ts` | Decay classes, TTL defaults, config parsing (incl. autoRecall, store, etc.) |
| `index.ts` | Plugin implementation (SQLite+FTS5, LanceDB, tools, CLI, lifecycle) |
| `versionInfo.ts` | Plugin and memory-manager version metadata |

## Dependencies

- `better-sqlite3` ^11.0.0
- `@lancedb/lancedb` ^0.23.0
- `openai` ^6.16.0
- `@sinclair/typebox` 0.34.47

Build tools required for `better-sqlite3`: C++ toolchain (e.g. `build-essential` on Linux, Visual Studio Build Tools on Windows), Python 3.
