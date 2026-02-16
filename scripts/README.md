# Upgrade scripts (LanceDB reinstall after OpenClaw upgrades)

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

See [../docs/hybrid-memory-manager-v3.md §12](../docs/hybrid-memory-manager-v3.md) for the full upgrade section.

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

See [../docs/hybrid-memory-manager-v3.md §8 Backfill](../docs/hybrid-memory-manager-v3.md) for full details.
