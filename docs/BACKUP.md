---
layout: default
title: Backup
parent: Operations & Maintenance
nav_order: 6
---
# Backing Up the Memory Solution

What to back up, where it lives, and how to restore. Use this before major upgrades, before running uninstall with `--clean-all`, or for regular disaster recovery.

---

## What to back up

The hybrid memory solution uses **files on disk**. Back up the following.

### Core data (required for full restore)

| What | Default path | Notes |
|------|--------------|-------|
| **SQLite database** | `~/.openclaw/memory/facts.db` | All facts, FTS index, metadata, optional credential pointers. Single file. |
| **LanceDB directory** | `~/.openclaw/memory/lancedb/` | Vector index (directory with internal files). Copy the whole directory. |

If you changed paths in config, use your `sqlitePath` and `lanceDbPath` instead.

### Optional but recommended

| What | Default path | Notes |
|------|--------------|-------|
| **Write-ahead log** | `~/.openclaw/memory/wal.jsonl` | Uncommitted ops; only needed if you care about crash recovery in flight. |
| **Discovered categories** | `~/.openclaw/memory/.discovered-categories.json` | Auto-discovered categories from “other” facts. |
| **Distillation last run** | `~/.openclaw/memory/.distill_last_run` | Timestamp for incremental session distillation. |

### If you use these features

| What | Default path | Notes |
|------|--------------|-------|
| **Credentials vault** | `~/.openclaw/memory/credentials.db` | Encrypted credential store. Back up if you use the vault. |
| **Persona proposals** | `~/.openclaw/memory/proposals.db` | Pending/approved proposals. Back up if you use persona proposals. |

### Workspace memory files (separate from plugin DBs)

| What | Typical path | Notes |
|------|--------------|-------|
| **Memory files** | `~/.openclaw/workspace/memory/` (or your workspace root) | Markdown files (MEMORY.md, memory/**/*.md). Not managed by the plugin DB; back up with your workspace. |

Bootstrap files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md, etc.) are also under the workspace; include them in your normal project/workspace backup.

### Config (optional)

| What | Path | Notes |
|------|------|-------|
| **OpenClaw config** | `~/.openclaw/openclaw.json` | Plugin config, memory slot, API keys (redact or store securely). |

---

## Simple backup (tar)

**Stop the gateway first** so SQLite and LanceDB are not in use:

```bash
openclaw gateway stop

# Default paths; adjust if you use custom sqlitePath/lanceDbPath
BACKUP_DIR=~/.openclaw/memory
TS=$(date +%Y%m%d-%H%M%S)
tar -czvf ~/openclaw-memory-backup-$TS.tar.gz -C "$(dirname "$BACKUP_DIR")" "$(basename "$BACKUP_DIR")"

openclaw gateway start
```

This archives the whole `memory` directory (facts.db, lancedb/, wal.jsonl, credentials.db, proposals.db, etc.). Restore by extracting the tarball over `~/.openclaw/memory/` (with gateway stopped).

---

## SQLite-only backup (smaller, no vectors)

If you only need facts (no vector search restore):

```bash
openclaw gateway stop
sqlite3 ~/.openclaw/memory/facts.db ".backup ~/facts-backup-$(date +%Y%m%d).db"
openclaw gateway start
```

Restore by replacing `facts.db` with the backup file (gateway stopped). Vector search will need to be repopulated (e.g. backfill or re-embed) unless you also back up the LanceDB directory.

---

## Restore procedure

1. **Stop the gateway** — `openclaw gateway stop`.
2. **Replace or extract** — Restore the files/directories to their correct paths (e.g. `~/.openclaw/memory/`). Overwrite existing if doing a full restore.
3. **Permissions** — Ensure the process that runs the gateway can read (and write) the restored files.
4. **Start the gateway** — `openclaw gateway start`.
5. **Verify** — `openclaw hybrid-mem verify` and `openclaw hybrid-mem stats`.

If you restored only SQLite (no LanceDB), vector search will be empty until you run a backfill or re-store data; FTS and lookup will still work.

---

## When to back up

- Before **major plugin or OpenClaw upgrades** (if you want a rollback path).
- Before **`openclaw hybrid-mem uninstall --clean-all`** (data is deleted; backup is the only way to get it back).
- On a **schedule** (e.g. daily/weekly) if you treat memory as critical state.
- Before running **consolidate** or **reflection** in production for the first time (optional; usually non-destructive).

---

## Related docs

- [UNINSTALL.md](UNINSTALL.md) — What gets removed with uninstall; full reset
- [OPERATIONS.md](OPERATIONS.md) — File locations reference
- [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md) — Upgrading the plugin
- [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md) — Upgrading OpenClaw
