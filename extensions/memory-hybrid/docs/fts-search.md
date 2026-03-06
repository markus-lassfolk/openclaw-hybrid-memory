# FTS5 Full-Text Search

## What is FTS5?

FTS5 is SQLite's built-in full-text search extension. It maintains an inverted index over selected text columns, enabling fast keyword and phrase queries that scale to millions of rows while staying entirely within the local SQLite file — no external search service needed.

The hybrid-memory plugin uses FTS5 as **retrieval strategy 1** (keyword search) in a three-strategy pipeline:

| Strategy | Backend | Strength |
|----------|---------|----------|
| 1 — FTS5 | SQLite `facts_fts` | Exact keyword, phrase, boolean, prefix |
| 2 — Vector | LanceDB | Semantic/fuzzy, paraphrase, conceptual |
| 3 — Merge  | RRF (Issue #152) | Combines both with Reciprocal Rank Fusion |

---

## Schema

The FTS5 virtual table mirrors six columns from the `facts` table:

```sql
CREATE VIRTUAL TABLE facts_fts USING fts5(
  text,       -- Main memory text
  category,   -- e.g. preference, decision, fact
  entity,     -- Named entity (person, project, tool)
  tags,       -- Comma-separated topic tags
  key,        -- Structured key for key/value facts
  value,      -- Structured value
  content='facts',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

`content='facts'` makes `facts_fts` a **content table**: SQLite stores the index separately and fetches full text from `facts` on demand. This saves disk space while keeping all original columns accessible in queries.

`tokenize='porter unicode61'` enables Porter stemming (so "running" matches "run") and full Unicode support.

### Sync Triggers

Three SQL triggers keep the FTS index in sync automatically:

| Trigger | Fires on | Action |
|---------|----------|--------|
| `facts_ai` | INSERT on `facts` | Insert into FTS index |
| `facts_au` | UPDATE on `facts` | Delete old entry, insert updated entry |
| `facts_ad` | DELETE from `facts` | Delete from FTS index |

You never need to manage the FTS index manually — it stays consistent with `facts` at all times.

---

## Query Syntax

The `searchFts()` function accepts plain strings and passes them through `buildFts5Query()`, which auto-detects the query type:

### Plain keywords (default)

```
dark mode
```

Each word is wrapped in double-quotes and joined with OR. Matches any fact containing any of the words.

### Phrase search

```
"dark mode"
```

Wrap the phrase in double-quotes to match the exact sequence of tokens (after stemming). For example `"quick brown fox"` only matches text where those three words appear consecutively.

### Boolean operators

```
TypeScript AND runtime
Deno OR Bun
NOT JavaScript
```

Use uppercase `AND`, `OR`, `NOT` for boolean logic. `AND` narrows results, `OR` broadens them, `NOT` excludes them.

### Prefix search

```
config*
```

The `*` wildcard matches any suffix, so `config*` matches `config`, `configuration`, `configured`, etc.

### Column-scoped search

Pass the `columns` option to restrict matching to specific fields:

```typescript
searchFts(db, "docker", { columns: ["tags", "text"] });
```

---

## Service API

### `searchFts(db, query, options?)`

```typescript
import { searchFts } from "./services/fts-search.js";

const results = searchFts(db, "TypeScript generics", {
  limit: 10,          // default: 20
  entityFilter: "user",
  tagFilter: "devops",
  columns: ["text"],
});
```

Returns `FtsSearchResult[]`:

```typescript
interface FtsSearchResult {
  factId: string;    // UUID — join with facts table for full entry
  text: string;
  entity?: string;
  rank: number;      // FTS5 BM25 rank (negative; closer to 0 = more relevant)
  snippet?: string;  // Highlighted excerpt: matched tokens wrapped in [...]
  matchInfo: string; // Space-separated column names that had a hit
}
```

Results are ordered by `rank` ascending (most relevant first).

### `rebuildFtsIndex(db)`

```typescript
import { rebuildFtsIndex } from "./services/fts-search.js";

const count = rebuildFtsIndex(db); // → number of facts indexed
```

Clears the FTS index and repopulates it from all rows in `facts`. Safe to call multiple times (idempotent). Use this after:
- Manual bulk imports that bypassed triggers
- Restoring from a backup that lacked the FTS index
- Database repair

### `buildFts5Query(raw)`

```typescript
import { buildFts5Query } from "./services/fts-search.js";

buildFts5Query("dark mode")        // → '"dark" OR "mode"'
buildFts5Query('"quick brown fox"')// → '"quick brown fox"'
buildFts5Query("Deno OR Bun")      // → 'Deno OR Bun'
buildFts5Query("config*")          // → 'config*'
buildFts5Query("")                 // → null
```

Converts a raw user string into a safe FTS5 MATCH expression. Strips FTS5 special characters that would cause a parse error (`'`, `"`, `(`, `)`) and unbalanced operators.

---

## Integration in the Retrieval Pipeline

`searchFts` is designed as an independent retrieval strategy. Issue #152 (RRF pipeline) calls it alongside vector search and merges the ranked lists using Reciprocal Rank Fusion.

```
memory_recall("dark mode preferences")
     │
     ├──► searchFts()        → [fact-A rank 1, fact-B rank 3, ...]
     ├──► vectorSearch()     → [fact-B rank 1, fact-C rank 2, ...]
     └──► mergeResults(RRF)  → [fact-B #1, fact-A #2, fact-C #3]
```

---

## Performance

FTS5 search over 10,000+ facts typically completes in **< 5ms** on local hardware. The `facts_fts` index is stored in the same `.db` file, so there is no network overhead.

Benchmarks (rough, SQLite WAL mode, NVMe):

| Facts | Search (keywords) | Rebuild index |
|-------|-------------------|---------------|
| 1 000 | < 2ms | ~10ms |
| 10 000 | < 5ms | ~80ms |
| 100 000 | < 15ms | ~800ms |

---

## Migration: How Existing Databases Get FTS

### New databases

A new `FactsDB` creates the FTS5 virtual table and triggers during initialization. No manual steps needed.

### Existing databases (pre-#151)

When an existing database is opened with the updated plugin, `FactsDB` automatically runs `migrateFtsTagsSupport()` which:

1. Detects that `tags` is absent from the current FTS schema.
2. Drops the old FTS triggers.
3. Drops the old `facts_fts` virtual table.
4. Recreates `facts_fts` with the `tags` column included.
5. Recreates the triggers.
6. Runs a backfill `INSERT INTO facts_fts ... SELECT ... FROM facts` to index all existing facts.

All steps are wrapped in `IF NOT EXISTS` / conditional checks, so the migration is **additive and idempotent** — running it multiple times is safe.

### Manual rebuild

If you ever suspect the FTS index is out of sync (e.g., after a crash or direct SQL manipulation):

```bash
openclaw memory rebuild-fts
# or in code:
rebuildFtsIndex(db);
```
