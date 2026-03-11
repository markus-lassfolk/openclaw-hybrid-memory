---
layout: default
title: FAQ
parent: Operations & Maintenance
nav_order: 9
---
# Frequently Asked Questions

Quick answers to common questions. For **why** you’d want this plugin and what benefits you get (short- and long-term), see the [README § Why you'll want this](../README.md#why-youll-want-this--in-plain-english).

---

### Can I use Claude or Gemini instead of OpenAI?

**Embeddings:** Yes — the plugin supports four embedding providers:

| Provider | Config value | Notes |
|----------|-------------|-------|
| **OpenAI** | `"openai"` | Default. `text-embedding-3-small` (1536d) or `text-embedding-3-large` (3072d). Requires `embedding.apiKey`. |
| **Ollama** | `"ollama"` | Fully local, no API key needed. Any model supported by Ollama (e.g. `nomic-embed-text`, `mxbai-embed-large`). |
| **ONNX** | `"onnx"` | Fully local, no API key needed. Requires `onnxruntime-node` (`npm i onnxruntime-node`). Models auto-downloaded from HuggingFace. |
| **Google** | `"google"` | Uses Gemini API (`text-embedding-004`). Requires `llm.providers.google.apiKey` or `distill.apiKey`. |

Set `embedding.provider` to select a provider. Use `embedding.preferredProviders` (ordered list) to enable automatic failover, e.g. `["ollama", "openai"]` tries Ollama first and falls back to OpenAI if Ollama is unavailable. See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md#embedding-providers) for full config examples.

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

**Agent tool:** `memory_forget(memoryId: "full-uuid")` or `memory_forget(query: "…")` — removes a fact from both SQLite and LanceDB.

**CLI:** Find the fact, then remove it by ID:

```bash
# Find the memory (note the id in the results)
openclaw hybrid-mem search "the fact I want to remove"

# Remove by full ID or short hex prefix (use --yes to skip confirmation)
openclaw hybrid-mem forget <id>
openclaw hybrid-mem forget <id> --yes
```

`forget` accepts a full UUID or a short hex prefix (e.g. `a1b2c3d4`). Without `--yes`, it prints a preview and exits; run again with `--yes` to confirm.

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

### How does the agent learn from my reactions (replies and emoji)?

The plugin treats your **replies** as implicit feedback and uses them in two pipelines:

- **Positive signals (reinforcement)** — When you say you liked something or react with approval, that response is used to **reinforce** the preceding assistant turn. Examples: “good job!”, “I really appreciate that”, “wow, that was great”, “I really liked it”, or positive emoji like 👍 ❤️ 😊. The nightly **extract-reinforcement** job (or manual `openclaw hybrid-mem extract-reinforcement`) scans session logs for these phrases and emoji, then boosts confidence on the related facts and procedures so they are preferred in future recall. So thanking the agent or saying “great job” after a good answer **strengthens** that behavior in memory.

- **Negative signals (corrections)** — When you signal that something was wrong or frustrating, that response is used as a **correction** incident. Examples: “that was wrong”, “try again”, “nooo!”, “stop doing that”, “why do you keep…”, “I give up”, “never do that”, or negative emoji like 👎 😠 💩. The **self-correction** pipeline extracts these, has an LLM analyze what went wrong, and can store a fact, add a TOOLS.md rule, or propose AGENTS changes so the agent doesn’t repeat the mistake.

**Emoji** are always included (language-agnostic). **Phrases** use English by default and can be extended to other languages via `openclaw hybrid-mem build-languages`. See [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md) (including the “Emoji as signals” section) for the full list and how the pipelines run.

**False positives:** Some phrases (e.g. “I’m excited about…”) can refer to things unrelated to what the agent just did. They are still treated as reinforcement; the system uses confidence scoring so that stronger, unambiguous praise (e.g. “perfect”, “great job”) is weighted more than generic or ambiguous wording.

**Learn your own wording:** Different people use different words for praise and frustration. The plugin can analyze your session logs and discover *your* phrases, then save them so detection uses them too. The flow is **model-agnostic** (uses your configured nano-tier and heavy-tier models from plugin config, not a single provider):

1. **Pre-filter:** Messages that already match built-in or learned reinforcement/correction phrases are skipped. A **cheap (nano-tier)** model labels the rest as positive_feedback, negative_feedback, or neutral.
2. **Phrase extraction:** Only messages labeled as positive or negative feedback are sent to a **heavy-tier** model to extract candidate phrases.
3. **First run vs nightly:** When you omit `--days`, the first run (or when no `.user-feedback-phrases.json` exists yet) uses the **last 30 days** to bootstrap; after that, runs use the **last 3 days** so a weekly nightly job only processes new sessions.

```bash
# Auto window: 30 days first time, then 3 days; models from config (nano + heavy)
openclaw hybrid-mem analyze-feedback-phrases

# Optional: override window and/or model
openclaw hybrid-mem analyze-feedback-phrases --days 30 --model <your-heavy-model>

# Save discovered phrases so reinforcement/correction detection uses them (per install)
openclaw hybrid-mem analyze-feedback-phrases --learn
```

Discovered phrases are stored in `~/.openclaw/memory/.user-feedback-phrases.json` and merged with the built-in lists. Run with `--learn` periodically (e.g. in a weekly nightly) so the system keeps learning how you and others on the same install give feedback.

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

**Yes.** You can use Ollama for two specific workloads:
1. **Embeddings**: Set `embedding.provider: "ollama"` and use models like `nomic-embed-text` (see [CONFIGURATION.md](CONFIGURATION.md#local-embedding-providers-153)).
2. **Bulk Session Pre-filtering**: Set `extraction.preFilter.enabled: true` and `extraction.preFilter.model: "qwen3:8b"` to use a local LLM as a gatekeeper before sending bulk sessions to a cloud LLM (see [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) and [CONFIGURATION.md](CONFIGURATION.md)).

For main conversational tasks (classification, consolidation, chat), local LLMs often lack the instruction-following consistency required, though any provider supported by the OpenClaw gateway can technically be configured via `llm.heavy` / `llm.fast` (see [MODEL-AGNOSTIC-ANALYSIS.md](MODEL-AGNOSTIC-ANALYSIS.md)).

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — Runtime flow
- [CONFIGURATION.md](CONFIGURATION.md) — All config options
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — When things break
- [EXAMPLES.md](EXAMPLES.md) — Recipes and patterns
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, scripts, upgrades
