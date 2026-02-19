# Code Review — Bug Hunting & Quality (GPT)

## 🐛 Bugs Found

### 1) `FactsDB.store()` ignores provided `scopeTarget`
- **File:** `extensions/memory-hybrid/backends/facts-db.ts`
- **Snippet:**
  ```ts
  const scope = entry.scope ?? "global";
  const scopeTarget = entry.scopeTarget ?? (scope === "global" ? null : null);
  ```
- **What’s wrong:** This expression always yields `null` when `entry.scopeTarget` is `undefined`, even when `scope !== 'global'`. That means user/agent/session-scoped writes will silently lose their `scope_target`, causing scope filtering and pruning/promotion logic to malfunction.
- **Severity:** **critical** (breaks FR-006 scoping correctness; can cause privacy/tenancy bugs)
- **Suggested fix:**
  - Enforce required target for non-global scopes:
    ```ts
    const scope = entry.scope ?? "global";
    const scopeTarget = scope === "global" ? null : (entry.scopeTarget ?? null);
    if (scope !== "global" && !scopeTarget) throw new Error("scopeTarget required for non-global scope");
    ```

### 2) `searchProcedures()` SQL is invalid (extra comma before `LIMIT`)
- **File:** `extensions/memory-hybrid/backends/facts-db.ts`
- **Snippet:**
  ```sql
  ... WHERE procedures_fts MATCH ? ORDER BY p.procedure_type DESC, LIMIT ?
  ```
- **What’s wrong:** The trailing comma before `LIMIT` is a SQL syntax error.
- **Severity:** **critical** (procedure search will throw and return `[]` due to catch)
- **Suggested fix:**
  ```sql
  ... WHERE procedures_fts MATCH ? ORDER BY p.procedure_type DESC LIMIT ?
  ```
  Also consider ordering by an actual score (see logic issues).

### 3) Likely wrong use of `rank` in FTS5 queries (facts + procedures)
- **File:** `extensions/memory-hybrid/backends/facts-db.ts`
- **Snippets:**
  ```sql
  SELECT f.*, rank, ... FROM facts f
  JOIN facts_fts fts ON f.rowid = fts.rowid
  WHERE facts_fts MATCH @query
  ORDER BY rank
  ```
  ```sql
  SELECT p.*, fts.rank FROM procedures p
  JOIN procedures_fts fts ON p.rowid = fts.rowid
  WHERE procedures_fts MATCH ?
  ```
- **What’s wrong:** In SQLite **FTS5**, there is no built-in `rank` column like older FTS versions. Unless you’ve defined a custom rank function/column elsewhere, these queries will error at runtime.
- **Severity:** **critical** (breaks recall/search)
- **Suggested fix:** Use `bm25()` or `rank` auxiliary function correctly, e.g.:
  ```sql
  SELECT f.*, bm25(facts_fts) AS score FROM facts f
  JOIN facts_fts ON f.rowid = facts_fts.rowid
  WHERE facts_fts MATCH @query
  ORDER BY score
  ```
  And similarly for `procedures_fts`.

### 4) Regex `.test()` statefulness can cause missed matches if caller passes `/.../g`
- **Files:**
  - `services/directive-extract.ts`
  - `services/reinforcement-extract.ts`
- **Snippets:**
  ```ts
  if (!directiveRegex.test(userText)) continue;
  // ...
  if (!reinforcementRegex.test(userText)) continue;
  ```
- **What’s wrong:** If the provided regex has the global (`g`) or sticky (`y`) flag, `.test()` mutates `lastIndex`, making subsequent calls potentially fail unexpectedly (false negatives).
- **Severity:** **medium** (depends on how regex is constructed upstream)
- **Suggested fix:**
  - Document/guard: disallow `g|y`, or normalize before use.
  - Defensive reset:
    ```ts
    directiveRegex.lastIndex = 0;
    ```
  - Or clone: `new RegExp(directiveRegex.source, directiveRegex.flags.replace(/g|y/g, ""))`.

### 5) `reinforceProcedure()` assumes non-null `reinforced_count`
- **File:** `extensions/memory-hybrid/backends/facts-db.ts`
- **Snippet:**
  ```ts
  const row = ... as { reinforced_count: number; confidence: number }
  const newReinforcedCount = row.reinforced_count + 1;
  ```
- **What’s wrong:** On migrated DBs, `reinforced_count` might be `NULL` (or missing in older rows before update), which would yield `NaN`.
- **Severity:** **medium**
- **Suggested fix:**
  ```ts
  const current = (row.reinforced_count ?? 0);
  const newReinforcedCount = current + 1;
  ```

### 6) Typo in exported API name: `isProceduraDirective`
- **File:** `services/directive-extract.ts`
- **Snippet:**
  ```ts
  export function isProceduraDirective(...)
  ```
- **What’s wrong:** Misspelling (`Procedura`). This leaks into public API and tests. It’s easy to miss and will proliferate.
- **Severity:** **low** (but annoying API wart)
- **Suggested fix:** Rename to `isProceduralDirective` and keep a deprecated alias for backward compatibility.

## ⚠️ Logic Issues

### 1) Procedure search scoring ignores FTS relevance (uses only `confidence + reinforcement`)
- **File:** `extensions/memory-hybrid/backends/facts-db.ts` (`searchProcedures`)
- **What’s wrong:** Even if SQL is fixed, the code doesn’t use any FTS relevance metric. It computes `boostedScore = confidence + reinforcement` and sorts by that, so a poorly matching procedure with high confidence could outrank a strongly matching one.
- **Severity:** **medium** (ranking quality)
- **Suggested fix:** Include FTS score (`bm25`) in composite, similar to facts:
  - `final = 0.6 * ftsScore + 0.4 * confidence + reinforcement` (example).

### 2) `runReinforcementExtract` looks back only 3 messages for assistant context
- **File:** `services/reinforcement-extract.ts`
- **Snippet:**
  ```ts
  for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
  ```
- **What’s wrong:** Many sessions include tool messages between assistant turns; the praised assistant message could be further back than 3 records.
- **Severity:** **medium** (missed incidents)
- **Suggested fix:** Scan back until first assistant message or up to a larger bound (e.g. 10–20), optionally skipping `role === 'tool'`.

### 3) Directive extraction requires `directiveRegex` pre-match, then category detection
- **File:** `services/directive-extract.ts`
- **What’s wrong:** Messages with directive categories that aren’t in the supplied regex won’t be analyzed at all. This couples detection too tightly to regex completeness.
- **Severity:** **low/medium** (depends on upstream keyword file quality)
- **Suggested fix:** Either:
  - remove the pre-filter and rely on `detectDirectiveCategories()` + `shouldSkipUserMessage()`; or
  - broaden pre-filter to reduce false negatives.

### 4) Facts search score can exceed 1.0
- **File:** `extensions/memory-hybrid/backends/facts-db.ts` (`search`)
- **Snippet:**
  ```ts
  const composite = bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15 + reinforcement;
  const salienceScore = computeDynamicSalience(composite, entry);
  ```
- **What’s wrong:** `reinforcement` is additive (default 0.1). Composite can exceed 1.0 (e.g. 1.0 + 0.1). If downstream assumes 0–1, this may skew ranking.
- **Severity:** **low** (if scores are only relative)
- **Suggested fix:** Clamp composite to 1.0 before salience (or document unbounded scoring).

## 📝 Style Issues

### 1) Unused variable `lower` in `detectDirectiveCategories`
- **File:** `services/directive-extract.ts`
- **Snippet:**
  ```ts
  const lower = text.toLowerCase();
  ```
- **What’s wrong:** Declared but not used.
- **Severity:** **low**
- **Suggested fix:** Remove, or consistently use `lower` for checks.

### 2) Comments disagree with implementation
- **File:** `backends/facts-db.ts`
- **Snippet:**
  - Comment: “Cached for 1 minute”
  - Code: `SUPERSEDED_CACHE_TTL_MS = 5 * 60_000`
- **Severity:** **low**
- **Suggested fix:** Update comment to 5 minutes.

### 3) Mixed serialization formats for `source_sessions`
- **File:** `backends/facts-db.ts`
- **What’s wrong:**
  - facts: `source_sessions` may store JSON (stringified array) depending on input type
  - procedures: `source_sessions` stores a CSV string and later splits by `,`
  This inconsistency makes migrations and consumers error-prone.
- **Severity:** **medium** (data hygiene)
- **Suggested fix:** Standardize on JSON array in both tables and parse/serialize centrally.

## 🧪 Test Gaps

### 1) No tests covering `/g` regex statefulness
- **Files:** `tests/directive-extract.test.ts`, `tests/reinforcement-extract.test.ts`
- **Gap:** Add a test where `directiveRegex`/`reinforcementRegex` includes `g` and ensure multiple user messages are detected.

### 2) No tests for scoping persistence (`scope` + `scopeTarget`)
- **File:** (missing) tests for `FactsDB.store()` with non-global scope
- **Gap:** A unit test should store `{ scope: 'user', scopeTarget: 'u1' }` and verify `getAll({scopeFilter:{userId:'u1'}})` returns it, while `userId:'u2'` doesn’t.

### 3) No tests for procedure search SQL / ranking
- **Gap:** Add tests that create a small `procedures` table, insert procedures, and verify `searchProcedures()` returns expected ordering and does not throw.

## ✅ What's Solid

- Defensive JSON parsing in both extractors (`try/catch` on per-line parsing) prevents a single malformed line from crashing the scan.
- Reinforcement quote retention is bounded (last 10 quotes) and truncates quote length to avoid unbounded growth.
- Scope filtering helpers (`scopeFilterClause*`) are clearly structured and the security warning comment is good.
- `refreshAccessedFacts()` batches updates to avoid obvious N+1 update patterns.

## Summary: 6 bugs, 4 logic issues, 3 style issues
