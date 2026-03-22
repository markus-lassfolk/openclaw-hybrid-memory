# Deployment artifacts for Hybrid Memory Manager v3.0

Use these with the [Quick Start](../docs/QUICKSTART.md) and [Configuration](../docs/CONFIGURATION.md) guides.

**Full hybrid only:** The system implements the **full hybrid memory system** — memory-hybrid plugin (SQLite+FTS5 + LanceDB) combined with memorySearch and hierarchical **memory/** files. One installation flow applies to any system (new, a few days old, or months old).

| File | Use |
|------|-----|
| **openclaw.memory-snippet.json** | Memory-related keys to merge into `~/.openclaw/openclaw.json`. Slot is `memory-hybrid`. Replace `YOUR_OPENAI_API_KEY`. Merge under existing `agents.defaults` if needed. |
| **openclaw.model-tokens-snippet.json** | Per-model `contextWindow` and `maxOutputTokens` for OpenClaw configs that support a model catalog. Source: [docs/MODEL-REFERENCE.md](../docs/MODEL-REFERENCE.md). The plugin uses its own catalog for distill; this snippet is for gateway/UI if your OpenClaw version reads it. |

**Deploy to local OpenClaw (for testing):** From the repo root run `./scripts/deploy-local.sh`. This syncs the plugin to `~/.openclaw/extensions/openclaw-hybrid-memory`, merges [openclaw.memory-snippet.json](openclaw.memory-snippet.json) and [openclaw.model-tokens-snippet.json](openclaw.model-tokens-snippet.json) into `~/.openclaw/openclaw.json`, then runs `openclaw hybrid-mem install` and `verify --fix` (if the openclaw CLI with the plugin is in PATH). Use `--no-install` or `--no-verify` to skip steps.

**Deploy:** Follow [QUICKSTART.md](../docs/QUICKSTART.md). Optional backfill (seed script + `openclaw hybrid-mem extract-daily`) is safe to run on a new system — see [MAINTENANCE.md](../docs/MAINTENANCE.md).

**After any OpenClaw upgrade:** Reinstall memory-hybrid deps and restart — see [MAINTENANCE.md](../docs/MAINTENANCE.md). Use the repo's **scripts/** (`post-upgrade.sh`, `upgrade.sh`) and alias `openclaw-upgrade` — see [../scripts/README.md](../scripts/README.md).
