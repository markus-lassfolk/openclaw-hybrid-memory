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
| **SQLite database** | `~/.openclaw/memory/facts.db` | All facts, FTS index, metadata. Single file. Credentials are stored separately (see below), not in this file. |
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
| **Crystallization proposals** | `~/.openclaw/memory/crystallization-proposals.db` | Pending workflow-crystallization skill proposals. Back up if `crystallization.enabled`. |
| **Tool proposals** | `~/.openclaw/memory/tool-proposals.db` | Pending self-extension/tool proposals. |

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

## Automated snapshot backups (`hybrid-mem backup`)

The plugin also ships a self-managed snapshot backup command that captures SQLite (via
`VACUUM INTO`, safe on a live WAL-mode database) and the LanceDB directory into a timestamped
folder — no need to stop the gateway.

```bash
# Create a snapshot: ~/.openclaw/backups/memory/<timestamp>/
openclaw hybrid-mem backup

# Verify SQLite integrity without creating a new backup
openclaw hybrid-mem backup verify

# Retention + health audit: completed/retained/stale-partial counts, bytes, last success/failure
openclaw hybrid-mem backup status

# Deterministically clean up stale/partial artifacts and enforce retention on demand
openclaw hybrid-mem backup prune

# Install a weekly cron entry (defaults to Sunday 04:00; configurable via
# maintenance.cronReliability.weeklyBackupCron)
openclaw hybrid-mem backup schedule
```

### Bounded retention (Issue #2229)

Every successful `backup` run atomically promotes a hidden `.backup-tmp-*` working directory to
its final timestamped name only once SQLite, LanceDB, and the manifest have all been written
successfully — a crash or `kill -9` mid-backup can never leave a directory that looks like a
completed snapshot, and any abandoned working directory or stray artifact is cleaned up on the
next run (or on demand via `backup prune`).

After a successful run, older completed snapshots are pruned per `maintenance.backup` config:

```yaml
maintenance:
  backup:
    retentionCount: 7      # keep the 7 newest completed snapshots (0 disables count-based pruning)
    retentionAgeDays: 30   # prune snapshots older than 30 days (0 disables age-based pruning)
```

The newest completed snapshot is **never** pruned, even if it's the only one on disk and older
than `retentionAgeDays` — losing the sole valid backup because it aged out would defeat the
purpose of having one. `openclaw hybrid-mem backup status` reports completed/retained/stale
counts, total bytes, and the newest/oldest snapshot; `openclaw hybrid-mem backup prune` applies
the policy deterministically without creating a new backup.

### Health alerting (Issue #2230)

Each run records its outcome to `~/.openclaw/state/memory-backup-last.json` (`ok`, timestamp,
error, failure reason category, consecutive-failure count, last verified success). This state
feeds three surfaces:

- `openclaw hybrid-mem health` — a `Backup` traffic-light indicator.
- `openclaw hybrid-mem audit health` / `graph health` — a `backupHealth` field with status,
  reason category, and age since last verified success (read-only; never fires an alert itself).
- The weekly `audit-health` maintenance cron step — the actual heartbeat tick, which fires a
  **deduplicated** alert (via the same error-reporter pipeline used for other plugin errors) when
  the backup has failed or when the last verified success is older than
  `maintenance.backup.alerting.staleAfterHours` (default 192h / 8 days — one day of grace past the
  default weekly cadence). Repeated failures only re-alert after
  `maintenance.backup.alerting.dedupeWindowHours` (default 24h) elapses; a later successful backup
  immediately clears the stale failure state from all three surfaces.

```yaml
maintenance:
  backup:
    alerting:
      enabled: true          # set false to disable backup health alerting entirely
      staleAfterHours: 192   # alert if no verified success in this many hours
      dedupeWindowHours: 24  # minimum time between repeated alerts for the same persisting issue
```

Failure reason categories (`disk_full`, `permission_denied`, `path_not_found`,
`integrity_check_failed`, `unknown`) are derived from the error message and come with
non-sensitive remediation guidance (e.g. "free disk space on the backup volume").

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
