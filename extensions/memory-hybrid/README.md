# OpenClaw `memory-hybrid` plugin (npm: `openclaw-hybrid-memory`)

This folder is the **published OpenClaw extension**: durable agent memory (structured store + semantic recall, auto-capture / auto-recall, configurable decay and maintenance, optional graph and credential vault).

**User-facing overview, scenarios, and install:** [Repository README](https://github.com/markus-lassfolk/openclaw-hybrid-memory#readme) · **[Documentation site](https://markus-lassfolk.github.io/openclaw-hybrid-memory/)** · [Quick start](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/QUICKSTART.md)

---

## Install & verify

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw hybrid-mem install
# Configure embedding (required) in ~/.openclaw/openclaw.json — see LLM-AND-PROVIDERS.md
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

Upgrade: `openclaw hybrid-mem upgrade` (then restart the gateway).

---

## Requirements (short)

| Requirement | Notes |
|-------------|--------|
| **Node.js** | `>=22.12.0` (`engines` in `package.json`) |
| **OpenClaw** | v2026.3.8+ (peer); current 2026.3.x recommended |
| **Embeddings** | Required — OpenAI, Ollama, ONNX, or Google; see [LLM-AND-PROVIDERS.md](../../docs/LLM-AND-PROVIDERS.md) |
| **Build toolchain** | For `@lancedb/lancedb`: C++ build tools + Python 3 on the install machine |

---

## Agent tools

All tools use **underscore** names (`memory_store`, `memory_recall`, …). Dotted aliases are invalid for some providers.

---

## Package layout

| Path | Role |
|------|------|
| `openclaw.plugin.json` | Manifest and config schema |
| `index.ts` | Plugin entry: stores, tools, CLI, lifecycle |
| `config.ts` | Defaults and config parsing |
| `backends/` | SQLite, LanceDB, event bus, etc. |
| `tools/` | Tool implementations and dashboard routes |
| `cli/` | `hybrid-mem` commands |
| `skills/hybrid-memory/` | Bundled Agent Skill (`SKILL.md` + references) |

---

## Deeper reference (repository docs)

| Topic | Doc |
|--------|-----|
| Full config | [CONFIGURATION.md](../../docs/CONFIGURATION.md) |
| CLI | [CLI-REFERENCE.md](../../docs/CLI-REFERENCE.md) |
| Architecture | [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) |
| Event bus API | [docs/event-bus.md](docs/event-bus.md) |
| Retrieval / RRF | [docs/rrf-retrieval.md](docs/rrf-retrieval.md), [RETRIEVAL-MODES.md](../../docs/RETRIEVAL-MODES.md) |
| Graph / contacts | [GRAPH-MEMORY.md](../../docs/GRAPH-MEMORY.md) |
| ONNX embeddings | [README](#local-onnx-embeddings-optional) below |

### Local ONNX embeddings (optional)

Install `onnxruntime-node` at **`~/.openclaw/extensions`** (one level above the plugin) so it survives upgrades:

```bash
npm install --prefix ~/.openclaw/extensions onnxruntime-node@^1.18.0
```

Then set `embedding.provider: "onnx"` in plugin config. See repository [TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md) if loading fails.

### Recall timing diagnostics

Optional `autoRecall.recallTiming` (`off` | `basic` | `verbose`) — see [INTERACTIVE-RECALL-LATENCY.md](../../docs/INTERACTIVE-RECALL-LATENCY.md) and [CONFIGURATION.md](../../docs/CONFIGURATION.md).

---

## Credits

Design lineage and a full list of extensions in this repo: [CREDITS-AND-ATTRIBUTION.md](../../docs/CREDITS-AND-ATTRIBUTION.md). Based on [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) (Clawdboss.ai).
