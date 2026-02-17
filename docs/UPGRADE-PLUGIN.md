# Upgrading the Hybrid Memory Plugin

When a **new version of the openclaw-hybrid-memory plugin** is released, this is what to do and what to think about.

---

## Quick upgrade (NPM)

If you installed the plugin via OpenClaw's plugin system:

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

This fetches the latest version, installs it (and its dependencies), and replaces the previous copy. Restart is required so the gateway loads the new code.

---

## Manual upgrade (copy from repo)

If you install by copying files from this repo:

```bash
# 1. Copy new extension files over the existing dir
cp -r extensions/memory-hybrid/* "$(npm root -g)/openclaw/extensions/memory-hybrid/"

# 2. Reinstall deps (in case package.json or native deps changed)
cd "$(npm root -g)/openclaw/extensions/memory-hybrid"
npm install

# 3. Restart
openclaw gateway stop && openclaw gateway start

# 4. Verify
openclaw hybrid-mem verify
```

---

## What to think about when upgrading

### Database migrations (automatic)

The plugin has a **schema version**. On startup it checks the existing SQLite (and LanceDB) state and applies any needed migrations (new columns, indexes, tables). You do **not** need to run a separate migration command. Just start the gateway with the new plugin; migrations run once automatically.

### Config and new defaults

New plugin versions sometimes add **optional** config keys (e.g. new features with defaults). To see what the installer would add without changing your config:

```bash
openclaw hybrid-mem install --dry-run
```

To apply the recommended defaults (memory slot, compaction, nightly job, etc.) on top of your existing config:

```bash
openclaw hybrid-mem install
```

Review the diff or backup `openclaw.json` first if you've heavily customised it.

### Version metadata

The plugin exposes version info you can use to confirm what's running:

- **Plugin version** — From package.json (e.g. 1.2.3). Bumped on each release.
- **Memory manager version** — Spec version (e.g. 3.0). Changes only when the overall design/spec changes.
- **Schema version** — Integer used for DB migrations. Bumped when schema or migrations change.

You can see these in:

- `openclaw hybrid-mem stats` (often printed in the header or footer).
- Gateway logs at startup (e.g. "memory-hybrid" with version).
- The plugin's `openclaw.plugin.json` / API if the host exposes them.

### OpenClaw upgrade vs plugin upgrade

- **Upgrading OpenClaw** (e.g. `npm update -g openclaw`) — Can break native deps in **all** extensions. Always run the [post-upgrade step](UPGRADE-OPENCLAW.md) (e.g. `openclaw-upgrade` or `post-upgrade.sh`) and restart. See [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md).
- **Upgrading only the hybrid-memory plugin** — Replacing the plugin files and running `npm install` in the extension dir is enough. Restart the gateway. No separate "OpenClaw upgrade" step unless you also upgraded OpenClaw.

### Changelog and release notes

Before or after upgrading, check:

- **CHANGELOG.md** in this repo — List of changes per version.
- **release-notes/** — Release notes for specific versions (e.g. new features, breaking changes, config changes).

If a release notes file says "run `hybrid-mem install` after upgrade" or "back up before upgrading", follow that.

### Backups

For major upgrades or if you're unsure, back up the memory data first. See [BACKUP.md](BACKUP.md) for what to copy and how to restore.

---

## After upgrading the plugin

1. **Restart** the gateway (required).
2. Run **`openclaw hybrid-mem verify`** — Confirms config, SQLite, LanceDB, embedding API, and jobs.
3. Run **`openclaw hybrid-mem stats`** — Confirms fact/vector counts; quick sanity check that data is still there.

If something fails, check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and the release notes for that version.

---

## Related docs

- [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md) — What to do when you upgrade **OpenClaw** (not just the plugin)
- [BACKUP.md](BACKUP.md) — What to back up before an upgrade
- [OPERATIONS.md](OPERATIONS.md) — Scripts and file locations
- [CONFIGURATION.md](CONFIGURATION.md) — Config reference
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues after upgrades
