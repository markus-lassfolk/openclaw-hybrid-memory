# OpenClaw memory-hybrid plugin

Your OpenClaw agent forgets after each session. This plugin gives it **lasting memory**: structured facts (SQLite + FTS5) and semantic search (LanceDB), with auto-capture, auto-recall, TTL-based decay, LLM auto-classification, graph-based spreading activation for zero-LLM recall, and an optional credential vault. One install, one config—then your agent remembers preferences, decisions, and context across conversations.

Part of the [OpenClaw Hybrid Memory](https://github.com/markus-lassfolk/openclaw-hybrid-memory) v3 deployment.

**Repository:** [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory) · **Docs:** [v3 deployment guide](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/hybrid-memory-manager-v3.md) · [README / Quick Start](https://github.com/markus-lassfolk/openclaw-hybrid-memory#quick-start)

## Requirements

- **OpenAI API key** — Required. The plugin uses it for embeddings (default model `text-embedding-3-small`); without a valid `embedding.apiKey` in config the plugin does not load. Optional features (auto-classify, summarize, consolidate) use the same key with a chat model (e.g. `gpt-4o-mini`). See the [v3 guide](../../docs/hybrid-memory-manager-v3.md) §1.5 and §4.
- **Build tools** for `better-sqlite3`: C++ toolchain (e.g. `build-essential` on Linux, Visual Studio Build Tools on Windows), Python 3.

## Installation

**1. Install the plugin** (OpenClaw will place it in your extensions directory and run `npm install`):

```bash
openclaw plugins install openclaw-hybrid-memory
```

Or with npm directly: `npm i openclaw-hybrid-memory` in your OpenClaw extensions folder if you manage it yourself.

**2. Configure.** Set your OpenAI API key and enable the plugin. Easiest: run `openclaw hybrid-mem install` to merge full defaults (memory slot, compaction prompts, nightly session-distillation job) into `~/.openclaw/openclaw.json`, then set `plugins.entries["openclaw-hybrid-memory"].config.embedding.apiKey` to your key.

**3. Restart the gateway** and run **`openclaw hybrid-mem verify [--fix]`** to confirm SQLite, LanceDB, and the embedding API. Use `--fix` to add any missing config (e.g. embedding block, nightly job).

**More options:** [Quick Start](https://github.com/markus-lassfolk/openclaw-hybrid-memory#quick-start) and [v3 deployment guide](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/hybrid-memory-manager-v3.md) (manual config merge, from-source install).

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

## Credits

Based on the design in **[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (Clawdboss.ai). The plugin has since been extended with auto-capture, auto-recall, decay/TTL, auto-classify, token caps, consolidation, verify/uninstall CLI, and more — see the repo root and [hybrid-memory-manager-v3.md](../../docs/hybrid-memory-manager-v3.md).
