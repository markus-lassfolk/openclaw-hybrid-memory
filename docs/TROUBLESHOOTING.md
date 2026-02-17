# Troubleshooting

Common issues, causes, and fixes for the memory-hybrid plugin.

---

## Quick diagnostics

```bash
openclaw hybrid-mem verify        # check config, DBs, API key
openclaw hybrid-mem verify --fix  # apply safe auto-fixes
openclaw hybrid-mem stats         # show fact/vector counts
```

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| memory-hybrid disabled / "memory slot set to memory-core" | Slot not set | Set `plugins.slots.memory` to `"openclaw-hybrid-memory"` in `openclaw.json` |
| Plugin fails to load / "embedding.apiKey is required" | No OpenAI key in config | Add `embedding.apiKey` and `embedding.model` to plugin config. See [CONFIGURATION.md](CONFIGURATION.md). |
| Invalid or expired API key | Key wrong, revoked, or out of credits | First embed or `verify` will fail with 401/403. Fix the key and restart. |
| Missing env var for API key | Env not loaded in non-interactive shell | Inline key in config or ensure env is set for the process |
| `Cannot find module '@lancedb/lancedb'` or `better-sqlite3` | Extension deps not installed, or OpenClaw was upgraded | Install in extension dir ([QUICKSTART.md](QUICKSTART.md)); after upgrades run post-upgrade ([MAINTENANCE.md](MAINTENANCE.md)). Full gateway stop/start. |
| Recall/capture failed after npm install | Stale module cache from SIGUSR1 reload | **Full stop then start** (`openclaw gateway stop` then `start`). Required for native modules. |
| Bootstrap file truncation | Limits too low | Increase `bootstrapMaxChars` (15000) and `bootstrapTotalMaxChars` (50000). See [CONFIGURATION.md](CONFIGURATION.md). |
| config.patch reverts API key to `${ENV_VAR}` | Gateway tool substitutes secrets | Edit config file directly for API keys |
| Prompt too large for model | Need lower cap | Set `contextTokens` to ~90% of your model's window |
| Memory files not found by search | File index stale | Ensure `sync.onSessionStart: true` and `sync.watch: true`; restart and start a new session |
| `hybrid-mem stats` still 0 after seed | Seed used wrong paths or schema | Point seed at same DB paths as plugin |
| `npm install` fails ("openclaw": "workspace:*") | devDependencies reference workspace protocols | Remove devDependencies: `node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"` then `npm install` |

---

## API key detection and behaviour

### At config load

If `embedding.apiKey` is missing or not a string, the plugin throws and does not register. You must supply a key.

### At runtime

Embeddings are used for vector search, auto-recall, store, consolidate, and find-duplicates. If the key is invalid or the API fails (401, 403, network):

- Those operations log a warning and skip or return empty
- Auto-recall falls back to FTS-only
- Store skips the vector write
- SQLite-only paths (lookup, FTS search, prune, stats) still work

### Detection

Run `openclaw hybrid-mem verify` — it checks for a non-placeholder key and calls the embedding API once. If invalid, verify reports "Embedding API: FAIL".

### Failover

The plugin does **not** support automatic failover to another provider. All embeddings and LLM calls use the configured OpenAI key only.

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [MAINTENANCE.md](MAINTENANCE.md) — Upgrades and periodic review
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
