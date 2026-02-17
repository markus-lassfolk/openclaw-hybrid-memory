# Feedback roadmap: scalability, performance, and stability

This document captures post–PR #15 feedback and maps it to concrete actions. Use it to plan work on `dev` (or feature branches) and track progress.

**Status:** In progress.  
**Branch:** `dev`.  
**Current index.ts:** ~5,9xx lines.

---

## Progress summary

| Area | Item | Status |
|------|------|--------|
| **Stability** | vectorDb.close() in stop() | ✅ Done |
| **Stability** | WAL fsync after each write | ✅ Done |
| **Stability** | LanceDB try/catch graceful degradation | ✅ Done |
| **Stability** | Race on DB reopen (SIGUSR1) | ✅ Done (reopen guard in register) |
| **Performance** | Bulk refreshAccessedFacts | ✅ Done |
| **Performance** | find-duplicates via LanceDB index | ✅ Done |
| **Performance** | Superseded cache TTL (5 min) | ✅ Done |
| **Performance** | Redundant embeddings / blocking I/O | 🔄 Partially done (in-memory LRU cache in Embeddings, max 500; blocking I/O not started) |
| **Redundant code** | truncateText / truncateForStorage | ✅ Done |
| **Redundant code** | safeEmbed centralize embedding errors | ✅ Done |
| **WAL** | Append-only NDJSON + compact in pruneStale | ✅ Done |
| **Code smells** | Named constants (REFLECTION_*, CREDENTIAL_*) | ✅ Done |
| **Code smells** | Error swallowing (catch blocks log) | ✅ Done |
| **Architecture** | Split index.ts into modules | 🔄 In progress (WAL, VectorDB, FactsDB, **cli** (first batch), types, utils, services, prompts) |
| **Architecture** | Embedding provider interface | ✅ Done (EmbeddingProvider in services/embeddings.ts) |
| **Code smells** | Prompts to external files, dead imports | ✅ Done (prompts in files; WALEntry, TTL_DEFAULTS, IDENTITY_FILE_TYPES, TAG_PATTERNS removed from index) |

**Tests:** All 251 tests (9 files) passing after changes.

---

## 1. Single-file concentration (index.ts)

**Feedback:** Plugin implementation, tools, runtime hooks, and CLI are in one very large file — long-term scalability and reliability risk.

**Proposed direction:**

- Split into **15–20 modules** under clear namespaces, for example:
  - `backends/` — SQLite/FactsDB, LanceDB/VectorDB, WAL
  - `services/` — embeddings, reflection, consolidation, classification, distillation
  - `cli/` — command tree and handlers (stats, prune, checkpoint, search, store, find-duplicates, consolidate, etc.)
  - `utils/` — text truncation, tag extraction, decay/expiry, crypto, shared constants
- Keep `index.ts` as a thin **plugin entry**: config, `register`/`stop`, wiring of backends and services.
- Prefer **incremental extraction**: one logical area at a time (e.g. WAL → `backends/wal.ts`, then FactsDB, then CLI) to avoid big-bang refactors.

**Priority:** High (enables all other refactors and reduces merge conflicts).

**Progress:** WAL, VectorDB, FactsDB, types, utils, services, prompts. **CLI:** `cli/register.ts` registers stats, prune, checkpoint, backfill-decay, search, lookup, categories, **store** (runStore), find-duplicates, consolidate, reflect, reflect-rules, reflect-meta, classify (context: runClassify, autoClassifyConfig). extract-daily, install, verify, credentials, distill-window, record-distill, uninstall still in index.

---

## 2. WAL implementation

**Feedback:** WAL reads/parses the full JSON array and rewrites it on every write/remove — O(n) per mutation and avoidable synchronous I/O at higher write rates.

**Status: ✅ Done.**

- **Append-only:** `write(entry)` now appends one JSON line (NDJSON) + fsync; no full-file rewrite.
- **Remove:** `remove(id)` appends a `{"op":"remove","id":"..."}` line; if no entries remain, file is cleared.
- **Fsync:** After every write/remove/compact we call `fsyncSync` for durability.
- **readAll:** Supports legacy single-JSON-array format and NDJSON; two-pass (collect removed ids, then collect entries).
- **pruneStale:** Rewrites file with only valid (non-stale) entries, then fsync (compact).

---

## 3. Redundant functions (~400 lines)

**Feedback:** Text truncation in 3+ forms; embedding calls with identical error handling copy-pasted 8+ times; WAL write/remove pattern duplicated 4+ times (300+ lines).

**Status: Partially done.**

| Utility | Status |
|---------|--------|
| **`truncateText(text, maxLen, suffix?)`** | ✅ Done. Added; used for credential notes and available in `_testing`. |
| **`truncateForStorage(text, maxChars)`** | ✅ Done. Added; replaces capture truncation at store call sites. |
| **`safeEmbed(embeddings, text, logWarn?)`** | ✅ Done. Returns `number[] \| null`; used in find-duplicates. |
| **WAL write/remove helper** | ⏳ Not done. Call sites still call `wal.write` / `wal.remove` directly; WAL is now O(1) append so duplication is less critical. |

---

## 4. Performance

| Issue | Status | Notes |
|-------|--------|-------|
| **N+1 in refreshAccessedFacts** | ✅ Done | Bulk UPDATE with `WHERE id IN (?,...,?)` in batches of 500. |
| **Quadratic find-duplicates** | ✅ Done | Uses `vectorDb.search(vector, limit, threshold)` per fact instead of O(n²) pairwise loop. |
| **Cache thrashing (superseded)** | ✅ Done | `SUPERSEDED_CACHE_TTL_MS` increased from 60s to 5 minutes. |
| **Redundant embeddings** | ✅ Done | In-memory LRU cache in `Embeddings` (max 500 entries); repeated embed of same text returns cached vector. |
| **Blocking I/O on hot path** | ⏳ Not started | Queue/background or cache for embedding/LLM. |

---

## 5. Stability

| Issue | Status | Notes |
|-------|--------|-------|
| **vectorDb never closed** | ✅ Done | `VectorDB.close()` added; called in `stop()` with closed guard. |
| **No fsync in WAL** | ✅ Done | fsync after every write/remove/compact. |
| **LanceDB failures crash plugin** | ✅ Done | All VectorDB methods (search, store, delete, hasDuplicate, count) wrapped in try/catch; search/count/hasDuplicate return empty/0/false and log; store/delete rethrow after log. CLI search and tool paths also wrapped. |
| **Race on DB reopen (SIGUSR1)** | ✅ Done | At start of register(), close and null out any existing factsDb/vectorDb/credentialsDb/proposalsDb so a second register() without stop() does not leak or duplicate instances. |

---

## 6. Architecture and coupling

| Topic | Recommendation |
|-------|-----------------|
| **God file** | Split as in §1 (backends, services, cli, utils). |
| **Embedding provider** | ✅ Done. `EmbeddingProvider` interface in `services/embeddings.ts` with `embed(text): Promise<number[]>`; `Embeddings` (OpenAI) implements it; `safeEmbed(provider, ...)` works with any provider. |
| **FactsDB responsibilities** | Over time, split into smaller units: e.g. schema/migrations, CRUD, search (FTS), checkpoint/decay, categories. Can follow after initial file split. |

---

## 7. Code smells

| Smell | Status |
|-------|--------|
| **Magic numbers** | ✅ Partially done. Added `REFLECTION_MAX_FACT_LENGTH`, `REFLECTION_MAX_FACTS_PER_CATEGORY`, `CREDENTIAL_NOTES_MAX_CHARS`; used for credential notes. More can be extracted. |
| **Error swallowing** | ✅ Partially done. Empty catch blocks in vectorDb.delete (tool + supersede) now log with `api.logger.warn`. |
| **78-line prompt inline** | ✅ Done. All LLM prompts in `prompts/*.txt`: memory-classify, reflection, consolidate, category-discovery, category-classify; `utils/prompt-loader.ts` (loadPrompt, fillPrompt) used throughout. |
| **Inconsistent naming** | ⏳ Not started. |
| **Dead imports** | ✅ Done. Removed WALEntry, TTL_DEFAULTS, IDENTITY_FILE_TYPES, TAG_PATTERNS from index. |

---

## Suggested order of work

1. ~~**Stability (quick):** Add `vectorDb.close()` in `stop()`, add WAL fsync, and wrap LanceDB in try/catch.~~ ✅
2. ~~**Performance (quick):** Bulk `refreshAccessedFacts`.~~ ✅
3. ~~**Redundant code (quick):** Extract `truncateText` / `truncateForStorage`, `safeEmbed`.~~ ✅
4. ~~**WAL (medium):** Append-only + compact + fsync.~~ ✅
5. ~~**Performance (medium):** find-duplicates via LanceDB; superseded cache TTL.~~ ✅
6. **Split index.ts (medium–high):** Backends first, then services, then CLI. ⏳
7. **Architecture (ongoing):** Embedding interface; FactsDB split; prompts externalized; redundant embeddings (cache done). Blocking I/O / queue still ⏳.

---

## How to use this doc

- **Track:** Add a "Done" column or move items to a "Completed" section as you go.
- **Branch:** Do stability and quick performance/redundancy on `dev`; larger refactors (file split, WAL redesign) can be feature branches and merged when green.
- **Tests:** Keep/extend `wal.test.ts`, `facts-db.test.ts`, and any integration tests; run after each change.
- **CHANGELOG:** When merging, add entries under "Unreleased" for user-visible fixes (e.g. "Fix plugin not closing LanceDB on stop", "Bulk access update for recall").
