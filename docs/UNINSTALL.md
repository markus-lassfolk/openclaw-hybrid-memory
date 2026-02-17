---
layout: default
title: Uninstall
parent: Operations & Maintenance
nav_order: 3
---
# Uninstalling the Hybrid Memory Solution

How to revert to OpenClaw’s default memory (memory-core) and optionally remove all hybrid memory data.

---

## What uninstall does

The command **`openclaw hybrid-mem uninstall`** does two things by default:

1. **Config** — Updates `openclaw.json`: sets `plugins.slots.memory` to `memory-core` and sets `plugins.entries["openclaw-hybrid-memory"].enabled` to `false`. OpenClaw will use the built-in memory manager instead of hybrid memory.
2. **Data** — Leaves all hybrid memory data in place (SQLite database, LanceDB directory, and other files). Nothing is deleted.

After uninstall, the gateway must be **restarted** for the config change to take effect. Your facts and vectors remain on disk; you can re-enable the plugin later and they will still be there.

---

## Basic uninstall (keep data)

```bash
openclaw hybrid-mem uninstall
openclaw gateway stop
openclaw gateway start
```

- OpenClaw will use **memory-core** (default memory).
- **Data is kept** at the configured paths (default: `~/.openclaw/memory/facts.db` and `~/.openclaw/memory/lancedb/`).
- To use hybrid memory again: re-enable the plugin and set `plugins.slots.memory` back to `openclaw-hybrid-memory`, then restart.

---

## Options

| Option | Description |
|--------|-------------|
| **none** | Update config only; leave all data in place. |
| `--leave-config` | Do **not** modify `openclaw.json`. Only print the manual steps you need to apply. Use when you want to uninstall “on paper” or edit config yourself. |
| `--clean-all` | Update config **and** delete the SQLite database and LanceDB directory. **Irreversible.** |
| `--force-cleanup` | Same as `--clean-all`. |

### Examples

```bash
# Uninstall but keep data (safe, reversible)
openclaw hybrid-mem uninstall

# Uninstall and remove SQLite + LanceDB data (irreversible)
openclaw hybrid-mem uninstall --clean-all

# Only get instructions; don't change config
openclaw hybrid-mem uninstall --leave-config
```

---

## What gets removed with `--clean-all`

Only the **main data stores** at the paths the plugin was using:

- **SQLite database** — e.g. `~/.openclaw/memory/facts.db` (facts, FTS index, credentials pointer table, etc.).
- **LanceDB directory** — e.g. `~/.openclaw/memory/lancedb/` (vector index).

These paths come from your config (`sqlitePath`, `lanceDbPath`) or defaults.

**Not removed** by `--clean-all`:

- **Write-ahead log** — `wal.jsonl` (next to facts.db). Safe to delete manually if you have no data left.
- **Credentials vault** — `credentials.db` (if you used it). Remove manually if you want to wipe secrets.
- **Persona proposals DB** — `proposals.db` (if persona proposals were enabled). Remove manually if desired.
- **Auxiliary files** — `.discovered-categories.json`, `.distill_last_run` (next to facts.db). Optional to delete.
- **Config** — `openclaw.json` is only **updated** (slot + disabled); not deleted.
- **Workspace memory files** — `memory/` under your workspace are **never** touched by uninstall. They belong to your project, not the plugin.

If you want a **full cleanup** (no trace of hybrid data), after `uninstall --clean-all` you can manually remove the rest:

```bash
# Optional: remove other hybrid-related files (adjust paths if you changed sqlitePath)
rm -f ~/.openclaw/memory/wal.jsonl
rm -f ~/.openclaw/memory/credentials.db
rm -f ~/.openclaw/memory/proposals.db
rm -f ~/.openclaw/memory/.discovered-categories.json
rm -f ~/.openclaw/memory/.distill_last_run
```

---

## If config can’t be updated

If the command reports `config_not_found` or `config_error`, it will print the steps. Apply them manually:

1. Open your OpenClaw config (e.g. `~/.openclaw/openclaw.json`).
2. Set `plugins.slots.memory` to `"memory-core"`.
3. Set `plugins.entries["openclaw-hybrid-memory"].enabled` to `false`.
4. Restart the gateway: `openclaw gateway stop` then `openclaw gateway start`.

---

## Re-enabling after uninstall (data kept)

If you ran uninstall **without** `--clean-all`:

1. Edit `openclaw.json`: set `plugins.slots.memory` to `"openclaw-hybrid-memory"` and `plugins.entries["openclaw-hybrid-memory"].enabled` to `true`.
2. Restart the gateway.
3. Run `openclaw hybrid-mem verify` to confirm DBs and API are working.

Your existing facts and vectors will still be there.

---

## Full reset (remove everything and start fresh)

To wipe hybrid memory completely and reinstall with defaults:

```bash
openclaw hybrid-mem uninstall --clean-all
openclaw hybrid-mem install
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

This removes SQLite and LanceDB data, then reapplies recommended config (memory slot, compaction, nightly job). Data is **irreversible**; backup first if needed (see [BACKUP.md](BACKUP.md)).

---

## Related docs

- [BACKUP.md](BACKUP.md) — What to back up before uninstall or reset
- [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md) — What to do after upgrading OpenClaw
- [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md) — Upgrading the plugin
- [QUICKSTART.md](QUICKSTART.md) — Reinstall from scratch
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All `hybrid-mem` commands
- [OPERATIONS.md](OPERATIONS.md) — File locations reference
