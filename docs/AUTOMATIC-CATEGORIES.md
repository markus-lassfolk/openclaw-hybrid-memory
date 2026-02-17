---
layout: default
title: Automatic Categories
parent: Features
nav_order: 8
---
# Automatic Categories (Category Discovery)

How the plugin **creates new categories automatically** from your data: the **category discovery** step groups "other" facts by free-form topic labels; any label that appears often enough becomes a real category.

---

## Overview

Besides **custom categories** in config, the plugin can **discover** new categories from facts in `"other"`:

1. **Discovery** — Before reclassifying "other" into existing categories, an LLM assigns each "other" fact a **short topic label** (1–2 words). No fixed category list is given; the LLM invents labels from the text (e.g. "food", "travel", "technical").
2. **Threshold** — Any label with at least **minFactsForNewCategory** facts (default 10) becomes a **new category**. The threshold is not shown to the LLM.
3. **Reclassify** — Those facts are updated from `"other"` to the new category.
4. **Persist** — New category names are written to **`.discovered-categories.json`** (next to your SQLite DB) and merged with config categories on load.

---

## When it runs

Discovery runs only as part of the **auto-classify** job (same schedule: ~5 min after startup, then every 24 h if `autoClassify.enabled` is true). It runs only if:

- `autoClassify.suggestCategories` is `true` (default), and
- There are at least **15** "other" facts (internal minimum).

Discovery runs **before** the normal "reclassify other into existing categories" step.

---

## How it works (steps)

1. Load all facts with category `"other"`.
2. Send them to the LLM in batches of 25. Prompt: assign a short label per fact; output a JSON array of strings.
3. Normalize labels (trim, lowercase, length ≤ 40); discard empty or `"other"`.
4. Group facts by label. For each label with count ≥ **minFactsForNewCategory** that is not already a category:
   - Add it as a new category.
   - Update those facts from `"other"` to the new category.
5. Read `.discovered-categories.json`, merge in new names, write back.

Built-in and config categories are unchanged; discovered ones are **added** and used everywhere (memory_store, classify, CLI).

---

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `autoClassify.suggestCategories` | `true` | Run category discovery before reclassifying "other". Set `false` to only use existing categories. |
| `autoClassify.minFactsForNewCategory` | `10` | Min facts per label to create a new category. Not sent to the LLM. |

Discovery uses `autoClassify.model` (e.g. `gpt-4o-mini`).

---

## File

- **Path** — `~/.openclaw/memory/.discovered-categories.json` (or next to `sqlitePath`). JSON array of strings, e.g. `["research", "travel"]`.
- **Backup** — Include this file in backups if you care about preserving discovered category names (see [BACKUP.md](BACKUP.md)).

---

## Related docs

- [FEATURES.md](FEATURES.md) — Categories and classification pipeline
- [CONFIGURATION.md](CONFIGURATION.md) — autoClassify and categories
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — hybrid-mem classify, categories
- [DYNAMIC-DERIVED-DATA.md](DYNAMIC-DERIVED-DATA.md) — Overview of tags, categories, decay, and other derived data
