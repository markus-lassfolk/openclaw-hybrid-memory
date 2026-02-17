# Conflicting and Contradictory Memories

How the plugin handles facts that contradict or update existing ones: **classify-before-write** (ADD/UPDATE/DELETE/NOOP), **supersession**, and **bi-temporal** queries.

---

## Overview

When new information contradicts or replaces old information, the system can:

1. **Classify before storing** — Ask an LLM whether the new fact is truly new (ADD), updates an existing fact (UPDATE), retracts one (DELETE), or is redundant (NOOP).
2. **Supersede** — Mark the old fact as superseded and link the new one (valid_from / valid_until, supersedes_id).
3. **Query by time** — Exclude superseded facts by default, or ask “what did we know as of date X?” (point-in-time).

No automatic merging of text: UPDATE creates a **new** fact row that supersedes the old; the old row stays for history but is excluded from normal search.

---

## Classify-before-write (FR-008)

When **`store.classifyBeforeWrite`** is `true`, every store (from `memory_store`, auto-capture, or batch) runs a **classification step** before writing:

1. **Find similar facts** — The new text is embedded and compared to existing facts (LanceDB + SQLite). A small set of the most similar facts is collected (with preference for same entity/key when available).
2. **LLM decision** — The new fact plus those existing facts are sent to a cheap LLM. It must respond in a fixed format: **ADD**, **UPDATE**, **DELETE**, or **NOOP**, plus an optional target fact ID and a short reason.
3. **Apply**:
   - **ADD** — No conflict; store the new fact as usual.
   - **UPDATE** — The new fact replaces an existing one. The existing fact is marked superseded; the new fact is stored with `supersedes_id` pointing to it.
   - **DELETE** — The user is retracting an existing fact. That fact is marked superseded; the new “fact” is not stored (it’s a retraction).
   - **NOOP** — Already captured; do not store.

Classification uses a dedicated prompt (e.g. `memory-classify`) and a configurable model (default `gpt-4o-mini`). On parse or API errors, the code **falls back to ADD** so storage still succeeds.

### Where it runs

- **memory_store** tool (when classifyBeforeWrite is enabled).
- **Auto-capture** — When a captured message is about to be stored, classification runs; UPDATE/DELETE/NOOP are applied the same way.
- **Batch / CLI** — e.g. session distillation or bulk store paths that support classify-before-write.

### Config

| Option | Default | Description |
|--------|---------|-------------|
| `store.classifyBeforeWrite` | `false` | Enable ADD/UPDATE/DELETE/NOOP classification before every store. |
| `store.classifyModel` | `gpt-4o-mini` | Model used for the classification call. |

---

## Supersession (FR-010)

**Supersession** is how we record “this fact replaces that one” without deleting history.

### Database fields

- **On the old (superseded) fact:**  
  `superseded_at` (timestamp), `superseded_by` (ID of the new fact), `valid_until` (end of validity).
- **On the new fact:**  
  `supersedes_id` (ID of the old fact), `valid_from` (start of validity).  
  `valid_from` is usually set from `source_date` or `created_at`.

### What happens on UPDATE

1. The old fact is updated: `superseded_at = now`, `superseded_by = newFactId`, `valid_until = now`.
2. The new fact is inserted with `supersedes_id = oldFactId` and `valid_from` set.
3. Search and lookup **exclude** rows where `superseded_at IS NOT NULL` unless you pass `includeSuperseded: true` or a point-in-time `asOf`.

So by default, “current” recall never sees superseded facts; they remain in the DB for auditing and point-in-time queries.

### Manual supersession

The **memory_store** tool accepts an optional **`supersedes`** parameter (a fact ID). If you pass it:

- The specified fact is marked as superseded (same fields as above).
- The new fact is stored with `supersedes_id` set to that ID.

Use this when you know explicitly which fact is being replaced (e.g. after reviewing duplicates or after a user correction).

---

## Bi-temporal and point-in-time queries

Every fact has **valid_from** and **valid_until** (Unix seconds). Together with supersession this gives **bi-temporal** behaviour:

- **valid_from** — When this version of the fact became valid (often creation or source date).
- **valid_until** — When it was superseded (null if still current).

### Point-in-time search

You can ask “what did we know as of date X?” so that superseded facts are still visible for that time:

```bash
openclaw hybrid-mem search "database" --as-of 2026-01-15
```

The search adds:  
`valid_from <= @asOf AND (valid_until IS NULL OR valid_until > @asOf)`  
so you see only facts that were valid at that moment.

Lookup and recall can support the same `asOf` semantics where exposed (e.g. API or future CLI flags).

---

## Relation to deduplication

Conflicting-memory handling is the **most advanced** layer of deduplication:

1. **Exact text** — Skip if the same text already exists.
2. **Fuzzy hash** — Skip if normalized text matches (when `store.fuzzyDedupe` is on).
3. **Vector similarity** — Skip adding to LanceDB if a very similar vector exists (SQLite fact still stored).
4. **Classify-before-write** — LLM decides ADD/UPDATE/DELETE/NOOP; UPDATE/DELETE implement contradiction resolution.

See [DEEP-DIVE.md](DEEP-DIVE.md#deduplication) for the full deduplication section.

---

## Summary

| Mechanism | Purpose |
|-----------|---------|
| **Classify-before-write** | Decide per store whether to ADD, UPDATE, DELETE, or NOOP using an LLM. |
| **Supersession** | Mark old fact as superseded; link new fact via `supersedes_id`; set valid_until / valid_from. |
| **Default search** | Exclude superseded facts so recall is “current” only. |
| **Point-in-time** | Use `--as-of` (or API equivalent) to query “what was true at date X?”. |
| **Manual supersedes** | Pass `supersedes: factId` in `memory_store` when you know which fact is replaced. |

---

## Related docs

- [DEEP-DIVE.md](DEEP-DIVE.md) — Supersession and deduplication sections
- [FEATURES.md](FEATURES.md) — Classification pipeline and config
- [CONFIGURATION.md](CONFIGURATION.md) — `store.classifyBeforeWrite` and `store.classifyModel`
- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — SUPERSEDES link type and graph traversal
