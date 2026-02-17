# Quick Start — Hybrid Memory Plugin

Get the memory-hybrid plugin running in 10 minutes. For full configuration options see [CONFIGURATION.md](CONFIGURATION.md); for architecture background see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- **OpenClaw** installed and running.
- **OpenAI API key** (required for embeddings and optional LLM features).
- **Node.js** with npm.

---

## 1. Install the plugin

Copy `extensions/memory-hybrid/` from this repo into your OpenClaw extensions directory:

- **Linux:** `/usr/lib/node_modules/openclaw/extensions/memory-hybrid/` (or `~/.npm-global/lib/node_modules/openclaw/extensions/memory-hybrid/`)
- **Windows:** `%APPDATA%\npm\node_modules\openclaw\extensions\memory-hybrid\`

Then install dependencies **in the extension directory**:

```bash
cd /usr/lib/node_modules/openclaw/extensions/memory-hybrid
npm install
```

If `npm install` fails due to `devDependencies` referencing `"openclaw": "workspace:*"`, remove them first:

```bash
node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
npm install
```

If `better-sqlite3` fails to compile, install the C++ build toolchain (Linux: `build-essential`, `python3`; Windows: Visual Studio Build Tools 2022 with "Desktop development with C++").

---

## 2. Apply recommended config

The fastest way to configure everything:

```bash
openclaw hybrid-mem install
```

This merges recommended defaults into `~/.openclaw/openclaw.json` — plugin config, memorySearch, compaction prompts, bootstrap limits, and a nightly distillation job. It preserves any existing API key.

Then set your OpenAI API key:

```bash
# Edit ~/.openclaw/openclaw.json and replace YOUR_OPENAI_API_KEY
# Or set the environment variable:
export OPENAI_API_KEY="sk-..."
```

For manual configuration or to customise individual settings, see [CONFIGURATION.md](CONFIGURATION.md).

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

You should see:

```
Config: embedding.apiKey and model present
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

## 5. Optional — Backfill existing data

If you have existing `memory/` files or daily logs:

```bash
# Backfill from memory files (dynamic — discovers all .md files)
EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs

# Or extract from daily logs
openclaw hybrid-mem extract-daily --days 30 --dry-run  # preview first
openclaw hybrid-mem extract-daily --days 30            # then apply
```

Restart the gateway after backfill so memorySearch re-indexes.

---

## Next steps

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — What happens each turn (auto-recall, auto-capture, costs)
- [EXAMPLES.md](EXAMPLES.md) — Real-world recipes and patterns
- [FAQ.md](FAQ.md) — Common questions and quick answers
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, scripts, upgrades
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues and fixes
