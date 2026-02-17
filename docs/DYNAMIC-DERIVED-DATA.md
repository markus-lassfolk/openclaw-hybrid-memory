---
layout: default
title: Dynamic Derived Data
parent: Features
nav_order: 9
---
# Dynamic and Derived Data

Many fields on a fact are **not** typed in by the user — they are **derived at runtime** from the fact text, entity, config, or background jobs. This doc is an index to where each kind of derived data is defined and documented.

---

## What is “dynamic” or “derived”?

When you store a fact (via `memory_store`, auto-capture, or CLI), the plugin often:

- Assigns a **category** (heuristic or LLM).
- Assigns **tags** (regex patterns or explicit).
- Assigns a **decay class** (and thus TTL and refresh behaviour).
- Extracts **entity / key / value** from the text.
- Optionally runs **classify-before-write** (ADD/UPDATE/DELETE/NOOP) and **supersession**.

Categories can also be **discovered** over time from "other" facts (new category names created by the system). All of this is “dynamic” in the sense that it is computed or learned, not only read from config or user input.

---

## Per-topic documentation

| What | How it’s derived | Full doc |
|------|-------------------|----------|
| **Tags** | Regex patterns over fact text (and optional entity). First match per tag; stored comma-separated. Optional explicit tags override. | [AUTO-TAGGING.md](AUTO-TAGGING.md) |
| **Categories** | Stage 1: heuristic regex (detectCategory). Stage 2: LLM auto-classify for "other". Stage 3: **category discovery** — LLM suggests topic labels; labels with ≥ N facts become new categories. | [FEATURES.md](FEATURES.md#categories), [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md) |
| **Decay class** | Heuristic (classifyDecay) from entity/key/text: permanent, stable, active, session, checkpoint. Determines TTL and refresh-on-access. | [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md) |
| **Entity / key / value** | Structured extraction (extractStructuredFields) from text: e.g. "X's Y is Z", "decided X because Y", email/phone. | [FEATURES.md](FEATURES.md#structured-field-extraction) |
| **Conflicting memories** | Classify-before-write (ADD/UPDATE/DELETE/NOOP); supersession (supersedes_id, valid_from, valid_until). | [CONFLICTING-MEMORIES.md](CONFLICTING-MEMORIES.md) |
| **Dynamic salience (FR-005)** | Access boost (recall_count), time decay (last_accessed), Hebbian RELATED_TO links on co-recall. | [DYNAMIC-SALIENCE.md](DYNAMIC-SALIENCE.md) |

---

## Where each is used

- **Tags** — Stored on the fact; used for tag-filtered search, lookup, and recall (e.g. `memory_recall(tag="nibe")`). See [AUTO-TAGGING.md](AUTO-TAGGING.md).
- **Categories** — Stored on the fact; used for filtering, stats, and auto-classify. Discovered categories are persisted in `.discovered-categories.json` and merged with config. See [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md).
- **Decay class** — Stored on the fact; drives expiry and confidence decay. See [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md).
- **Entity/key/value** — Stored on the fact; used for lookup (e.g. by entity or entity+key) and for decay heuristics. See [FEATURES.md](FEATURES.md).
- **Supersession** — Stored as supersedes_id / superseded_at / valid_from / valid_until; used to hide superseded facts in default search and to support point-in-time queries. See [CONFLICTING-MEMORIES.md](CONFLICTING-MEMORIES.md).
- **Dynamic salience** — recall_count and last_accessed drive access boost and time decay in search/lookup scores; co-recalled facts get RELATED_TO links (Hebbian). See [DYNAMIC-SALIENCE.md](DYNAMIC-SALIENCE.md).

---

## Related docs

- [FEATURES.md](FEATURES.md) — Categories, pipeline, structured extraction
- [AUTO-TAGGING.md](AUTO-TAGGING.md) — Tags
- [AUTOMATIC-CATEGORIES.md](AUTOMATIC-CATEGORIES.md) — Category discovery
- [DECAY-AND-PRUNING.md](DECAY-AND-PRUNING.md) — Decay class and TTL
- [CONFLICTING-MEMORIES.md](CONFLICTING-MEMORIES.md) — Contradiction handling and supersession
- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage and search internals
- [DYNAMIC-SALIENCE.md](DYNAMIC-SALIENCE.md) — Access-based importance (FR-005)
