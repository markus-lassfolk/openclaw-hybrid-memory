# Council Review Punch List — PR #198 Milestone A

## Repository
`markus-lassfolk/openclaw-hybrid-memory`, branch: `milestone-a`

## Instructions
1. Create a new branch `fix/council-review-findings` from `origin/milestone-a`
2. Fix ALL items below (Critical first, then Warnings, then Suggestions)
3. Run `npm test` and `npx tsc --noEmit` after EACH fix — do NOT accumulate breakage
4. For EACH fix, reply to the GitHub review thread confirming the fix with commit SHA
5. After replying, resolve the thread via GraphQL:
   ```
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'
   ```
6. Push and create PR targeting `milestone-a`
7. When done: `openclaw system event --text "Done: council review fixes PR" --mode now`

---

## 🔴 CRITICAL (8 items)

### C1. Linear Scan over Embeddings in JS
**File:** `services/retrieval-aliases.ts:115`
**Thread:** PRRT_kwDORQuyQM5yguMi | Reply-to: 2894051155
**Issue:** `AliasDB.search` performs a manual linear float array dot-product scan over ALL aliases in JS. With 50k facts × 3-5 aliases each = 150-250k embeddings scanned on main thread per search.
**Fix:** Use LanceDB vector search for alias lookup instead of in-memory linear scan. If AliasDB doesn't have its own LanceDB table, add one. Fall back to linear scan only for very small datasets (<1000 aliases).

### C2. Full Graph BFS on Every Search
**File:** `services/retrieval-orchestrator.ts:416`
**Thread:** PRRT_kwDORQuyQM5yguMl | Reply-to: 2894051160
**Issue:** `detectClusters` is invoked inline in the retrieval hot path. It fetches ALL links and performs BFS over the entire graph O(V+E) on every query.
**Fix:** Cache cluster results with a TTL (e.g., 5 minutes). Invalidate on link creation/deletion. Only recompute if cache is stale. Add a `private clusterCache: { clusters: Map, timestamp: number } | null` field.

### C3. N+1 SQLite Queries in BFS Inner Loop
**File:** `services/graph-retrieval.ts:164`
**Thread:** PRRT_kwDORQuyQM5yguMm | Reply-to: 2894051161
**Issue:** `expandGraph` BFS loop performs a separate `factsDb.getById` for every connected neighbor — thousands of synchronous queries for well-connected nodes.
**Fix:** Batch-fetch neighbors. Collect all neighbor IDs from the current BFS frontier, then fetch them in one `WHERE id IN (...)` query. Add a `getByIds(ids: string[])` method to factsDb if it doesn't exist.

### C4. SQL injection pattern in migrateTimestampUnits
**File:** `backends/facts-db.ts` (around line 751)
**Thread:** PRRT_kwDORQuyQM5ygvkx | Reply-to: 2894058458
**Issue:** String interpolation in `exec()` instead of parameterized queries. While the value is a constant today, this pattern is dangerous if copied.
**Fix:** Replace string interpolation with parameterized query or use a constant that's clearly safe. Add a comment explaining why this specific case is safe if parameterization isn't possible for DDL.

### C5. Encryption key in plaintext config object
**File:** `config/index.ts` (around line 1463)
**Thread:** PRRT_kwDORQuyQM5ygvk3 | Reply-to: 2894058467
**Issue:** Encryption key persists as a string in `HybridMemoryConfig` for the entire process lifetime, serializable via diagnostics.
**Fix:** Store the key in a closure or WeakRef that isn't enumerable/serializable. At minimum, make sure diagnostics/health endpoints redact it. Consider `Object.defineProperty` with `enumerable: false`.

### C6. consecutiveFailures counter resets every timer tick
**File:** `services/passive-observer.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-Z | Reply-to: 2894065857
**Issue:** The `consecutiveFailures` Map is declared inside `runPassiveObserver()`, so it's recreated on every interval tick. Counter can never reach the threshold — permanently-corrupt JSONL files retry LLM calls forever.
**Fix:** Hoist the Map outside the function (module-level or class-level). It must persist across invocations.

### C7. authFailureRecallsThisSession.clear() wipes ALL sessions
**File:** `lifecycle/hooks.ts:16`
**Thread:** PRRT_kwDORQuyQM5ygw-d | Reply-to: 2894065861
**Issue:** The shared Map is cleared entirely on any `agent_end` event, destroying auth failure tracking for other active sessions.
**Fix:** On `agent_end`, delete only the entries for the ending session (filter by session key prefix), not `.clear()` the entire map.

### C8. Error reporting consent not enforced (GPT finding)
**File:** `config/index.ts`
**No thread** — address inline, no reply needed.
**Issue:** `openclaw.plugin.json` says "Explicit user consent required" for error reporting, but config parses `consent` without using it to gate `enabled`.
**Fix:** If `errorReporting.enabled === true` and `consent !== true`, either throw with a clear error or force `enabled = false` and log a warning.

---

## 🟡 WARNING (10 items)

### W1. Unbounded Entity Lookup
**File:** `tools/memory-tools.ts:333`
**Thread:** PRRT_kwDORQuyQM5yguMo | Reply-to: 2894051165
**Fix:** Add `LIMIT 100` (or configurable) to entity lookup queries.

### W2. O(E×M) String Search for Entities
**File:** `services/ambient-retrieval.ts:130`
**Thread:** PRRT_kwDORQuyQM5yguMp | Reply-to: 2894051167
**Fix:** Pre-build a Set or Trie for entity matching. For now, at minimum cache the entity list and use a prefix-based approach.

### W3. Unconsolidated events accumulate forever
**File:** `backends/event-log.ts` (around line 201)
**Thread:** PRRT_kwDORQuyQM5ygvk1 | Reply-to: 2894058464
**Fix:** Add a configurable max-age for unconsolidated events (e.g., 90 days). After that, archive them regardless.

### W4. Credential migration deletes before verifying
**File:** `services/credential-migration.ts` (around line 65)
**Thread:** PRRT_kwDORQuyQM5ygvk6 | Reply-to: 2894058470
**Fix:** After vault store, read back and verify before deleting the original.

### W5. Fire-and-forget async init race
**File:** `setup/init-databases.ts` (around line 262)
**Thread:** PRRT_kwDORQuyQM5ygvlB | Reply-to: 2894058480
**Fix:** Ensure health checks wait for init completion. Add an `initialized` promise that must resolve before health endpoints report healthy.

### W6. dream-cycle markConsolidated not in try/catch
**File:** `services/dream-cycle.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-g | Reply-to: 2894065865
**Fix:** Wrap `eventLog.markConsolidated()` in try/catch. On failure, delete the just-created consolidated fact to maintain consistency.

### W7. Merged fact loses key + value
**File:** `services/consolidation.ts:8`
**Thread:** PRRT_kwDORQuyQM5ygw-j | Reply-to: 2894065870
**Fix:** Preserve `key` and `value` from the highest-confidence source fact. If facts have different keys, keep both as structured data or pick the most specific.

### W8. stop() closes DB while observer may be running
**File:** `setup/plugin-service.ts:17`
**Thread:** PRRT_kwDORQuyQM5ygw-l | Reply-to: 2894065874
**Fix:** Add a shutdown drain: set a `shuttingDown` flag, wait for current observer run to finish (with timeout), then close DBs.

### W9. Per-fact embedding failure silently drops fact
**File:** `services/passive-observer.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-p | Reply-to: 2894065879
**Fix:** Add `logger.warn` on embed failure. Increment `result.errors`. Don't silently swallow.

### W10. FTS5 sanitizer doesn't strip `:`, `{}`, `NEAR` (Opus finding)
**File:** `backends/facts-db.ts` (sanitizeFTS5Query function)
**No thread** — fix inline.
**Fix:** Extend the FTS5 sanitizer to also strip `:`, `{`, `}`, and the `NEAR` operator.

---

## 🟢 SUGGESTIONS (7 items)

### S1. Embedding cache not invalidated on model switch
**File:** `services/embeddings.ts` (around line 125)
**Thread:** PRRT_kwDORQuyQM5ygvk_ | Reply-to: 2894058476
**Fix:** Clear embedding cache when model config changes. Add a cache key that includes model name.

### S2. Passive observer integration tests are stubs
**File:** `tests/passive-observer.test.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-s | Reply-to: 2894065882
**Fix:** Add at least one end-to-end test that calls `runPassiveObserver` with mocked LLM + DB.

### S3. Missing consolidation.test.ts
**File:** `services/consolidation.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-u | Reply-to: 2894065884
**Fix:** Add basic test file covering: merge preserves key/value, similarity threshold boundary, empty LLM response handling.

### S4. No end-to-end reflection tests
**File:** `services/reflection.ts`
**Thread:** PRRT_kwDORQuyQM5ygw-v | Reply-to: 2894065885
**Fix:** Add at least one happy-path test for `runReflection`.

### S5. tsconfig includes tests in build (GPT finding)
**File:** `tsconfig.json`
**No thread** — fix inline.
**Fix:** Exclude tests from the production build. Either split into tsconfig.build.json or adjust `include`.

### S6. `as any` casts in CLI handlers (GPT finding)
**File:** `cli/handlers.ts`
**No thread** — fix inline.
**Fix:** Type the credential parse result properly instead of `as any`.

### S7. ProcedureEntry.scope should be MemoryScope (GPT finding)
**File:** `types/memory.ts`
**No thread** — fix inline.
**Fix:** Change `ProcedureEntry.scope?: string` to `ProcedureEntry.scope?: MemoryScope`.

---

## Thread Resolution Checklist
After fixing each item WITH a thread, reply to the thread and resolve it:
```bash
# Reply
gh api repos/markus-lassfolk/openclaw-hybrid-memory/pulls/198/comments \
  -f body="Fixed in COMMIT_SHA: DESCRIPTION" \
  -F in_reply_to=DATABASE_ID

# Resolve
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'
```

Items WITHOUT threads (C8, W10, S5, S6, S7) don't need replies — just fix them.
