---
layout: default
title: Operations
parent: Operations & Maintenance
nav_order: 2
---
# Operations — Background Jobs, Scripts, Cron, and Upgrades

Everything that runs automatically or needs periodic attention.

---

## Automatic background jobs (no setup needed)

These run inside the gateway process. No cron, no external scheduler.

| Job | Interval | What it does | Log signature |
|-----|----------|-------------|---------------|
| **Prune** | Every 60 minutes | Hard-deletes expired facts; soft-decays confidence for facts past ~75% of TTL | `memory-hybrid: periodic prune — N expired, M decayed` |
| **Auto-classify** | Every 24 hours + once at startup (5 min delay) | Reclassifies "other" facts into proper categories via LLM. Only runs if `autoClassify.enabled` is `true` | `memory-hybrid: auto-classify done — reclassified N/M facts` |
| **Proposal prune** | Every 60 minutes | Removes expired persona proposals. Only runs if `personaProposals.enabled` is `true` | `memory-hybrid: pruned N expired proposal(s)` |
| **WAL recovery** | Once at startup | Replays uncommitted write-ahead log entries from a crash | `memory-hybrid: WAL recovery completed — recovered N` |
| **Startup prune** | Once at startup | Deletes any expired facts immediately | (included in periodic prune log) |

**All timers are cleaned up on gateway stop.** No orphaned processes.

---

## Optional scheduled jobs (cron / OpenClaw jobs)

These are **not** required for core functionality but enhance the system for long-running setups.

**How to enable when "not defined":**

1. **Recommended:** Run **`openclaw hybrid-mem verify --fix`**. This adds the four optional jobs when they are missing (without overwriting existing jobs) to both `~/.openclaw/cron/jobs.json` and, if present, the `jobs` array in `~/.openclaw/openclaw.json`: `nightly-memory-sweep`, `weekly-reflection`, `weekly-extract-procedures`, and `self-correction-analysis`.
2. **Or** add the job definitions manually to `~/.openclaw/openclaw.json` (under a top-level `jobs` array if your OpenClaw version uses it) or to `~/.openclaw/cron/jobs.json` (see snippets below).
3. **Or** run the standalone install script from the repo: `node scripts/install-hybrid-config.mjs` (merges full defaults including jobs into openclaw.json).

After adding jobs, the gateway will pick them up on next start (or according to your host’s job reload behavior). No plugin restart needed for cron store changes in many setups.

### Nightly session distillation

Extracts durable facts from old conversation logs. Recommended if you want to capture knowledge from sessions where auto-capture missed things.

**OpenClaw jobs (recommended):** The `openclaw hybrid-mem install` command adds the nightly distillation and weekly reflection jobs to your config. When you run **`openclaw hybrid-mem verify --fix`**, missing jobs are added with a **model chosen from your config** (`llm.default` / `llm.heavy` when set, else legacy: Gemini → distill, Claude → claude, else OpenAI → reflection). See [CONFIGURATION.md § LLM routing and model preference](CONFIGURATION.md#llm-routing-and-model-preference) and [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md).

Example structure (actual `model` value is filled from your provider at install/verify time):

```json
{
  "jobs": [
    {
      "name": "nightly-memory-sweep",
      "schedule": "0 2 * * *",
      "channel": "system",
      "message": "Run nightly session distillation: last 3 days, isolated session.",
      "isolated": true,
      "model": "gemini-2.0-flash"
    }
  ]
}
```

This runs at 2 AM daily as an isolated sub-agent. It processes session logs from the last 3 days (incremental), extracts facts, dedupes, and stores.

**System cron alternative:** If you prefer system cron over OpenClaw's job scheduler:

```bash
# Add to crontab (crontab -e)
0 2 * * * cd ~/.openclaw && openclaw hybrid-mem distill >> /var/log/openclaw-distill.log 2>&1
```

Distill automatically records the run timestamp so the next job uses the correct incremental window and `verify` shows the last run.

**Distillation window commands:**

```bash
# See what the next distillation run would process
openclaw hybrid-mem distill-window

# Machine-readable output for scripts
openclaw hybrid-mem distill-window --json
# → {"mode":"incremental","startDate":"2026-02-14","endDate":"2026-02-17","mtimeDays":3}
```

See [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for the full pipeline details.

### Weekly reflection

Synthesizes behavioral patterns from recent facts. The `openclaw hybrid-mem install` command adds a weekly job; `verify --fix` adds it when missing.

```json
{
  "name": "weekly-reflection",
  "schedule": "0 3 * * 0",
  "channel": "system",
  "message": "Run memory reflection: analyze facts from the last 14 days, extract behavioral patterns, store as pattern-category facts. Use memory_reflect tool.",
  "isolated": true,
  "model": "gpt-4o-mini"
}
```

Runs at 3 AM Sundays. The `model` value is resolved from your config (see [CONFIGURATION.md § Default model selection](CONFIGURATION.md#default-model-selection-maintenance-and-self-correction)). Requires `reflection.enabled: true` in plugin config. See [REFLECTION.md](REFLECTION.md).

### What the two jobs cover (and what they don’t)

| What | Covered by | Notes |
|------|------------|--------|
| **Session distillation** (facts from old conversation logs) | **nightly-memory-sweep** | Distill automatically records the run timestamp after completion. With `distill.extractDirectives` / `distill.extractReinforcement` the same run can extract directives and reinforcement. |
| **Reflection** (pattern synthesis from facts) | **weekly-reflection** | Uses `memory_reflect`; requires `reflection.enabled: true`. |
| **Prune expired facts** | Gateway (every 60 min) | No cron job needed. |
| **Auto-classify** ("other" → categories) | Gateway (every 24 h if enabled) | No cron job needed. |
| **Compaction** (tier migration hot/warm/cold) | Gateway (on session end if `memoryTiering.compactionOnSessionEnd`) | No cron job needed. |
| **Procedural memory** (extract procedures from sessions) | Not in the two jobs | Run **`openclaw hybrid-mem extract-procedures`** on a schedule (e.g. weekly after distill) if you want procedures updated from session logs. |
| **Self-correction analysis** | Optional third job | The repo’s `scripts/install-hybrid-config.mjs` adds a `self-correction-analysis` job; you can add it manually or run `openclaw hybrid-mem self-correction-run` on a schedule. |

So the two suggested jobs (nightly sweep + weekly reflection) cover **distillation** and **reflection**. Everything else that must run regularly (prune, auto-classify, compaction) runs inside the gateway. Only **extract-procedures** and **self-correction** are additional optional schedules if you want them.

---

## Scripts reference

All scripts live in `scripts/` in this repo. Copy the ones you need to `~/.openclaw/scripts/`.

### Upgrade scripts

| Script | Purpose | When to use |
|--------|---------|-------------|
| `scripts/upgrade.sh` | Runs `npm update -g openclaw` then `post-upgrade.sh` | Every time you upgrade OpenClaw |
| `scripts/post-upgrade.sh` | Reinstalls deps in extension dir, restarts gateway | After any OpenClaw upgrade (manual or npm) |

**Setup (one time):**

```bash
mkdir -p ~/.openclaw/scripts
cp scripts/post-upgrade.sh scripts/upgrade.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/post-upgrade.sh ~/.openclaw/scripts/upgrade.sh

# Add alias to ~/.bashrc
echo "alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'" >> ~/.bashrc
source ~/.bashrc
```

**Then upgrade with:** `openclaw-upgrade`

**Environment variables for scripts:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_MEMORY_EXTENSION` | `memory-hybrid` | Extension name (change if using `memory-lancedb`) |
| `OPENCLAW_MEMORY_EXTENSION_DIR` | Auto-detected via `npm root -g` | Override full path to extension dir |

### Install and backfill scripts

| Script | Purpose | When to use |
|--------|---------|-------------|
| `scripts/install-hybrid-config.mjs` | Writes full config defaults to `openclaw.json` | First install (before gateway exists) |
| `scripts/backfill-memory.mjs` | Seeds plugin DBs from `MEMORY.md` + `memory/**/*.md` | After first install or adding new memory files |

**Backfill:**

```bash
EXT_DIR="$(npm root -g)/openclaw/extensions/memory-hybrid"
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs

# Dry run first:
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs --dry-run
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_WORKSPACE` | `~/.openclaw/workspace` | Workspace root to scan for memory files |
| `OPENCLAW_EXTENSION_DIR` | Auto-detected | Extension dir for loading deps |

### Session distillation scripts

Located in `scripts/distill-sessions/`. See [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) for full details.

| Script | Purpose |
|--------|---------|
| `batch-sessions.sh` | Groups session logs into batches for processing |
| Nightly log output | Written to `scripts/distill-sessions/nightly-logs/YYYY-MM-DD.md` |

---

## Upgrading OpenClaw

**Important:** After every OpenClaw upgrade, the plugin's native dependencies (`better-sqlite3`, `@lancedb/lancedb`) can break because npm reinstalls the top-level package without touching extension directories.

→ Full guide: [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md)

### Upgrade process

```bash
# Option 1: One-command upgrade (recommended)
openclaw-upgrade

# Option 2: Manual steps
npm update -g openclaw
~/.openclaw/scripts/post-upgrade.sh

# Option 3: Fully manual
npm update -g openclaw
cd "$(npm root -g)/openclaw/extensions/memory-hybrid"
npm install
openclaw gateway stop
openclaw gateway start
```

### After upgrading

1. Check logs for `memory-hybrid: initialized` — confirms the plugin loaded.
2. Run `openclaw hybrid-mem verify` — confirms DBs and embedding API work.
3. Run `openclaw hybrid-mem stats` — confirms fact/vector counts are intact.

### Why this is needed

Global npm upgrades reinstall the top-level `openclaw` package without running `npm install` inside extension directories. The plugin depends on native modules that need to be compiled for the current Node.js version and platform.

---

## Upgrading the hybrid memory plugin

When a new version of this plugin is released:

→ Full guide: [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md)

### NPM install

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

### Manual install

```bash
# 1. Copy new extension files
cp -r extensions/memory-hybrid/* "$(npm root -g)/openclaw/extensions/memory-hybrid/"

# 2. Install deps (in case package.json changed)
cd "$(npm root -g)/openclaw/extensions/memory-hybrid"
npm install

# 3. Restart
openclaw gateway stop && openclaw gateway start

# 4. Verify
openclaw hybrid-mem verify
```

**Database migrations** run automatically on startup. The plugin checks `schemaVersion` and applies any needed SQLite migrations. No manual migration step is required.

**Config changes:** New features may add optional config keys. Run `openclaw hybrid-mem install --dry-run` to see what defaults would be added, then `openclaw hybrid-mem install` to apply them.

---

## Periodic maintenance checklist

These are optional but recommended for long-running systems:

| Task | Frequency | Command / Action |
|------|-----------|-----------------|
| **Verify health** | Weekly or after changes | `openclaw hybrid-mem verify` |
| **Review stats** | Weekly | `openclaw hybrid-mem stats` |
| **Find duplicates** | Monthly | `openclaw hybrid-mem find-duplicates --threshold 0.92` |
| **Consolidate** | Monthly (after review) | `openclaw hybrid-mem consolidate --dry-run` then `consolidate` |
| **Review memory files** | Monthly | Read recent `memory/YYYY-MM-DD.md`, update `memory/` files |
| **Update MEMORY.md index** | When files change | Edit `MEMORY.md` to reflect current structure |
| **Archive completed projects** | When done | Move from `memory/projects/` to `memory/archive/` |
| **Run reflection** | Monthly | `openclaw hybrid-mem reflect --dry-run` then `reflect` |
| **Check distillation** | Weekly (if enabled) | `openclaw hybrid-mem verify` shows last distillation run |
| **Backfill after adding files** | After adding many memory files | `node scripts/backfill-memory.mjs` |

---

## File locations reference

| What | Default path | Override |
|------|-------------|----------|
| OpenClaw config | `~/.openclaw/openclaw.json` | `OPENCLAW_HOME` env var |
| SQLite database | `~/.openclaw/memory/facts.db` | `sqlitePath` in plugin config |
| LanceDB directory | `~/.openclaw/memory/lancedb/` | `lanceDbPath` in plugin config |
| Write-ahead log | `~/.openclaw/memory/wal.jsonl` | Adjacent to SQLite path |
| Discovered categories | `~/.openclaw/memory/.discovered-categories.json` | Adjacent to SQLite path |
| Distillation last run | `~/.openclaw/memory/.distill_last_run` | Adjacent to SQLite path |
| Credential vault | `~/.openclaw/memory/credentials.db` | Adjacent to SQLite path |
| Workspace root | `~/.openclaw/workspace/` | `OPENCLAW_WORKSPACE` env var |
| Extension directory | `$(npm root -g)/openclaw/extensions/memory-hybrid/` | `OPENCLAW_MEMORY_EXTENSION_DIR` env var |
| Upgrade scripts | `~/.openclaw/scripts/` | Copy from repo `scripts/` |

For **what to back up** and how to restore, see [BACKUP.md](BACKUP.md).

---

## Related docs

- [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md) — What to do after every OpenClaw upgrade
- [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md) — Upgrading the hybrid-memory plugin
- [BACKUP.md](BACKUP.md) — What to back up and how to restore
- [UNINSTALL.md](UNINSTALL.md) — Uninstalling the solution (revert to default memory)
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — Runtime flow and what happens each turn
- [QUICKSTART.md](QUICKSTART.md) — Installation
- [CONFIGURATION.md](CONFIGURATION.md) — Config reference
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Session distillation pipeline
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues
- [MAINTENANCE.md](MAINTENANCE.md) — File hygiene and periodic review
