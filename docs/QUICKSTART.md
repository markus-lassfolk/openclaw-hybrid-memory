---
layout: default
title: Quick Start
parent: Getting Started
nav_order: 1
---
# Quick Start - Hybrid Memory Plugin

Get an agent that **remembers you** and **gets better at giving the right context** over time - in about 10 minutes. For full configuration options see [CONFIGURATION.md](CONFIGURATION.md); for architecture background see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- **OpenClaw v2026.3.8+** (minimum — matches plugin peer dependency and startup warning): use a **recent 2026.3.x** release in practice; CI resolves a specific `openclaw` in `extensions/memory-hybrid/package-lock.json`.
- **Embedding access** (required): configure `embedding.provider` and related settings so the plugin can generate embedding vectors. Four providers are supported:
  - **OpenAI** (default): set `embedding.apiKey` and `embedding.model` (e.g. `text-embedding-3-small`).
  - **Ollama**: set `embedding.provider: "ollama"` and `embedding.model` (e.g. `nomic-embed-text`). No API key required — Ollama must be running locally.
  - **ONNX**: set `embedding.provider: "onnx"` and `embedding.model` (e.g. `all-MiniLM-L6-v2`). Fully local; install `onnxruntime-node` first.
  - **Google**: set `embedding.provider: "google"` and `llm.providers.google.apiKey`. Uses `gemini-embedding-001` via Gemini API.
  
  Use `embedding.preferredProviders` for automatic failover between providers (e.g. `["ollama", "openai"]`). See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-providers) for full details.
- **Chat/completion** (optional for basic memory): needed for distillation, reflection, auto-classify, etc. Any provider the OpenClaw gateway supports works; optional **`llm`** config sets model preference lists. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md).
- **Node.js `>=22.12.0`** with npm (plugin `engines` field).

---

## 1. Install the plugin

**Recommended (NPM):** OpenClaw installs the plugin into `~/.openclaw/extensions` and runs `npm install` (including a `postinstall` that rebuilds `@lancedb/lancedb` if needed). If you ever see "duplicate plugin id detected", run once: `./scripts/use-npm-only.sh` from this repo so only the NPM copy is used.

```bash
openclaw plugins install openclaw-hybrid-memory
```

If the installer shows a warning about "dangerous code patterns" or "credential harvesting", it is a false positive — the plugin only uses your configured API keys (OpenAI, Google, or none for local providers) with the respective embedding APIs, and never exfiltrates credentials. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#install-warning-dangerous-code-patterns--credential-harvesting).

**Manual (copy from repo):** Copy `extensions/memory-hybrid/` into your OpenClaw extensions directory:

- **Linux:** `~/.npm-global/lib/node_modules/openclaw/extensions/memory-hybrid/` or `/usr/lib/node_modules/openclaw/extensions/memory-hybrid/`
- **Windows:** `%APPDATA%\npm\node_modules\openclaw\extensions\memory-hybrid\`

Then install dependencies **in the extension directory**:

```bash
cd <path-to-extensions>/memory-hybrid
npm install
```

If `npm install` fails due to `devDependencies` referencing `"openclaw": "workspace:*"`, remove them first:

```bash
node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
npm install
```

If `@lancedb/lancedb` fails to build, install the C++ build toolchain (Linux: `build-essential`, `python3`; Windows: Visual Studio Build Tools 2022 with "Desktop development with C++"). The published package runs `npm rebuild @lancedb/lancedb` in a postinstall step.

---

## 2. Apply recommended config

The fastest way to configure everything:

```bash
openclaw hybrid-mem install
```

This merges recommended defaults into `~/.openclaw/openclaw.json` - plugin config, memorySearch, compaction prompts, bootstrap limits, and a nightly distillation job. It preserves any existing API key.

Then set your **embedding** config (required) and optionally **LLM** preferences:

```bash
# Edit ~/.openclaw/openclaw.json:
# - embedding.provider + embedding.model + embedding.dimensions (required for vector search)
# - embedding.apiKey (required for OpenAI and Google providers only)
# - llm.default / llm.heavy (optional) for chat model preference lists - see LLM-AND-PROVIDERS.md
# Or use env: e.g. embedding.apiKey = "env:OPENAI_API_KEY"
```

If you run isolated maintenance jobs (`hybrid-mem:*` in `~/.openclaw/cron/jobs.json`), keep `agents.defaults.model.primary` and each job `model`/`payload.model` on the same provider family (for example `azure-foundry/...` for both). Mixed families (for example `minimax/...` primary with `google/...` cron model) can fail with `LiveSessionModelSwitchError`. After changing primary, run `openclaw hybrid-mem verify --fix` to refresh job models.

For manual configuration and all options (including `llm` and legacy `distill`), see [CONFIGURATION.md](CONFIGURATION.md) and [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md).

---

## 3. Create workspace layout

Create the directory structure under your workspace (e.g. `~/.openclaw/workspace/`):

```bash
mkdir -p memory/{people,projects,technical,companies,decisions,archive}
```

Create bootstrap files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`, `IDENTITY.md`. See [ARCHITECTURE.md](ARCHITECTURE.md) for what goes in each file and [MEMORY-PROTOCOL.md](MEMORY-PROTOCOL.md) for the Memory Protocol block to paste into `AGENTS.md`.

---

## 4. Restart and verify

```bash
openclaw gateway stop
openclaw gateway start
```

Then verify everything is working:

```bash
openclaw hybrid-mem verify
```

If SQLite or LanceDB show native bindings errors, run `openclaw hybrid-mem verify --fix` to rebuild them, then restart the gateway.

You should see:

```
Config: embedding.provider and model present
SQLite: OK (...)
LanceDB: OK (...)
Embedding API: OK
All checks passed.
```

Also run:

```bash
openclaw hybrid-mem stats
```

### Verification checklist

- [ ] `plugins.slots.memory` is `"openclaw-hybrid-memory"`
- [ ] Logs show `memory-hybrid: initialized`
- [ ] `openclaw hybrid-mem stats` returns fact/vector counts
- [ ] No embedding API errors on first message
- [ ] `memorySearch` is enabled (`agents.defaults.memorySearch.enabled: true`)
- [ ] Memory directory exists with expected subdirs

---

## 5. Optional - Backfill existing data

If you have existing `memory/` files or daily logs:

```bash
# Backfill from memory files (dynamic - discovers all .md files)
EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs

# Or extract from daily logs
openclaw hybrid-mem extract-daily --days 30 --dry-run  # preview first
openclaw hybrid-mem extract-daily --days 30            # then apply
```

Restart the gateway after backfill so memorySearch re-indexes.

---

## Next steps

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - What happens each turn (auto-recall, auto-capture, costs)
- [EXAMPLES.md](EXAMPLES.md) - Real-world recipes and patterns
- [FAQ.md](FAQ.md) - Common questions and quick answers
- [CONFIGURATION.md](CONFIGURATION.md) - Full config reference
- [FEATURES.md](FEATURES.md) - Categories, decay, tags, auto-classify
- [CLI-REFERENCE.md](CLI-REFERENCE.md) - All CLI commands
- [OPERATIONS.md](OPERATIONS.md) - Background jobs, scripts, upgrades
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues and fixes

