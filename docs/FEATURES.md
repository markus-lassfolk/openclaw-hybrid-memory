---
layout: default
title: Features Overview
parent: Features
nav_order: 1
---
# Features — Categories, Decay, Tags, and Auto-Classify

Detailed reference for the memory-hybrid plugin's classification, decay, tagging, and LLM auto-classify features.

---

## Feature documentation (by topic)

| Feature | Document | Description |
|---------|----------|-------------|
| **Persona proposals** | [PERSONA-PROPOSALS.md](PERSONA-PROPOSALS.md) | Agent self-evolution with human approval: propose identity file changes, review/apply via CLI |
| **Auto-tagging** | [AUTO-TAGGING.md](AUTO-TAGGING.md) | Regex-inferred topic tags, built-in patterns, tag-filtered search and recall |
| **Decay & pruning** | [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md) | Decay classes, TTLs, refresh-on-access, hard/soft prune, when they run |
| **Reflection** | [REFLECTION.md](REFLECTION.md) | Pattern synthesis from facts (reflect, reflect-rules, reflect-meta) |
| **Graph memory** | [GRAPH-MEMORY.md](GRAPH-MEMORY.md) | Typed links between facts, spreading activation |
| **Session distillation** | [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) | Extracting facts from session logs |
| **Procedural memory** | [PROCEDURAL-MEMORY.md](PROCEDURAL-MEMORY.md) | Procedure tagging, recall, auto-skills from session tool sequences (issue #23) |
| **Credentials** | [CREDENTIALS.md](CREDENTIALS.md) | Opt-in encrypted credential vault |
| **WAL** | [WAL-CRASH-RESILIENCE.md](WAL-CRASH-RESILIENCE.md) | Write-ahead log for crash resilience |
| **Conflicting memories** | [CONFLICTING-MEMORIES.md](CONFLICTING-MEMORIES.md) | Classify-before-write (ADD/UPDATE/DELETE/NOOP), supersession, bi-temporal |
| **Automatic categories** | [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md) | Category discovery from "other" facts (LLM labels, threshold, .discovered-categories.json) |
| **Dynamic derived data** | [DYNAMIC-DERIVED-DATA.md](DYNAMIC-DERIVED-DATA.md) | Index: tags, categories, decay, entity/key/value, conflicting memories |
| **Dynamic salience** | [DYNAMIC-SALIENCE.md](DYNAMIC-SALIENCE.md) | Access-based importance — access boost, time decay, Hebbian co-recall links |
| **Memory scoping** | [MEMORY-SCOPING.md](MEMORY-SCOPING.md) | Global, user-private, agent-specific, session-scoped memories; privacy in multi-user environments |
| **Memory tiering** | [MEMORY-TIERING.md](MEMORY-TIERING.md) | Hot/warm/cold tiers, compaction (tasks→COLD, preferences→WARM, blockers→HOT), `hybrid-mem compact` |

---

## Categories

### Default categories

Seven categories are built in and always available:

| Category | Typical content | Examples |
|----------|----------------|----------|
| `preference` | Likes, dislikes, working-style choices | "I prefer dark mode", "I hate tabs" |
| `fact` | Biographical or factual statements | "My birthday is Nov 13", "lives in Prague" |
| `decision` | Architectural or process decisions with rationale | "Decided to use Postgres because ..." |
| `entity` | Named things: people, projects, tools, identifiers | "John's email is john@example.com" |
| `pattern` | Behavioral patterns synthesized by the reflection layer | "User consistently favors composition over inheritance" |
| `rule` | Actionable one-line rules from reflection | "Always suggest composition over inheritance" |
| `other` | Anything the heuristics can't classify | Catch-all; reclassified later by auto-classify |

### Custom categories

Add a `categories` array to plugin config in `openclaw.json`:

```json
{ "categories": ["research", "health", "finance"] }
```

Defaults are always included; custom categories are merged and deduplicated. See [CONFIGURATION.md](CONFIGURATION.md) for the full config block.

Once registered, custom categories are available in `memory_store`, the LLM auto-classifier, `hybrid-mem classify` CLI, and `hybrid-mem categories`.

### Category discovery

When `autoClassify.suggestCategories` is `true` (default), the auto-classify job groups "other" facts by free-form topic labels. Any label with at least `minFactsForNewCategory` facts (default 10) becomes a new category. Discovered categories are persisted to `~/.openclaw/memory/.discovered-categories.json`.

→ Full detail: [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md)

---

## Classification Pipeline

Every fact passes through up to three stages:

```text
conversation text
      |
      v
 1. Auto-capture filter          shouldCapture() — regex triggers
    (hot path, no LLM)           + sensitive-content exclusion
      |
      v
 2. Heuristic classification     detectCategory() — fast regex
    (hot path, no LLM)           matching on the text
      |
      v
 3. LLM auto-classify            Runs in background:
    (background, cheap LLM)      daily batch + 5 min after startup
      |
      v
  stored fact
```

**Stage 1 — Auto-capture filter.** `shouldCapture()` checks regex triggers (e.g. "remember", "prefer", "decided", email/phone patterns) and rejects sensitive content (passwords, API keys, SSNs, credit cards) and messages that are too short/long or look like structured markup.

**Stage 2 — Heuristic classification.** `detectCategory()` runs a fast regex pass — no LLM call. Anything that doesn't match falls through to `"other"`.

**Stage 3 — LLM auto-classify.** Background job periodically queries all `"other"` facts and sends them to a cheap LLM in batches. When category discovery is enabled, it first groups by free-form topic labels.

**Manual override.** The `memory_store` tool accepts an explicit `category` parameter that bypasses heuristic detection.

### Heuristic detection patterns

| Category | Patterns matched |
|----------|-----------------|
| `decision` | `decided`, `chose`, `went with`, `selected`, `always use`, `never use`, `will use` |
| `preference` | `prefer`, `like`, `love`, `hate`, `want` |
| `entity` | Phone numbers (`+` followed by 10+ digits), email addresses, `is called` |
| `fact` | `born`, `birthday`, `lives`, `works`, `is`, `are`, `has`, `have` |
| `other` | Everything else (fallback) |

### Structured field extraction

After category detection, `extractStructuredFields()` extracts **entity / key / value** triples:

| Pattern | Extracted fields | Example |
|---------|-----------------|---------|
| `decided/chose X because Y` | entity=`decision`, key=`X`, value=`Y` | "Decided to use Postgres because JSONB" |
| `always/never X` | entity=`convention`, key=`X` | "Always use strict mode" |
| `X's Y is Z` / `My Y is Z` | entity=`X`/`user`, key=`Y`, value=`Z` | "My birthday is Nov 13" |
| `I prefer/like/hate X` | entity=`user`, key=`prefer`/`like`/`hate`, value=`X` | "I prefer dark mode" |
| Email found | key=`email`, value=address | "john@example.com" |
| Phone found | key=`phone`, value=number | "+1234567890" |

### Adding heuristic patterns for custom categories

The built-in `detectCategory()` only recognizes a subset of the default categories (not `pattern` or `rule`, which are assigned by the reflection layer). To add a heuristic for a custom category, edit `detectCategory()` in `index.ts`:

```typescript
// Before the final return:
if (/research|paper|study|journal|arxiv/i.test(lower)) return "research";
return "other";
```

Without this, custom categories are only assigned via explicit `memory_store` calls or the LLM auto-classifier.

---

## Auto-Classify (LLM Reclassification)

### How it works

1. **No inline LLM calls.** During auto-capture, facts are classified by fast heuristics only.
2. **Background batch job.** If `autoClassify.enabled` is `true`:
   - Once on startup (5-minute delay).
   - Then every **24 hours**.
3. **Safe.** Only reclassifies facts currently categorized as `"other"`.
4. **Batched.** Sent in batches of `batchSize` (default 20) with 500ms pause between batches.

### LLM prompt

> You are a memory classifier. Categorize each fact into exactly one category.
> Available categories: preference, fact, decision, entity *(plus custom categories, minus "other")*
> Use "other" ONLY if no category fits at all.
> Respond with ONLY a JSON array of category strings.

### CLI commands

| Command | Description |
|---------|-------------|
| `hybrid-mem classify --dry-run` | Preview classifications without applying |
| `hybrid-mem classify` | Run LLM auto-classify immediately |
| `hybrid-mem classify --limit N` | Classify at most N facts |
| `hybrid-mem classify --model M` | Override the LLM model |
| `hybrid-mem categories` | List all categories with fact counts |

---

## Decay and Pruning

**No cron or external jobs are required.** The plugin handles decay automatically: on gateway start (hard-delete expired) and every 60 minutes (hard prune + soft-decay confidence). Decay classes: permanent, stable (90d), active (14d), session (24h), checkpoint (4h). Stable and active facts get their expiry refreshed when recalled.

**Manual controls:** `openclaw hybrid-mem prune` (options: `--soft`, `--dry-run`), `openclaw hybrid-mem backfill-decay` to re-classify existing facts.

→ Full detail: [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md)

---

## Source date

Facts have an optional `source_date` (Unix seconds): when the fact *originated*, not when it was stored.

| Source | `source_date` | `created_at` |
|--------|---------------|--------------|
| Live capture | `null` (uses `created_at`) | Insertion time |
| Distillation from Jan 15 session | `2026-01-15` (Unix) | Feb 16 (insertion) |
| Backfill from `[2026-01-15]` prefix | Parsed from text | Insertion time |

**Ordering:** Lookup, search, and recall use `COALESCE(source_date, created_at)` for temporal ordering.

**memory_store tool:** Optional `sourceDate` (ISO-8601 or Unix seconds).
**CLI:** `openclaw hybrid-mem store --text "..." --source-date 2026-01-15`

---

## Auto-tagging

Facts can have optional **tags** for topic filtering. When `tags` are omitted, the plugin infers tags from fact text (and entity) via regex patterns. Tag-filtered search/lookup and `memory_recall(tag="…")` use only SQLite with a tag filter. Manual override: pass `tags` to `memory_store` or `hybrid-mem store --tags "a,b"`.

→ Full detail: [AUTO-TAGGING.md](AUTO-TAGGING.md)

---

## Related docs

- [PERSONA-PROPOSALS.md](PERSONA-PROPOSALS.md) — Persona proposals (agent self-evolution, human approval)
- [AUTO-TAGGING.md](AUTO-TAGGING.md) — Auto-tagging (patterns, storage, filtering)
- [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md) — Decay classes, TTLs, pruning
- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage internals, search algorithms, tags, links, deduplication
- [CONFIGURATION.md](CONFIGURATION.md) — Config reference for all features
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design overview
- [REFLECTION.md](REFLECTION.md) — Reflection layer (pattern synthesis from facts)
- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — Graph-based spreading activation (fact linking)
- [CREDENTIALS.md](CREDENTIALS.md) — Credential vault (opt-in encrypted store)
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Extracting facts from session logs
- [PROCEDURAL-MEMORY.md](PROCEDURAL-MEMORY.md) — Procedural memory (procedure tagging, recall, auto-skills)
- [CONFLICTING-MEMORIES.md](CONFLICTING-MEMORIES.md) — Conflicting/contradictory memories (classify-before-write, supersession)
- [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md) — Automatic category discovery
- [DYNAMIC-DERIVED-DATA.md](DYNAMIC-DERIVED-DATA.md) — Overview of tags, categories, decay, and other derived data
- [DYNAMIC-SALIENCE.md](DYNAMIC-SALIENCE.md) — Access-based importance
