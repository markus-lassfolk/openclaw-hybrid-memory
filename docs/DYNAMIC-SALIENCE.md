# Dynamic Salience Scoring (FR-005)

## Overview

Dynamic Salience Scoring adjusts memory relevance based on **access patterns** instead of static importance. Memories that are frequently recalled or recently used score higher; older, unused memories fade in relevance. This mimics biological memory ("use it or lose it") and keeps the vector space focused on active context.

### The Problem

Previously, memory importance was static (set at creation time). Memories from months ago were treated equally with fresh ones unless manually decayed or searched by date. Over time, the vector space became cluttered with irrelevant facts.

### The Solution

The system now applies three mechanisms:

1. **Access Boost** — Frequently recalled facts score higher
2. **Time Decay** — Older, unused memories fade in relevance
3. **Hebbian Reinforcement** — Co-recalled memories get stronger associations

---

## How It Works

### 1. Access Boost

Every time a memory is recalled (via `memory_recall` or auto-recall):

- `recall_count` is incremented
- `last_accessed` is set to the current timestamp

The effective importance score is boosted by:

```
boost = 1 + 0.1 * log(recall_count + 1)
```

So a fact recalled 100 times gets roughly a 46% boost over one never recalled.

**Where access is tracked:**

- `FactsDB.search()` — all returned facts
- `FactsDB.lookup()` — all returned facts
- `memory_recall` by id — when fetching a specific memory
- Auto-recall — all injected memories (full, short, minimal, progressive, progressive_hybrid)

### 2. Time Decay

The score is multiplied by a decay factor based on `(now - last_accessed)`:

```
decay = 1 / (1 + days_since_access / 30)
```

Default half-life is 30 days: after 30 days without access, salience halves. If `last_accessed` is null, `last_confirmed_at` or `created_at` is used.

### 3. Hebbian Reinforcement

When two or more memories are recalled together in the same session, the system creates or strengthens `RELATED_TO` links between them. Co-recalled facts become associated in the graph, enabling graph traversal (FR-007) to surface related context.

**When Hebbian linking runs:**

- `memory_recall` returns 2+ results
- Auto-recall injects 2+ memories (any format)

Requires `graph.enabled` (default true).

---

## Configuration

No separate config is required. FR-005 uses:

- `graph.enabled` — must be true for Hebbian reinforcement (default true)

Salience scoring (access boost + time decay) always runs on search and lookup.

---

## Database Schema

| Column        | Type    | Description                                  |
|---------------|---------|----------------------------------------------|
| `recall_count`| INTEGER | Number of times the fact was recalled        |
| `last_accessed` | INTEGER | Epoch seconds of last recall (null if never) |

These columns are added by migration `migrateAccessTracking()` and seeded with `last_confirmed_at` for existing facts.

---

## Related Docs

- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — `RELATED_TO` links and graph traversal (FR-007)
- [DEEP-DIVE.md](DEEP-DIVE.md) — Search scoring and access tracking
- [DYNAMIC-DERIVED-DATA.md](DYNAMIC-DERIVED-DATA.md) — Derived fields index
- [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md) — TTL and expiry

---

## Inspiration

- **neural-memory** — Hebbian learning
- **engram-memory** — Salience decay

See [issue #5](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/5).
