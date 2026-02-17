# How It Works — Runtime Flow

What actually happens under the hood when you chat with an agent that has hybrid memory enabled.

---

## The big picture

Every conversation turn goes through this cycle:

```
You send a message
      |
      v
 1. AUTO-RECALL (before_agent_start)
    Search both backends for relevant memories
    Inject top matches into the agent's context
      |
      v
 2. AGENT PROCESSES your message
    Has access to memory tools (memory_store, memory_recall, lookup, etc.)
    Can explicitly store/search if needed
      |
      v
 3. AUTO-CAPTURE (agent_end)
    Scan the assistant's reply for memorable content
    Extract and store facts automatically
      |
      v
 Agent responds to you
```

No manual intervention needed — the plugin hooks into OpenClaw's lifecycle events to capture and recall automatically.

---

## Step 1: Auto-Recall (before each turn)

When you send a message, **before the agent sees it**, the plugin:

1. **Embeds your prompt** — sends it to OpenAI to get a vector representation.
2. **Searches both backends in parallel:**
   - **SQLite FTS5** — full-text search over all stored facts (free, instant).
   - **LanceDB** — vector similarity search over embeddings (finds fuzzy/semantic matches).
3. **Merges and deduplicates** — combines results from both backends, removes duplicates, filters superseded facts.
4. **Scores and ranks** — factors in: vector similarity, text relevance, importance, recency, decay class (optionally boosting permanent/stable facts).
5. **Applies token budget** — trims to `maxTokens` (default 800) to avoid overwhelming the context.
6. **Injects into context** — adds a `<memory-context>` block before the agent's system prompt with the top matches.

**What the agent sees** (injected at the top of context):

```
<memory-context>
[sqlite/preference] User prefers dark mode in all applications
[lance/decision] Decided to use PostgreSQL because of JSONB support
[sqlite/entity] User's email: john@example.com
</memory-context>
```

**Optional enhancements:**
- **Entity lookup** — if your prompt mentions a known entity (e.g. "user"), lookup facts for that entity are merged in.
- **Summary injection** — long facts are injected as short summaries to save tokens.
- **Graph traversal** — if graph memory is enabled, related facts are discovered via typed links (zero LLM cost).

**Cost per turn:** One embedding API call (~$0.00002 for `text-embedding-3-small`). No LLM calls on the hot path.

---

## Step 2: Agent processing

The agent processes your message with the injected memories in context. It also has access to **tools** it can call explicitly:

| Tool | What it does | When the agent uses it |
|------|-------------|----------------------|
| `memory_store` | Store a new fact | When it learns something important |
| `memory_recall` | Search memories by query | When auto-recall missed something |
| `memory_forget` | Remove a stored fact | When a fact is outdated or wrong |
| `memory_checkpoint` | Create a snapshot | Before major operations |
| `memory_prune` | Clean up expired facts | Maintenance |
| `lookup` | Exact entity/key lookup | "What's User's email?" |
| `memory_link` | Create a relationship between facts | Connect related facts |
| `memory_reflect` | Run pattern synthesis | Extract behavioral patterns |

Most of the time, the agent doesn't need to use these explicitly — auto-capture handles the common case.

---

## Step 3: Auto-Capture (after each turn)

After the agent responds, the plugin scans the assistant's reply:

1. **Filter check** (`shouldCapture()`) — regex triggers look for memorable content:
   - Preference signals: "prefer", "like", "hate", "want"
   - Decision signals: "decided", "chose", "will use", "always", "never"
   - Entity signals: email addresses, phone numbers, "is called"
   - Factual signals: "born", "birthday", "lives", "works"
2. **Sensitive content exclusion** — skips passwords, API keys, SSNs, credit cards.
3. **Length check** — skips messages shorter than 10 chars or longer than `captureMaxChars` (default 5000).
4. **Category detection** (`detectCategory()`) — fast regex classifies into: preference, fact, decision, entity, or other. No LLM call.
5. **Structured field extraction** (`extractStructuredFields()`) — extracts entity/key/value triples (e.g. "My birthday is Nov 13" → entity=user, key=birthday, value=Nov 13).
6. **Classify-before-write** (optional) — if enabled, checks existing facts via embedding similarity. Decides: ADD (new fact), UPDATE (supersede old), DELETE (retract), or NOOP (already known).
7. **Dual store:**
   - **WAL** — writes to the write-ahead log first (crash protection).
   - **SQLite** — stores the fact with metadata (category, importance, decay class, tags).
   - **LanceDB** — stores the embedding vector for semantic search.
   - **WAL cleanup** — removes the WAL entry after successful commit.

**Cost per turn:** Zero or one embedding call (only if a fact is captured). No LLM calls unless classify-before-write is enabled.

---

## Background jobs (automatic)

These run inside the gateway process — no cron needed:

| Job | Interval | What it does |
|-----|----------|-------------|
| **Prune** | Every 60 minutes | Hard-deletes expired facts; soft-decays confidence for aging facts |
| **Auto-classify** | Every 24 hours (+ 5 min after startup) | Reclassifies "other" facts into proper categories via LLM |
| **Proposal prune** | Every 60 minutes | Removes expired persona proposals (if enabled) |
| **WAL recovery** | On startup | Replays any uncommitted operations from the write-ahead log |

---

## What happens at startup

When the gateway starts (or restarts):

1. **Config load** — reads `openclaw.json`, validates embedding API key.
2. **Database init** — opens SQLite (runs migrations if needed), connects to LanceDB.
3. **WAL recovery** — replays any pending operations from the write-ahead log.
4. **Startup prune** — deletes any expired facts immediately.
5. **Auto-classify** (if enabled) — schedules a classify run 5 minutes after startup.
6. **Timer setup** — starts the hourly prune timer and daily classify timer.
7. **Tool registration** — registers all memory tools with the agent.
8. **Event hooks** — registers `before_agent_start` (auto-recall) and `agent_end` (auto-capture).

---

## What happens at shutdown

When the gateway stops:

1. **Timers cleared** — prune, classify, and proposal timers are cancelled.
2. **Databases closed** — SQLite, LanceDB, and credentials vault (if enabled) are closed cleanly.

---

## Data flow diagram

```
                    ┌─────────────────────┐
                    │   Your message      │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │   AUTO-RECALL       │
                    │                     │
                    │  Embed prompt       │
                    │  Search SQLite FTS5 │──── Free, instant
                    │  Search LanceDB    │──── ~$0.00002
                    │  Merge & rank      │
                    │  Inject top N      │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │   AGENT RESPONSE    │
                    │                     │
                    │  (memory tools      │
                    │   available if      │
                    │   needed)           │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │   AUTO-CAPTURE      │
                    │                     │
                    │  Regex filter       │──── Free, instant
                    │  Detect category   │──── Free, instant
                    │  Extract fields    │──── Free, instant
                    │  Store → WAL       │──── Disk write
                    │  Store → SQLite    │──── Disk write
                    │  Store → LanceDB   │──── ~$0.00002
                    │  Cleanup WAL       │
                    └─────────────────────┘

Background (automatic):
  ┌─────────────────────────────────────────┐
  │  Every 60 min: Prune expired facts      │
  │  Every 24h:    Auto-classify "other"    │──── ~$0.001/batch
  │  On startup:   WAL recovery + prune     │
  └─────────────────────────────────────────┘
```

---

## Cost summary

| Operation | Cost | When |
|-----------|------|------|
| Auto-recall (per turn) | ~$0.00002 | Every turn |
| Auto-capture (per captured fact) | ~$0.00002 | When a fact is captured |
| Auto-classify batch (20 facts) | ~$0.001 | Once per 24h |
| Consolidation (per cluster) | ~$0.002 | On-demand (CLI) |
| Reflection (per run) | ~$0.003 | On-demand (CLI) |
| SQLite operations | Free | Always |

At typical usage (~50 turns/day), expect **~$0.003/day** for embeddings. Auto-classify adds ~$0.001/day when enabled. Total: roughly **$0.10–0.15/month**.

---

## Related docs

- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage internals, search algorithms, tags, links, deduplication
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design and workspace layout
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
- [CONFIGURATION.md](CONFIGURATION.md) — Tune auto-recall, auto-capture, token budgets
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, cron, scripts, upgrades
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — When things don't work
