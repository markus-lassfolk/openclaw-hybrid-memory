---
layout: default
title: Upgrade OpenClaw
parent: Operations & Maintenance
nav_order: 4
---
# Upgrading OpenClaw (and What to Do After)

When you upgrade the **OpenClaw** CLI/platform (e.g. `npm update -g openclaw`), the hybrid memory plugin's native dependencies can break. This doc explains why and what to do every time you upgrade OpenClaw.

---

## Why something extra is needed

OpenClaw is installed globally. When you run `npm update -g openclaw`, npm updates only the top-level package. It does **not** run `npm install` inside extension directories.

The memory-hybrid plugin depends on **native modules** (better-sqlite3, @lancedb/lancedb) that must be compiled for your Node.js version and OS. After an OpenClaw upgrade they may no longer load — you may see "Cannot find module '@lancedb/lancedb'" or "Cannot find module 'better-sqlite3'".

So after **every OpenClaw upgrade** you must **reinstall dependencies in the extension directory** and **restart the gateway**.

---

## What to do after every OpenClaw upgrade

### Option 1: One-command upgrade (recommended)

**One-time setup:**

```bash
mkdir -p ~/.openclaw/scripts
cp scripts/post-upgrade.sh scripts/upgrade.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/post-upgrade.sh ~/.openclaw/scripts/upgrade.sh
echo "alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'" >> ~/.bashrc
source ~/.bashrc
```

**Every time you upgrade OpenClaw:**

```bash
openclaw-upgrade
```

This runs `npm update -g openclaw` then `post-upgrade.sh` (npm install in extension dir + gateway restart). See [scripts/README.md](../scripts/README.md) for env vars.

### Option 2: Manual steps

```bash
npm update -g openclaw
~/.openclaw/scripts/post-upgrade.sh
```

Or without scripts:

```bash
npm update -g openclaw
cd "$(npm root -g)/openclaw/extensions/memory-hybrid"
npm install
openclaw gateway stop
openclaw gateway start
```

---

## Config and state directory (if config seems "lost" after upgrade)

OpenClaw stores **config and state** in a **state directory**. After an OpenClaw (core) upgrade, config can appear "lost" if the new version looks in a different place.

- **Default state dir:** `~/.openclaw/` — main config file is `openclaw.json` there.
- **Overrides:** `OPENCLAW_STATE_DIR` or `--profile` can change the path (e.g. some profiles use `~/.openclaw-<name>/`).
- **Legacy names:** Older installs used `clawdbot.json` / `moltbot.json` / `moldbot.json`. Newer OpenClaw uses `openclaw.json` in the state dir; when both exist, the core may prefer one and doctor can rename legacy files to `*.migrated`.

**If your config or plugin settings seem missing after an OpenClaw upgrade:**

1. **See where OpenClaw is looking:**  
   `openclaw status` — check which state directory / profile is in use.
2. **Run doctor (migrations + repair):**  
   `openclaw doctor` — applies config migrations and can rename stale legacy configs.
3. **Confirm config path:**  
   Ensure `openclaw.json` exists in that state dir (e.g. `~/.openclaw/openclaw.json` if you use the default). If you had a backup or an old install, copy or merge your `openclaw.json` (and plugin entries) into that path.
4. **Env/profile:**  
   If you use `OPENCLAW_STATE_DIR` or a profile, run the gateway with the same env/profile so it uses the same state dir you migrated or edited.

OpenClaw’s own docs: [Migrating OpenClaw](https://docs.openclaw.ai/install/migrating) and [Where does OpenClaw store its data?](https://docs.openclaw.ai/help/faq#where-does-openclaw-store-its-data).

---

## After upgrading: verify

1. Check logs for e.g. `memory-hybrid: initialized`.
2. Run `openclaw hybrid-mem verify`.
3. Run `openclaw hybrid-mem stats` to confirm fact/vector counts.

---

## Script environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_MEMORY_EXTENSION` | `memory-hybrid` | Extension name. |
| `OPENCLAW_MEMORY_EXTENSION_DIR` | Auto-detected | Override path to extension dir. |

---

## Related docs

- [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md) — Upgrading the hybrid-memory plugin itself
- [OPERATIONS.md](OPERATIONS.md) — Scripts and background jobs
- [MAINTENANCE.md](MAINTENANCE.md) — File hygiene and periodic review
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Cannot find module and other issues
- [scripts/README.md](../scripts/README.md) — Upgrade script details
