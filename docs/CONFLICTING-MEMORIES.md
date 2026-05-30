---
layout: default
title: Conflicting Memories
parent: Features
nav_order: 7
---
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

## Classify-before-write

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
- **CLI** — `hybrid-mem store` (when classifyBeforeWrite is enabled).
- **extract-daily** — Daily scan / batch extraction uses classification when classifyBeforeWrite is enabled.

### Performance warning: batch imports and classify-before-write

> **Warning:** Classification is implemented **one new fact at a time**: each candidate store runs `classifyMemoryOperation`, which issues **at least one chat completion** to decide ADD / UPDATE / DELETE / NOOP. On **batch or scripted paths** (extract-daily, repeated CLI `store`, or any loop that stores many facts), enabling `classifyBeforeWrite` therefore causes **O(n) LLM calls** for n facts—higher latency, cost, and risk of **provider rate limits**. Interactive auto-capture only considers a **small capped number** of messages per turn, so the blast radius there is limited.

**Mitigations you can use today:**

- Turn off `store.classifyBeforeWrite` for a one-off bulk import, then re-enable afterward.
- Prefer smaller extract windows or fewer facts per run when classification must stay on.
- Track [issue #862](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/862) for future **batched** classification (multiple facts per LLM request).

### Config

| Option | Default | Description |
|--------|---------|-------------|
| `store.classifyBeforeWrite` | `false` | Enable ADD/UPDATE/DELETE/NOOP classification before every store. |
| `store.classifyModel` | `gpt-4o-mini` | Model used for the classification call. |

---

## Supersession

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

The **memory_store** tool and the **CLI** accept an optional supersedes target:

- **memory_store:** Pass the **`supersedes`** parameter (a fact ID). The specified fact is marked as superseded (same fields as above), and the new fact is stored with `supersedes_id` set to that ID.
- **CLI:** `hybrid-mem store --text "..." --supersedes <fact-id>` does the same for scripted or manual updates.

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
openclaw hybrid-mem lookup "user" --key "theme" --as-of 2026-01-15
```

The search and lookup add:  
`valid_from <= @asOf AND (valid_until IS NULL OR valid_until > @asOf)`  
so you see only facts that were valid at that moment.

- **CLI:** `hybrid-mem search` and `hybrid-mem lookup` support `--as-of <date>` (ISO date or epoch seconds) and `--include-superseded`.
- **memory_recall tool:** Parameters `asOf` (ISO date or epoch) and `includeSuperseded` (default false). When `asOf` is set, only facts valid at that time are returned (including LanceDB results filtered by SQLite validity).
- **CLI store:** `hybrid-mem store --text "..." --supersedes <fact-id>` marks the given fact as superseded and stores the new fact with `supersedes_id` and `valid_from`.

---

## Autonomous contradiction resolution pipeline (Issue #1692)

The `resolve-contradictions` command includes a **multi-tier autonomous pipeline** that can resolve ≥80% of ambiguous contradiction pairs without human input while keeping genuinely risky conflicts for manual review.

### Resolution tiers

| Tier | Mechanism | Outcome |
|------|-----------|---------|
| **1 — deterministic LWW** | Project-state latest-wins: newer trusted fact supersedes the stale value | Resolved automatically; audit row written |
| **2 — guard rails** | Detects risky patterns (entity reuse, verified old fact, missing confidence) | Skipped; added to manual-review queue |
| **3 — LLM adjudication** | Calls a configured LLM; auto-applies when confidence ≥ 0.90 | Resolved if confident; otherwise falls through to Tier 4 |
| **4 — manual review queue** | Unresolved pairs exported as stable JSONL with suggested decisions | Human edits decisions; applied via `--apply-review` |

**Tier 1 eligibility criteria** — a pair is eligible for deterministic LWW when all of the following hold:
- `category = project`
- Key is in the mutable-key set: `status`, `next`, `task_updated`, `related_session`, `coverage`, `last_live_verified_at`, `live_state_hash`, `last_actionable_blocker`, `owner`
- The newer fact comes from a trusted source: `conversation`, `cli`, `active-task`, or `tool`
- Timestamps are strictly ordered (newer > older)
- Newer fact confidence ≥ original fact confidence

Write-time auto-supersede also applies Tier 1 immediately when a newer project-state fact is stored, so many contradictions never enter the backlog at all.

### CLI usage

```bash
# Preview: what would be resolved, what would stay manual?
openclaw hybrid-mem resolve-contradictions --auto --dry-run

# Apply: resolve deterministic pairs, write audit trail
openclaw hybrid-mem resolve-contradictions --auto

# Apply with a different target rate (default 0.80)
openclaw hybrid-mem resolve-contradictions --auto --target-rate 0.90

# Apply with opt-in LLM adjudication for remaining pairs
openclaw hybrid-mem resolve-contradictions --auto --llm --model gpt-4o-mini

# Export remaining manual-review items as stable JSONL
openclaw hybrid-mem resolve-contradictions --auto --dry-run --export-review ./review.jsonl

# Apply reviewed decisions from JSONL (fill in "decision" fields, re-run)
openclaw hybrid-mem resolve-contradictions --apply-review ./review-decisions.jsonl
```

The `--export-review` / `--apply-review` round-trip:
1. Run `--export-review` to write unresolved items with `suggestedDecision`, `suggestedStrategy`, `suggestedConfidence`, and `suggestedReason` fields.
2. Edit the file: set each item's `decision` to one of:
   - `keep_new` — discard the older fact, keep the newer one
   - `keep_old` — discard the newer fact, keep the older one
   - `merge` — mark both facts as resolved without discarding either
   - `manual_review` — leave this item unresolved (skip it; no changes applied)
3. Run `--apply-review` to apply all non-`manual_review` decisions with a full audit trail.

### Structured run reporting

Every `--auto` run prints a machine-readable summary line:

```
contradiction-auto summary total=222 deterministic=188 llm=0 merged=0 manual_review=34 applied=false target=0.80 achieved=0.846
```

If the target rate is missed, an additional line is printed:

```
contradiction-auto target-missed achieved=0.714 target=0.80
```

### Audit trail

Every applied decision (auto or reviewed) is written to the `contradiction_resolution_audit` table with:

- `contradiction_id` — the contradiction being resolved
- `kept_fact_id` / `superseded_fact_id` — which fact wins
- `strategy` — e.g. `project-state-lww`, `llm-adjudication`, `manual-review-file`
- `confidence` — 0.0–1.0
- `reason` — human-readable explanation
- `decided_at` — Unix seconds
- `actor` — tool name / identity
- `tool_version` — optional plugin version
- `mode` — `auto` or `review`
- `model` — LLM model name if applicable

### Nightly maintenance integration

The default nightly-memory-sweep cron job runs:

```
openclaw hybrid-mem resolve-contradictions --auto --verbose
```

This applies deterministic Tier 1 resolutions silently and reports any unresolved pairs. LLM adjudication is opt-in and not part of the default cron schedule; enable it by editing the cron command once proven in your environment.

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
| **Autonomous pipeline** | `resolve-contradictions --auto` resolves ≥80% of project-state contradictions deterministically; opt-in LLM adjudication for the rest; audit trail for every decision. |

---

## Related docs

- [DEEP-DIVE.md](DEEP-DIVE.md) — Supersession and deduplication sections
- [FEATURES.md](FEATURES.md) — Classification pipeline and config
- [CONFIGURATION.md](CONFIGURATION.md) — `store.classifyBeforeWrite` and `store.classifyModel`
- [GRAPH-MEMORY.md](GRAPH-MEMORY.md) — SUPERSEDES link type and graph traversal
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `resolve-contradictions` full flag reference
- [MAINTENANCE-TASKS-MATRIX.md](MAINTENANCE-TASKS-MATRIX.md) — nightly-memory-sweep schedule
