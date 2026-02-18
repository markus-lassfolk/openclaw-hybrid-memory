---
layout: default
title: Auto-Tagging
parent: Features
nav_order: 11
---
# Auto-Tagging

Facts can carry **topic tags** for filtering. When you don’t pass tags explicitly, the plugin **infers tags from the fact text (and optional entity)** using regex patterns. Tag-filtered queries then restrict results to facts that have a given tag.

---

## Why tags?

- **Topic filtering** — e.g. only memories about “nibe” or “homeassistant” when answering a question about your heat pump.
- **Narrow recall** — `memory_recall(tag="nibe")` uses only SQLite with a tag filter (no vector search), which is fast and deterministic.
- **CLI and tools** — `hybrid-mem search` and `hybrid-mem lookup` support `--tag <tag>`; the memory_store tool accepts an optional `tags` parameter.

---

## How tags are assigned

1. **Explicit tags** — If you pass `tags` (array or comma-separated string) to `memory_store` or `hybrid-mem store --tags "a,b"`, those are stored. They are **not** merged with auto-tags; they replace the default inference for that fact.
2. **Auto-tagging** — If `tags` are omitted, the plugin calls `extractTags(text, entity)`:
   - Input: fact `text` and optional `entity` (e.g. from structured extraction).
   - Both are combined (e.g. `text + " " + entity`), lowercased, and matched against a fixed list of **tag patterns**.
   - Each pattern is `[tagName, regex]`. First match wins per tag; tags are deduplicated and lowercased.
   - Result: array of tag strings stored with the fact.

So auto-tagging is **regex-only** (no LLM). Adding a new topic means adding a new pattern (see [Adding tag patterns](#adding-tag-patterns)).

---

## Built-in tag patterns

Patterns are defined in `extensions/memory-hybrid/utils/tags.ts` as `TAG_PATTERNS: Array<[string, RegExp]>`. Order matters: the first matching pattern for a tag is used.

| Tag | Pattern (concept) | Example text |
|-----|-------------------|--------------|
| `nibe` | `\bnibe\b` (case-insensitive) | "The Nibe S1255 heat pump" |
| `zigbee` | `\bzigbee\b` | "Zigbee coordinator setup" |
| `z-wave` | `\bz-?wave\b` | "Z-Wave mesh", "zwave stick" |
| `auth` | `\bauth(entication\|orization)?\b` | "Authentication flow", "authorization token" |
| `homeassistant` | `\bhome[- ]?assistant\b` | "Home Assistant integration" |
| `openclaw` | `\bopenclaw\b` | "OpenClaw plugin" |
| `postgres` | `\bpostgres(ql)?\b` | "Postgres" / "PostgreSQL" |
| `sqlite` | `\bsqlite\b` | "SQLite database" |
| `lancedb` | `\blancedb\b` | "LanceDB vectors" |
| `api` | `\bapi\s+(key\|endpoint\|url)\b` | "API key", "API endpoint" |
| `docker` | `\bdocker\b` | "Docker container" |
| `kubernetes` | `\bkubernetes\|k8s\b` | "Kubernetes" / "k8s" |
| `ha` | `\bha\b` | "HA setup" |

If the **entity** is passed (e.g. from structured extraction), it is included in the combined string. For example, `extractTags("some text", "nibe")` can yield `["nibe"]` because "nibe" appears in the entity.

---

## Storage

Tags are stored in the `facts` table in SQLite as a single **comma-separated** string (e.g. `nibe,homeassistant,zigbee`). Empty or null means no tags. Helpers:

- `serializeTags(tags: string[])` → string for DB
- `parseTags(s: string | null)` → string[] from DB
- `tagsContains(tagsStr, tag)` — exact match in comma-separated list

---

## Filtering by tag

- **FTS search** — `factsDb.search(..., { tag })` adds a SQL condition so that the stored `tags` column (comma-separated) contains the requested tag: `(',' || COALESCE(f.tags,'') || ',') LIKE '%,tag,%'`.
- **Lookup** — `factsDb.lookup(entity, key, tag, options)` applies the same tag filter.
- **memory_recall** — When you pass `tag="nibe"`, the plugin uses only SQLite + tag filter and skips LanceDB, so recall is deterministic and fast for that topic.
- **CLI** — `openclaw hybrid-mem search "heat pump" --tag nibe`, `openclaw hybrid-mem lookup user --tag homeassistant`.

Multiple tags in one query: the current design filters by **one** tag per call. For “nibe AND homeassistant” you’d need two lookups or search and intersect in your own logic (or add a future option).

---

## Manual tags override

To force specific tags and skip auto-tagging for a fact:

- **memory_store tool:** pass `tags: ["nibe", "homeassistant"]` (or comma-separated string if the schema accepts it).
- **CLI:** `openclaw hybrid-mem store --text "..." --tags "nibe,homeassistant"`.

Those values are stored as-is (normalized to lowercase when parsed). They are not merged with `extractTags()`.

---

## Adding tag patterns

1. Open `extensions/memory-hybrid/utils/tags.ts`.
2. Add a pair to `TAG_PATTERNS`: `["tagname", /\byour\b\s+regex/i]`.
3. Keep tag names lowercase and short (e.g. `homeassistant`, not `HomeAssistant`).
4. Order: first matching pattern wins; put more specific patterns before broad ones if they overlap.
5. Run tests: `extractTags` is covered in `tests/utils.test.ts`; add a test for your new pattern if you want.

No config option exists for tag patterns; they are code-defined.

---

## Related docs

- [FEATURES.md](FEATURES.md) — Categories, decay, auto-classify, and brief tag mention
- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage and search internals, including tag filtering
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `search`, `lookup`, `store` options
- [EXAMPLES.md](EXAMPLES.md) — Using tags in practice
