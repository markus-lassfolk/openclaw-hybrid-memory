# Scripts

## Standalone install (when "plugin not found" blocks upgrade)

If you see **"plugin not found: openclaw-hybrid-memory"** and `openclaw plugins install` fails, use one of these — they bypass OpenClaw entirely:

```bash
# Option A: npx
npx -y openclaw-hybrid-memory-install

# Option B: curl (from this repo or raw URL)
./scripts/install.sh
# Or: curl -sSL https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh | bash
```

See [docs/UPGRADE-PLUGIN.md](../docs/UPGRADE-PLUGIN.md#when-plugin-not-found-blocks-install).

---

## Use NPM only (avoid duplicate plugin)

If you see **"duplicate plugin id detected"** and want a single, user-friendly upgrade path, use only the NPM-installed plugin in `~/.openclaw/extensions`. Remove the global/bundled copy once:

```bash
./scripts/use-npm-only.sh
```

Then install and upgrade with:

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

See [docs/UPGRADE-PLUGIN.md](../docs/UPGRADE-PLUGIN.md#using-npm-only-recommended).

---

## First install: config only (no gateway needed)

**`install-hybrid-config.mjs`** — Writes full Hybrid Memory defaults (plugin slot, memorySearch, compaction prompts, nightly-memory-sweep job) into `~/.openclaw/openclaw.json` so you can get a complete config before the first gateway start.

```bash
# From repo root (set OPENCLAW_HOME if needed)
node scripts/install-hybrid-config.mjs
```

Then set your OpenAI API key in the config, copy the plugin to the extensions dir, run `npm install` there, and start the gateway. See the repo [README](../README.md) § First install.

---

## Upgrade scripts (LanceDB reinstall after OpenClaw upgrades)

After every **OpenClaw upgrade**, the active memory extension’s native deps (e.g. `@lancedb/lancedb`, and for memory-hybrid `better-sqlite3`) must be reinstalled in the extension directory and the gateway restarted. These scripts automate that.

**Copy both scripts to `~/.openclaw/scripts/`:**

```bash
mkdir -p ~/.openclaw/scripts
cp scripts/post-upgrade.sh scripts/upgrade.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/post-upgrade.sh ~/.openclaw/scripts/upgrade.sh
```

**Which extension is used:** The script defaults to **memory-hybrid**. If you use **memory-lancedb** as the memory slot, set before running (e.g. in `~/.bashrc`):

```bash
export OPENCLAW_MEMORY_EXTENSION=memory-lancedb
```

**Optional: bash alias for one-command upgrades**

Add to `~/.bashrc` or `~/.bash_aliases`:

```bash
alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'
```

Then run **`openclaw-upgrade`** whenever you upgrade; it runs `npm update -g openclaw` and then post-upgrade (reinstall + restart).

**If OpenClaw is installed somewhere `npm root -g` doesn’t cover**, set the full extension path before running:

```bash
export OPENCLAW_MEMORY_EXTENSION_DIR=/path/to/openclaw/extensions/memory-hybrid
~/.openclaw/scripts/post-upgrade.sh
```

See [../docs/MAINTENANCE.md](../docs/MAINTENANCE.md) for the full upgrade section.

---

## Backfill (memory-hybrid)

The **dynamic backfill script** `backfill-memory.mjs` seeds the memory-hybrid plugin from `MEMORY.md` and `memory/**/*.md` under your workspace. It uses no hardcoded dates or section names: it discovers files by glob and parses content so it keeps working as you add files or change structure.

**When parsing old memories:** Include `source_date` if available. Lines with a `[YYYY-MM-DD]` prefix are parsed: the date is stored as `source_date` and stripped from the fact text.

**Requirements:** Plugin config in `~/.openclaw/openclaw.json` (including `embedding.apiKey`). The script loads `better-sqlite3`, `openai`, and `@lancedb/lancedb` from the memory-hybrid extension’s `node_modules`.

**Run from repo root (or set `OPENCLAW_EXTENSION_DIR` to the extension path):**

```bash
# Extension dir: npm global or explicit
EXT_DIR="${OPENCLAW_EXTENSION_DIR:-$(npm root -g)/openclaw/extensions/memory-hybrid}"
NODE_PATH="$EXT_DIR/node_modules" OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}" node scripts/backfill-memory.mjs
```

**Dry run (no writes):**

```bash
NODE_PATH="$EXT_DIR/node_modules" node scripts/backfill-memory.mjs --dry-run
```

See [../docs/MAINTENANCE.md](../docs/MAINTENANCE.md) for full details on deployment and backfill.

---

## Gateway watchdog (cron-only, no systemd)

Use this when the gateway is **not** run as a systemd (or launchd) service: e.g. WSL2, containers, or when you prefer cron to start and supervise the gateway. The script checks every run (e.g. every 5 minutes via crontab) whether the gateway is running and responsive; if not, it restores **last-known-good config** (keeps 3 snapshots) and tries each in reverse order until the gateway is healthy.

**Behaviour:**

- **Health check:** `openclaw gateway probe` (no systemd).
- **If healthy:** Optionally stamp current config as a new last-good snapshot (keeps 3 most recent).
- **If not healthy:** Kill anything on the gateway port, start `openclaw gateway run` in the background, wait, probe. If that fails (e.g. bad config), restore each of the 3 good snapshots (newest first), start gateway, probe, until one works.

**Install:**

```bash
mkdir -p ~/.openclaw/scripts ~/.openclaw/logs
cp scripts/gateway-watchdog-cron.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/gateway-watchdog-cron.sh
```

**Crontab (one entry, every 5 minutes):**

```bash
*/5 * * * * /home/markus/.openclaw/scripts/gateway-watchdog-cron.sh >> /home/markus/.openclaw/logs/watchdog.log 2>&1
```

**Optional:** Set `OPENCLAW_HOME` or `OPENCLAW_GATEWAY_PORT` in crontab or in the script if your state dir or port differ. Do **not** use `openclaw gateway start` (systemd) on the same machine; use either this watchdog with `gateway run` or systemd, not both.

The watchdog’s **kill_port** step now uses `ss`, then `lsof`/`fuser` as fallback to find the process on the gateway port, and sends SIGTERM then SIGKILL if the port is still in use (so stale or stuck processes are cleared).

See [../docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md) for WSL2 / no-systemd notes.

---

## Force-release gateway port

When **"Port 18789 is already in use"** or the gateway won’t start because the port is held by a stale process (e.g. after OOM or crash), use the force-release script to stop the systemd service (if any), find and kill whatever is on the port, then report whether the port is free.

**From repo:**

```bash
./scripts/force-release-gateway-port.sh
```

**After copying to ~/.openclaw/scripts/:**

```bash
cp scripts/force-release-gateway-port.sh ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/force-release-gateway-port.sh
~/.openclaw/scripts/force-release-gateway-port.sh
```

Set `OPENCLAW_GATEWAY_PORT` if your port is not 18789. Full causes and manual steps: [../docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md#port-not-releasing-gateway-port-18789-already-in-use).
