# Frequently Asked Questions

---

### Can I use Claude or Gemini instead of OpenAI?

**Embeddings:** No — the plugin currently requires OpenAI for embeddings (`text-embedding-3-small`). There is no multi-provider support or failover. See [MODEL-AGNOSTIC-ANALYSIS.md](MODEL-AGNOSTIC-ANALYSIS.md) for future options.

**LLM features** (auto-classify, consolidate, summarize): These also use the OpenAI API with a chat model (default `gpt-4o-mini`). Same key, different model.

**Session distillation:** The distillation pipeline is model-agnostic — it uses `openclaw sessions spawn --model <any>`. Gemini is recommended for its 1M+ token context window, but Claude or GPT work too (with smaller batch sizes).

---

### How much does this cost?

Very little. At typical usage (~50 turns/day):

| Component | Cost/day | Cost/month |
|-----------|----------|------------|
| Auto-recall (embedding per turn) | ~$0.001 | ~$0.03 |
| Auto-capture (embedding per captured fact) | ~$0.001 | ~$0.03 |
| Auto-classify (if enabled, daily batch) | ~$0.001 | ~$0.03 |
| **Total** | **~$0.003** | **~$0.10** |

Consolidation, reflection, and session distillation are on-demand (CLI) and cost ~$0.002–0.005 per run.

---

### How do I know it's working?

```bash
# Quick check
openclaw hybrid-mem verify
openclaw hybrid-mem stats

# Look for these in gateway logs:
# - "memory-hybrid: initialized v..."
# - "memory-hybrid: injecting N memories into context"
# - "memory-hybrid: auto-captured N memories"
```

Ask the agent something only memory could answer (a preference you stated earlier, a decision you made). If it recalls it without you repeating — it's working.

---

### Does this work with multiple agents?

Each agent instance shares the same SQLite and LanceDB databases (by default). All agents read/write the same memory pool. This is usually what you want — facts stored in one session are available in another.

If you need **isolated memory per agent**, configure different `sqlitePath` and `lanceDbPath` values per agent profile.

---

### What happens if I run out of OpenAI credits?

- **Auto-recall** falls back to SQLite FTS5 only (no vector search). Still works, less fuzzy.
- **Auto-capture** skips the vector store (SQLite still stores the fact).
- **SQLite-only operations** (lookup, FTS search, prune, stats, categories) work without any API key.
- **LLM features** (classify, consolidate, reflect) fail with a logged warning.

The system degrades gracefully. Fix the key and restart to restore full functionality.

---

### Can I delete a specific memory?

**Agent tool:** `memory_forget(id: "fact-id")` — removes a fact from both SQLite and LanceDB.

**CLI:** There's no direct delete command, but you can find the fact first:

```bash
openclaw hybrid-mem search "the fact I want to remove"
# Note the id from the results, then use the agent tool to forget it
```

---

### How do I reset all memory?

**Careful — this is irreversible.**

```bash
openclaw hybrid-mem uninstall --clean-all
openclaw hybrid-mem install
openclaw gateway stop && openclaw gateway start
```

This removes all SQLite and LanceDB data and reinstalls with fresh defaults.

---

### My facts are all categorized as "other"

This is normal initially. The heuristic classifier only catches common patterns. Enable auto-classify to fix it:

```json
{
  "autoClassify": {
    "enabled": true,
    "model": "gpt-4o-mini",
    "batchSize": 20
  }
}
```

Restart the gateway. It will run 5 minutes after startup and then every 24 hours. Or run manually:

```bash
openclaw hybrid-mem classify
```

---

### How do I see what the agent remembers about me?

```bash
# Search by topic
openclaw hybrid-mem search "user preferences"

# Lookup by entity
openclaw hybrid-mem lookup user

# See all categories and counts
openclaw hybrid-mem categories

# Full stats
openclaw hybrid-mem stats
```

---

### The agent recalls wrong or outdated information

1. **Find the wrong fact:** `openclaw hybrid-mem search "the wrong info"`
2. **Use the agent to forget it:** Ask the agent to `memory_forget` the specific fact ID.
3. **Store the correct version:** `memory_store` with the updated information.

The plugin supports **supersession** — new facts can explicitly supersede old ones, preserving history while showing the latest version.

---

### What's the difference between memory_store and writing to a memory file?

| | `memory_store` | Memory file (`memory/*.md`) |
|--|---------------|---------------------------|
| **Best for** | Small facts, preferences, decisions | Structured reference, project state, device lists |
| **Storage** | SQLite + LanceDB | Filesystem |
| **Search** | Auto-recall + FTS5 + vector | memorySearch (BM25 + vector) |
| **When loaded** | Auto-injected each turn (if relevant) | On-demand (semantic search or explicit read) |
| **Size** | One fact/sentence | Any size |

See [EXAMPLES.md](EXAMPLES.md) for detailed guidance.

---

### Do I need to set up cron jobs?

**No.** All background jobs (prune, auto-classify, WAL recovery) run inside the gateway process automatically. No external cron needed.

**Optional:** You can set up a nightly session distillation job for extracting facts from old session logs. The `openclaw hybrid-mem install` command adds one to your config. See [OPERATIONS.md](OPERATIONS.md).

---

### What happens during an OpenClaw upgrade?

Native dependencies (`better-sqlite3`, `@lancedb/lancedb`) can break. Run the post-upgrade script:

```bash
openclaw-upgrade  # if you set up the alias
# or
~/.openclaw/scripts/post-upgrade.sh
```

See [UPGRADE-OPENCLAW.md](UPGRADE-OPENCLAW.md) for the full guide.

---

### How do I back up my memory data?

The important files are:

```bash
# SQLite database (all facts)
~/.openclaw/memory/facts.db

# LanceDB directory (all vectors)
~/.openclaw/memory/lancedb/

# Optional: credentials vault
~/.openclaw/memory/credentials.db

# Optional: discovered categories
~/.openclaw/memory/.discovered-categories.json
```

Back up `facts.db` and the `lancedb/` directory. SQLite can be safely copied while the gateway is stopped.

---

### Can I use this with a local LLM / Ollama?

Not currently. The plugin requires OpenAI's embedding API. Local LLMs could work for the chat features (classify, consolidate) if they expose an OpenAI-compatible API, but this isn't officially supported. See [MODEL-AGNOSTIC-ANALYSIS.md](MODEL-AGNOSTIC-ANALYSIS.md).

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — Runtime flow
- [CONFIGURATION.md](CONFIGURATION.md) — All config options
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — When things break
- [EXAMPLES.md](EXAMPLES.md) — Recipes and patterns
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, scripts, upgrades
