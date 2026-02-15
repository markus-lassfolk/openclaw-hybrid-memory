# Hybrid Memory Manager — Version 3.0

**Version:** 3.0  
**Date:** 2026-02-15  
**Purpose:** Single deployment-ready reference for the **full hybrid memory system** : vector/DB (memory-hybrid) combined with file-based memory (memorySearch + hierarchical `memory/` files) for the most capable setup. One installation flow applies to any system — new, a few days old, or months old. With an optional backfill steps to migrate memory to new system.

This document unifies:

- **Maeves Current Steup** (hybrid-hierarchical memory from `hybrid-hierarchical-memory-guide.md` v2.0)
- **ucsandman** [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): index + drill-down, token math, safeguards
- **Clawdboss.ai** [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): **memory-hybrid** plugin (SQLite+FTS5+LanceDB), decay, checkpoints

---

## 1. Full Hybrid Architecture

Four components work together:

| Component | What it handles | Agent action | Technology |
|-----------|------------------|--------------|------------|
| **1a. Structured facts** | "What's X's Y?" — precise lookups | None (auto); or `lookup` / tools | memory-hybrid: **SQLite + FTS5** |
| **1b. Vector recall** | "What was that thing?" — fuzzy semantic | None (auto); or `memory_store` / `memory_recall` | memory-hybrid: **LanceDB** + OpenAI embeddings |
| **2. Semantic file search** | "Where did I write about X?" | None (automatic) | **memorySearch**: SQLite + BM25/vector over `memory/**/*.md` |
| **3. Hierarchical files** | "Where are we on this project?" | Manual read/write | **memory/** directory + **MEMORY.md** index |

**memory-hybrid plugin** (one plugin, two backends): SQLite+FTS5 for fast, free structured fact lookup; LanceDB for semantic conversation recall. Both auto-capture and auto-recall. **memorySearch** indexes all `memory/**/*.md` files for on-demand semantic search. **MEMORY.md** is the lightweight index (~1.5k tokens) loaded every session; detail lives in `memory/` and is drilled into on demand.

**Token discipline:** Bootstrap files (AGENTS.md, SOUL.md, MEMORY.md, etc.) are loaded every turn — keep them lean. Put reference data in `memory/**/*.md` so it's only loaded when relevant.

---

## 2. Directory Structure (Workspace)

Create this under your OpenClaw workspace (e.g. `~/.openclaw/workspace/` or your project root):

```text
workspace/
├── AGENTS.md              # Agent behaviour + Memory Protocol (every session)
├── SOUL.md                # Agent personality & tone (every session)
├── USER.md                # User profile (every session)
├── TOOLS.md               # Behavioural rules, quick refs (every session)
├── HEARTBEAT.md           # Periodic task checklist (every session)
├── IDENTITY.md            # Agent name/emoji (every session)
├── MEMORY.md              # Root index → links to memory/ (every session)
└── memory/
    ├── people/            # User & team profiles (permanent)
    ├── projects/          # Active project state (review every 180 days)
    ├── technical/         # Systems, APIs, integrations (review every 180 days)
    ├── companies/         # Organisation intel
    ├── decisions/         # Decision logs (YYYY-MM.md)
    ├── archive/           # Completed projects (move from projects/ when done)
    └── YYYY-MM-DD.md      # Daily logs (optional: YYYY-MM-DD-afternoon.md etc.)
```

**Plugin data (memory-hybrid):** By default the plugin stores its own DBs under `~/.openclaw/memory/` (SQLite `facts.db`, LanceDB dir). These are separate from the workspace `memory/` folder. Config can override paths if you want them under the workspace.

**Note:** `archive/` is created when you need it (e.g. when moving completed projects out of `projects/`). Your live setup may not have it yet.

### What Goes Where

| Content Type | Location | Loaded When |
|-------------|----------|-------------|
| Agent personality, tone, boundaries | `SOUL.md` | Every session (bootstrap) |
| User preferences, identity | `USER.md` | Every session (bootstrap) |
| Behavioural rules, voice rules, formatting | `TOOLS.md` | Every session (bootstrap) |
| Memory index (lightweight pointers) | `MEMORY.md` | Every session (bootstrap) |
| Periodic task checklist | `HEARTBEAT.md` | Every session (bootstrap) |
| Agent name/emoji | `IDENTITY.md` | Every session (bootstrap) |
| Behaviour + Memory Protocol | `AGENTS.md` | Every session (bootstrap) |
| Technical reference (APIs, IPs, auth) | `memory/technical/*.md` | On-demand (semantic search or explicit read) |
| Project status & roadmaps | `memory/projects/*.md` | On-demand |
| People profiles | `memory/people/*.md` | On-demand |
| Decision records | `memory/decisions/*.md` | On-demand |
| Daily session logs | `memory/YYYY-MM-DD.md` | On-demand |
| Isolated facts, conversation fragments | memory-hybrid plugin (SQLite + LanceDB) | Auto-injected via autoRecall |

### Bootstrap vs memory files

**Bootstrap files** (AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, IDENTITY.md) are loaded into the system prompt **every turn**. They consume context tokens constantly. Keep them **lean** (behavioural rules, not reference data), **actionable** (needed for every interaction), and **pointer-rich** (link to deeper files).

**Memory files** (`memory/**/*.md`) are indexed by semantic search and loaded **on demand**. They can be detailed, reference-heavy, and larger — no per-turn cost until relevant.

**Rule of thumb:** If you'd need it in every conversation → bootstrap file. If you'd need it only when working on X → memory file.

**Rules:**

- Update **MEMORY.md** whenever you add or change a file under `memory/`. Same commit when possible.
- Keep **MEMORY.md** under ~3k tokens. Archive inactive items to `memory/archive/` or linked docs.
- **Active Context** in MEMORY.md: list 2–5 "always load" detail files (e.g. key people, current project). Rotate based on what's hot.

---

## 3. Plugin Installation (memory-hybrid)

The full hybrid uses the **memory-hybrid** plugin from this repo. Install it before configuring.

### 3.1 Copy plugin files

Copy the entire `extensions/memory-hybrid/` directory from this repo into your OpenClaw extensions directory:

- **Windows:** `%APPDATA%\npm\node_modules\openclaw\extensions\memory-hybrid\`
- **Linux:** `/usr/lib/node_modules/openclaw/extensions/memory-hybrid/` (or `~/.npm-global/lib/node_modules/openclaw/extensions/memory-hybrid/` if you use a user install)

Create the `memory-hybrid` directory if it doesn't exist. Copy: `package.json`, `openclaw.plugin.json`, `config.ts`, `index.ts`.

### 3.2 Install dependencies

Install dependencies **in the extension directory only**. The plugin’s `package.json` already lists `better-sqlite3` and `@lancedb/lancedb`, so `npm install` there is sufficient for the plugin to run.

**Linux (example):**

```bash
cd /usr/lib/node_modules/openclaw/extensions/memory-hybrid
npm install
```

**Windows:** Use the equivalent path (e.g. `%APPDATA%\npm\node_modules\openclaw\extensions\memory-hybrid`), then run `npm install` in that directory.

If `npm install` fails (e.g. due to `devDependencies` with `"openclaw": "workspace:*"` or similar), remove devDependencies **in place** (printing to stdout does not edit the file), then install. From the extension directory:
  ```bash
  node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
  npm install
  ```
  See §12 for more. If `better-sqlite3` fails to compile, install the C++ build toolchain (e.g. Linux: `build-essential`, `python3`; Windows: Visual Studio Build Tools 2022 with "Desktop development with C++").

**Note:** Some older guides also run `npm install better-sqlite3` from `~/.openclaw`. That only works if you have a `package.json` in `~/.openclaw` (e.g. for a seed script). For the plugin itself, the extension-dir install is enough; you do not need to create a package.json in `~/.openclaw` unless you run separate tools from there that depend on better-sqlite3.

Full details: [SETUP-PROMPT-1-CREATE-PLUGIN-FILES.md](SETUP-PROMPT-1-CREATE-PLUGIN-FILES.md), [SETUP-PROMPT-2-INSTALL-DEPENDENCIES.md](SETUP-PROMPT-2-INSTALL-DEPENDENCIES.md).

---

## 4. Configuration (`openclaw.json`)

Merge these into your existing `openclaw.json` (e.g. `~/.openclaw/openclaw.json`). Replace placeholders; do **not** commit real API keys to git.

### 4.1 Memory slot and memory-hybrid plugin

OpenClaw allows only one plugin to own the `memory` slot. Set it to **memory-hybrid**:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-hybrid"
    },
    "entries": {
      "memory-core": {
        "enabled": true
      },
      "memory-hybrid": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "YOUR_OPENAI_API_KEY",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "captureMaxChars": 5000
        }
      }
    }
  }
}
```

`captureMaxChars` (e.g. `5000`) is optional; the plugin has a default if omitted.

**memory-core** stays `enabled: true` alongside memory-hybrid: it provides the file-based tools (`memory_store`, `memory_recall`, `memory_forget`) independently of the slot. Only one plugin can own the slot; memory-core does not conflict with memory-hybrid.

**API key:** Inline the key if non-interactive shells don't load your env (see §12). Editing the config file directly is more reliable than using `config.patch` — the gateway’s config.patch tool can re-substitute inlined secrets back to `${ENV_VAR}` references, so set or change API keys by editing the file.

Optional: `lanceDbPath` and `sqlitePath` (defaults: `~/.openclaw/memory/lancedb` and `~/.openclaw/memory/facts.db`).

### 4.2 memorySearch (semantic file search over memory/**/*.md)

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "sources": ["memory"],
        "provider": "openai",
        "model": "text-embedding-3-small",
        "sync": {
          "onSessionStart": true,
          "onSearch": true,
          "watch": true
        },
        "chunking": {
          "tokens": 500,
          "overlap": 50
        },
        "query": {
          "maxResults": 8,
          "minScore": 0.3,
          "hybrid": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

### 4.3 Memory backend

```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

### 4.4 Compaction memory flush (recommended)

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "default",
        "memoryFlush": {
          "enabled": true
        }
      }
    }
  }
}
```

### 4.5 Bootstrap limits and context (recommended)

```json
{
  "agents": {
    "defaults": {
      "bootstrapMaxChars": 15000,
      "bootstrapTotalMaxChars": 50000,
      "contextTokens": 180000
    }
  }
}
```

**Recommended:** Set `contextTokens` to avoid prompt-overflow errors — use roughly 90% of your model’s context window (e.g. `180000` for Opus’s 200k). This was the main lever for fixing context overflow in production.

### 4.6 Pruning (optional — context overflow)

To prune stale tool results and keep context under control, you can set a pruning TTL:

```json
{
  "agents": {
    "defaults": {
      "pruning": {
        "ttl": "30m"
      }
    }
  }
}
```

This was part of the context-overflow fix in our live setup; add it if you see prompts growing too large from accumulated tool output.

### 4.7 Decay and pruning (memory-hybrid facts)

**No cron or external jobs are required.** The memory-hybrid plugin handles decay and pruning automatically during normal use:

1. **On gateway start** — Expired facts are hard-deleted once (startup prune).
2. **Every 60 minutes** — The plugin runs a **periodic prune** inside the gateway process: it deletes expired facts and **soft-decays** confidence for facts that are past ~75% of their TTL window (confidence halves; facts below 0.1 are removed). You’ll see log lines like `memory-hybrid: periodic prune — N expired, M decayed` when something is removed.

Facts are assigned a **decay class** when stored (auto-classified from content; see plugin logic). TTL and refresh behaviour:

| Decay class | TTL | Refresh on access? |
|-------------|-----|--------------------|
| permanent   | Never expires | No |
| stable      | 90 days      | Yes — expiry resets when the fact is recalled |
| active      | 14 days      | Yes — expiry resets when recalled |
| session     | 24 hours     | No |
| checkpoint  | 4 hours      | No |

So **stable** and **active** facts that keep being recalled stay alive; unused ones eventually expire and are pruned. Classification is automatic (e.g. decisions/conventions → permanent; tasks/sprint → active; project/tech details → stable). No user configuration is needed for decay or the 60-minute interval; both are built into the plugin.

**Optional manual controls:** Run `openclaw hybrid-mem prune` to prune immediately (options: `--hard` only expired, `--soft` only confidence decay, `--dry-run` to see counts). Run `openclaw hybrid-mem backfill-decay` to re-classify existing facts with auto-detected decay classes. See §13 for the full CLI.

### 4.8 Categories and default decay

The plugin uses two separate notions: **category** (what kind of fact) and **decay class** (how long it lives). Decay is **not** configured per category; it is derived from the fact’s **entity**, **key**, **value**, and **text** when the fact is stored.

**Categories** (for labeling, search, and FTS):

| Category     | Typical use | Default decay (from content) |
|-------------|-------------|------------------------------|
| preference  | "I prefer X", "like/hate Y" | Usually **stable** (90d, refresh on access) |
| fact        | "X's birthday is Y", "lives in Z" | **Stable** or **permanent** if key is name/email/birthday etc. |
| decision    | "Decided to use X because Y", "always use Z" | Usually **permanent** (entity=decision/convention) |
| entity      | Names, identifiers, "is called X" | **Stable** or **permanent** (e.g. name/email → permanent) |
| other       | Everything that doesn’t match above | **Stable** (90d) |

**How decay is chosen:** When storing a fact, the plugin either uses an explicit `decayClass` (if you pass it) or runs **auto-classification** on (entity, key, value, text). So the “default” decay depends on what’s extracted, for example:

- Keys like `name`, `email`, `decision`, `architecture` → **permanent**
- Entity `decision` or `convention` → **permanent**
- Keys like `task`, `todo`, `sprint`, `blocker` or text “working on”, “need to” → **active** (14d)
- Keys like `current_file`, `temp`, `debug` or text “this session” → **session** (24h)
- Key `checkpoint` / `preflight` → **checkpoint** (4h)
- Otherwise → **stable** (90d, refresh on access)

**How to change decay**

- **When storing:** Use the `memory_store` tool and pass `decayClass` explicitly (e.g. `permanent`, `stable`, `active`, `session`, `checkpoint`). That overrides auto-classification for that fact.
- **Existing facts:** Run `openclaw hybrid-mem backfill-decay`. It re-runs auto-classification for all facts and updates their decay class. There is no config file or CLI flag to map “category X → decay Y”; only code changes can change the classification rules or TTLs.

**How to add new categories**

Categories are fixed in the plugin code. To add one:

1. In `extensions/memory-hybrid/config.ts`, add the new label to `MEMORY_CATEGORIES` (e.g. `"custom"`).
2. In `extensions/memory-hybrid/index.ts`, extend `detectCategory(text)` if you want the new category to be auto-assigned from captured text; update any schema that references `MEMORY_CATEGORIES` (e.g. the `memory_store` tool parameter).
3. Rebuild/reload the plugin.

**How to change TTLs or add decay classes**

TTLs and decay class names are defined in code (`config.ts`: `TTL_DEFAULTS`, `DECAY_CLASSES`). To change a TTL (e.g. stable from 90 to 60 days) or add a new decay class, edit those constants and the `classifyDecay` logic in `index.ts`, then redeploy the plugin. There is no `openclaw.json` setting for decay or TTL.

---

## 5. Bootstrap Files (What to Create)

| File | Purpose | Keep small? |
|------|---------|--------------|
| **AGENTS.md** | Behaviour, safety, tools, **Memory Protocol** (see §7) | Yes — rules, not reference data |
| **SOUL.md** | Personality, tone, boundaries | Yes |
| **USER.md** | User identity, preferences | Yes |
| **TOOLS.md** | Voice rules, formatting, index to `memory/technical/` | Yes |
| **MEMORY.md** | Index of `memory/` (Active Context, People, Projects, Technical, Decisions, Archive) | Yes — ~1.5–3k tokens |
| **HEARTBEAT.md** | Periodic checklist (e.g. health checks, memory maintenance) | Yes |
| **IDENTITY.md** | Agent name, emoji, one-line vibe | Yes |

Bootstrap files are injected every session. **Memory files** (`memory/**/*.md`) are indexed by memorySearch and loaded on demand — they can be detailed and larger.

---

## 6. MEMORY.md Template (Root Index)

Use this structure for `MEMORY.md`. Replace placeholders and add/remove rows as needed.

```markdown
# Long-Term Memory Index

## 🟢 Active Context
- [[memory/people/owner.md]]
- [[memory/projects/current-project.md]]

## 👥 People Index
- **Owner**: [[memory/people/owner.md]] - Short role/title.
- _(Add more people and links.)_

## 🚀 Projects Index
- 🟢 **Project Name**: [[memory/projects/project-name.md]] - One-line description.
- 🟡 **Paused**: [[memory/projects/paused.md]]
- 🔵 **Completed**: [[memory/projects/completed.md]]

## 🛠 Technical Knowledge
- **System/API:** [[memory/technical/system-name.md]] - Short description.

## 🏢 Company Insights
- [[memory/companies/]] - Business profiles, partners, competitors.

## ⚖️ Decisions Log
- [[memory/decisions/YYYY-MM.md]] - Architecture & strategy decisions.

## 📚 Archived Context
- _(Links or filenames for completed/archived items.)_
```

Status emojis: 🟢 active, 🟡 paused, 🔵 completed. Keep the index under ~3k tokens; move inactive projects to `memory/archive/` and link or list them in Archived Context.

---

## 7. AGENTS.md — Memory Protocol Section

Add the following block to your **AGENTS.md** so the agent knows how to use the full hybrid and when to update files.

```markdown
## Memory Protocol (Full Hybrid)

You are the **Auto-Archivist**. You have a four-part memory system:

### Part 1a: Structured facts (memory-hybrid — SQLite + FTS5)
- **Automatic.** Structured facts (names, dates, preferences, decisions) are stored and retrieved by the memory-hybrid plugin. Instant full-text lookup, no API cost.
- Use the `lookup` command when you need an exact entity/key lookup (e.g. "openclaw hybrid-mem lookup user preference").

### Part 1b: Vector recall (memory-hybrid — LanceDB)
- **Automatic.** The plugin captures important conversation snippets and auto-recalls relevant memories into context each turn.
- Use `memory_store` to explicitly save a small fact for vector recall.
- Use `memory_recall` to explicitly search when auto-recall misses something.

### Part 2: Semantic file search (memorySearch / builtin)
- **Automatic on session start + on search.** OpenClaw indexes all `memory/**/*.md` files. Well-structured markdown = better search results. Files are chunked (500 tokens, 50 overlap) and searchable via hybrid BM25 + vector.

### Part 3: Hierarchical file memory (manual)
You must keep `memory/` files up to date *without* being asked.

**Directory structure:**
memory/
├── people/          # User & team profiles (permanent)
├── projects/        # Active project state (review every 180 days)
├── technical/       # Systems, APIs, integrations (review every 180 days)
├── companies/       # Organisation intel
├── decisions/       # Architectural Decision Records (YYYY-MM.md)
└── archive/         # Completed projects

**Triggers for File Updates:**
- **New Project Started:** Create `memory/projects/project-name.md`. Use sections: # Status, # Goals, # Roadmap.
- **Milestone Reached:** Edit the relevant project file to check off the item.
- **Decision Made:** Log in `memory/decisions/YYYY-MM.md`.
- **Person Profile:** Update `memory/people/name.md` when you learn preferences or role.
- **New Tech Stack:** Create `memory/technical/tech-name.md` for major systems/APIs.
- **Company Insight:** Create `memory/companies/company-name.md` for partners/competitors.

### When to Use Which Part

| Situation | Use |
|-----------|-----|
| Precise fact ("User's birthday", "API key location") | Plugin structured store / `lookup` (SQLite+FTS5) |
| Small isolated fact ("User prefers dark mode") | `memory_store` → vector recall |
| "What did we discuss about X last week?" | `memory_recall` or semantic file search |
| Project status, roadmap, active state | File in `memory/projects/` |
| Technical reference (APIs, IPs, credentials) | File in `memory/technical/` |
| Decision log | File in `memory/decisions/YYYY-MM.md` |

### 🛑 Flush Before Finish (The "Save Game" Rule)
**Before closing a major task or reporting done:**
1. **Scan Context:** Did we make a decision, finish a milestone, or learn a new preference?
2. **Commit:** Write it to the relevant `memory/projects/` or `memory/decisions/` file immediately.
3. **Store:** If it's a small or structured fact, use `memory_store` (and/or ensure it's in the right memory/ file).
*Never let the context window close on unsaved state.*

**Index:** Keep `MEMORY.md` as a lightweight index pointing to these deeper files.
```

---

## 8. Deployment (one flow for any system)

Use this sequence whether the system is brand new, a few days old, or has been running for months. On a new system with very few or no memories, the optional backfill steps (seed + extract-daily) are safe to run and will not make things worse — they may add little or nothing until you have content.

1. **Workspace:** Create or use workspace root (e.g. `~/.openclaw/workspace/`).
2. **memory/ layout:** Create subdirs: `people/`, `projects/`, `technical/`, `companies/`, `decisions/`, `archive/`.
3. **Bootstrap files:** Create or update AGENTS.md (include §7 Memory Protocol), SOUL.md, USER.md, TOOLS.md, MEMORY.md (use §6 template), HEARTBEAT.md, IDENTITY.md.
4. **Plugin:** Install memory-hybrid per §3 (copy `extensions/memory-hybrid/`, run `npm install` in the plugin dir only).
5. **Config:** Merge §4 into `openclaw.json` (memory slot = `memory-hybrid`, memorySearch, memory backend, compaction, bootstrap limits, recommended `contextTokens`, optional pruning). Set OpenAI API key.
6. **Restart:** Full gateway restart (`openclaw gateway stop` then `openclaw gateway start`).
7. **Optional — Backfill plugin DBs:** So existing MEMORY.md and `memory/**/*.md` content is in SQLite + LanceDB. Use a **dynamic** approach (no hardcoded dates or section names — discover files by glob, parse structure from content):
   - **Dynamic backfill script (recommended):** Use the repo’s [scripts/backfill-memory.mjs](../scripts/backfill-memory.mjs). It discovers the workspace from `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`), globs `MEMORY.md` and `memory/**/*.md` (all .md files; no fixed date list), parses lines/sections from content, extracts facts, and writes to the plugin’s SQLite + LanceDB. Safe on a new system. See [§8 Backfill (dynamic)](#8-deployment-one-flow-for-any-system) below for how to run it.
   - **Plugin command for daily logs only:** `openclaw hybrid-mem extract-daily --days N` is **dynamic on dates** (you choose N). It reads from **`~/.openclaw/memory/`** (the plugin’s default path). If your daily logs live under the workspace (e.g. `~/.openclaw/workspace/memory/YYYY-MM-DD.md`), the command will see 0 files unless you fix the path. **Concrete options:**
     ```bash
     # Option A: Symlink workspace memory into the path extract-daily expects
     ln -snf ~/.openclaw/workspace/memory ~/.openclaw/memory

     # Option B: Use the backfill script instead — it reads from OPENCLAW_WORKSPACE
     # and processes MEMORY.md + memory/**/*.md (including daily logs)
     ```
     Use `extract-daily --dry-run --days N` first to confirm it sees files; if it reports 0, use Option A or B.
8. **Restart again (if you ran backfill):** So memorySearch re-syncs the file index (it syncs on session start and watch). A full restart plus next session start is enough.
9. **Verify:** See §11. Check logs for `memory-hybrid: initialized` and `memory-hybrid: injecting N memories into context`. Run `openclaw hybrid-mem stats`. **Ask the agent a question that only memory could answer** (e.g. a fact from a `memory/` file or a past conversation) and confirm it finds it.

### Backfill (dynamic — no hardcoded dates or sections)

Backfill should be **dynamic**: discover files by glob, parse structure from the content, and use config from `openclaw.json`. That way it keeps working as your workspace grows (new files, new dates, changed section names).

- **Use the repo’s script:** [scripts/backfill-memory.mjs](../scripts/backfill-memory.mjs) does the following:
  - **Workspace:** From env `OPENCLAW_WORKSPACE` (default `~/.openclaw/workspace`).
  - **Files:** Globs `MEMORY.md` and `memory/**/*.md` under the workspace — no hardcoded dates or section names; any new file is included automatically.
  - **Parsing:** Splits content by lines and by `##` sections; treats list items and short lines as fact candidates. No fixed list of section titles.
  - **Config:** Reads `~/.openclaw/openclaw.json` for memory-hybrid `sqlitePath`, `lanceDbPath`, and `embedding.apiKey` (resolves `${ENV_VAR}`).
  - **Storage:** Writes to the same SQLite and LanceDB as the plugin; skips duplicates by text. Safe to run repeatedly or on a new system.

**How to run the backfill script:** The script needs the plugin’s dependencies (better-sqlite3, openai, @lancedb/lancedb). Run it with `NODE_PATH` pointing at the memory-hybrid extension’s `node_modules`, or run it from inside the extension directory (see [scripts/README.md](../scripts/README.md#backfill)).

```bash
# From repo root (or wherever the script lives). Extension dir from npm global.
EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}" node scripts/backfill-memory.mjs

# Optional: --dry-run to print what would be stored
node scripts/backfill-memory.mjs --dry-run
```

**Alternative:** You can still use a custom seed script (e.g. from [SETUP-PROMPT-4-SEED-FROM-MEMORY-FILES.md](SETUP-PROMPT-4-SEED-FROM-MEMORY-FILES.md)); make it dynamic the same way (env for workspace, glob for files, parse structure from content, no hardcoded dates or section names).

### Backfill from session logs (existing system with history)

If you've been running OpenClaw for weeks without memory files, **session logs** are how you bootstrap from history. The dynamic backfill script only processes `MEMORY.md` and `memory/**/*.md`; it does not read past session logs.

**Option:** Spawn a sub-agent (or use a one-off task) and ask it to scan session logs and create memory files:

> "Scan my recent session logs (last 30 days) at `~/.openclaw/agents/main/sessions/`. Create `memory/projects/`, `memory/technical/`, `memory/people/`, and `memory/companies/` files from what you find. Update `MEMORY.md` index. Output a summary of files created."

The sub-agent gets a fresh context window and can process large volumes without cluttering the main session. After that, you can run the dynamic backfill script to seed the plugin DBs from the newly created memory files.

---

## 9. Writing Effective Memory Files

Memory files are your searchable corpus. Their quality directly affects recall quality.

### Good practices

1. **Use clear headings** — `## API Access`, `## Camera Names` — these become search anchors.
2. **Front-load key info** — put the most important facts in the first few lines (chunking uses 500 tokens + 50 overlap; front-loaded content ranks better).
3. **Use consistent naming** — e.g. `memory/technical/frigate.md` rather than long ad-hoc names.
4. **Include keywords** — if someone might search "Frigate password", make sure both words appear near each other.
5. **Keep files focused** — one topic per file; avoid mega-docs that mix unrelated subjects.
6. **Use tables for structured data** — camera lists, entity IDs, API endpoints chunk better than long prose.

### Bad practices

- ❌ Huge monolithic files (>5000 chars) — harder to chunk meaningfully.
- ❌ Files with only links and no content — nothing to embed.
- ❌ Duplicating info across files — creates conflicting search results.
- ❌ Stale files never reviewed — outdated info pollutes recall.
- ❌ Putting reference data in bootstrap files — wastes context tokens every turn.

### File size guidelines

| File type | Target size | Why |
|-----------|-------------|-----|
| Bootstrap files (TOOLS.md, MEMORY.md, etc.) | &lt;3000 chars | Loaded every turn, context cost |
| Memory files (technical, projects) | 500–3000 chars | Fits well in 500-token chunks |
| Decision logs | Any size | Append-only, searched by date |
| People profiles | 500–1500 chars | Focused, rarely massive |

---

## 10. Maintenance & Hygiene

### Periodic review (e.g. via HEARTBEAT.md)

1. Read recent `memory/YYYY-MM-DD.md` daily files.
2. Identify significant events, lessons, insights worth keeping long-term.
3. Update relevant `memory/` files with distilled learnings.
4. Update `MEMORY.md` index if new files were created.
5. Remove outdated info from files that's no longer relevant.
6. Archive completed projects: move from `memory/projects/` to `memory/archive/`.

### MEMORY.md as root index

`MEMORY.md` is loaded every session via bootstrap. Keep it as a **lightweight pointer file**: links to active projects, people, technical docs; status emojis (🟢 active, 🟡 paused, 🔵 completed). No detailed content — just enough to orient the agent.

### Daily files (`memory/YYYY-MM-DD.md`)

Raw session logs. Write what happened, decisions made, issues found. They are searchable via memorySearch, source material for periodic reviews, and not loaded at bootstrap (too many, too large).

---

## 11. Post-Install Verification Checklist

After config merge and restart:

1. **Memory slot:** `plugins.slots.memory` is `"memory-hybrid"`. Without it, the hybrid plugin is disabled (logs may say memory slot set to memory-core).
2. **Plugin loaded:** Logs show e.g. `memory-hybrid: initialized` (and DB paths if logged). CLI: `openclaw hybrid-mem stats` runs and shows fact/vector counts.
3. **Embedding API key:** Set in plugin config (inline or env); no errors on gateway start or on first message that triggers recall.
4. **memorySearch:** `agents.defaults.memorySearch` is enabled, `sync.onSessionStart: true`, `sync.watch: true`. After a session start, file changes under `memory/` are picked up.
5. **Bootstrap truncation:** If logs say "workspace bootstrap file MEMORY.md is X chars (limit Y); truncating", increase `bootstrapMaxChars` / `bootstrapTotalMaxChars` (§4.5).
6. **Layers working:**  
   - Structured + vector: Log shows e.g. `memory-hybrid: injecting N memories into context`.  
   - File search: No errors; agent can find content that exists only in `memory/**/*.md`.  
   - Hierarchical: `memory/` exists with the expected subdirs and MEMORY.md index.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| memory-hybrid disabled / "memory slot set to memory-core" | Slot not set | Set `plugins.slots.memory` to `"memory-hybrid"` |
| Missing env var for API key | Env not loaded in non-interactive shell | Inline key in config or ensure env is set for the process |
| `Cannot find module '@lancedb/lancedb'` or `better-sqlite3` | Extension deps not installed, or **OpenClaw was just upgraded** | Install in extension dir (§3.2); after any **openclaw upgrade** run post-upgrade (§14). Full gateway stop/start. |
| recall/capture failed after npm install | Stale module cache: SIGUSR1 reload keeps the same process, so Node’s dynamic-import cache does not load newly installed native modules (e.g. better-sqlite3, lancedb) | **Full stop then start** (`openclaw gateway stop` then `start`). A full restart is required so the process loads the new native modules. |
| Bootstrap file truncation | Limits too low | Increase `bootstrapMaxChars` (e.g. 15000) and `bootstrapTotalMaxChars` (e.g. 50000) |
| config.patch reverts API key to ${ENV_VAR} | Gateway tool substitutes secrets | Edit config file directly for API keys |
| prompt too large for model | No context limit | Set `contextTokens` (e.g. 180000) |
| Memory files not found by search | File index not built or stale | Ensure `sync.onSessionStart: true` and `sync.watch: true`; restart and start a new session |
| hybrid-mem stats still 0 after seed | Seed script used wrong paths or schema | Point seed at same DB paths as plugin; use plugin schema (see extensions/memory-hybrid or seed prompt) |
| `npm install` fails in extension dir (e.g. "openclaw": "workspace:*", invalid protocol) | Plugin package.json has devDependencies that reference workspace or unsupported protocols | Remove devDependencies in place, then install. From the extension dir: `node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"` then `npm install`. Or fix package.json and re-copy from this repo. |

---

## 13. memory-hybrid CLI Reference

Use these from the shell for inspection and maintenance:

| Command | Purpose |
|---------|---------|
| `openclaw hybrid-mem stats` | Show fact count (SQLite) and vector count (LanceDB). |
| `openclaw hybrid-mem lookup <entity> [--key <key>]` | Exact lookup in SQLite (e.g. `lookup user --key preference`). |
| `openclaw hybrid-mem search <query>` | Semantic search over LanceDB. |
| `openclaw hybrid-mem extract-daily [--dry-run] --days N` | Extract facts from daily logs (`memory/YYYY-MM-DD.md`); `--dry-run` only prints what would be stored. |
| `openclaw hybrid-mem prune` | Remove expired facts (decay/TTL). |
| `openclaw hybrid-mem checkpoint` | Create a checkpoint (pre-flight state). |
| `openclaw hybrid-mem backfill-decay` | Backfill decay classes for existing rows. |

After implementation and re-indexing, use `stats` and `lookup`/`search` to confirm data is present.

---

## 14. Upgrading OpenClaw (LanceDB reinstall)

**Important:** After every **OpenClaw (Clawbot) upgrade** (e.g. `npm update -g openclaw`), the memory-hybrid plugin’s native dependencies (**@lancedb/lancedb** and **better-sqlite3**) can end up broken or missing in the extension directory. The gateway may then fail to load the plugin with `Cannot find module '@lancedb/lancedb'` (or similar). You must **reinstall extension deps and restart the gateway** after each upgrade.

### Recommended: upgrade scripts + alias

Use two small scripts and a shell alias so upgrades are one command and never forget the reinstall.

1. **Copy the scripts** from this repo’s `scripts/` into `~/.openclaw/scripts/` (create the directory if needed):
   - `scripts/post-upgrade.sh` — reinstalls deps in the memory-hybrid extension dir, then restarts the OpenClaw gateway.
   - `scripts/upgrade.sh` — runs `npm update -g openclaw`, then runs `post-upgrade.sh`.

2. **Make them executable:**  
   `chmod +x ~/.openclaw/scripts/post-upgrade.sh ~/.openclaw/scripts/upgrade.sh`

3. **Add a bash alias** (e.g. in `~/.bashrc` or `~/.bash_aliases`):
   ```bash
   alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'
   ```
   Then run **`openclaw-upgrade`** whenever you upgrade; it updates OpenClaw and runs the post-upgrade reinstall + restart in one go.

If you upgrade OpenClaw by some other means (e.g. system package), run **`~/.openclaw/scripts/post-upgrade.sh`** manually after the upgrade, then restart the gateway.

### Why this is needed

Global npm upgrades often reinstall or move the top-level `openclaw` package without re-running `npm install` inside extension directories. The memory-hybrid plugin lives under `openclaw/extensions/memory-hybrid/` and depends on native modules there; those are not updated automatically. A post-upgrade step that runs `npm install` in that extension dir and restarts the process is the reliable workaround until OpenClaw (or the plugin) supports an official post-upgrade hook.

---

## Summary

| Item | Where |
|------|--------|
| Full hybrid architecture (4 parts) | §1 |
| Directory layout, What Goes Where, bootstrap vs memory | §2 |
| memory-hybrid plugin install | §3 |
| openclaw.json (memory-hybrid, memorySearch, decay/pruning, categories) | §4 |
| Bootstrap files list | §5 |
| MEMORY.md template | §6 |
| AGENTS.md Memory Protocol (paste-ready) | §7 |
| Deployment (one flow, any system), backfill, session-log backfill | §8 |
| Writing effective memory files | §9 |
| Maintenance & hygiene | §10 |
| Post-install verification | §11 |
| Troubleshooting | §12 |
| memory-hybrid CLI | §13 |
| **Upgrading OpenClaw (LanceDB reinstall)** | **§14** |

**AI-friendly setup:** For autonomous installation by an OpenClaw agent, use [SETUP-AUTONOMOUS.md](SETUP-AUTONOMOUS.md) instead of this document. It distills the steps into an imperative, phase-by-phase flow the agent can follow without reading the full reference.

**Sources:** hybrid-hierarchical-memory-guide.md (v2.0), [ucsandman/OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System), [Clawdboss.ai — Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory). Live reference: `~/.openclaw/` workspace and config (redacted for this doc).
