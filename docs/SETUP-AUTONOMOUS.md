# Autonomous Hybrid Memory Setup

**For:** An OpenClaw agent setting up the full hybrid memory system on itself.
**Reference:** [hybrid-memory-manager-v3.md](hybrid-memory-manager-v3.md) (full details, troubleshooting, explanations).
**Repo root:** The directory containing this file's parent (`docs/`).

---

## Instructions

You are setting up the **full hybrid memory system** on this OpenClaw instance. Follow each phase in order. After each phase, run the verification step before continuing. Skip steps that are already done (check first). If a step fails, consult `hybrid-memory-manager-v3.md` at the noted section.

---

## Phase 1: Detect environment

1. Identify the workspace root. Check `OPENCLAW_WORKSPACE` env, then default `~/.openclaw/workspace/`.
2. Identify the OpenClaw extensions directory:
   - Linux: `$(npm root -g)/openclaw/extensions/` or `/usr/lib/node_modules/openclaw/extensions/`
   - Fallback: check `~/.npm-global/lib/node_modules/openclaw/extensions/`
3. Identify the config file: `~/.openclaw/openclaw.json`.
4. Record these three paths — you will use them in every subsequent phase.

**Verify:** All three paths exist. If the workspace doesn't exist, create it.

---

## Phase 2: Create workspace structure

In the workspace root, ensure these directories exist (create missing ones):

```
memory/people/
memory/projects/
memory/technical/
memory/companies/
memory/decisions/
memory/archive/
```

**Verify:** `ls` the workspace — `memory/` with all six subdirs exists.

---

## Phase 3: Install memory-hybrid plugin

1. Check if `<extensions_dir>/memory-hybrid/` already exists with `package.json`, `index.ts`, `config.ts`, `openclaw.plugin.json`.
2. If missing: copy the entire `extensions/memory-hybrid/` directory from this repo into `<extensions_dir>/memory-hybrid/`.
3. In the extension directory, run `npm install`. If it fails with workspace protocol errors:
   ```bash
   cd <extensions_dir>/memory-hybrid
   node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
   npm install
   ```
4. If `better-sqlite3` fails to compile: ensure `build-essential` and `python3` are installed (Linux).

**Verify:** `ls <extensions_dir>/memory-hybrid/node_modules/@lancedb/lancedb` exists. `ls <extensions_dir>/memory-hybrid/node_modules/better-sqlite3` exists. *(ref: v3 §3)*

---

## Phase 4: Configure openclaw.json

Read `~/.openclaw/openclaw.json`. **Deep-merge** the following keys (do not overwrite unrelated config). If a key already has the correct value, skip it.

**4a. Plugin slot and entries** — set `plugins.slots.memory` to `"memory-hybrid"`. Ensure `plugins.entries.memory-core.enabled` is `true`. Set `plugins.entries.memory-hybrid`:

```json
{
  "enabled": true,
  "config": {
    "embedding": {
      "apiKey": "<OPENAI_API_KEY>",
      "model": "text-embedding-3-small"
    },
    "autoCapture": true,
    "autoRecall": true,
    "captureMaxChars": 5000
  }
}
```

For the API key: check if `OPENAI_API_KEY` is set in the environment. If yes, use the literal value (inline it — do not use `${OPENAI_API_KEY}` syntax, it breaks in non-interactive shells). If no env var is found, check if a key already exists in config. If neither, **stop and ask the user for their OpenAI API key.**

**4b. memorySearch** — set `agents.defaults.memorySearch`:

```json
{
  "enabled": true,
  "sources": ["memory"],
  "provider": "openai",
  "model": "text-embedding-3-small",
  "sync": { "onSessionStart": true, "onSearch": true, "watch": true },
  "chunking": { "tokens": 500, "overlap": 50 },
  "query": { "maxResults": 8, "minScore": 0.3, "hybrid": { "enabled": true } }
}
```

**4c. Memory backend** — set `memory.backend` to `"builtin"`, `memory.citations` to `"auto"`.

**4d. Compaction with hybrid memory flush** — set `agents.defaults.compaction`. The custom prompts ensure the model saves structured facts via `memory_store` (not just file-based notes) before context is compacted:

```json
{
  "mode": "default",
  "memoryFlush": {
    "enabled": true,
    "softThresholdTokens": 4000,
    "systemPrompt": "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
    "prompt": "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving."
  }
}
```

**4e. Bootstrap limits and context** — set under `agents.defaults`:

```json
{ "bootstrapMaxChars": 15000, "bootstrapTotalMaxChars": 50000 }
```

Context is taken from the model catalog automatically. Only add `contextTokens` as a troubleshooting override if you hit prompt-overflow errors (e.g. set to ~90% of your model's window).

**4f. Pruning (optional)** — set `agents.defaults.pruning`:

```json
{ "ttl": "30m" }
```

**4g. Auto-classify (recommended)** — enable LLM-based reclassification of `"other"` facts. Add `autoClassify` and optionally `categories` inside `plugins.entries.memory-hybrid.config`:

```json
{
  "autoClassify": {
    "enabled": true,
    "model": "gpt-4o-mini",
    "batchSize": 20
  },
  "categories": []
}
```

This runs automatically: once on startup (5-minute delay) and then every 24 hours. It reclassifies facts that were assigned `"other"` by the fast heuristic into proper categories (`preference`, `fact`, `decision`, `entity`) using a cheap LLM. Only `"other"` facts are touched; manually categorized facts are never changed.

- `model`: Use the cheapest chat model that gives acceptable results. `gpt-4o-mini` is a good default.
- `batchSize`: Facts per LLM call (default 20). Higher = fewer API calls but longer prompts.
- `categories`: Add custom category names (e.g. `["research", "health"]`) to extend the five defaults. Leave empty `[]` if you only need the defaults.

**Verify:** Read back `~/.openclaw/openclaw.json` and confirm all seven blocks (4a-4g) are present and correct. *(ref: v3 §4, §4.8, §4.9)*

---

## Phase 5: Create or update bootstrap files

In the workspace root, ensure each of these files exists. If a file already exists, do **not** overwrite it — only append missing sections (e.g. the Memory Protocol to AGENTS.md).

| File | Action if missing | Action if exists |
|------|-------------------|------------------|
| `AGENTS.md` | Create with basic behaviour rules + the Memory Protocol block below | Append the Memory Protocol block if not already present |
| `SOUL.md` | Create with a placeholder personality section | Leave as-is |
| `USER.md` | Create with a placeholder user profile section | Leave as-is |
| `TOOLS.md` | Create with placeholder behavioural rules | Leave as-is |
| `MEMORY.md` | Create using the MEMORY.md template below | Leave as-is (or update index if new memory files were created) |
| `HEARTBEAT.md` | Create with a basic periodic checklist | Leave as-is |
| `IDENTITY.md` | Create with a placeholder agent name/emoji | Leave as-is |

### Memory Protocol block (append to AGENTS.md if missing)

```markdown
## Memory Protocol (Full Hybrid)

You are the **Auto-Archivist**. You have a four-part memory system:

### Part 1a: Structured facts (memory-hybrid — SQLite + FTS5)
- **Automatic.** Structured facts are stored and retrieved by the memory-hybrid plugin.
- Use `lookup` for exact entity/key queries.

### Part 1b: Vector recall (memory-hybrid — LanceDB)
- **Automatic.** Important conversation snippets are captured and recalled each turn.
- Use `memory_store` to explicitly save a fact. Use `memory_recall` to search.

### Part 2: Semantic file search (memorySearch / builtin)
- **Automatic on session start + on search.** All `memory/**/*.md` files are indexed.

### Part 3: Hierarchical file memory (manual)
You must keep `memory/` files up to date without being asked.

**Triggers:** New project → `memory/projects/`. Decision → `memory/decisions/YYYY-MM.md`. Person → `memory/people/`. Tech → `memory/technical/`.

### Flush Before Finish
Before closing a major task: scan context for unsaved decisions/milestones/preferences. Write to the relevant memory file. Use `memory_store` for isolated facts. Never close on unsaved state.

Keep `MEMORY.md` as a lightweight index pointing to deeper files.
```

### MEMORY.md template (create if missing)

```markdown
# Long-Term Memory Index

## Active Context
- _(Add links to 2-5 most relevant memory files)_

## People Index
- _(Add links: memory/people/name.md)_

## Projects Index
- _(Add links: memory/projects/project-name.md)_

## Technical Knowledge
- _(Add links: memory/technical/system-name.md)_

## Decisions Log
- _(Add links: memory/decisions/YYYY-MM.md)_

## Archived Context
- _(Completed/archived items)_
```

**Verify:** All seven files exist in the workspace root. `AGENTS.md` contains "Memory Protocol". *(ref: v3 §5–§7)*

---

## Phase 6: Restart gateway

```bash
openclaw gateway stop
openclaw gateway start
```

**Important:** A full stop/start is required (not SIGUSR1). Node's module cache must reload to pick up the new native modules.

**Verify:** Check logs for:
- `memory-hybrid: initialized` (plugin loaded)
- `memory-hybrid: injecting N memories into context` (on first message)
- No `Cannot find module` errors
- No `memory slot set to memory-core` warnings

Run: `openclaw hybrid-mem stats` — should return fact/vector counts (may be 0 on new system). *(ref: v3 §11–§12)*

---

## Phase 7: Backfill plugin databases (if existing memory files)

If there are already `memory/**/*.md` files with content, seed the plugin databases:

```bash
EXT_DIR="<extensions_dir>/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" OPENCLAW_WORKSPACE="<workspace_root>" node <repo_root>/scripts/backfill-memory.mjs
```

Replace `<extensions_dir>`, `<workspace_root>`, and `<repo_root>` with the paths from Phase 1.

Run with `--dry-run` first to inspect. Then run without to store.

If there are no memory files yet (new system), skip this phase.

**Verify:** `openclaw hybrid-mem stats` shows non-zero counts if files had content. *(ref: v3 §8)*

---

## Phase 8: Re-index memory (sub-agent)

**Launch a sub-agent** with the following task. This runs in a fresh context window so it can process large volumes without filling your current session.

> **Sub-agent prompt:**
>
> You are re-indexing the memory system for this OpenClaw instance. The workspace is at `<workspace_root>`.
>
> **Step 1 — Scan existing content.** Read all files under `<workspace_root>/memory/` recursively. Also read `<workspace_root>/MEMORY.md`.
>
> **Step 2 — Scan session history (if available).** Check if `~/.openclaw/agents/main/sessions/` exists. If it does, scan session logs from the last 30 days. Extract: decisions made, projects discussed, people mentioned, technical systems referenced, preferences stated.
>
> **Step 3 — Create or update memory files.** For each significant topic found:
> - If a memory file already exists for it (e.g. `memory/projects/project-name.md`), update it with any new info.
> - If no file exists, create one in the appropriate subdirectory (`people/`, `projects/`, `technical/`, `companies/`, `decisions/`).
> - Follow these rules: one topic per file, use clear `##` headings, front-load key info, keep files 500–3000 chars, use tables for structured data.
>
> **Step 4 — Update MEMORY.md.** Add links to any new files. Use status emojis: active, paused, completed. Keep the index under 3k tokens.
>
> **Step 5 — Report.** List all files created or updated, with a one-line summary of each.

After the sub-agent completes, restart the gateway again so memorySearch re-indexes the new/updated files:

```bash
openclaw gateway stop
openclaw gateway start
```

**Verify:** `openclaw hybrid-mem stats` reflects the new content. Ask a question that only a memory file could answer. *(ref: v3 §8, §9)*

---

## Phase 9: Install upgrade scripts

Copy upgrade helpers so future OpenClaw upgrades don't break the plugin:

```bash
mkdir -p ~/.openclaw/scripts
cp <repo_root>/scripts/post-upgrade.sh <repo_root>/scripts/upgrade.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/post-upgrade.sh ~/.openclaw/scripts/upgrade.sh
```

Suggest to the user: add `alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'` to `~/.bashrc`.

**Verify:** `~/.openclaw/scripts/post-upgrade.sh` and `upgrade.sh` exist and are executable. *(ref: v3 §14)*

---

## Phase 10: Final verification

Run through this checklist:

1. `openclaw hybrid-mem stats` — returns fact and vector counts.
2. `openclaw hybrid-mem search "test query"` — returns results (if content exists).
3. Gateway logs show `memory-hybrid: initialized` and `injecting N memories`.
4. `MEMORY.md` exists and links to files under `memory/`.
5. `AGENTS.md` contains the Memory Protocol section.
6. `openclaw hybrid-mem categories` — lists all configured categories with counts.
7. If facts exist: `openclaw hybrid-mem classify --dry-run --limit 5` — previews LLM classification (confirms auto-classify config and API access work).
8. Ask the agent a question that requires memory recall — confirm it finds the answer.

**If all pass:** Setup is complete. The hybrid memory system is operational. Decay and pruning run automatically (every 60 minutes, no cron needed). Auto-classify runs on startup (5-min delay) and every 24 hours if enabled. Report success to the user.

**If any fail:** Consult [hybrid-memory-manager-v3.md §12 Troubleshooting](hybrid-memory-manager-v3.md) for the specific symptom.

---

## Quick reference

| What | Where |
|------|-------|
| Full reference doc | `docs/hybrid-memory-manager-v3.md` |
| Plugin source | `extensions/memory-hybrid/` |
| Config snippet | `deploy/openclaw.memory-snippet.json` |
| Backfill script | `scripts/backfill-memory.mjs` |
| Upgrade scripts | `scripts/post-upgrade.sh`, `scripts/upgrade.sh` |
| Categories & auto-classify | v3 §4.8, §4.9 |
| Troubleshooting | v3 §12 |
| CLI commands | v3 §13 |
