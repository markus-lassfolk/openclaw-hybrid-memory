## 2026.4.15 - Productisation baseline tracking (Epic #1029)

### Added
- Added `produkt/hybrid-memory-productisation.md` to track shipped capabilities and open productisation lanes.

### Changed
- Updated `README.md` with a Productisation status section linking to the new tracker document.

### Notes
- Epic #1029 is maintained as a planning/coordinating epic; implementation is split into focused child issues.
- Shipped productisation milestones reflected: #1023 (viewer UX track), #1024 (README/onboarding), #1027 (public API/export surface).
- Remaining open tracks: #1025 (session observability), #1028 (messaging/demo package), #1026 (filter→rank→hydrate retrieval mode).

# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D for date; same-day revisions use a three-part **npm** version with patch = day×10 + revision, e.g. 2026.2.170, 2026.2.171, so npm accepts it as a normal release).

---

## [Unreleased]

## [2026.7.191] - 2026-07-09

### Fixed

Loop iteration 125 — second finding from the fresh `backends/`+`routes/` sweep: the GraphQL `stats` query could crash on a large fact store.

- **`routes/graphql-resolvers.ts`'s `Query.stats` computed `oldestFactDate`/`newestFactDate` via `Math.min(...facts.map(...))`/`Math.max(...facts.map(...))`, where `facts = allFacts(context, true)` has no LIMIT clause** (unlike every other resolver in this file — `search`, `graph` — which explicitly cap `limit`/`maxNodes`). Spreading an array into a function call is bounded by V8's argument-count limit (~65k-125k elements); a long-lived agent memory store that has accumulated more facts than that throws `RangeError: Maximum call stack size exceeded` on every `stats` query, permanently breaking that query for large stores.
- Fixed by replacing the two spreads with a single forward pass tracking running min/max, avoiding any array-length-bounded call.

Regression test added (new `tests/graphql-stats-resolver.test.ts`): constructs a 150,000-fact mock store (above the spread limit) and asserts `Query.stats` resolves without throwing and computes the correct oldest/newest dates, plus small-store correctness checks (empty store → `null`/`null`; mixed-order store → correct min/max). Verified via `git stash` to fail without the fix — reproduces the exact `RangeError: Maximum call stack size exceeded`. tsc clean; biome clean (same 1 pre-existing import-order error on `graphql-resolvers.ts` before and after, zero new findings — my own new test file's non-null-assertion warnings match the established pattern used elsewhere in this suite). Related suites (graphql-stats-resolver, graphql-link-scope-security, graphql-related-facts-link-visibility): 15 passed, no regressions.

## [2026.7.190] - 2026-07-09

### Fixed

Loop iteration 124 — first finding from the fresh `backends/`+`routes/` sweep dispatched at iteration 123: `CredentialsDB`'s constructor leaked the native SQLite handle on every rejected vault open.

- **`backends/credentials-db.ts`'s constructor opened the native `DatabaseSync` handle (`const db = new DatabaseSync(dbPath); super(db);`) before running any vault-metadata validation, and its two validation-failure paths (`"Credentials vault was created with encryption..."` and `"Credentials vault contains data but no encryption metadata..."`) threw without ever closing that handle.** Since the constructor throws, the caller never receives a reference to call `.close()` on — the partially-constructed instance is simply discarded, along with the open connection. A caller that retries with a corrected key (a CLI re-prompting for the right `credentials.encryptionKey`, or a service falling back through key sources) leaks another native SQLite connection per attempt for the life of the process.
- Fixed by calling `db.close()` (the local, always-in-scope constructor variable) immediately before each of the two validation throws — mirroring the direct `this.db.close()` calls `BaseSqliteStore` itself already uses in its own close/reopen paths, so no other cleanup mechanism was needed.

Regression test added (`tests/credentials-db.test.ts`, new `describe` block): spies on `DatabaseSync.prototype.close` around each of the two existing throw scenarios (opening an encrypted vault with an empty key; opening a legacy vault with data but no `vault_meta` using the wrong key) and asserts the handle is closed exactly once. Verified via `git stash` to fail without the fix (both assert 0 close calls pre-fix vs. 1 post-fix). tsc clean; biome clean (identical 2 pre-existing errors/2 warnings baseline on both changed files, before and after — zero new findings). Related suites (credentials-db plus 8 sibling credentials-* suites): 153 passed, no regressions.

## [2026.7.189] - 2026-07-09

### Fixed

Loop iteration 123 — fixes the fourth and final `cli/` fresh-sweep finding: `expire-by-source --decay-class` accepted any free-form string with no validation.

- **`register-lifecycle.ts`'s `expire-by-source` command cast `opts.decayClass` directly to `DecayClass` (`(opts.decayClass ?? "short") as DecayClass`) with no runtime check against the `DECAY_CLASSES` enum.** `factsDb.expireBySourcePattern` writes this value straight into the `decay_class` column, a plain `TEXT NOT NULL` column with no CHECK constraint — `expire-by-source --pattern 'temp/*' --days 7 --apply --decay-class bogus` silently persisted `decay_class='bogus'` on every matched fact, an out-of-enum value that every downstream decay/TTL computation (`utils/decay.ts`'s `TTL_DEFAULTS[decayClass]`, decay-class stats breakdowns, `decay reclassify`) doesn't recognize. Every sibling CLI option in this codebase (`--policy`, `--scope`, `--format`) validates against an explicit allow-list before use; this was the one outlier.
- Fixed by validating `decayClassRaw` against `DECAY_CLASSES` (already exported from `config.js`, the same enum `routes/graphql-resolvers.ts` validates against) before calling `expireBySourcePattern`, printing a clear error and setting `process.exitCode = 1` on an invalid value — matching the file's own existing `--days` validation pattern two lines above.

Regression test added (new `tests/register-lifecycle-expire-by-source.test.ts`, using the real-`Command`/`parseAsync` harness already established in the sibling `tests/register-lifecycle-github-cli.test.ts`): asserts an invalid `--decay-class` prints the expected error, sets `process.exitCode = 1`, and never calls `factsDb.expireBySourcePattern`; companion tests confirm a valid `--decay-class` and the omitted-defaults-to-`"short"` case both still work. Verified via `git stash` to fail without the fix — the pre-fix code called `expireBySourcePattern` with the invalid value unguarded (surfacing as a `TypeError` on the undefined-mock-return in the test, since there was no validation to short-circuit it). tsc clean; biome clean (zero findings on either changed file, both before and after the fix). Related suites (register-lifecycle-expire-by-source, register-lifecycle-github-cli, facts-db): 209 passed, no regressions.

This closes out the fresh flat sweep of `services/`, `tools/`, and `cli/` dispatched at loop iteration 117 — all 8 genuine findings from that sweep are now fixed (iterations 117-123).

---

## [2026.7.188] - 2026-07-09

### Fixed

Loop iteration 122 — fixes the third `cli/` fresh-sweep finding: `verified triage` never converted a reported partial failure into a nonzero exit code.

- **`cli/verified.ts`'s `verified triage` action prints `"...failed ${result.counts.failed}"` in its summary line, but never set `process.exitCode` based on it.** `result.counts.failed` counts items that landed in the `"failed-review"` bucket (e.g. a verified-fact row whose underlying fact was deleted/orphaned) — a genuine partial failure. Every sibling command in this codebase that reports a `failed`/`.failed > 0` count (`cli/goals.ts`, `cli/active-tasks.ts`, `cli/cmd-doctor.ts`, `register-credentials-scope.ts`) sets `process.exitCode = 1` when it's nonzero; `verified triage` was the one outlier that reported the failure count in its own printed summary but never propagated it to the exit code, so cron/CI automation checking the exit code would treat a partial failure as success.
- Fixed by adding `if (result.counts.failed > 0) process.exitCode = 1;` after the result is printed (for both the JSON and human-readable output branches), matching the established convention.

Regression test added (new `tests/verified-cli.test.ts`, using the same lightweight fake `Chainable` action-capture harness as `tests/task-queue-status.test.ts`): seeds a verified, due-for-reverification fact whose underlying `facts` row is then deleted (the same fixture `tests/verified-fact-triage.test.ts` already uses to force a `"failed-review"` classification), runs `triage`, and asserts `process.exitCode` becomes `1`; a companion test confirms it stays `undefined` when nothing fails. Verified via `git stash` to fail without the fix — the pre-fix code printed "failed 1" but left `process.exitCode` as `undefined`. tsc clean; biome clean (zero new findings on `cli/verified.ts`, verified against its pre-existing baseline; the new test file's own findings — a long-line format issue and the same `noNonNullAssertion` pattern used throughout this test-file family — were fixed/are consistent with established convention). Related suites (verified-cli, verified-fact-triage): 29 passed, no regressions.

1 more `cli/` sweep finding remains queued: `register-lifecycle.ts`'s `expire-by-source --decay-class` accepts any free-form string with no validation against the `DECAY_CLASSES` enum.

---

## [2026.7.187] - 2026-07-09

### Fixed

Loop iteration 121 — fixes the second `cli/` fresh-sweep finding: `sensor-sweep --tier` silently accepted any invalid value as tier 1.

- **`register-sensor-sweep.ts` parsed `--tier` with `tierRaw === "all" ? "all" : tierRaw === "2" ? 2 : 1`, with no validation.** The option's own description reads "Tier to run: 1, 2, or all," but any other value (`--tier 3`, `--tier bogus`, a typo) silently fell through to tier 1 instead of erroring — `sensor-sweep --tier bogus` ran (and reported success for) tier-1 sensors with no indication the operator's `--tier` value was invalid.
- Fixed by validating `tierRaw` against the exact allow-list (`"all" | "1" | "2"`) before dispatch and throwing a descriptive error otherwise — `withExit` (already wrapping this action) converts the thrown error into `process.exitCode = 1` plus a logged error message, matching this codebase's established validation-failure pattern for `withExit`-wrapped commands.

Regression test added (`tests/register-sensor-sweep-verbose.test.ts`, reusing its existing real-`Command`/`parseAsync` harness): runs `sensor-sweep --tier bogus` and asserts `process.exit` was called with `1` and the error output contains "--tier must be one of." Verified via `git stash` to fail without the fix — the pre-fix code ran to completion and reported `sensor-sweep tier=1: ... semantic=success`, calling `process.exit(0)`. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline — the one flagged import-order finding predates this change). Related suites (register-sensor-sweep-verbose, sensor-sweep, sensor-sweep-github-progress): 44 passed, no regressions.

2 more `cli/` sweep findings remain queued: `verified.ts triage`'s missing exit code on partial failures, and `register-lifecycle.ts`'s unvalidated `--decay-class`.

**Full-suite checkpoint (every 10 iterations, per agreement):** the complete `npx vitest run` suite kicked off at iteration 119 has now completed — 642 passed, 3 failed, 4 skipped (649 files) / 9014 passed, 3 failed, 23 skipped (9040 tests). All 3 failures are the same known pre-existing, unrelated failures already documented in earlier iterations (`crystallization-proposer.test.ts`, `implicit-feedback-routing.test.ts`, `memory-recall-timeline.test.ts`) — confirmed by exact test-name match, none touch any file changed in iterations 111-121. Next full-suite checkpoint due at iteration 129.

---

## [2026.7.186] - 2026-07-09

### Fixed

Loop iteration 120 — fixes the first of 4 `cli/` fresh-sweep findings: `task-queue-touch --repair` reported a clear failure to stderr but always exited 0.

- **`cli/task-queue-status.ts`'s `task-queue-touch --repair` action printed `"✗ current.json is malformed..."` to stderr and returned when `current.json` failed to parse as JSON, but never set `process.exitCode`.** The action isn't wrapped in any exit-code-propagating helper, and Node defaults to exit code 0, so `openclaw hybrid-mem task-queue-touch --repair` run against a corrupted `current.json` from cron/automation reports success (exit 0) despite the visible failure message — inconsistent with every other reachable-failure path in this codebase's CLI commands, which set `process.exitCode = 1` before returning.
- Fixed by adding `process.exitCode = 1;` before the early return.

Regression test added (new `tests/task-queue-status.test.ts`, using a lightweight fake `Chainable` command-registration harness to capture the `task-queue-touch` action callback without needing a real Commander program): asserts `process.exitCode` becomes `1` when `current.json` is malformed, and stays `undefined` for the valid-JSON path. Verified via `git stash` to fail without the fix — the pre-fix code left `process.exitCode` as `undefined`. tsc clean; biome clean (zero new findings on `cli/task-queue-status.ts`, verified against its pre-existing baseline; the new test file's own import-order finding was fixed directly since it's new code, leaving only the same `noNonNullAssertion` warning pattern already used throughout `tests/fact-mutation-gateway.test.ts`). Related suites (task-queue-status, task-queue-watchdog): 42 passed, no regressions.

3 more `cli/` sweep findings remain queued: `register-sensor-sweep.ts`'s unvalidated `--tier`, `verified.ts triage`'s missing exit code on partial failures, and `register-lifecycle.ts`'s unvalidated `--decay-class`.

**Full-suite checkpoint**: the background `npx vitest run` kicked off at iteration 119 is still running as of this entry; results will be reported once it completes.

---

## [2026.7.185] - 2026-07-09

### Fixed

Loop iteration 119 — fixes the remaining `services/` fresh-sweep finding: `maintenance-log-analyzer.ts`'s persisted occurrence count always reported 1 regardless of true history.

- **`loadPersistedMaintenanceFindingLedger`'s SQL aggregated `MAX(occurrence_count) AS occurrence_count` per fingerprint, but every row `persistMaintenanceFindings` ever writes stores `occurrence_count = f.occurrenceCount ?? 1`.** The only caller (`register-analyze-maintenance-logs.ts`) always persists the *raw*, never-summarized findings array — the correctly-aggregated `summarized.findings` (which does compute a real running `occurrenceCount`) is only used for the report/digest, never passed to `persistMaintenanceFindings`. So every persisted row's `occurrence_count` column is always `1`, and `MAX()` over an all-1s column always yields `1` — a recurring failure with the same fingerprint occurring daily for 30 days produces 30 distinct rows, but the digest reports "Seen 2 times" (1 from the always-1 `MAX` plus 1 from that day's new occurrence) instead of "Seen 31 times," severely understating the chronicity of a long-running recurring failure.
- Fixed by aggregating `COUNT(*) AS occurrence_count` instead — the number of persisted rows for a fingerprint, matching how `MIN`/`MAX(occurred_at)` already correctly aggregate over the same row-set in the same query. The per-row `occurrence_count` column and its `?? 1` write-side default are untouched (a correctly-accurate per-row value); the bug was purely in the read-side aggregation choice.

Regression test added (`tests/maintenance-log-analyzer.test.ts`): persists 3 separate rows for the same fingerprint (simulating 3 daily cron runs), then summarizes 1 new occurrence, and asserts the resulting `occurrenceCount` is `4` (3 historical + 1 new). The existing sibling test ("collapses repeated fingerprints...", asserting `occurrenceCount === 3` with only 1 historical row) continues to pass unchanged — `MAX()` and `COUNT(*)` are indistinguishable in the single-row case, which is exactly why that test didn't catch this bug. Verified via `git stash` to fail without the fix — the pre-fix code returned `2` instead of `4`. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline). Related suites (maintenance-log-analyzer, maintenance-log-parse): 55 passed, no regressions.

This closes out both `services/` fresh-sweep findings from loop iteration 117 (the other was iteration 118's `task-queue-leases.ts` fix). 4 findings from the `cli/` sweep remain queued: missing exit codes on `task-queue-touch --repair`/`verified triage`, and unvalidated `--tier`/`--decay-class` CLI options.

**Full-suite checkpoint (every 10 iterations, per agreement):** ran the complete `npx vitest run` suite at this iteration to catch anything the targeted per-iteration runs might have missed across 8 iterations of changes (111-119) — see commit for the result.

---

## [2026.7.184] - 2026-07-09

### Fixed

Loop iteration 118 — fixes a permanently-stuck-lease bug from the `services/` fresh-sweep findings: `task-queue-leases.ts`'s `transitionDispatchLease` cleared a running lease's TTL instead of refreshing it.

- **`transitionDispatchLease(..., toState: "running")` set `lease.expiresAt = undefined`, with a comment reading "Refresh expiry while work is active" — but clearing it does the opposite of refreshing it.** `expireActiveLeases()` (the sweep that reclaims stuck leases) skips any active-state lease whose `expiresAt` doesn't parse to a finite number, and `blocksAcquire()` unconditionally blocks re-acquisition for any active state with no other time-based fallback. A worker that transitions a lease to `"running"` and then crashes or is killed before reaching a terminal state (`completed`/`failed`/`lease-expired`) leaves that issue permanently un-dispatchable — the lease can never be TTL-reclaimed, requiring manual intervention.
- Fixed by setting `expiresAt` to `now + DEFAULT_LEASE_TTL_MS` (the same 30-minute default used for the initial `leased` state) instead of `undefined`, matching the code's own stated intent and restoring `expireActiveLeases()`'s ability to reclaim a stuck `running` lease.

Regression test added (`tests/task-queue-leases.test.ts`): acquires a lease with a short (1s) TTL, transitions it to `running`, confirms it survives an expiry sweep run well past that original short TTL (proving the running-state refresh actually took effect), then confirms a sweep run past the refreshed 30-minute window does reclaim it (proving it isn't simply stuck forever). Verified via `git stash` to fail without the fix — the pre-fix code left the lease in `running` state indefinitely; the final assertion (`expiredCount === 1`) received `0` even 31 minutes after the running transition. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline — the one flagged import-order finding predates this change). Related suites (task-queue-leases, task-queue-watchdog, task-queue-leases-stale-lock-race): 48 passed, no regressions.

Found via a fresh flat (non-recursive) sweep of `services/` (loop iteration 117); one more genuine finding from that sweep (`maintenance-log-analyzer.ts`'s `occurrence_count` aggregation always returning 1 instead of the true historical count) and 4 findings from the `cli/` sweep (missing exit codes, unvalidated CLI options) remain queued for upcoming iterations.

---

## [2026.7.183] - 2026-07-09

### Fixed

Loop iteration 117 — with the loop-iteration-103 backlog closed, dispatched a fresh flat (non-recursive) multi-agent sweep across `services/`, `tools/`, and `cli/`. The `tools/` sweep surfaced two genuine, verified bugs; fixed both this iteration.

- **`tools/fact-mutation-gateway.ts`'s `hybrid-mem.facts.list` RPC method only clamped `limit` on the upper end (`Math.min(params.limit, 100)`), never the lower.** A caller passing a negative `limit` (e.g. `-1`) bypassed the intended 20-default/100-max pagination cap two different ways: `factsDb.lookup`'s underlying `lookupFacts` treats any non-positive limit as `null`, dropping its SQL `LIMIT` clause entirely (unbounded — every matching row for that entity); the no-query/no-entity branch's `getAll().slice(0, limit)` with a negative `limit` returns "all rows except the last N," i.e. nearly the caller's entire in-scope fact corpus in one response. Exposed to any Gateway RPC client (memory-wiki, Workboard, CLI, WebUI) — a resource-exhaustion/oversized-payload bug, not a scope leak (the scope filter itself is unaffected).
- **`tools/graph-tools.ts`'s `memory_link` tool never checked `sourceFact !== targetFact`.** Both endpoints are independently validated to exist and be in-scope, but a call linking a fact to itself (e.g. `{ sourceFact: "f1", targetFact: "f1", linkType: "CONTRADICTS" }`) passed both checks and reached `factsDb.recordContradiction("f1", "f1")`, which inserts a self-referential `CONTRADICTS` edge into `memory_links` (no DB constraint prevents it) and docks the fact's own confidence by 0.2 for "contradicting itself" — a one-shot but real data-corruption bug (confidence decay plus a spurious self-loop edge visible in `memory_graph`/graph exports). The tool's own success message was also visibly nonsensical (`from "X" to "X"`).
- Fixed by clamping `limit` to `[1, 100]` (`Math.min(Math.max(Math.floor(rawLimit), 1), 100)`, defaulting to 20 for non-finite/non-number input) and by adding an explicit `sourceFact === targetFact` rejection (`error: "self_link"`) before dispatching to either the `CONTRADICTS` or generic-link path.

Regression tests added: `tests/fact-mutation-gateway.test.ts` asserts a negative `limit` is clamped into `[1, 100]` before reaching `factsDb.search`/`lookup`/`getAll` (plus a companion test confirming the existing overflow-clamp-to-100 behavior is unchanged); `tests/graph-tools-scope-security.test.ts` asserts `memory_link` with identical `sourceFact`/`targetFact` returns `error: "self_link"` and never calls `recordContradiction`/`createLink`. Verified via `git stash` to fail without the fix — the negative limit reached `factsDb.search` as `-1` verbatim, and the self-link call reached neither guard (`result.details.error` was `undefined`, meaning it fell through to `recordContradiction`). tsc clean; biome clean (zero new *categories* of findings on any of the 4 changed files, verified against each file's pre-existing baseline — the 2 additional warnings on the test file are more instances of the same `handlers.get(...)!` non-null-assertion pattern already used by every other test in that file, not a new issue). Related suites (fact-mutation-gateway, graph-tools-scope-security, edge-types, issue-tools-scope-security, plugin-e2e, project-state-lww): 106 passed, no regressions.

The `cli/` sweep found 4 more candidates (missing exit codes on `task-queue-touch --repair`/`verified triage`, unvalidated `--tier`/`--decay-class` CLI options) — queued for the next iterations. The `services/` sweep is still running as of this entry.

---

## [2026.7.182] - 2026-07-09

### Fixed

Loop iteration 116 — fixes `backends/credentials-db.ts`'s lazy vault-migration race, the last item from the "Deferred (fresh sweep, loop iteration 103)" backlog.

- **`CredentialsDB.store()`/`.storeIfNew()` always encrypted with `this.key` — the in-memory key derived when *this instance* was constructed — with no check for whether another process had since migrated the on-disk vault from v1 (legacy SHA-256) to v2 (scrypt).** `migrateLegacyVault()` (triggered lazily by any `get()`) generates a fresh salt, re-derives a v2 key, re-encrypts every row, and rewrites `vault_meta` — all in the process that called `get()`. A second process (e.g. the gateway and a concurrent CLI invocation, or two CLI commands racing) that opened the same vault before the migration keeps its stale v1 key in memory; its next `store()` encrypts with that stale key while `vault_meta.kdf_version` on disk already says v2. Every future read (by any process, including its own) derives the v2 key from the new salt and fails to decrypt that credential — permanent, silent data loss for that one row (AES-GCM's auth-tag check throws rather than returning garbage, so the failure is a hard "Unsupported state or unable to authenticate data" error, not a wrong value).
- Fixed by adding `maybeAdoptExternalVaultMigration()`, called at the top of `store()`/`storeIfNew()`: when this instance's in-memory state is still v1 but the *on-disk* `vault_meta.kdf_version` already reads v2, re-derive the v2 key from the disk salt (using the retained raw password, exactly as `migrateLegacyVault()` itself does) and adopt it before encrypting — instead of blindly trusting stale in-memory state.

Regression test added (`tests/credentials-db.test.ts`): hand-crafts a legacy v1 vault on disk (one credential encrypted with the v1 key derivation, no `vault_meta` rows), opens two independent `CredentialsDB` instances against it (simulating two processes), triggers the lazy migration via the first instance's `get()`, then calls `store()` on the *second* (still-v1-in-memory) instance and confirms a fresh third instance can still decrypt the newly-stored credential. Verified via `git stash` to fail without the fix — the pre-fix code threw `Unsupported state or unable to authenticate data` when the fresh instance tried to decrypt the row written with the stale key. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline). Related suites (credentials-db, credential-migration, credential-type-migration, credential-validation, credentials-auto-capture, credentials-encryption-key, verify-credentials-vault-partial-corruption): 161 passed, no regressions.

This closes out the entire "Deferred (fresh sweep, loop iteration 103)" backlog. What remains open is exclusively design-decision-gated: `backends/facts-db/clusters.ts`/`services/goal-registry.ts`/`services/workboard-facts-sync.ts`/`backends/facts-db/entity-layer.ts` all need a scope/schema decision before any fix, not a surgical patch.

---

## [2026.7.181] - 2026-07-09

### Fixed

Loop iteration 115 — fixes `backends/wal.ts`'s missing rewrite-lock coordination on the write path, from the "Deferred (fresh sweep, loop iteration 103)" backlog.

- **`WriteAheadLog.write()`/`.remove()` appended directly to the WAL file with no awareness of `compactIfOversized()`/`pruneStale()`'s cross-process rewrite lock.** Those two methods already coordinate with *each other* across processes via an exclusive `.rewrite.lock` file around their read-snapshot → atomic-replace window (rename over the WAL path) — but `write()`/`remove()` never checked it. A concurrent plain `write()`/`remove()` call from a different process (or the CLI racing the gateway's own scheduled compact/prune) landing in that window appended to the pre-rename file; the rewrite's subsequent `rename()` then silently discarded that append, the same class of corruption the rewrite lock exists to prevent (#80), just for the two code paths left out of it.
- Fixed by having `write()`/`remove()` wait (bounded, ~1s max, polling every 20ms) for a live rewrite lock to clear before appending. Deliberately fail-open on timeout — a write must never hang indefinitely on a lock file, and this narrows the race window from "unprotected" to "only if a rewrite outlives ~1s," a large reduction given rewrites are small read-then-rename operations.

Regression tests added (`tests/wal.test.ts`): one test holds a fresh rewrite-lock file, starts a `write()`, confirms the entry is *not* on disk after a short delay while the lock is held, then clears the lock and confirms the write completes; an analogous test for `remove()`; a third confirms the bounded wait times out and proceeds (with a warning) rather than hanging forever. Verified via `git stash` — all three failed against the pre-fix code (the entry/removal always landed immediately regardless of the lock, and the timeout warning was never logged since there was nothing to wait for). tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline). Related suites (wal, wal-helpers, wal-replay, wal-scope-payload, facts-db): 305 passed, no regressions.

This item, along with `backends/facts-db/entity-layer.ts`'s contact same-priority-tier overwrite (investigated this iteration — genuinely needs a `contacts` table scope/tenant column, the same schema-migration class of fix as `clusters.ts`/`goal-registry.ts`, not a safe single-iteration patch: naively tightening the priority comparison would freeze legitimate same-tenant corrections instead of fixing the cross-tenant leak) and `backends/credentials-db.ts`'s vault migration race, was the last of the loop iteration 103 backlog's concurrency/robustness items. Remaining backlog: the 3 scope/schema design-decision items (`clusters.ts`, `goal-registry.ts`, `workboard-facts-sync.ts`) and `entity-layer.ts`'s contact scope column (moved into that same design-decision bucket) and `credentials-db.ts`'s vault migration race.

---

## [2026.7.180] - 2026-07-09

### Fixed

Loop iteration 114 — fixes the last remaining "not yet attempted" item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `install-index-reconcile.ts`'s redundant npm-project tree removal could irreversibly delete the wrong copy when its version couldn't be read.

- **`removeRedundantNpmProjectTreeWhenExtensionsCanonical`'s "never delete a newer install" guard was `if (npmVer && compareVersions(npmVer, extVer) > 0)`.** When `readPluginPackageVersion(npmPluginDir)` returned `undefined` (missing or corrupted `package.json` under the npm-project tree), the falsy `npmVer` short-circuited the `&&` and skipped the comparison entirely, falling through to the unconditional, unrecoverable removal a few lines below (rename-then-`rmSync`, with no real backup — "atomic-then-cleanup" is about not leaving the gateway with a duplicate mid-operation, not about recoverability). An unreadable version is exactly the case the guard's own doc comment says must be treated as unsafe ("never delete a newer install — the host may be mid-upgrade"): we can't prove it's *not* newer, so silently proceeding is wrong.
- Fixed by returning early with a new `skippedReason: "npm-project-version-unreadable"` when the npm-project version can't be read, instead of falling through to the comparison.

Regression test added (`tests/run-upgrade.test.ts`): sets up a redundant npm-project tree whose plugin dir has no `package.json` at all, and asserts `removeRedundantNpmProjectTreeWhenExtensionsCanonical` returns `attempted: false` / `skippedReason: "npm-project-version-unreadable"` and leaves the tree on disk untouched. Verified via `git stash` to fail without the fix — the pre-fix code returned `attempted: true` and deleted the tree. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline). Related suites (run-upgrade, install-index-reconcile, install-defaults, run-install-atomic-write, cmd-verify-orphans, cmd-verify-fact-count): 46 passed, no regressions.

This closes out the entire "Deferred (fresh sweep, loop iteration 103)" backlog's surgical-fix items — the 3 remaining entries (`backends/facts-db/clusters.ts` scope-storage migration, `services/goal-registry.ts` scope concept, `services/workboard-facts-sync.ts` design ambiguity) all explicitly need a larger design/schema decision, not a single-iteration patch, and stay deferred. The `backends/facts-db/entity-layer.ts` contact-overwrite item, `backends/credentials-db.ts`'s vault migration race, and `backends/wal.ts`'s missing rewrite lock also remain open.

---

## [2026.7.179] - 2026-07-09

### Fixed

Loop iteration 113 — fixes another item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `hybrid-mem verify --reconcile --fix` unconditionally reported the SQLite-orphan branch as a failure even when every orphan was successfully rebuilt, and the rebuild itself never kept SQLite's canonical embedding bookkeeping in sync with LanceDB.

- **`cli/verify/sections/reconcile.ts`'s SQLite-orphan branch pushed `state.issues.push(...)` and set `state.allOk = false` unconditionally whenever `sqliteOrphans.length > 0`, regardless of whether the preceding `--fix` rebuild loop actually rebuilt every one of them.** Unlike the sibling vector-orphan branch a few lines above (which re-verifies after a delete attempt and only reports failure if orphans are confirmed to remain), the SQLite-orphan branch had no equivalent "did the fix actually work" check — a fully successful `--fix` run (every orphan rebuilt, budget covered them all, zero failures) was still reported as an unresolved issue.
- **Separately, the rebuild loop called `vectorDb.store(...)` directly and never wrote the corresponding row into SQLite's `fact_embeddings` canonical table (via `factsDb.setEmbeddingModel`/`storeEmbedding`)**, unlike every other vector-write path in this codebase (`tools/memory/helpers.ts`, `utils/fact-embeddings.ts`, `utils/wal-replay.ts`), all of which route through the already-shared `storeCanonicalVectorForFact` helper in `services/vector-maintenance.ts` specifically to keep `fact_embeddings` aligned with LanceDB. This meant that even after fixing the first bug, a "fully rebuilt" run would immediately trip the unrelated Storage-sync section's embedding-drift check (`canonicalEmbeddings` under-counting relative to `lanceRows`) in the same `verify` run — a second, compounding false-failure surfaced only after fixing the first.
- Fixed both: (1) track whether the rebuild loop fully covered every SQLite orphan with zero failures, and only push the issue / set `allOk = false` when it didn't (otherwise report it as a verified fix, matching the vector-orphan branch's pattern); (2) switched the rebuild loop to call `storeCanonicalVectorForFact` instead of a bare `vectorDb.store`, so a successful rebuild keeps `fact_embeddings` in sync like every other vector-write path already does.

Regression tests added (`tests/cmd-verify-orphans.test.ts`): seeds 3 SQLite-only facts and runs `verify --reconcile --fix`, asserting the log shows "Verified rebuild: 3/3..." and contains neither the old unconditional-failure issue text nor a fresh "Embedding drift:" report; a second test seeds 10 facts with a `--reconcile-max-fixes 3` budget (a genuine partial rebuild) and asserts the "Skipped 7..." line is present with no "Verified rebuild:" success claim. Verified via `git stash` to fail without the fix — the pre-fix code omitted the "Verified rebuild" line and additionally reported "❌ Embedding drift: canonicalEmbeddings=0 vs lanceRows=3" in the same run. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline — both flagged import-order findings predate this change). Related suites (cmd-verify-orphans, reconcile, storage-sync-diagnostics, register-storage-maintenance-artifacts, vector-maintenance): 40 passed, no regressions.

---

## [2026.7.178] - 2026-07-09

### Fixed

Loop iteration 112 — fixes another item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `cli/cmd-selfcorrection.ts`'s `MEMORY_STORE` remediation path re-used stale pre-merge text/vector when `storeWithResult` merged onto an existing fact.

- **The `MEMORY_STORE` remediation handler embedded its candidate `text` before calling `factsDb.storeWithResult`, then stored that pre-merge `text`/`vector` pair to the vector backend regardless of outcome.** When `storeWithResult` merges the new text onto an existing fact (`newlyStored: false`, `embeddingStale: true`), `entry.text` becomes the full merged content — but the skip check (`if (storeResult.newlyStored === false && !storeResult.embeddingStale) continue;`) only bails on the pure-dedupe case, letting the merge case fall through to `vectorDb.store()` with the stale pre-merge fragment and its already-computed vector. This desynced the vector backend from the fact row's real persisted text — the identical bug class already fixed in the sibling `cli/cmd-distill.ts` and `cli/cmd-extract-reinforcement.ts` (commit `9074af9`, iteration 62) but missed in this third file.
- Fixed identically: detect the merge case (`storeResult.newlyStored === false && storeResult.embeddingStale === true`) and re-embed from `entry.text` before storing, instead of reusing the pre-merge `text`/`vector`.

Regression test added (new `tests/cmd-selfcorrection-memory-store-merge-reembed.test.ts`, mirroring `tests/cmd-extract-reinforcement-batch.test.ts`'s iteration-62 regression test): seeds a `fuzzyDedupe` + `onDuplicate: "merge"` profile for the `"self-correction"` source, stores one `MEMORY_STORE` remediation, then a case-insensitive duplicate that merges onto it, and asserts the vector backend was called with the merged `entry.text` (not the second call's pre-merge fragment) and that `embeddings.embed` was called with the merged text. Verified via `git stash` to fail without the fix — the pre-fix code stored the pre-merge fragment's text/vector to the vector backend instead of the merged content. tsc clean; biome clean (zero new findings on `cmd-selfcorrection.ts`, verified against its pre-existing baseline; the new test file's only findings are the same `as any` mock-cast style warnings already present in its sibling `cmd-selfcorrection-memory-store-object-remediation.test.ts`). Related suites (cmd-selfcorrection-memory-store-object-remediation, self-correction-m3-hardening-1876, cmd-selfcorrection-json-parse, reinforcement-analysis, cmd-extract-reinforcement-batch, cmd-distill): 131 passed, no regressions (one unrelated pre-existing failure in `implicit-feedback-routing.test.ts`, confirmed unaffected by this change).

---

## [2026.7.177] - 2026-07-09

### Fixed

Loop iteration 111 — fixes another item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `lifecycle/stage-recall.ts`'s FTS/hot degraded-recall timeout fallback had no rejection handler.

- **`stage-recall.ts`'s `runRecallStage` raced the primary recall pipeline against a stage wall-clock timeout; on timeout, it called `buildDegradedFtsHotRecallStage(...).then((degraded) => { if (!recallSettled) resolve(degraded); })` with only a fulfillment handler.** `buildDegradedFtsHotRecallStage` has several unguarded call sites in its own body (`sessionState.resolveSessionKey`, `ctx.auditStore?.append`, `assembleRecallPrependContext`, among others) — if any of them threw, the returned promise rejected, nothing ever called `resolve(...)` or `reject(...)` on the `Promise.race`'s timeout branch, and — since the primary pipeline promise was itself the reason the timeout fired in the first place (i.e. also stuck) — `before_agent_start` could hang indefinitely instead of degrading gracefully. The identical bug shape was already fixed in the sibling `stage-injection.ts` (iteration 92) but missed here.
- Fixed by adding a rejection handler alongside the existing fulfillment handler: on rejection, reports the error via `capturePluginError` (`operation: "recall-timeout-fallback"`, `subsystem: "stage-recall"`) and resolves with a safe `{ kind: "empty", prependContext: undefined }` fallback instead of leaving the stage hanging — mirroring the established two-argument `.then(onFulfilled, onRejected)` pattern from the iteration 92 fix.

Regression test added (`tests/lifecycle-stage-recall.test.ts`): forces the stage wall-clock timeout to fire (fake timers, primary pipeline hung on the abort signal) with `ctx.auditStore.append` mocked to throw, and asserts `runRecallStage` still resolves with the empty fallback (instead of hanging/rejecting) and that `capturePluginError` was called with the expected `operation` tag. Verified via `git stash` to fail without the fix — the pre-fix code left the returned promise unsettled, surfacing as an unhandled rejection instead of a resolved fallback. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline — the two pre-existing import-order/line-length findings in `stage-recall.ts` and the test file predate this change). Related suites (lifecycle-stage-recall, lifecycle-stage-injection, and all other `tests/lifecycle-*` files): 51 passed, no regressions.

### Deferred (fresh sweep, loop iteration 103 backlog — CLOSED as of v2026.7.182; all remaining items below are design-decision-gated, not surgical patches)

- `backends/facts-db/clusters.ts`'s `saveClusters`/`getClusters`/`getClusterMembers` operate on the `clusters`/`cluster_members` tables, which have no `scope`/`scope_target` columns at all — the *storage* layer is still fully shared across tenants (any tenant's `memory_clusters` call with the default `save: true` still wipes and rebuilds the whole shared table, just now with only its own scoped facts as candidates). Needs a schema migration to add scope columns and thread scope through the storage functions, not a single-iteration surgical patch.
- `services/goal-registry.ts` (`readGoal`/`listGoals`/`updateGoal`/`terminateGoal`) has no scope concept at all — the `Goal` type carries no owner/tenant field, so `goal_list`/`goal_get`/`goal_complete`/`goal_abandon` in `tools/goal-tools.ts` operate across every tenant sharing a plugin instance. Larger fix than a single-iteration surgical patch (needs a scope field added to the Goal schema and threaded through every registry function and caller), so still deferred.
- `services/workboard-facts-sync.ts`'s `applyWorkboardTaskStatusUpdate` and `setup/workboard-integration.ts:143`'s `loadTasks` both call `loadTaskLedgerFromFacts(factsDb)` with no scope filter. **Design ambiguity, not a confirmed bug**: `WorkboardConfig` has no tenant/scope field anywhere (single `gatewayUrl` per plugin instance), suggesting Workboard sync may be an intentionally shared, board-wide visibility feature (like a team kanban board) rather than a per-tenant private surface. Needs a design decision (is Workboard meant to be shared or per-tenant?) before a fix direction can be chosen.
- `backends/facts-db/entity-layer.ts`'s `applyContactProfileFields` allows same-priority-tier (`>=`) overwrite of a globally-shared contact's email/phone/role with no per-tenant attribution, reachable via any `memory_store` call that mentions an existing contact's name (NER-driven, default-on). **Investigated (iteration 115): needs a `scope`/`scope_target` column on the `contacts` table** (same schema-migration class as `clusters.ts` above) so same-priority overwrites can be scoped to the writer's own tenant instead of either leaking cross-tenant (current `>=`) or freezing legitimate same-tenant corrections after the first write (a naive `>` fix). Not a single-iteration surgical patch.

---

## [2026.7.176] - 2026-07-09

### Fixed

Loop iteration 110 — fixes the top item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `hybrid-mem store`'s duplicate pre-check ran as if every store was global-scoped.

- **`cli/cmd-store.ts`'s `runStoreForCli` called `factsDb.hasDuplicate(text, "cli", {category, entity, key, value})` with no `scope`/`scopeTarget` args, computed several lines *before* `scope`/`scopeTarget` were resolved.** `hasDuplicateText` → `applyDedupe` (`services/dedupe-policy.ts`) treats an omitted scope as `"global"`, so the pre-check always probed as if the store were global-scoped regardless of the caller's actual `--scope`/`--scope-target`. This cuts both ways: (1) a scoped store (`--scope agent --scope-target X`) with the same text as an unrelated *global* fact was wrongly rejected as `{outcome: "duplicate"}`; (2) a scoped store that duplicated an *earlier scoped* store of its own was **not** caught by this fast pre-check at all (since it only ever checked global-scoped rows), silently falling through to `factsDb.storeWithResult`'s own separate, already-scope-aware dedupe safety net later in the same call — wasted embedding/classification work before the duplicate was finally caught by a different code path. The identical bug (case 1) was already fixed in the sibling `tools/memory/register-store-tools.ts` MCP path (commit `a471c545`); `cmd-store.ts` predates that fix and was never updated to match.
- Fixed by moving the `scope`/`scopeTarget` resolution above the duplicate pre-check and passing both through to `hasDuplicate`, matching the sibling MCP path's fix.

Regression tests added (new `tests/cmd-store-scope-duplicate-check.test.ts`, using the same minimal `HandlerContext` mock pattern as `tests/cli-store-rollback.test.ts`): confirms a scoped store with the same text as an unrelated global fact now succeeds (`stored`, not `duplicate`) and creates a genuinely separate fact tagged with the caller's scope; confirms a true same-scope duplicate is still rejected. Verified via `git stash` to fail without the fix — the first test failed with `duplicate` instead of `stored` (case 1 above), and the second failed with `noop`/`reason: "dedupe"` instead of the expected fast-path `duplicate` (case 2 above, confirming the pre-check missed a genuine same-scope duplicate and it was only caught by the later, separate dedupe path). tsc clean; biome clean (zero new findings on `cmd-store.ts`, verified against its pre-existing baseline; the new test file's only finding is the same `as any` mock-cast style warning already present in its sibling `cli-store-rollback.test.ts`). Related suites (cli-store-rollback, memory-store-merge-dedupe-vector): 16 passed, no regressions.

---

## [2026.7.175] - 2026-07-09

### Fixed

Loop iteration 109 (self-caught regression, not from the deferred backlog): the iteration 106 `detectClusters` scope-isolation fix broke `ClusterCache`'s test mock's assumed contract, caught by a full-suite background baseline run kicked off after starting the fresh QA branch.

- **`services/retrieval-orchestrator.ts`'s `ClusterCache.getClusterMap` calls `detectClusters(factsDb, { minClusterSize })` with `scopeFilter` omitted, and iteration 106 changed `detectClusters` to require `getById(id, { scopeFilter })` to return a real entry before a linked fact can enter any cluster** (previously `getById`'s result was only used for cluster *label* generation, never for membership). `tests/retrieval-orchestrator.test.ts`'s `fakeFactsDb` test helper's `getById` unconditionally returned `null` — a valid simplification under the old contract, since cluster membership never depended on it — but under the new contract this filtered every linked fact out of every cluster, breaking `ClusterCache`'s own regression tests (`does not leak cluster assignments between different FactsDB instances`, `invalidate() clears cached clusters for all instances`). Reproduced deterministically running the file in isolation, not a suite-order flake.
- No behavior change in production `ClusterCache` — a real `FactsDB.getById(id, { scopeFilter: undefined })` already returns the entry unconditionally when no scope filter is applied (confirmed in `backends/facts-db/fact-read-queries.ts`'s `applyLookupFilters`), so this was a test-fixture-only gap. Fixed `fakeFactsDb` to return a minimal, realistic `MemoryEntry` for known fact IDs (matching how the real `FactsDB.getById` behaves), instead of reverting the iteration 106 fix.

Verified via `git stash` that both `ClusterCache` tests fail against the pre-fix mock exactly as observed in the full-suite run. tsc clean; biome clean (zero new findings, verified against the file's pre-existing baseline). Related suites (topic-clusters, retrieval-modes, constrained-recall, context-engine, multi-model-retrieval): 96 passed, no regressions.

**Process note:** caught by kicking off a full background `vitest run` immediately after establishing the fresh `claude/memory-hybrid-scope-security-qa` branch, rather than waiting for the usual 10-iteration cadence — appropriate here since the branch's own history (and thus the "last known full-suite baseline") had just been reset, and iteration 108's own git-stash operations transiently contaminated part of that run's output (the `storage-stats-helpers-scope-filter.test.ts` failures in that run are a stash-timing artifact, not real; already re-verified clean in isolation in the v2026.7.174 entry above).

---

## [2026.7.174] - 2026-07-09

### Fixed

Loop iteration 108 — fixes the top item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `hybrid-mem search --scope user|agent|session` silently ignored scope when `--scope-target` was omitted.

- **`cli/commands/manage/storage-stats-helpers.ts`'s `buildHybridSearchScopeFilter` built `{ userId: null }`/`{ agentId: null }`/`{ sessionId: null }` when `--scope user|agent|session` was passed without `--scope-target`.** `scopeFilterClausePositional`/`filterByScope` treat a filter with all of `userId`/`agentId`/`sessionId` falsy as "no restriction" (matches every scope) — the same trap `globalOnlyScopeFilter()` was introduced to close for `--scope global` (iteration 95), but never patched for the `user`/`agent`/`session` case. `hybrid-mem search "foo" --scope user` (forgetting `--scope-target`, an easy operator mistake since it's a separate flag) silently returned matches from every user/agent/session instead of erroring or restricting to nothing.
- Fixed by extracting the validation `register-credentials-scope.ts`'s `prune` command already applies for this exact input shape (reject non-global scope with no scope-target; reject scope-target alongside global) into a new, directly-testable `validateSearchScopeOption()` helper, and wiring `register-storage-entities-decay.ts`'s `search` command to call it before `buildHybridSearchScopeFilter`, exiting with a clear error and non-zero exit code on an invalid combination — matching the sibling command's established pattern instead of leaving `search` as the one outlier with no guard.

Regression tests added (`tests/storage-stats-helpers-scope-filter.test.ts`): unit tests cover every valid/invalid `(scope, scopeTarget)` combination for `validateSearchScopeOption`; an end-to-end test seeds two different users' private facts and demonstrates that `buildHybridSearchScopeFilter("user", undefined)` alone (bypassing the new guard) would return both — proving why the guard has to run first, and asserting it correctly flags this exact input as invalid. Verified via `git stash` to fail without the fix — all 7 new/changed tests failed with `validateSearchScopeOption is not a function` against the pre-fix code. tsc clean; biome clean (zero new findings across all 3 changed files, verified against each file's pre-existing baseline — the 6 pre-existing unused-variable warnings in `register-storage-entities-decay.ts` predate this change). Related suites (storage-stats-helpers-scope-filter): 15 passed, no regressions.

---

## [2026.7.173] - 2026-07-09

### Fixed

Loop iteration 107 (continuing the ongoing QA sweep on a fresh branch, `claude/memory-hybrid-scope-security-qa`, after PR #2054 merged into `main` — see note below) — fixes two pre-existing `tsc --noEmit` failures introduced by unrelated parallel work that landed on `main` after the merge.

- **`tests/task-ledger-scope-sync.test.ts` passed `status: "in_progress"` (snake_case) to `syncActiveTaskEntryToFacts`, but `ActiveTaskEntry.status` only accepts the display-cased `ActiveTaskStatus` union (`"In progress" | "Waiting" | "Stalled" | "Failed" | "Done"`).** The test still passed at runtime by coincidence — `displayStatusToFact`'s `switch` falls through to its `default` case for any unrecognized status string, and that default happens to return the same `"in_progress"` value the correct `"In progress"` input would have produced — but the type error blocked a clean `tsc --noEmit`. Fixed by correcting the three literals to `"In progress"`.
- **`tests/reregister-policy.test.ts`'s `runtimeWithStores` helper used a direct `as PluginRuntime` cast on a mock object missing 27+ of the interface's fields** (`embeddings`, `openai`, `identityReflectionStore`, etc.), which TypeScript flags as an unsafe assertion between insufficiently-overlapping types. Fixed with the established `as unknown as PluginRuntime` escape hatch already used elsewhere in this codebase for intentionally-partial test mocks.

Verified via `git stash` that both errors reproduce exactly against the pre-fix code (`tsc --noEmit` output byte-for-byte matches what's shown above). tsc clean after the fix; biome clean (zero new findings on either file, verified against each file's pre-existing baseline). Related suites (reregister-policy, task-ledger-scope-sync, heartbeat-facts-ledger, task-ledger-facts, task-ledger-live-state): 80 passed, no regressions.

**Branch note:** PR #2054 (`claude/core-exec-tooling-blocker-z9ikt1`) was merged (squashed) into `main` during this session. Verified byte-for-byte that every file touched by loop iterations 90-106 (all the scope-isolation security fixes: consolidation, continuous-verifier, topic-clusters, active-task-checkpoint, redaction, etc.) is identical between the old branch and the post-merge `main`, so no work was lost. Started a fresh branch (`claude/memory-hybrid-scope-security-qa`) from `origin/main`'s current tip to continue the QA sweep, rather than reusing the now-closed PR's branch. The full "Deferred (fresh sweep, loop iteration 103)" backlog from the v2026.7.170 entry above still applies and is picked up from here.

---

## [2026.7.172] - 2026-07-09

### Fixed

- Hardened hybrid-memory reload teardown so database users drain before close/reuse, preventing stale teardown activity from destabilizing hot reloads and voice-call smoke validation paths.
- Fixed closed database handle reuse during re-registration so repeated plugin reloads can reopen/re-register cleanly after prior teardown.

### Fixed

- **Cron delivery safety (issue #2056):** plugin-owned `hybrid-mem:*` cron jobs no longer install in the unsafe `sessionTarget=isolated + payload.kind=agentTurn + delivery.mode=announce` shape (with no explicit `delivery.channel` and no `delivery.to`). The OpenClaw cron safety guard refuses delivery in that shape and records the run as `error` even when the body work succeeded (e.g. `digest-pending exit=0` plus `validate-cron-exit exit=0` plus `state.lastStatus=error`).
  - `cli/install/cron-jobs.ts` `resolveCronJob` now defaults `workshop-approval-reminder` and `maintenance-log-analyzer` to `delivery: { mode: "none" }` (these are plugin-internal logs; the work output is captured in the maintenance log and any operator-visible notification should be opt-in via a future explicit configuration).
  - `cli/install/cron-jobs.ts` `resolveWeeklyPendingDigestDelivery` now maps every destinationless mode — including the historical `"system"` default and any `telegram` config without a non-empty `chatId` — to `delivery: { mode: "none" }`. When the operator configures `digest.weekly.delivery.mode = "telegram"` together with a non-empty `chatId`, the job is installed with `delivery: { mode: "announce", channel: "telegram", to: <chatId>, chatId: <chatId>, bestEffort: true }` so the cron safety guard sees both `channel` and `to`.
  - `config/parsers/features.ts` `parseDigestWeeklyDeliveryOnly` now defaults `digest.weekly.delivery.mode` to `"none"` (was `"system"`), and treats the legacy `"system"` value as destinationless (also normalized to `"none"`).
  - `cli/install/cron-jobs.ts` `ensureMaintenanceCronJobsLocked` normalizeExisting pass now (a) repairs the `announce + channel=system|channel=last` shape uniformly across every `hybrid-mem:*` job (the three jobs that were previously excluded — `weekly-pending-digest`, `workshop-approval-reminder`, `maintenance-log-analyzer` — are now included so legacy installs converge on the safe shape), and (b) adds a dedicated repair for the wider `isolated + agentTurn + announce` shape with no explicit `channel`+`to`, collapsing it to `delivery: { mode: "none" }` so `openclaw hybrid-mem verify --fix` repairs existing unsafe jobs.
  - `cli/verify/sections/config-cron.ts` `runVerifyConfigCronSection` now scans the cron store for the unsafe shape and surfaces a warning + recommended fix in `openclaw hybrid-mem verify` output (so operators learn about the issue even before running `--fix`).
  - Regression coverage in `tests/cron-implicit-announce-delivery.test.ts` (19 tests across generation, repair/migration, and parser-default axes) and an updated assertion in `tests/cron-session-key-normalization.test.ts` for the new safe default. No Markus-specific values are referenced in any test (uses `telegram` + `12345` as a safe dummy destination, or `mode=none` fallback).

---

## [2026.7.170] - 2026-07-07

### Fixed

Loop iteration 106 — fixes the top item from the "Deferred (fresh sweep, loop iteration 103)" backlog: the `memory_clusters` tool leaked cross-tenant fact IDs and content.

- **`services/topic-clusters.ts`'s `detectClusters` had no scope awareness — it read the entire shared `memory_links` graph via `getAllLinkedFactIds()`/`getAllLinks()` and called `getById(id)` with no scope filter**, so a fact belonging to a different tenant could enter another tenant's returned cluster (its ID, plus its content contributing to the cluster's generated label) purely by being linked in the graph. Reachable directly via the agent-facing `memory_clusters` tool (`tools/utility-tools.ts`), which had no scope computation at all — unlike every other scoped tool in this codebase.
- Fixed by adding an optional `scopeFilter` to `ClusterDetectionOptions`/`ClusterFactLookup.getById`, and re-verifying every linked fact against it *before* it can enter the adjacency graph, an edge, or a cluster (reusing the already-scope-checked entries for label generation instead of re-querying). Wired `memory_clusters`' handler to compute a `scopeFilter` via `buildToolScopeFilter` (threaded `currentAgentIdRef`/`buildToolScopeFilter` into `PluginContext`/`UtilityInstallerContext`, matching the pattern already used by the sibling graph/provenance tool contexts) and pass it through. Note: the underlying `clusters`/`cluster_members` tables still have no `scope` column at all, so cross-tenant *storage* sharing (the separate "any tenant can force a global recompute of everyone's clusters" concern) is unchanged by this fix — that needs a schema migration and is tracked below, not attempted as part of this surgical patch.

Regression test added (`tests/topic-clusters.test.ts`): a 3-fact triangle where two facts belong to tenant A and one to tenant B; calling `detectClusters` with tenant A's scope filter confirms the returned cluster contains only the two tenant-A facts, with `totalLinkedFacts` correctly reduced to 2 (tenant B's fact and both edges touching it excluded entirely, not merely hidden after the fact). Verified via `git stash` to fail without the fix — the pre-fix code ignored the `scopeFilter` option entirely and returned all 3 facts in one cluster. tsc clean; biome clean (zero new findings across all 4 changed files, verified against each file's pre-existing baseline — the flagged import-sort item on `utility-tools.ts` is pre-existing and unrelated to the new import). Related suites (topic-clusters, plugin-e2e, knowledge-gaps-tool, verbosity): 67 passed, no regressions.

### Deferred (fresh sweep, loop iteration 103 — remaining items, ranked by severity; superseded top item above already fixed in this version)

- `backends/facts-db/clusters.ts`'s `saveClusters`/`getClusters`/`getClusterMembers` operate on the `clusters`/`cluster_members` tables, which have no `scope`/`scope_target` columns at all — the *storage* layer is still fully shared across tenants (any tenant's `memory_clusters` call with the default `save: true` still wipes and rebuilds the whole shared table, just now with only its own scoped facts as candidates). Needs a schema migration to add scope columns and thread scope through the storage functions, not a single-iteration surgical patch — separate from and larger than the read-side leak just fixed.
- `services/goal-registry.ts` (`readGoal`/`listGoals`/`updateGoal`/`terminateGoal`) has no scope concept at all — the `Goal` type carries no owner/tenant field, so `goal_list`/`goal_get`/`goal_complete`/`goal_abandon` in `tools/goal-tools.ts` operate across every tenant sharing a plugin instance. Larger fix than a single-iteration surgical patch (needs a scope field added to the Goal schema and threaded through every registry function and caller), so still deferred.
- `services/workboard-facts-sync.ts`'s `applyWorkboardTaskStatusUpdate` and `setup/workboard-integration.ts:143`'s `loadTasks` both call `loadTaskLedgerFromFacts(factsDb)` with no scope filter. **Design ambiguity, not a confirmed bug**: `WorkboardConfig` has no tenant/scope field anywhere (single `gatewayUrl` per plugin instance), suggesting Workboard sync may be an intentionally shared, board-wide visibility feature (like a team kanban board) rather than a per-tenant private surface — unlike the other items in this list, which all involve otherwise-scoped data leaking through an unscoped code path. Needs a design decision (is Workboard meant to be shared or per-tenant?) before a fix direction can be chosen; blindly adding scope filtering here risks breaking the legitimate shared-dashboard use case if that's the intent.
- `backends/facts-db/entity-layer.ts`'s `applyContactProfileFields` allows same-priority-tier (`>=`) overwrite of a globally-shared contact's email/phone/role with no per-tenant attribution, reachable via any `memory_store` call that mentions an existing contact's name (NER-driven, default-on).
- `cli/cmd-store.ts:181-191`'s duplicate pre-check calls `hasDuplicate` with no scope args (computed after the check runs), so a scoped store can be silently rejected as a duplicate of an unrelated global fact with the same text — the identical bug already fixed in the sibling `tools/memory/register-store-tools.ts` MCP path.
- `cli/commands/manage/storage-stats-helpers.ts`'s `buildHybridSearchScopeFilter` builds `{ userId: null }`/`{ agentId: null }`/`{ sessionId: null }` when `--scope user|agent|session` is passed without `--scope-target` — an all-falsy filter is "no restriction" downstream, so `hybrid-mem search --scope user` (forgetting `--scope-target`) silently returns every tenant's matches instead of erroring.
- `lifecycle/stage-recall.ts:50` has no rejection handler on its FTS/hot degraded-recall fallback promise — the same class of bug already fixed in sibling `stage-injection.ts` (iteration 92) but missed here; an error in the unguarded remainder of the fallback path can hang `before_agent_start` forever.
- `cli/cmd-selfcorrection.ts:401-410`'s `MEMORY_STORE` remediation path re-uses stale pre-merge text/vector when `storeWithResult` merges onto an existing fact, instead of re-embedding the merged text — the identical pattern already fixed in sibling `cmd-distill.ts`/`cmd-extract-reinforcement.ts` (commit `9074af9`) but missed in this third file.
- `cli/verify/sections/reconcile.ts:164-211`'s SQLite-orphan `--fix` branch unconditionally reports failure and sets a non-zero exit code even when every orphan was successfully rebuilt, unlike the sibling vector-orphan branch a few lines above that re-checks before failing.
- `cli/install/install-index-reconcile.ts:204-213`'s `removeRedundantNpmProjectTreeWhenExtensionsCanonical` irreversibly deletes the legacy npm-project plugin tree (no backup, unlike every other mutation in the file) when the competing install's version simply can't be read, rather than treating an unreadable version as unsafe-to-delete.
- `backends/credentials-db.ts`'s lazy v1→v2 vault migration (`migrateLegacyVault`, triggered by any `get()`) generates a fresh salt/key in one process while a concurrently-running process still holds the stale v1 key in memory; that process's next `store()` call silently encrypts with the wrong key, permanently breaking decryption for that credential.
- `backends/wal.ts`'s `write()` never takes the cross-process rewrite lock that `compactIfOversized()`/`pruneStale()` use, so a concurrent plain `write()` landing in the compaction's snapshot→rename window is silently discarded — the exact class of corruption the lock exists to prevent, just for the one code path left out of it.

---

## [2026.7.169] - 2026-07-07

### Fixed

Loop iteration 105 — fixes the top item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `continuous-verifier.ts`'s re-verification cycle leaked cross-tenant fact content into LLM prompts.

- **`ContinuousVerifier.runCycle` built its "recent facts about this entity" context via `factsDb.getRecentFacts(days)` with no scope option**, pulling every tenant's facts into a single shared lookup. A due fact's re-verification prompt (sent to a third-party LLM) could then include a *different tenant's* private facts about a same-named entity — a cross-tenant content leak in transit, and since the LLM's CONFIRMED/STALE/UNCERTAIN verdict then drives a real confidence/tag mutation on the fact being verified, one tenant's private content could indirectly influence another tenant's fact state (`dream-cycle`/`runVerificationCycle`, reachable via `setup/cli-context/cli-services.ts`).
- Fixed by adding an inclusive `scopeFilter` option to `getRecentFacts` (global + the caller's own scope, reusing the same `scopeFilterClausePositional` SQL-clause builder `getProjectFacts` already uses — kept separate from the existing `globalOnly` boolean, since that's a stricter, different semantic used by `reflection.ts` to keep its global-scope output consistent with global-only input). `runCycle` now groups the due facts by their own `(scope, scopeTarget)` — already tracked on `VerifiedFact` since the iteration-40 fix — and builds one scoped recent-facts context map per distinct group (not per fact, to avoid N redundant queries when most due facts share a scope), instead of a single global pull.

Regression test added (`tests/continuous-verifier.test.ts`): seeds a tenant-A-scoped fact containing an obviously-sensitive marker string and a tenant-B-scoped fact (same entity name) that's due for re-verification, captures the actual LLM prompt sent via a mocked `chat.completions.create`, and asserts tenant A's marker string never appears in tenant B's verification prompt. Verified via `git stash` to fail without the fix — the captured prompt contained tenant A's full secret text verbatim under "Recent knowledge about \"shared-entity\"" against the pre-fix code. tsc clean; biome clean (zero new findings on the 3 changed source files, verified against each file's pre-existing baseline; one pre-existing import-sort nit and one new formatting nit in the test file both auto-fixed via `biome check --write`). Related suites (continuous-verifier, confidence-reinforcement, reflection, passive-observer, passive-observer-enoent, facts-db): 360 passed, no regressions.

---

## [2026.7.168] - 2026-07-07

### Fixed

Loop iteration 104 — fixes the top item from the "Deferred (fresh sweep, loop iteration 103)" backlog: `runConsolidate` could cluster and LLM-merge facts across different tenant scopes.

- **`backends/facts-db/fact-read-queries.ts`'s `getFactsForConsolidation` had no scope filtering, and `services/consolidation.ts`'s `runConsolidate` clustering step (embedding-similarity union-find) ignored scope entirely.** Two facts belonging to different tenants (different `scope`/`scopeTarget`) could land in the same cluster purely by text similarity, get LLM-merged into one fact, and the merged output was always stored at `scope: "global"` (the `storeWithResult` call had no `scope`/`scopeTarget` fields) — leaking every source fact's content, including private tenant-scoped ones, into a single fact visible to everyone, while the original scoped facts were deleted. This runs via the scheduled `consolidate` maintenance step, not just an on-demand CLI call, so it's one of the more routinely-triggered paths in the fresh-sweep backlog.
- Fixed by extending `getFactsForConsolidation`'s row shape to include `scope`/`scopeTarget` (SELECT-level addition, no query semantics change), then adding a same-scope guard to the clustering edge-building loop — two facts are only linked as a merge candidate when they share the exact same `(scope, scopeTarget)` pair — and stamping the merged fact's `storeWithResult` call with the cluster's own (now-guaranteed-uniform) scope instead of defaulting to global. This is a self-contained fix within `consolidation.ts`'s own clustering logic: it needed no new parameter threaded in from any CLI/maintenance-step call site, since consolidation now safely partitions by scope internally rather than requiring the caller to already know which tenant to run it for.

Regression tests added (`tests/consolidation.test.ts`): confirms two highly-similar facts in different tenant scopes are never clustered/merged (`clustersFound: 0`, `storeWithResult` never called), and confirms same-scope facts merge with the output correctly stamped `scope: "agent", scopeTarget: "tenant-a"` rather than the previous default of global. Verified via `git stash` to fail without the fix — both tests failed against the pre-fix code exactly as expected (the cross-tenant pair merged into one cluster, and the same-scope merge's `storeWithResult` call carried no scope fields at all). tsc clean; biome clean (zero new findings across all 4 changed files, verified against each file's pre-existing baseline). Related suites (consolidation, consolidate-heartbeat-cli, consolidation-controls, pre-consolidation-flush, dream-cycle-consolidate-lock, facts-db, find-duplicates): 232 passed, no regressions.

### Deferred (fresh sweep, loop iteration 103 — remaining items, ranked by severity; superseded top item above already fixed in this version, see v2026.7.169 for the next fix)

- `services/goal-registry.ts` (`readGoal`/`listGoals`/`updateGoal`/`terminateGoal`) has no scope concept at all — the `Goal` type carries no owner/tenant field, so `goal_list`/`goal_get`/`goal_complete`/`goal_abandon` in `tools/goal-tools.ts` operate across every tenant sharing a plugin instance. Larger fix than a single-iteration surgical patch (needs a scope field added to the Goal schema and threaded through every registry function and caller), so still deferred.
- `services/workboard-facts-sync.ts`'s `applyWorkboardTaskStatusUpdate` and `setup/workboard-integration.ts:143`'s `loadTasks` both call `loadTaskLedgerFromFacts(factsDb)` with no scope filter — Workboard sync (opt-in feature) pushes/pulls active-task state across every tenant with no isolation.
- `backends/facts-db/clusters.ts` (`getAllLinkedFactIds`/`getAllLinks`/`saveClusters`/`getClusters`) has zero scope filtering and is directly reachable via the `memory_clusters` tool (`tools/utility-tools.ts`), which by default also unconditionally wipes and rebuilds the shared `clusters`/`cluster_members` tables as a side effect of any single tenant's call.
- `backends/facts-db/entity-layer.ts`'s `applyContactProfileFields` allows same-priority-tier (`>=`) overwrite of a globally-shared contact's email/phone/role with no per-tenant attribution, reachable via any `memory_store` call that mentions an existing contact's name (NER-driven, default-on).
- `cli/cmd-store.ts:181-191`'s duplicate pre-check calls `hasDuplicate` with no scope args (computed after the check runs), so a scoped store can be silently rejected as a duplicate of an unrelated global fact with the same text — the identical bug already fixed in the sibling `tools/memory/register-store-tools.ts` MCP path.
- `cli/commands/manage/storage-stats-helpers.ts`'s `buildHybridSearchScopeFilter` builds `{ userId: null }`/`{ agentId: null }`/`{ sessionId: null }` when `--scope user|agent|session` is passed without `--scope-target` — an all-falsy filter is "no restriction" downstream, so `hybrid-mem search --scope user` (forgetting `--scope-target`) silently returns every tenant's matches instead of erroring.
- `lifecycle/stage-recall.ts:50` has no rejection handler on its FTS/hot degraded-recall fallback promise — the same class of bug already fixed in sibling `stage-injection.ts` (iteration 92) but missed here; an error in the unguarded remainder of the fallback path can hang `before_agent_start` forever.
- `cli/cmd-selfcorrection.ts:401-410`'s `MEMORY_STORE` remediation path re-uses stale pre-merge text/vector when `storeWithResult` merges onto an existing fact, instead of re-embedding the merged text — the identical pattern already fixed in sibling `cmd-distill.ts`/`cmd-extract-reinforcement.ts` (commit `9074af9`) but missed in this third file.
- `cli/verify/sections/reconcile.ts:164-211`'s SQLite-orphan `--fix` branch unconditionally reports failure and sets a non-zero exit code even when every orphan was successfully rebuilt, unlike the sibling vector-orphan branch a few lines above that re-checks before failing.
- `cli/install/install-index-reconcile.ts:204-213`'s `removeRedundantNpmProjectTreeWhenExtensionsCanonical` irreversibly deletes the legacy npm-project plugin tree (no backup, unlike every other mutation in the file) when the competing install's version simply can't be read, rather than treating an unreadable version as unsafe-to-delete.
- `backends/credentials-db.ts`'s lazy v1→v2 vault migration (`migrateLegacyVault`, triggered by any `get()`) generates a fresh salt/key in one process while a concurrently-running process still holds the stale v1 key in memory; that process's next `store()` call silently encrypts with the wrong key, permanently breaking decryption for that credential.
- `backends/wal.ts`'s `write()` never takes the cross-process rewrite lock that `compactIfOversized()`/`pruneStale()` use, so a concurrent plain `write()` landing in the compaction's snapshot→rename window is silently discarded — the exact class of corruption the lock exists to prevent, just for the one code path left out of it.

---

## [2026.7.167] - 2026-07-07

### Fixed

Loop iteration 103 — first fix from a fresh full-codebase sweep (the iteration 87-101 fresh-sweep backlog closed out at iteration 102): `active_task_checkpoint`'s project-fact reads/writes had zero scope filtering.

- **`task-ledger-facts.ts`'s `findLatestActiveTaskKeyFact`/`upsertProjectTaskKey` read and wrote active-task project facts with no scope filtering at all**, unlike sibling task-ledger functions (`loadTaskLedgerFromFacts`/`getProjectFacts`) that were already scope-filtered in iteration 93. `active_task_checkpoint` (the tool's own `register-checkpoint-tools.ts` handler) already computed a `scopeFilter` via `buildToolScopeFilter`, but it was only wired to `episodeScopeFilter` (the audit-trail stamp) — never threaded into the actual fact read/write path. Concretely: `findLatestActiveTaskKeyFact` called the unscoped `listFactsByCategory`, and `upsertProjectTaskKey`'s `storeWithResult` call had no `scope`/`scopeTarget` fields (defaulting to `scope: "global"`). Two different tenants/agents checkpointing a colliding entity label could read each other's owner/next/title/related_session/resume_at fields as their own "existing" defaults, and a later checkpoint's `supersede()` call could retire the other tenant's fact row entirely.
- Fixed by threading an optional `scopeFilter` through `findLatestActiveTaskKeyFact`/`retireProjectTaskKeyFacts` (switched their data source from the unscoped `listFactsByCategory` to the already-scoped `getProjectFacts`, reusing the exact query the sibling ledger-read functions already use) and `upsertProjectTaskKey` (derives `scope`/`scopeTarget` from the filter via `scopeFieldsFromFilter` for its `storeWithResult` write), then wired `ActiveTaskCheckpointDeps.scopeFilter` through both `active-task-checkpoint.ts` call sites and both real tool entry points (`register-checkpoint-tools.ts`'s `active_task_checkpoint`, `goal-tools.ts`'s `goal_register`'s task-link checkpoint). Left the parameter optional so callers that don't yet thread scope (Workboard sync's `applyWorkboardTaskStatusUpdate`, tracked below) keep their current unscoped behavior rather than silently changing under them.

Regression tests added (`tests/active-task-checkpoint.test.ts`): two tests seed two different `scopeFilter` "tenants" checkpointing the same entity label, confirming (a) tenant B's checkpoint no longer resolves tenant A's owner/next as its own defaults, and (b) tenant A's own scoped fact survives tenant B's later checkpoint on the same entity rather than being superseded. Verified via `git stash` to fail without the fix — both tests failed against the pre-fix code exactly as expected (tenant B read tenant A's leaked values; tenant A's fact was clobbered to tenant B's value). tsc clean; biome clean (zero new findings across all 5 changed files, verified against each file's pre-existing baseline). Related suites (task-ledger-facts, active-task-checkpoint-sync-race, stage-active-task, goal-stewardship-registry, goal-tools): 112 passed, no regressions.

### Deferred (fresh sweep, loop iteration 103 — not yet fixed, ranked by severity; a broad sweep surfaced far more than one iteration can close, so only the highest-confidence/highest-severity items are tracked here)

- `backends/facts-db/fact-read-queries.ts`'s `getFactsForConsolidation` has no scope filter; `services/consolidation.ts`'s `runConsolidate` (a scheduled maintenance step) clusters/LLM-merges facts across every tenant and stores the merged result at global scope while deleting the original per-tenant facts — cross-tenant leak plus data loss, on a routinely-scheduled path.
- `services/continuous-verifier.ts:205`'s `runCycle` calls `getRecentFacts` with no scope option, pulling every tenant's facts into re-verification LLM prompts and letting one tenant's fact content influence another tenant's confidence/tag mutation (`dream-cycle`/`runVerificationCycle`).
- `services/goal-registry.ts` (`readGoal`/`listGoals`/`updateGoal`/`terminateGoal`) has no scope concept at all — the `Goal` type carries no owner/tenant field, so `goal_list`/`goal_get`/`goal_complete`/`goal_abandon` in `tools/goal-tools.ts` operate across every tenant sharing a plugin instance. Same bug class as the already-fixed cross-tenant procedure hijack; unfixed here. Larger fix than iteration 103's (needs a scope field added to the Goal schema and threaded through every registry function and caller), so deferred rather than attempted as a single surgical patch.
- `services/workboard-facts-sync.ts`'s `applyWorkboardTaskStatusUpdate` and `setup/workboard-integration.ts:143`'s `loadTasks` both call `loadTaskLedgerFromFacts(factsDb)` with no scope filter — Workboard sync (opt-in feature) pushes/pulls active-task state across every tenant with no isolation.
- `backends/facts-db/clusters.ts` (`getAllLinkedFactIds`/`getAllLinks`/`saveClusters`/`getClusters`) has zero scope filtering and is directly reachable via the `memory_clusters` tool (`tools/utility-tools.ts`), which by default also unconditionally wipes and rebuilds the shared `clusters`/`cluster_members` tables as a side effect of any single tenant's call.
- `backends/facts-db/entity-layer.ts`'s `applyContactProfileFields` allows same-priority-tier (`>=`) overwrite of a globally-shared contact's email/phone/role with no per-tenant attribution, reachable via any `memory_store` call that mentions an existing contact's name (NER-driven, default-on).
- `cli/cmd-store.ts:181-191`'s duplicate pre-check calls `hasDuplicate` with no scope args (computed after the check runs), so a scoped store can be silently rejected as a duplicate of an unrelated global fact with the same text — the identical bug already fixed in the sibling `tools/memory/register-store-tools.ts` MCP path.
- `cli/commands/manage/storage-stats-helpers.ts`'s `buildHybridSearchScopeFilter` builds `{ userId: null }`/`{ agentId: null }`/`{ sessionId: null }` when `--scope user|agent|session` is passed without `--scope-target` — an all-falsy filter is "no restriction" downstream, so `hybrid-mem search --scope user` (forgetting `--scope-target`) silently returns every tenant's matches instead of erroring.
- `lifecycle/stage-recall.ts:50` has no rejection handler on its FTS/hot degraded-recall fallback promise — the same class of bug already fixed in sibling `stage-injection.ts` (iteration 92) but missed here; an error in the unguarded remainder of the fallback path can hang `before_agent_start` forever.
- `cli/cmd-selfcorrection.ts:401-410`'s `MEMORY_STORE` remediation path re-uses stale pre-merge text/vector when `storeWithResult` merges onto an existing fact, instead of re-embedding the merged text — the identical pattern already fixed in sibling `cmd-distill.ts`/`cmd-extract-reinforcement.ts` (commit `9074af9`) but missed in this third file.
- `cli/verify/sections/reconcile.ts:164-211`'s SQLite-orphan `--fix` branch unconditionally reports failure and sets a non-zero exit code even when every orphan was successfully rebuilt, unlike the sibling vector-orphan branch a few lines above that re-checks before failing.
- `cli/install/install-index-reconcile.ts:204-213`'s `removeRedundantNpmProjectTreeWhenExtensionsCanonical` irreversibly deletes the legacy npm-project plugin tree (no backup, unlike every other mutation in the file) when the competing install's version simply can't be read, rather than treating an unreadable version as unsafe-to-delete.
- `backends/credentials-db.ts`'s lazy v1→v2 vault migration (`migrateLegacyVault`, triggered by any `get()`) generates a fresh salt/key in one process while a concurrently-running process still holds the stale v1 key in memory; that process's next `store()` call silently encrypts with the wrong key, permanently breaking decryption for that credential.
- `backends/wal.ts`'s `write()` never takes the cross-process rewrite lock that `compactIfOversized()`/`pruneStale()` use, so a concurrent plain `write()` landing in the compaction's snapshot→rename window is silently discarded — the exact class of corruption the lock exists to prevent, just for the one code path left out of it.

---

## [2026.7.166] - 2026-07-07

### Fixed

Loop iteration 102 of the fresh full-codebase sweep — fixes the last remaining item in the "Deferred (fresh sweep, loop iterations 87-101)" backlog: `redaction.ts`'s free-text secret regex missed credential keywords used as the suffix of a compound identifier.

- **The `\b(?:password|...|token|...)\b` word-boundary match in `SECRET_PATTERNS` only fires when the keyword is preceded by a non-word character**, but a lowercase-to-uppercase transition (camelCase) and `_` (itself a word character) are both *not* `\b` transitions. So `sessionToken:`, `authToken:`, `clientSecret:`, `refreshToken:`, and `auth_token:` all passed through `redactAutopilotText` unredacted and landed verbatim in the persisted `pending_autopilot_decisions` audit trail (evidence/summary text), even though the structured object-key redaction a few lines below (`CREDENTIAL_KEY_NORMALIZED`/`isCredentialKey`) already treats these exact compound forms as sensitive. Fixed by adding two more entries to `SECRET_PATTERNS`: a case-sensitive pattern using a `(?<=[a-z0-9])` lookbehind to catch the capitalized suffix of a camelCase compound (`Token`, `Secret`, `Password`, etc.), and a case-insensitive pattern using a `(?<=_)` lookbehind to catch the underscore-joined form — both scoped narrowly to their specific boundary gap rather than loosening the original pattern's `\b` (which would risk matching the keyword inside unrelated words).

Regression tests added (`tests/pending-autopilot-redaction.test.ts`): confirms `sessionToken:`, `authToken:`, `clientSecret:`, `refreshToken:` (camelCase) and `auth_token:` (underscore-joined) are all now redacted, alongside a no-regression check on the original standalone `token:` form. Verified via `git stash` to fail without the fix — both new tests failed with `redactionCount` of `0` (no redaction occurred at all) against the pre-fix regex. tsc clean; biome clean (zero findings on either changed file). Related suites (pending-autopilot-redaction, skill-quality-hardening): 37 passed, no regressions.

**This closes the last item in the "Deferred (fresh sweep, loop iterations 87-101)" backlog — the entire fresh-sweep backlog opened at iteration 87 is now fully resolved.** The next iteration starts a new fresh full-codebase sweep for new findings.

---

## [2026.7.165] - 2026-07-07

### Fixed

Loop iteration 101 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-100)" backlog: two dev-tooling gaps in `benchmark/offline-qa/`.

- **`verify-fixtures.ts`'s `daily-logs-memory-dir` fixture check called `readdirSync` on the sandbox memory directory with no `existsSync` guard**, unlike the sibling `dailyInMemory` check a few lines below that already had one — running `offline-qa:verify --sandbox` before the sandbox was populated crashed with `ENOENT` instead of reporting the fixture as missing. Extracted the shared check into a new exported `sandboxHasDailyLogs()` helper (guarded with `existsSync` first) and used it at both call sites, so the two checks can no longer drift apart.
- **`run-maintenance-qa.ts`'s `runTaskSubprocess` had no `'error'` listener on the spawned child**, only `'close'` — a spawn failure (missing binary, `EACCES`, etc.) either threw an uncaught exception (Node special-cases an unhandled `'error'` event) or left the returned promise unresolved forever, since `'close'` never fires when the child never actually launched. Added an `'error'` listener that resolves with a synthetic failure result (`exitCode: 1`, the spawn error appended to `stderr`) instead, guarded against double-resolution with the existing `'close'` handler via a shared `settled` flag.
- Both files previously called their CLI entrypoint (`main()`) unconditionally at module load, which also made them unsafe to import for direct unit testing of the two fixes above. Guarded both with the `import.meta.url === \`file://${process.argv[1]}\`` idiom already established in this codebase (`tests/perf/recall-benchmark.ts`), and exported `runTaskSubprocess` so it's directly testable. Verified this doesn't change the real invocation path (`npm run offline-qa:verify`, and `run-maintenance-qa`'s own npm script, both still fire `main()` correctly through their `jiti`-wrapped subprocess).

Regression tests added (new `tests/offline-qa-dev-tooling-guards.test.ts`): three tests on `sandboxHasDailyLogs` (missing dir doesn't throw and returns `false`; a matching `YYYY-MM-DD.md` returns `true`; a non-matching file returns `false`); one test mocks a spawned child's `'error'` event (via `vi.mock` on `utils/process-runner.js`) and confirms `runTaskSubprocess` resolves with a failure result instead of hanging or throwing. Verified via `git stash` to fail without the fix — with both files unguarded, importing the test file triggered `main()`'s `process.exit()` at module load and the entire suite failed to load (0 tests ran, "process.exit unexpectedly called with '1'"), a stronger proof than a per-assertion failure since the bug prevented the test file from loading at all. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline — the two pre-existing unsorted-import and two pre-existing unused-variable findings in these files predate this change and are unrelated to it). Related suites: no other module imports either file besides the new test and the `package.json` npm scripts (confirmed via search), so the new test file is the full regression surface.

**With this fix, the "Deferred (fresh sweep, loop iterations 87-100)" backlog is reduced to a single remaining item** (the `redaction.ts` compound-credential-keyword gap, fixed in the v2026.7.166 entry above).

---

## [2026.7.164] - 2026-07-07

### Fixed

Loop iteration 100 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-99)" backlog: `utils/auth-failover.ts`'s unlocked read-modify-write on its persisted backoff state.

- **`recordOAuthFailure`/`resetAllBackoff`/`isOAuthInBackoff`'s reset-if-due path all did a load-mutate-save on `statePath` with no cross-process synchronization.** `recordOAuthFailure` is called from `setup/provider-router.ts` on every OAuth failure for a provider — under real, plausible concurrency (multiple parallel LLM calls to the same provider failing around the same time), two racing calls can both read the same stale state, and the second write silently clobbers the first's increment — a lost update, under-applying the backoff level. Fixed with a lightweight, purpose-built synchronous cross-process lock (exclusive `wx`-flag lock-file creation, matching the established technique already used by `services/cron-guard.ts`'s step locks, but tuned for this file's millisecond-scale critical section: a short 2-second staleness window and a bounded few-retry budget) wrapping each function's full load-mutate-save sequence. Deliberately fails open (proceeds without the lock) if contention outlasts the retry budget, rather than blocking a hot LLM-failure-handling path — losing the lock race in that edge case still just means an occasional under-applied backoff, the same non-security failure mode this file already documented; the fix targets the *common* case (a normal few-millisecond critical section), not a hypothetical zero-contention guarantee.

Regression test added (new `tests/auth-failover-concurrency.test.ts`): spawns 10 real `worker_threads` (each independently importing the actual `auth-failover.ts` module via Node's native `--experimental-strip-types`, not a mock) that all call `recordOAuthFailure` for the same provider concurrently, then asserts the final backoff level reflects all 10 increments (sequentially-consistent result), not fewer. Verified via `git stash` to fail without the fix — under genuine OS-level thread concurrency the race is inherently non-deterministic (it reproduced clearly on the 3rd of 3 runs against the pre-fix code, with the final level landing at `0` instead of the expected `9` — most of the 10 concurrent increments were lost), while 5/5 runs against the fixed code landed on the correct value. tsc clean; biome clean (zero new findings on either changed file). Related suites (auth-failover, auth-failover-concurrency, provider-routing): 105 passed, no regressions.

---

## [2026.7.163] - 2026-07-07

### Fixed

Loop iteration 99 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-98)" backlog: `getDuplicateIdByNormalizedHash`'s scope-blindness, resolved by removing the dead code entirely.

- **`backends/facts-db/procedures/crud.ts`'s (actually `backends/facts-db/crud.ts`'s) `getDuplicateIdByNormalizedHash(db, text)` ran an unscoped SQL lookup, unlike its scoped sibling hash lookups in `services/dedupe-policy.ts`.** Traced every call site across the codebase: the only references were its own `FactsDB` public-method wrapper (`facts-db-layer1.ts`) and the barrel re-export (`backends/facts-db/index.ts`) — zero internal callers anywhere, and `FactsDB` isn't re-exported from the plugin's top-level entrypoint either, so it isn't part of the package's external public API surface. Rather than adding a scope filter to code nothing calls (extra surface area with no behavior to verify), removed the function, its `FactsDB.getDuplicateIdByNormalizedHash` wrapper method, and both barrel re-exports entirely — closing the scope-blindness concern by eliminating the unscoped code path rather than just guarding it.

Regression test added (new `tests/facts-db-dead-code-removed.test.ts`): asserts `FactsDB` instances no longer expose a `getDuplicateIdByNormalizedHash` method. Verified via `git stash` to fail without the fix — the method still existed and the test's `toBeUndefined()` assertion failed with the actual function reference. tsc clean; biome clean (zero new findings across all three changed files, verified against each file's pre-existing baseline). Related suites (facts-db-dead-code-removed, facts-db): 199 passed, no regressions.

**Full-suite checkpoint (10th-iteration cadence, kicked off in the background at the start of iteration 98) completed cleanly**: 8925 passed, 23 skipped, only the same 3 known pre-existing failures (`crystallization-proposer`, `implicit-feedback-routing`, `memory-recall-timeline`) — zero new regressions across the full run of fixes from iterations 90-98. Next full-suite checkpoint due at iteration 108.

---

## [2026.7.162] - 2026-07-07

### Fixed

Loop iteration 98 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-97)" backlog: `finishBatchJobRun`'s divergent checkpoint-clear default.

- **`finishBatchJobRun()` re-derived its own checkpoint-clear default (a denylist: clear unless `partial`/`failed`/`failed_semantic_empty`) instead of delegating to `MaintenanceJobRun.finish()`'s own default (an allowlist: clear only on `success`/`empty`/`skipped`).** Since `finishBatchJobRun` always computed and passed an explicit `clearCheckpoint` value into `jobRun.finish({ clearCheckpoint })`, `finish()`'s own default logic never actually ran through this path. The two defaults disagree for the `monitoring` and `success_with_review` outcomes: `finish()`'s allowlist treats them as "not a clean success" and preserves resumable progress, while `finishBatchJobRun`'s denylist treats them as "not a known failure" and clears it. Confirmed dormant today — traced every current call site (`self-correction-bridge.ts`, `light-job-run-bridge.ts`, `register-storage-maintenance.ts`'s `storage re-index`) and none can currently reach `monitoring`/`success_with_review` without also passing an explicit `clearCheckpoint` — but a latent trap for the next caller that doesn't. Fixed by passing `options?.clearCheckpoint` straight through to `jobRun.finish()` unchanged, letting its own default apply when the caller doesn't specify one, instead of re-deriving a separate (and divergent) rule.

Regression tests added (new `tests/batch-job-run-bridge-checkpoint-default.test.ts`): seeds a `MaintenanceJobRun`'s own checkpoint store with valid progress, then asserts `finishBatchJobRun(jobRun, "monitoring")` and `finishBatchJobRun(jobRun, "success_with_review")` (both called with no `clearCheckpoint` option) *preserve* the checkpoint file; confirms `"success"` still clears and `"partial"` still preserves (no regression for the six already-agreeing outcomes); confirms an explicit `clearCheckpoint: true` still overrides both defaults. Verified via `git stash` to fail without the fix — both divergent-outcome tests failed (checkpoint was cleared when it should have been preserved), while the three non-divergent tests already passed under the old code, confirming the fix is behavior-preserving except for exactly the two previously-mismatched outcomes. tsc clean; biome clean (zero new findings on either changed file; formatting/import-sort nits from the new test file auto-fixed via `biome check --write`). Related suites (batch-job-run-bridge-checkpoint-default, maintenance-job-run): 17 passed, no regressions.

Full-suite checkpoint (10th-iteration cadence, last run at iteration 88): background `npx vitest run` kicked off at the start of this iteration. Completed cleanly (see the v2026.7.163 entry above for results).

---

## [2026.7.161] - 2026-07-07

### Fixed

Loop iteration 97 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-96)" backlog: `hybrid-mem entities clean --stopwords` was a permanently inert flag.

- **`--stopwords` is a plain (non-negated) boolean Commander option, so `opts.stopwords` is only ever `true` (passed) or `undefined` (absent) — Commander never sets it to `false`.** The handler's `opts?.stopwords === false ? [] : ctx.cfg.entityExtraction.stopWords` therefore ALWAYS took the "use the configured list" branch, regardless of whether `--stopwords` was actually passed — the flag had zero effect on behavior, contrary to its own help text ("Use default and configured entity stopword list"). Note the DEFAULT built-in stop words (`agent`, `api`, `the`, `user`, etc. — see `utils/entity-stopwords.ts`) are unconditionally applied by `isEntityStopWord` regardless of this flag; only the additional, user-*configured* extras were affected. Fixed by gating on `=== true` instead of `=== false`, so omitting the flag now actually opts out of the configured extras as the help text promises. Extracted the selection logic into a new, directly-testable `resolveEntityCleanStopWords()` helper in `storage-stats-helpers.ts`.

Regression tests added (`tests/storage-stats-helpers-scope-filter.test.ts`): unit tests on `resolveEntityCleanStopWords` for both the passed and omitted cases; an end-to-end test seeds a fact with entity `"it"` (not a default stop word) and confirms `factsDb.cleanEntityStopwords` matches it only when the configured extras are actually applied (`--stopwords` passed), not when omitted. Verified via `git stash` to fail without the fix — `resolveEntityCleanStopWords` didn't exist yet on the pre-fix code, so all four new/changed tests threw `TypeError: resolveEntityCleanStopWords is not a function`. tsc clean; biome clean (zero new findings across both changed files, verified against each file's pre-existing baseline). Related suites (storage-stats-helpers-scope-filter, audit-health-cli, facts-db): 228 passed, no regressions.

---

## [2026.7.160] - 2026-07-07

### Fixed

Loop iteration 96 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-95)" backlog: Windows path-separator bugs in `services/maintenance-job-run/run-catalog.ts`.

- **`isJobRunSummaryPath`/`isOrchestratorSummaryPath` hardcoded `/`-separator substring checks (`.includes("/job-runs/")`) against paths built via `node:path`'s `join()` (`walkDirs`), which uses the OS-native separator (`\` on Windows).** On Windows, a genuine job-run summary path would never contain the literal substring `/job-runs/`, so `isJobRunSummaryPath` would return `false` for it — and since job-run summaries are named plain `summary.json` (not `.summary.json`, the suffix `isOrchestratorSummaryPath` requires), they wouldn't match that classifier either. Every job-run summary would be silently dropped from `maintenance run list`/`explain`/`resume` on Windows. **`resolveRunArtifacts`'s regex for deriving an orchestrator summary's log-root-relative `log`/`exit` paths had the identical bug** (`/^(.+)\/\d{8}\/([^/]+)\.summary\.json$/`) — on Windows it would never match, so orchestrator runs would silently fall through to the "non-dated summary" fallback, producing `log`/`exit` paths in the wrong directory (the dated day-dir instead of the log root). Fixed both: the classifiers now use a shared `JOB_RUN_SEGMENT_RE = /[/\\]job-runs(?:-standalone)?[/\\]/` that matches either separator, and `resolveRunArtifacts`'s regex captures the separator itself (`([/\\])\d{8}\2(...)`, backreferenced) so the derived paths stay consistent with whichever separator the source path actually used.

Regression tests added (`tests/maintenance-run-catalog.test.ts`, new "Windows path separators" describe block): exercises both classifiers and `resolveRunArtifacts` against literal Windows-style backslash path strings (independent of the actual host OS, since the fix matches either separator explicitly rather than relying on `path.sep`) alongside equivalent POSIX-style paths to confirm no regression. `isJobRunSummaryPath`/`isOrchestratorSummaryPath` are now exported (previously module-private) to make them directly testable. Verified via `git stash` to fail without the fix — the classifier functions weren't exported yet (`TypeError: ... is not a function`), and the `resolveRunArtifacts` Windows test showed the exact wrong-fallback path (`...\20260101\maintenance-nightly-xyz.log` instead of the log-root-relative `...\maintenance-nightly-xyz.log`). tsc clean; biome clean (zero new findings; two pre-existing non-null-assertion warnings and formatting nits from the new test literals auto-fixed via `biome check --write` where safe). Related suite (maintenance-run-catalog): 7 passed, no regressions.

---

## [2026.7.159] - 2026-07-07

### Fixed

Loop iteration 95 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-94)" backlog: `hybrid-mem search --scope global` returning every scope instead of only global facts.

- **`register-storage-entities-decay.ts`'s `search` command built a `ScopeFilter` for `user`/`agent`/`session` scopes but had no branch for `global`, so `--scope global` produced an empty `{}` filter.** `scopeFilterClausePositional()` (used by `factsDb.search`) and `filterByScope()` (used to filter the LanceDB vector results) both treat a filter with no `userId`/`agentId`/`sessionId` as "no restriction, include every scope" — so `hybrid-mem search "x" --scope global` silently returned every user's/agent's/session's facts instead of only global-scoped ones, the opposite of what `--scope global` asks for. The sibling `scope prune` command in `register-credentials-scope.ts` has its own correct handling for this case (`scopeFilter.global = true`), but that idiom is specific to `listScopedFactIdsPendingPrune`'s own OR-list construction — it wouldn't have worked here, since `scopeFilterClausePositional`/`filterByScope` don't check `.global` at all. Fixed by using `globalOnlyScopeFilter()` (`utils/scope-filter.ts`) instead — its sentinel `agentId` value matches no real agent-scoped row, so combined with those two functions' unconditional `scope = 'global'` OR-clause, only global-scoped facts pass. Extracted the whole scope-filter-construction ternary into a new, directly-testable `buildHybridSearchScopeFilter()` helper in `storage-stats-helpers.ts` in the process.

Regression tests added (new `tests/storage-stats-helpers-scope-filter.test.ts`): unit tests on `buildHybridSearchScopeFilter` covering all four `--scope` values plus the no-scope case; an end-to-end test seeds a real `FactsDB` with one global fact and one user-scoped ("Bob") fact sharing search terms, and asserts `factsDb.search(..., { scopeFilter: buildHybridSearchScopeFilter("global") })` returns only the global one. Verified via `git stash` to fail without the fix — `buildHybridSearchScopeFilter` didn't exist yet on the pre-fix code, so every test threw `TypeError: buildHybridSearchScopeFilter is not a function`. tsc clean; biome clean (zero new findings across both changed files, verified against each file's pre-existing baseline; one pre-existing import-sort auto-fixed via `biome check --write`). Related suites (storage-stats-helpers-scope-filter, audit-health-cli, audit-health-entity-enrichment-backlog-error, record-storage-growth-sample-race): 29 passed, no regressions.

---

## [2026.7.158] - 2026-07-07

### Fixed

Loop iteration 94 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-93)" backlog: `services/maintenance-job-run/reindex-bridge.ts`'s stale-checkpoint silent shadow-table corruption risk.

- **`createReindexJobRunCheckpointAdapter()`'s constructor unconditionally imported a legacy-format checkpoint file into the fresh job-run's own checkpoint store, silently overwriting whatever native state was already there — with no check that the fresh store already held valid progress and no fingerprint/total compatibility check against the legacy file's own content.** `storage re-index`'s call site already reads and carefully validates that exact same legacy file itself, entirely separately, as `resumeCheckpoint` — checking `--resume` was actually passed, that the checkpoint's `total` matches the current fact count, and (since every invocation creates a brand-new shadow table) discarding any nonzero offset as unsafe to resume into a table that's guaranteed to start empty. But `createReindexJobRunCheckpointAdapter`'s own `load()` is checked *first* in the CLI's checkpoint-load callback (`jobRunCheckpoint.load() ?? resumeCheckpoint`), so its unconditional, unvalidated auto-import silently short-circuited all of that validation — a `storage re-index` run with no `--resume` flag at all could still resume from a stale offset if a legacy checkpoint file happened to exist at the conventional path, causing `migrateEmbeddings` to skip re-embedding facts `0..offset` in the always-fresh shadow table; if the remaining fraction still cleared `--min-fraction-success`, the incomplete shadow table would get swapped into production with no warning. Fixed by removing the auto-import entirely — the CLI's own `resumeCheckpoint` fallback already provides correct, validated legacy-checkpoint handling, so the adapter's redundant, unguarded duplicate of that logic was pure liability. `importLegacyReindexCheckpoint()` itself is unchanged and still exported as a standalone utility; it's simply no longer invoked automatically.

Investigated `services/lifecycle/github-adapter.ts:196-202,244`'s previously-deferred "unscoped fact mutation" flag from the same backlog and determined it is **not a bug**: the adapter's SELECT scan is intentionally global (GitHub PR/issue open/closed/merged state is objective, shared truth — not tenant-specific — so restricting the scan per-tenant would defeat the sync's purpose of keeping *every* fact that references a GitHub item current), and each matched row is updated by its own unique `id` (`UPDATE facts SET ... WHERE id = ?`), so there is no cross-tenant ambiguity in the write path either. Removed from the deferred list.

Regression test added (new `tests/reindex-bridge.test.ts`): seeds a job-run's own native checkpoint store with valid progress (`offset: 10, total: 500`), writes an incompatible stale legacy checkpoint (`offset: 999, total: 999999`) at a separate path, and asserts the adapter's `load()` returns the native `offset: 10` untouched — calling the adapter with the pre-fix 2-argument shape via a permissive cast (extra JS call arguments are simply ignored by a function that no longer declares that parameter) so the same test call exercises both the pre-fix and post-fix code paths. Verified via `git stash` to fail without the fix: `load()` returned the stale `offset: 999`, proving the silent overwrite. tsc clean; biome clean (zero new findings across all three changed files, verified against each file's pre-existing baseline; one pre-existing import-sort auto-fixed via `biome check --write`). Related suites (reindex-bridge, maintenance-job-run, reindex-shadow-table, register-storage-maintenance-artifacts, register-storage-maintenance-json-exit-code, register-storage-maintenance-verbose, runtime-locks): 35 passed, no regressions.

---

## [2026.7.157] - 2026-07-07

### Fixed

Loop iteration 93 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-92)" backlog: missing scope-filter thread-through for the active-task ledger read in four lifecycle-stage call sites.

- **`lifecycle/stage-active-task.ts:77`, `lifecycle/stage-cleanup.ts` (three call sites), and `lifecycle/stage-goal-subagent.ts:29` all called `loadTaskLedgerFromFacts`/`loadTaskLedgerFromFactsWithMetrics` with no `scopeFilter`, silently reading every tenant's active-task facts.** `services/goal-context-injection.ts:119` and `services/active-task-tools-loader.ts:31` already carry an explicit `// SECURITY:` comment documenting that this pair of functions accepts an optional `scopeFilter` but silently returns every tenant's rows when it's omitted — these four lifecycle call sites were the ones that never got the memo. Not currently exploitable as a data leak, since every existing write path writes active-task facts with `scope: "global"` (which any scope filter passes through unconditionally, by design — see `scopeFilterClausePositional`'s unconditional `scope = 'global'` clause) — but an undocumented API-contract divergence that would become an immediate cross-tenant leak the moment any future write path stops being global-only, and inconsistent with the two call sites that already do this correctly. Fixed by threading `buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg)` into all four call sites — the exact resolver already used by the two correct reference call sites' own callers (`tools/task-hygiene-tools.ts`, `lifecycle/stage-goal-stewardship.ts`).

Regression tests added (new `tests/task-ledger-scope-threading.test.ts`): mocks `services/task-ledger-facts.js`'s two load functions and asserts each of the three lifecycle-stage registration functions (`registerActiveTaskInjection`, `registerCleanupHandlers`, `registerGoalSubagentHandlers`) invokes them with a scope filter derived from a non-orchestrator `currentAgentIdRef` (`{ userId: null, agentId: "sub-agent-x", sessionId: null }`) rather than omitting the parameter. Verified via `git stash` to fail without the fix — all three assertions saw the ledger-load functions called with only 1 argument (`factsDb`) instead of 3. Also fixed an existing test (`tests/stage-active-task.test.ts`'s "logs facts-ledger selection diagnostics" case) whose `ctx` fixture omitted the required `currentAgentIdRef` field — a `LifecycleContext` field the fix now reads unconditionally on the facts-ledger path, matching how every other correctly-constructed test fixture in this codebase already sets it. tsc clean; biome clean (zero new findings across all five changed files, verified against each file's pre-existing baseline). Related suites (task-ledger-scope-threading, stage-active-task, heartbeat-facts-ledger, active-task-reconcile-race, stage-cleanup-facts-ledger, stage-cleanup-markdown-ledger, stage-frustration-tool-store-dispose, stage-goal-subagent-facts, goal-stewardship-integration): 49 passed, no regressions.

---

## [2026.7.156] - 2026-07-07

### Fixed

Loop iteration 92 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-91)" backlog: the injection-stage timeout fallback's hang/crash risk.

- **`runInjectionStage()`'s timeout branch (`lifecycle/stage-injection.ts`) consumed its fallback `runInjection(...)` call with `.then(resolve)` and no rejection handler — the same unguarded-`.then()` shape iteration 91 fixed in the sibling recall stage, but strictly worse here.** When the primary injection path is genuinely stuck (which is *why* the timeout fired in the first place) and the fallback call then also throws, two things went wrong at once: the rejection became an unhandled promise rejection (capable of crashing the process, same class as iteration 91's finding), and — because `resolve` was never called for that race branch — the `timeoutFallback` promise never settled either. Since `Promise.race([primary, timeoutFallback])` needs *one* side to settle and `primary` is presumed stuck, `runInjectionStage()` would then hang forever instead of ever returning, unlike the recall-stage sibling (whose primary independently tends to settle via its own abort handling). Fixed by adding an explicit rejection handler to the fallback's `.then()` that logs via `capturePluginError` and calls `resolve(undefined)` — matching the "no injection" fallback shape already used elsewhere in this function — so a throw in the last-resort fallback now degrades gracefully instead of hanging or crashing.

Regression test added (`tests/lifecycle-stage-injection.test.ts`, "resolves instead of hanging/rejecting when the timeout-fallback injection itself throws"): reuses the existing timeout-fallback test's setup (primary hangs forever at the LLM summarize call via a never-resolving `openai.chat.completions.create` mock, fake timers advance past `INJECTION_STAGE_TIMEOUT_MS`), additionally spies on `factsDb.refreshAccessedFacts` to throw — reached only by the fallback call's `finishPrepend` → `applyInjectionSideEffects` path, since the primary call never gets past its hung LLM call — and asserts `runInjectionStage(...)` resolves to `undefined` with `capturePluginError` called for `"injection-timeout-fallback"`. Verified via `git stash` to fail without the fix: the test timed out at its 15s limit with an unhandled promise rejection logged, confirming the hang. tsc clean; biome clean (zero new findings on either changed file, verified against each file's pre-existing baseline). Related suites (lifecycle-stage-injection, memory-journey-e2e, memory-recall-injection-hardening, plugin-lifecycle-registration): 42 passed, no regressions.

---

## [2026.7.155] - 2026-07-07

### Fixed

Loop iteration 91 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-90)" backlog: the degraded-recall fallback path could itself crash the process.

- **`buildDegradedFtsHotRecallStage()` (`lifecycle/stage-recall/degraded-recall.ts`) — the shared FTS-only + HOT fallback used both when interactive recall times out and when it's queue-degraded — had no guard around its two DB-touching sub-builders, unlike the third (`buildNarrativePart`, which already wraps its body in try/catch and returns `""` on error).** `buildHotPart()`'s `ctx.factsDb.getHotFacts(...)` call and the FTS block's `ctx.factsDb.search(...)` call both ran unguarded; a transient SQLite error (busy/locked, corrupted index, etc.) from either would propagate out of `buildDegradedFtsHotRecallStage` as a rejected promise. At the `stage-recall.ts` timeout call site, that promise is consumed via `void buildDegradedFtsHotRecallStage(...).then((degraded) => { ... })` with no `.catch()` — so a throw there became an **unhandled promise rejection**, which under Node's default `unhandledRejection` handling terminates the process. The one code path specifically designed as the safety net for a slow/degraded primary recall could, on a transient DB hiccup, crash the whole plugin instead of degrading gracefully. Fixed by wrapping `buildHotPart`'s body and the FTS block in try/catch, matching `buildNarrativePart`'s already-proven pattern exactly (log via `capturePluginError` at `warning` severity, return/skip gracefully) — a failure in one sub-block now degrades that block to empty instead of failing the whole fallback.

Regression tests added (`tests/degraded-recall.test.ts`, new "buildDegradedFtsHotRecallStage resilience (loop iteration 91 regression)" block): one test makes `factsDb.getHotFacts` throw, one makes `factsDb.search` throw, both assert `buildDegradedFtsHotRecallStage(...)` resolves rather than rejects. Verified via `git stash` to fail without the fix (both calls rejected with the simulated error instead of resolving) and pass with it. tsc clean; biome clean (zero new findings; one new-import sort and one long-line format auto-fixed via `biome check --write`, matching this file's pre-existing baseline of 2 unrelated warnings). Related suites (degraded-recall, lifecycle-stage-recall, recall-pipeline, constrained-recall, plugin-lifecycle-registration): 66 passed, no regressions.

---

## [2026.7.154] - 2026-07-07

### Fixed

Loop iteration 90 of the fresh full-codebase sweep — fixes the top item from the "Deferred (fresh sweep, loop iterations 87-88)" backlog: the scope-blind procedure merge lookup.

- **`services/procedure-extractor.ts`'s merge-candidate lookup (`FactsDB.findProcedureByTaskPattern`, `backends/facts-db/procedures/crud.ts`) ran a global FTS5 match with no scope/vault/agent filter, unlike sibling `searchProcedures`/`searchProceduresRanked` (`procedures/search.ts`), which both thread a scope filter through.** The matched id then flowed into `recordProcedureSuccess`/`recordProcedureFailure` (`backends/facts-db/procedures/promotion.ts`), which were themselves also scope-blind — their existence-check guard (`getProcedureById(db, id)`) ran with no filter, so a matching id from any tenant's procedure would pass the guard and have its `success_count`/`failure_count`/`confidence`/`procedure_type` mutated. Lower severity than iteration 88's `upsertProcedure` hijack since this path is only reachable via the offline `extract-procedures` CLI batch job (no live per-tenant MCP call currently invokes it), but it closed the same class of gap at the API level for any future scoped caller. Fixed by threading an optional `scopeFilter` parameter through all three functions and their `FactsDB` wrappers — `findProcedureByTaskPattern` now appends a scope clause (via the existing `scopeFilterClausePositional()` helper already used by `searchProcedures`) to its FTS5 query, and `recordProcedureSuccess`/`recordProcedureFailure` pass their `scopeFilter` into the existing `getProcedureById` existence check they already depended on, so an out-of-scope id now reads as "not found" and the function returns `false` without mutating anything. `services/procedure-extractor.ts`'s call sites are left unchanged (no existing scope concept in that offline batch job) — the new parameters are optional and default to unscoped, preserving its current behavior exactly while closing the API-level gap.

Regression tests added (`tests/procedures-db.test.ts`, new "scope isolation (loop iteration 90 regression)" block): Bob registers a procedure; Alice's scoped `findProcedureByTaskPattern` call returns zero matches for it while an unscoped call finds it; Alice's `recordProcedureSuccess`/`recordProcedureFailure` calls against Bob's procedure id both return `false` and leave his `success_count`/`failure_count` untouched; a same-scope `recordProcedureSuccess` call still updates normally. Verified via `git stash` (all three backend files together) to fail without the fix — the cross-tenant lookup found Bob's procedure and the cross-tenant mutation calls both returned `true` — and pass with it. tsc clean; biome clean (zero new findings; one new-import sort auto-fixed via `biome check --write`, matching the existing pre-fix findings' baseline). Related suites (procedures-db, procedure-extractor, procedure-feedback-tool, facts-db, procedure-promotion-policy, procedure-skill-generator): 330 passed, no regressions.

---

## [2026.7.153] - 2026-07-07

### Fixed

Loop iteration 89 of the fresh full-codebase sweep — fixes the `setup/register-hooks.ts` cross-tenant memory leak in `before_compaction`.

- **`before_compaction`'s hot-fact scope filter was built directly from `api.context` — the weakest/last-resort identity source per this codebase's own docs — instead of the canonical `resolveRecallScopeFilter(lifecycleContext)` resolver.** The sibling `after_compaction` hook (~140 lines below, same file) already uses `resolveRecallScopeFilter(lifecycleContext)`, which derives scope from `currentAgentIdRef` (set from `resolveAgentIdFromHookEvent` during `before_agent_start` — the codebase's canonical, reliably-updated identity source) and `cfg.autoRecall.scopeFilter`. `before_compaction` instead built `{ sessionId: api.context?.sessionId, agentId: api.context?.agentId, userId: api.context?.userId }` directly — when `api.context` is unset or stale relative to the actual current agent (a realistic condition this same file already accounts for elsewhere, in `resolveCompactionHookIdentity`'s fallback chain), the resulting scope filter either restricted to the *wrong* agent or, if all three fields were undefined, produced an object `scopeFilterClausePositional()` treats as "no restriction at all" — so `getHotFacts(4000, scopeFilter)` could return hot facts across every agent/user/session, injected verbatim into the current session's compaction prompt as "Pinned Session Constraints / Memories." A cross-tenant memory leak in multi-agent deployments. Fixed by switching to `resolveRecallScopeFilter(lifecycleContext)`, matching `after_compaction`'s already-correct pattern — `lifecycleContext` is the same shared object already in scope for both hooks (constructed once at the top of the enclosing `registerLifecycleHooks` function).

Regression test added (`tests/compaction-hooks.test.ts`): sets `currentAgentIdRef.value` to a non-orchestrator sub-agent id while `api.context.agentId` reports a different, stale value (mirroring the realistic scenario the bug description points to), then asserts `getHotFacts` is called with the *canonical* agent id, not `api.context`'s stale one. Verified via `git stash` to fail without the fix (`getHotFacts` was called with `api.context`'s wrong `agentId: "main"`) and pass with it. tsc clean; biome clean (zero new findings). Related suites (compaction-hooks, plugin-lifecycle-registration, register-hooks-capability-hints, comprehensive-e2e): 27 passed, no regressions.

---

## [2026.7.152] - 2026-07-07

### Fixed

Loop iteration 88 of the fresh full-codebase sweep (started at iteration 87) — fixes the highest-priority finding from that sweep: a live, MCP-tool-reachable cross-tenant procedure hijack.

- **`upsertProcedure`'s internal existence check (`backends/facts-db/procedures/crud.ts`) ran unscoped, letting a caller-invented id collision silently overwrite another tenant's procedure.** `services/procedure-feedback-tool.ts`'s `bootstrapProcedureIfMissing` (backing the `memory_procedure_feedback` MCP tool's `registerIfMissing: true` path) does a correctly-scoped existence check first — but the tool explicitly instructs agents to invent a human-readable `procedureId` slug (e.g. "fix-flaky-test"), and when that slug happens to match another tenant's existing procedure id, the scoped check correctly reports "not found for me," so the bootstrap proceeds to call `factsDb.upsertProcedure({ id: <the colliding id>, ... })`. Inside `upsertProcedure`, the existence check (`getProcedureById(db, id)`) was called with **no scope filter at all**, so it found the *other* tenant's row and took the UPDATE branch — overwriting `task_pattern`/`recipe_json`/`procedure_type`/`confidence`/`ttl_days`/`scope`/`scope_target` with the calling tenant's values and resetting success/failure counts to 0. A full hijack of another tenant's procedure row, not just a read leak. Fixed by threading an optional `scopeFilter` into `upsertProcedure` (and its `FactsDB` wrapper), using it for the existence check so a same-scope row still correctly takes the UPDATE branch, and — since a caller-invented id can also collide with a foreign-scope row that a scoped check will never see — adding an explicit unscoped existence check that throws a clear error instead of silently inserting into (or updating) a row it doesn't own. `services/procedure-feedback-tool.ts` now passes its already-resolved `scopeFilter` through to `upsertProcedure`.

Regression test added (`tests/procedure-feedback-tool.test.ts`): Bob registers a procedure at a given id under his own scope; Alice then calls `registerIfMissing: true` with the same id under her own scope — asserts the call throws (`/already exists/`) instead of succeeding, and that Bob's procedure is completely untouched (same `task_pattern`, `scope`, `scopeTarget`, and `version` as before). Verified via `git stash` to fail without the fix (no error was thrown — the call silently succeeded, meaning the hijack happened) and pass with it. tsc clean; biome clean (zero new findings). Related suites (procedure-feedback-tool, procedure-extractor, procedures-db, procedure-promotion-policy, procedure-skill-generator, facts-db): 327 passed, no regressions.

---

## [2026.7.151] - 2026-07-07

### Fixed

Loop iteration 87 of the full-codebase review loop — the deferred backlog from iteration 34's sweep and the older carried-over items are now fully exhausted (as of iteration 86), so this begins a fresh full-codebase sweep for new bugs (dispatched via parallel research agents covering routes/, setup/, lifecycle/, backends/facts-db/, utils/, cli/, benchmark/, and credentials/cron/lease code not already touched by iterations 35-86).

- **`utils/signal-race.ts`'s `raceWithAbortSignal()` never actually resolved early on abort — it only appeared to.** The abort handler's `resolve(fallback)` call was nested inside a `.then()` chained onto the very `promise` being raced: `onAbort` called `promise.then((value) => resolve(value), () => { if (signal.aborted) resolve(fallback); })`. A `.then()` callback cannot run until the promise it's attached to settles — so when `promise` genuinely hangs (never resolves or rejects, e.g. a stuck embedding request), aborting the signal did nothing at all: `onAbort` fired, but its inner `.then()` never got a chance to call `resolve()`, so the wrapper's own race-array entry also never settled. Since `promise` itself is *also* directly in the `Promise.race([promise, ...])` array, this whole `.then()` indirection was pointless in every case where `promise` DOES eventually settle (its own array entry already wins the race the moment it does) — the only scenario where the indirection could ever matter (a hung `promise`) was exactly the scenario it couldn't handle. This completely defeated the function's stated purpose ("resolve a promise early when an AbortSignal fires (stage timeout / superseded recall)"): a stage-timeout abort during a genuinely stuck call left the whole recall stage hanging forever instead of falling back, at both call sites in `lifecycle/stage-recall/run-recall.ts` (the `embed()` calls at line 559 and the candidate-filtering call at line 1039). Fixed by having `onAbort` call `resolve(fallback)` directly and unconditionally — the "promise wins if it settles first" semantic is preserved automatically by `Promise.race`'s own mechanics via `promise`'s direct array entry, with no need for the broken indirection.

Regression tests added (`tests/signal-race.test.ts`): a promise that never settles, raced against a signal aborted after 20ms, must resolve the fallback within the test's own timeout window rather than hang (raced against an explicit 500ms "timed-out" sentinel to make the hang observable without an actual test timeout); a companion test asserts the raced promise's own resolution still wins when it settles before abort. Verified via `git stash` to fail without the fix (the hang-detection race returned `"timed-out"` instead of the fallback) and pass with it. tsc clean; biome clean (zero new findings). Related suites (signal-race, constrained-recall, degraded-recall, lifecycle-stage-recall, lifecycle-startup-memory-checkpoint, memory-correlation-recommendations, memory-recall-injection-hardening, plugin-hot-reload-race, post-compaction-recall, recall-pipeline, retrieval-modes): 120 passed, no regressions.

---

## [2026.7.150] - 2026-07-07

### Fixed

Loop iteration 86 of the full-codebase review loop — fixes the last remaining item on the "Deferred (carried over from earlier iterations)" backlog, closing it out entirely. Combined with iteration 83's closure of the iteration-34 sweep's own deferred list, every confirmed finding from loop iterations 34 through 86 is now fixed or resolved-as-not-a-bug.

- **`tools/converters/esphome-yaml-converter.ts` inverted its API/OTA enabled detection.** In ESPHome's YAML config format, a bare `api:` or `ota:` key with no sub-options YAML-parses to `null`, and that's the *normal* way to enable those components with default settings — presence of the key is what turns a component on, not any particular value under it. The converter's `apiEnabled`/`otaEnabled` checks were `x !== false && x !== null`, which reported `Enabled: false` for exactly this common case (a bare key parsing to `null`), while only reporting `true` for a non-null, non-false value like an object with sub-options. Fixed by dropping the `&& x !== null` term — since the surrounding `if (x !== undefined)` guard already excludes "key absent entirely" (the true disabled case), only an explicit `x: false` should report disabled. This converter is defined but not currently registered into any production conversion path (no other file imports `esphomeYamlConverter`), so the bug had no live user impact, but the fix keeps it correct for whenever it is wired in.

Regression tests added (`tests/esphome-yaml-converter.test.ts`, new file — none existed for this converter before): asserts a bare `api:`/`ota:` key reports `Enabled: true`, sub-configured `api:`/`ota:` blocks report `Enabled: true`, an explicit `api: false`/`ota: false` reports `Enabled: false`, and absent keys omit the sections entirely. Verified via `git stash` to fail without the fix (bare-key case reported `Enabled: false`) and pass with it. tsc clean; biome clean (zero new findings); no other test file exercises this converter, so no related-suite run was needed beyond the new file's own 4 tests.

---

## [2026.7.149] - 2026-07-07

### Fixed

Loop iteration 85 of the full-codebase review loop — fixes the `tools/apitap-tools.ts` off-by-one bullet from the "Deferred (carried over from earlier iterations)" backlog.

- **`apitap_capture`'s output formatting overwrote the wrong line when relabeling the endpoints header.** `persistAndFormatEndpoints()` builds an output with a `"Discovered endpoints:"` header followed by the endpoint list, a blank line, and a final `"Use apitap_to_skill..."` line. The `apitap_capture` handler then does `lines.splice(2, 0, durationLine)` to inject a duration line near the top — which shifts every subsequent line's index by one — and afterward tried to relabel the header to `"Discovered endpoints (pending review):"` via `lines[lines.length - 2]`. That index arithmetic was computed against the *post-splice* array length but never accounted for the splice's effect on which line sits at `length - 2`: it actually targeted the blank spacer line right before the final `"Use apitap_to_skill..."` line, not the header. The result was garbled output — the real `"Discovered endpoints:"` header stayed unchanged near the top, while `"Discovered endpoints (pending review):"` got injected in a nonsensical spot near the bottom, right where a blank separator used to be. Fixed by finding the header line via `lines.indexOf("Discovered endpoints:")` instead of fragile length-relative arithmetic — robust regardless of whether the optional "Blocked (filtered)" line or the duration splice are present.

Regression test added (`tests/apitap-tools.test.ts`): mocks `ApitapService.prototype.capture` to return two endpoints (with `node:dns/promises`'s `lookup` mocked to a public IP so `validateUrl`'s SSRF check doesn't need real network access, mirroring `apitap-service-ssrf.test.ts`'s existing pattern) and asserts the relabeled header appears exactly once, the original `"Discovered endpoints:"` label is gone, and the relabeled header sits immediately before the first endpoint line rather than near the final lines. Verified via `git stash` to fail without the fix (the original header was left unchanged) and pass with it. tsc clean; biome clean (zero new findings). Related suites (apitap-tools, apitap-store, apitap-service-ssrf): 37 passed, no regressions.

---

## [2026.7.148] - 2026-07-07

### Fixed

Loop iteration 84 of the full-codebase review loop — fixes the `backends/issue-store.ts` bullet from the "Deferred (carried over from earlier iterations)" backlog.

- **`IssueStore.transition()`/`update()` did a plain read-then-write with no compare-and-swap protection**, unlike this same file's `linkFact()` (already fixed for this exact class of bug with an `IMMEDIATE` transaction). `transition()` reads the issue's current status, validates the requested transition against the state machine, then calls `update()`, which does its own unconditional `UPDATE issues SET ... WHERE id = ?` — with no check that the status is still what `transition()` read. Cross-process only (`IssueStore`'s SQLite calls are synchronous, so nothing can interleave within a single process), but `IssueStore` is explicitly designed for multi-process access (CLI invocations, cron jobs, etc. all writing to the same file). Two processes racing a transition from the same stale status could both pass validation and both write, with whichever `UPDATE` lands last silently overwriting the other's transition (and any `rootCause`/`fix`/`rollback` data that came with it). Fixed by adding an optional `expectedStatus` option to `update()` that appends `AND status = ?` to the `UPDATE`'s `WHERE` clause and throws if the statement affects zero rows (meaning another writer already changed the status); `transition()` now passes the status it read as `expectedStatus`, making the check-and-write atomic at the database level instead of split across two separate statements. `update()`'s direct callers that don't touch status (e.g. `tools/issue-tools.ts`'s plain field updates) are unaffected — they don't pass `expectedStatus`, so behavior there is unchanged.

Regression test added (`tests/issue-store.test.ts`): uses `vi.spyOn(store, "get")` with a `mockImplementationOnce` that captures the stale ("open") snapshot, then performs a real concurrent `transition()` to `"wont-fix"` before returning the stale value — mirroring this repo's established deterministic-race-injection pattern (same technique as the file's existing `linkFact` TOCTOU test). Asserts the racing `transition("diagnosed")` call throws instead of silently overwriting, and the issue's actual status stays `"wont-fix"` (the first writer's transition). Verified via `git stash` to fail without the fix (the stale-read transition silently succeeded and overwrote the racer's status) and pass with it. tsc clean; biome clean (zero new findings). Related suites (issue-store, issue-tools-scope-security, issue-tools, memory-correlation-recommendations, retrieval-orchestrator): 110 passed, no regressions.

---

## [2026.7.147] - 2026-07-07

### Fixed

Loop iteration 83 of the full-codebase review loop — fixes the last remaining Security/cross-tenant bullet from iteration 34's sweep (the "Data loss/correctness" and "Lower-severity/cosmetic" groups from that same sweep were already fully closed out in earlier iterations).

- **`tools/memory/register-recall-tools.ts`'s graph expansion ignored per-result vault during multi-vault fan-out (`vault: "all"`).** Both the modern `expandGraph`-based BFS path and the legacy flat-score `getConnectedFactIds` path called their graph traversal unconditionally against `recallFactsDb` — the resolved/default vault's factsDb — even though `results` (the seed set for expansion) can contain facts from *multiple* vaults once `vaultHandles.length > 1`. Since `memory_links` tables are per-vault SQLite databases, this meant graph expansion silently produced nothing for any seed that came from a non-default vault (the traversal call never even reaches that vault's link data), contradicting the per-result-vault routing this same file's `getByIdInResultVault`/`isContradictedInResultVault` helpers already apply to the cold-tier and `asOf` filters a few lines above. Fixed by adding `groupByResultVault()` to `tools/memory/vault-resolve.ts` — a small generic helper that buckets items by the vault their fact id actually resolved to (via `vaultByFactId`, falling back to the default factsDb for ids with no vault entry, e.g. single-vault mode or entity-lookup merges) — and using it in both graph-expansion branches to run the traversal separately per vault group before merging the results back together. In single-vault mode the grouping collapses to one group, so behavior there is unchanged.

Regression tests added (`tests/vault-resolve.test.ts`): four tests on the extracted `groupByResultVault()` helper — routes items to their own vault per `vaultByFactId`, falls back to the default factsDb when an id has no vault entry, falls back when `vaultByFactId` names a vault absent from `vaultHandles`, and collapses to a single group in single-vault mode (no behavior change). Verified via `git stash` to fail without the fix (`groupByResultVault is not a function` — the helper doesn't exist yet) and pass with it. tsc clean; biome clean (zero new findings). A full end-to-end integration test (real multi-vault RRF fan-out + graph expansion through the actual `memory_recall` tool) was not added — wiring the full RRF/embedding/FTS pipeline across two vaults is disproportionately larger mocking surface than this fix, which is a direct, minimal generalization of the already-tested `getByIdInResultVault` pattern in the same function, using the same `vaultByFactId`/`vaultHandles` inputs; verified by code inspection of the call-site wiring instead. Related suites (vault-resolve, graph-retrieval, graph-retrieval-cte-hub-penalty, auto-linking, memory-tools-execute-boundaries, memory-forget-promote-vault-resolution, memory-store-vault-active-task-ledger-isolation, comprehensive-e2e): 141 passed, no regressions.

---

## [2026.7.146] - 2026-07-07

### Fixed

Loop iteration 82 of the full-codebase review loop — fixes the `llm-selection.ts` bullet flagged during iteration 34's sweep, closing out the entire "Lower-severity / cosmetic" list from that sweep (all items are now fixed or resolved-as-not-a-bug).

- **`utils/llm-selection.ts`'s `resolveTierPreferenceWithSources` mislabeled a configured `llm.fallbackModel` as `"built-in"` in diagnostic source attribution.** `getLLMModelPreferenceUnfiltered` appends the user's configured `llm.fallbackModel` past the end of the explicit tier/default list (both when `fallbackToDefault` appends it after an explicit list, and when no explicit list is configured and it's appended to the built-in defaults) — but the source-attribution loop only recognized entries matching `llm.<tier>[i]` or `llm.default[i]` by position; anything else fell through to the generic `"built-in"` label, including a fallback model the user explicitly set. Display-only (doesn't affect which model is actually used), but it made the verify/diagnostic output describe a user-configured setting as a hardcoded default. Fixed by adding a check for `models[i] === cfg.llm?.fallbackModel` before the `"built-in"` fallback, labeling it `"llm.fallbackModel"` instead.

Regression test added (`tests/llm-selection.test.ts`): configures `default: ["explicit-default-model"], fallbackToDefault: true, fallbackModel: "my-fallback-model"` and asserts `resolveTierPreferenceWithSources(config, "default").sources` is `["llm.default[0]", "llm.fallbackModel"]` (not `"built-in"` for the second entry). Verified via `git stash` to fail without the fix (`sources[1]` was `"built-in"`) and pass with it. tsc clean; biome clean (zero new findings). `tests/llm-selection.test.ts`: 29 passed, no regressions.

---

## [2026.7.145] - 2026-07-07

### Fixed

Loop iteration 81 of the full-codebase review loop — fixes the `goal_register` `maxActiveGoals` TOCTOU bullet flagged during iteration 34's sweep.

- **`goal_register` had a TOCTOU race on `maxActiveGoals`: no lock around the cap re-check.** The handler read `listActiveGoals(goalsDir)` and compared its length against `gs.globalLimits.maxActiveGoals`, then — several `await` points later (clarity/confirmation checks, `createGoal`'s own write) — wrote a new goal file if the check passed. Two concurrent `goal_register` calls could both read the same stale active count, both see it under the cap, and both proceed to write, pushing the active goal count past `maxActiveGoals`. `createGoal` itself only locks on `label:${label}`, which serializes duplicate-label writes but does nothing to serialize the cap check across different labels. Fixed by adding `createGoalWithCapCheck()` to `services/goal-registry.ts`, which re-checks the active count and performs the write together under a new global lock key (`_active-goal-count`) — closing the race window between the count read and the write. The original fast-path check in `goal-tools.ts` is kept as-is (avoids lock-acquisition overhead for the common already-over-cap case); the new lock-protected check is the authoritative one.

Regression test added (`tests/goal-tools.test.ts`): sets `maxActiveGoals: 1`, then uses `vi.spyOn(goalRegistry, "listActiveGoals")` to deterministically inject a concurrent `createGoal` call between the snapshot read and its return (mirroring this file's existing TOCTOU-injection pattern for `goal_assess`) — asserts the racing `goal_register` call is rejected with `error: "max_active_goals"` and the active count stays at `1`. Verified via `git stash` to fail without the fix (the racing registration silently succeeded, leaving 2 active goals against a cap of 1) and pass with it. tsc clean; biome clean (zero new findings). Full goal-subsystem test surface (22 files covering goal-tools, goal-stewardship, goal-registry, workboard, heartbeat): 202 passed, no regressions.

---

## [2026.7.144] - 2026-07-07

### Fixed

Loop iteration 80 of the full-codebase review loop — fixes the `fact-mutation-gateway.ts` bullet flagged during iteration 34's sweep.

- **`hybrid-mem.facts.create`'s gateway RPC handler didn't clamp `importance` to `[0,1]`, unlike the sibling `confidence` field in the same handler.** `confidence` is clamped with `Math.max(0, Math.min(1, params.confidence))` before being passed to `factsDb.store()`, but `importance` was passed through as-is. Since `FactsDB.store()` → `storeFact()` calls `validateStoreEntryInput()`, which throws `"importance must be a number in [0, 1]"` for any out-of-range value, an out-of-range `importance` from a Gateway RPC caller (memory-wiki, Workboard, or any other client) turned into a hard RPC failure instead of being silently normalized the way `confidence` already is — an inconsistency between two structurally identical fields in the same handler. Fixed by clamping `importance` the same way `confidence` is clamped.

Regression test added (`tests/fact-mutation-gateway.test.ts`): asserts `hybrid-mem.facts.create` with `importance: 1.5, confidence: -3` calls `factsDb.store()` with both fields clamped to `1` and `0` respectively, and that the RPC still responds `true` (previously it would have thrown before clamping was added). Verified via `git stash` to fail without the fix (`importance: 1.5` passed through unclamped) and pass with it. tsc clean; biome clean (zero new findings). `tests/fact-mutation-gateway.test.ts`: 18 passed, no regressions.

---

## [2026.7.143] - 2026-07-07

### Fixed

Loop iteration 79 of the full-codebase review loop — fixes the `cli/cmd-backfill.ts` bullet flagged during iteration 34's sweep.

- **`runBackfillForCli`/`runIngestFilesForCli` didn't increment the `skipped` stat when `factsDb.storeWithResult(...)` reported a pre-store-guard rejection** (`skipped: true` — e.g. text that looks like an LLM classifier artifact, per `isPromptArtifactOrReasoningTrace`). Only the sibling skip branch (`newlyStored === false`, a dedupe boost) incremented `skipped`; the pre-store-guard branch just `continue`d. The sibling `cmd-distill.ts` increments `skipped` on both branches. This understated the CLI's summary output — a candidate silently dropped by the pre-store guard counted as neither `stored` nor `skipped`, so `stored + skipped < candidates` with no accounting for where the item went. In `runBackfillForCli` this branch also skipped the loop's `processed++` counter, which drives the progress-bar position, so enough guard-blocked candidates would leave the progress display trailing behind the true completion count. Fixed by adding `skipped++` (and, in `runBackfillForCli`, `processed++`) to the pre-store-guard branch in both functions, mirroring `cmd-distill.ts`'s existing pattern.

Regression test added (`tests/cmd-backfill-skipped-stat.test.ts`, new file): a `MEMORY.md` fixture with one normal fact and one classifier-artifact-shaped line (`"NOOP | duplicate content flagged during triage"`, which trips `isPromptArtifactOrReasoningTrace`) asserts `stored + skipped === candidates` after `runBackfillForCli`. Verified via `git stash` to fail without the fix (`skipped` stayed `0` instead of `1`) and pass with it. tsc clean; biome clean (zero new findings). `runIngestFilesForCli`'s identical one-line fix wasn't given its own dedicated test — mocking its LLM-driven extraction pipeline is disproportionately larger than the bug it fixes, and the fix is a line-for-line mirror of the now-test-proven `runBackfillForCli` pattern; verified by direct code inspection instead. Related suites (cmd-backfill-skipped-stat, cmd-backfill-analyze-feedback, cmd-backfill-jsonl, register-backfill-maintenance-errors): 9 passed, no regressions.

---

## [2026.7.142] - 2026-07-07

### Fixed

Loop iteration 78 of the full-codebase review loop — fixes the `cli/cmd-mine.ts --undo` bullet flagged during iteration 34's sweep.

- **`mine --undo <batchId>` superseded facts by `mine_batch_id` alone, with no scope check** — a plausible cross-tenant supersede. `mine` writes facts tagged with `scope`/`scopeTarget` (mirroring the rest of the scoped-fact system), but `--undo` didn't filter its `SELECT`/`UPDATE` by scope at all, even though `--scope`/`--scope-target` were already parseable CLI options on the same command (just unused in the undo branch). Anyone who learned another tenant's batch id — e.g. from a shared log, a `mine_batch_id: ...` line pasted into a support channel, or a database dump — could run `--undo <batchId>` with no scope arguments and supersede that tenant's facts regardless of which scope they were mined into. Fixed by threading `opts.scope`/`opts.scopeTarget` into the undo query with the same `scope = ? AND (scope_target IS ? OR scope_target IS NULL)` filter the mining write path already uses for its own dedup check, defaulting to `"global"` (matching mine's own default) when unspecified — so undoing a non-global-scoped batch now requires supplying the matching `--scope`/`--scope-target`, and an unscoped `--undo` no longer reaches facts outside the `global` scope.

Regression tests added (`tests/cmd-mine.test.ts`): mines a batch into `scope: "user", scopeTarget: "user-42"`, then asserts `--undo <batchId>` with no `--scope` leaves the fact un-superseded (`superseded_at` stays `null`), and a companion test asserts `--undo <batchId> --scope user --scope-target user-42` does supersede it. Verified via `git stash` to fail without the fix (the mismatched-scope undo superseded the fact anyway) and pass with it. tsc clean; biome clean (zero new findings). `tests/cmd-mine.test.ts`: 6 passed, no regressions.

---

## [2026.7.141] - 2026-07-07

### Fixed

Loop iteration 77 of the full-codebase review loop — fixes the `cli/cmd-selfcorrection.ts` bullet flagged during iteration 34's sweep.

- **A `MEMORY_STORE` remediation whose `remediationContent` is an object missing the `text` field stringified to the literal `"[object Object]"` and got stored as a real fact instead of being skipped.** The object-vs-string normalization only checked `typeof c === "object" && c && "text" in c` — when that failed (object present, but no `text` key at all, as opposed to `text: undefined`), it fell through to the string-coercion fallback `{ text: String(c), ... }`, meant for the primitive-`remediationContent` case. `String()` on a plain object produces `"[object Object]"`, which is truthy and passes the `if (!rawText) continue;` empty-text guard, so a malformed LLM remediation item silently became a garbage fact. Fixed by giving the "object but no `text` key" case its own branch that yields `text: ""` (so the existing empty-text guard correctly skips it), instead of falling into the string-coercion path.

Regression tests added (`tests/cmd-selfcorrection-memory-store-object-remediation.test.ts`, new file): asserts a `MEMORY_STORE` remediation with `remediationContent: { entity: "Fact", tags: [...] }` (no `text` key) results in zero facts stored and no fact with text `"[object Object]"`; a companion test asserts the normal `{ text: "...", ... }` shape still stores correctly. Verified via `git stash` to fail without the fix (one fact stored, `autoFixed === 1`) and pass with it. tsc clean; biome clean (zero new findings). Related suites (cmd-selfcorrection-memory-store-object-remediation, self-correction-m3-hardening-1876, cmd-selfcorrection-atomic, cmd-selfcorrection-json-parse, self-correction-run-parser, self-correction-batch-analyze): 99 passed, no regressions.

---

## [2026.7.140] - 2026-07-07

### Fixed

Loop iteration 76 of the full-codebase review loop — fixes the `cli/cmd-health.ts` bullet flagged during iteration 34's sweep, closing out the standalone "Lower-severity / cosmetic" list item.

- **`health --json` never reflected an `unhealthy` overall status in its exit code.** `hasErrors`/`hasWarnings` (and the `overall` field embedded in the JSON body) were only computed once, after the `--json` branch had already printed its report and unconditionally `return`ed. The human-readable branch, reached only when `--json` is absent, separately recomputed the same booleans and called `process.exit(1)` on errors — but the JSON branch never did, so a script running `health --json` and gating on exit code (rather than parsing the JSON body for `overall: "unhealthy"`) would see a passing (0) exit even with real error-status indicators present. Fixed by hoisting the `hasErrors`/`hasWarnings`/`overall` computation before both branches and calling `process.exit(1)` from the `--json` branch when `hasErrors` is true, mirroring the human-readable branch's existing behavior.

Regression test added (`tests/cmd-health-json-exit-code.test.ts`, new file): asserts `process.exit(1)` is called when `health --json` reports an error-status indicator, and is not called when all indicators are healthy/degraded-only. Verified via `git stash` to fail without the fix (`process.exit` never invoked) and pass with it. tsc clean; biome clean (zero new findings). Three pre-existing tests in `tests/user-friendly-cli.test.ts` that exercise `health --json` against a real (unavailable-in-sandbox) Ollama embedding provider started legitimately triggering the now-correct `process.exit(1)` call and needed `vi.spyOn(process, "exit")` added to match — not a regression, just tests that predated the fix reflecting the newly-correct behavior. Related suites (cmd-health-json-exit-code, user-friendly-cli, cmd-doctor-resilience, register-maintenance-health-cli, health-dashboard, hybrid-mem-version-flag, hybrid-mem-root-flags-no-shadow): 65 passed, no regressions.

---

## [2026.7.139] - 2026-07-07

### Fixed

Loop iteration 75 of the full-codebase review loop — fixes two bugs in `register-storage-maintenance.ts` flagged during iteration 34's sweep, in the same deferred bullet.

- **`--json` mode on `rebuild-aliases`, `repair-vectors`, and `classification-artifacts` all returned right after printing the JSON report, before the block that sets `process.exitCode = 2` on real errors.** Each command's error/exit-code logic lived only in the human-readable (non-`--json`) branch, so a run with genuine errors reported them faithfully inside the JSON body but exited 0 anyway — silently defeating any CI/automation script that gates on the command's exit code instead of parsing the JSON. Fixed by computing the error condition and setting `process.exitCode` before the `--json` early-return in all three commands, so JSON mode reports failures via exit status too.
- **`classification-artifacts --apply`'s pagination intentionally keeps `offset` at 0 while a batch supersedes at least one fact** (the active set shrinks under it, so re-querying at the same offset naturally advances past what was just removed) — **but a still-active *verified* fact sharing that same batch window gets re-fetched and re-processed on every such iteration**, and was pushed into `verifiedSkippedIds` once per re-fetch instead of once overall, since nothing tracked which ids had already been recorded. Fixed by adding a `Set`-backed dedup guard around the `verifiedSkippedIds.push()` call.

Regression tests added (`tests/register-storage-maintenance-json-exit-code.test.ts`, new file): a mixed batch with one verified fact and one real artifact asserts `verifiedSkippedIds` contains the verified fact exactly once despite the offset-pinned re-fetch (proven by asserting the artifact really was superseded, so the re-fetch genuinely happened); separate tests assert `process.exitCode === 2` for `classification-artifacts --apply --json` (vector-delete error) and `rebuild-aliases --json` (rebuild error). Verified via `git stash` to fail without the fix (duplicate entry present; exit code stayed `undefined` in both `--json` cases) and pass with it. tsc clean; biome clean (zero new findings). Related suites (register-storage-maintenance-json-exit-code, register-storage-maintenance-artifacts, register-storage-maintenance-verbose, rebuild-aliases-cli, reembed-vectorless-cli): 20 passed, no regressions. `repair-vectors`'s identical fix was not given its own dedicated test — `runStorageRepairPipeline`'s orchestration surface is substantially larger to mock than the other two commands', and the fix there is a line-for-line mirror of the now-test-proven `rebuild-aliases`/`classification-artifacts` pattern; verified by direct code inspection instead.

---

## [2026.7.138] - 2026-07-07

### Fixed

Loop iteration 74 of the full-codebase review loop — fixes the consolidated-cron standalone-job install gap flagged during iteration 34's sweep.

- **Under the default consolidated-cron mode, standalone/optional jobs (`weekly-pending-digest`, `maintenance-log-analyzer`, `sensor-sweep` — all `supersededByOrchestrator: false`) were never actually installed, even on a fresh setup.** `buildMaintenanceCronJobDefsForEnsure()` correctly includes these jobs alongside `CONSOLIDATED_CRON_JOBS` in the defs it hands to the install loop (its own doc comment: "Standalone / optional jobs still normalized in consolidated orchestrator mode"), but the install loop's own separate `shouldSkipAddingMaintenanceCronJob()` check re-derived membership in `CONSOLIDATED_CRON_JOBS` from scratch for anything not already existing in the cron store — and since these standalone jobs were never part of that set by design, the check silently skipped adding them, undoing what the defs list had already correctly computed. Fixed by short-circuiting `shouldSkipAddingMaintenanceCronJob()` to never skip a job with `supersededByOrchestrator: false`, matching `buildMaintenanceCronJobDefsForEnsure()`'s own inclusion criteria exactly.

Regression test added (`tests/cron-jobs-consolidated-standalone-install.test.ts`, new file): calls `ensureMaintenanceCronJobs` with `consolidatedCronJobs: true` against an empty cron store and asserts both `weekly-pending-digest` and `maintenance-log-analyzer` are actually added (not just `maintenance-nightly`). Verified via `git stash` to fail without the fix (`result.added` contained only `maintenance-nightly`) and pass with it. tsc clean; biome clean (zero new findings). Related suites (cron-jobs-consolidated-standalone-install, cron-jobs-verify-fix, cron-jobs-concurrency, verify-consolidated-cron, pending-digest-delivery): 18 passed, no regressions.

---

## [2026.7.137] - 2026-07-07

### Fixed

Loop iteration 73 of the full-codebase review loop — fixes the `verify --test-llm` exit-code gap flagged during iteration 34's sweep.

- **`openclaw hybrid-mem verify --test-llm` ran live tests against every configured LLM model and displayed per-row results, but a failure never affected `state.allOk`, `state.issues`, or `process.exitCode`** — unlike the parallel embeddings `--test-llm` check, which already gates `allOk`/exit code on `anyEmbOk`. A CI or automation script gating on `verify --test-llm`'s exit code would silently pass even when every configured LLM model actually failed to respond. Fixed by adding a `state.llmOk` field (mirroring `embeddingOk`'s pattern): when `--test-llm` actually exercised at least one of the user's *configured* models (`llm.nano`/`maintenance`/`default`/`heavy` — not the always-shown reference-only rows like Opus/GPT-5.4/Codex that most users never configure), `llmOk` requires at least one of those tests to have succeeded, and pushes an issue+fix when none did. `config-cron.ts`'s `allOk` computation now includes `(!opts.testLlm || state.llmOk)` — gated on `opts.testLlm` specifically, so normal (non-`--test-llm`) verify runs are unaffected and embeddings-only setups without any LLM credentials configured don't newly fail.

Regression test added (`tests/verify-llm-test-failure-exit-code.test.ts`, new file): configures a real model with a valid-looking API key but an unreachable `baseURL` (deterministic, fast connection-refused failure, no real network dependency) and runs `verify --test-llm` — asserts the issue message appears, the run doesn't print "All checks passed", and `process.exitCode === 1`; a second test with `--test-llm` omitted confirms the same broken config doesn't fail the normal run. Verified via `git stash` to fail without the fix (the specific issue message never appeared) and pass with it. tsc clean; biome clean (zero new findings). Related suites (verify-llm-test-failure-exit-code, verify-consolidated-cron, verify-model-alignment, verify-fix-config-error, cmd-verify-orphans, cmd-verify-fact-count): 26 passed, no regressions.

---

## [2026.7.136] - 2026-07-07

### Fixed

Loop iteration 72 of the full-codebase review loop — fixes two `verify` command gaps flagged during iteration 34's sweep, in the same deferred bullet.

- **`verify`'s credentials-vault health check only test-decrypted the first stored credential, so corruption in any later row was silently missed.** `runVerifyConfigCronSection` called `credentialsDb.get()` on `items[0]` only; a vault with multiple credentials where a later row was corrupted (partial disk write, botched migration) still reported "Credentials (vault): OK" as long as the first row happened to be intact. Fixed by test-decrypting every stored credential, matching the check's actual intent (confirm the vault is genuinely readable, not just its first entry).
- **`ensureRawPluginConfigOnState`'s memoization guard checked `state.rawPluginConfig !== undefined`, which never distinguished "not yet attempted" from "attempted and failed to parse"** — both leave `rawPluginConfig` as `undefined`. Since two separate verify sections (`llm-models.ts` and `embeddings.ts`) each call this helper, a config parse failure caused every call after the first to re-read the file and re-push the same "could not be interpreted for plugin settings" warning, duplicating it in the summary. Fixed by tracking the attempt itself via a new `rawPluginConfigAttempted` flag on `VerifyRunState`, independent of whether resolution succeeded.

Regression tests added: `tests/verify-credentials-vault-partial-corruption.test.ts` (new file) runs `runVerifyForCli` against a real `CredentialsDB` with two credentials where the alphabetically-later one is corrupted directly via raw SQL — asserts `FAIL` is reported (was silently `OK` before); `tests/verify-raw-plugin-config-duplicate-warning.test.ts` (new file) calls `ensureRawPluginConfigOnState` three times against a state pointing at a nonexistent config file — asserts exactly one warning is pushed (was three before). Verified via `git stash` to fail without the fixes (corruption missed; warning duplicated 3x) and pass with them. tsc clean; biome clean (zero new findings). Related suites (verify-credentials-vault-partial-corruption, verify-raw-plugin-config-duplicate-warning, verify-consolidated-cron, verify-model-alignment, verify-fix-config-error, credentials-encryption-key): 26 passed, no regressions.

---

## [2026.7.135] - 2026-07-07

### Fixed

Loop iteration 71 of the full-codebase review loop — fixes the legacy-key warning gap flagged during iteration 34's sweep. First item from the "Lower-severity / cosmetic" backlog.

- **`resolveCredentialsVaultKeyMaterial`'s legacy-literal-key security warning was gated on the matched candidate's array index (`i > 0`) instead of whether it was actually the literal `file:/path` ref string — so it never fired for the most common trigger case: the key file missing entirely.** When the configured key file resolves successfully, `resolveCredentialsEncryptionKeyCandidates()` returns `[fileContents, literalRef]` — the literal ref sits at index 1, so `i > 0` happened to work by coincidence. When the key file is *missing* (unreadable, deleted, or never created — the actual legacy scenario this warning exists to catch, since it means the vault was originally encrypted using the literal ref string as a passphrase because no key file was ever configured), the resolver has no file-derived candidate to offer, so the literal ref becomes the *only* candidate, at index 0 — and the index-based check silently skipped the warning admins most need to see. Fixed by comparing the matched candidate directly against the trimmed literal ref (`candidate === trimmed`) instead of its array position, so the warning fires whenever the vault was actually opened using the legacy literal-ref passphrase, regardless of where it landed in the candidate list.

Regression test added (`tests/credentials-encryption-key.test.ts`): a legacy vault encrypted with a `file:/path` ref whose key file was *never created* (distinct from the existing "file exists but has different content" test, which already exercised the index-1 case that happened to work before) — asserts the legacy-literal-key warning fires when the vault opens successfully via the literal ref. Verified via `git stash` to fail without the fix (only an unrelated "could not be resolved to a usable key" warning fired, not the legacy-key one) and pass with it. tsc clean; biome clean (zero new findings). Related suites (credentials-encryption-key, register-credentials-scope-cli): 18 passed, no regressions.

---

## [2026.7.134] - 2026-07-07

### Fixed

Loop iteration 70 of the full-codebase review loop — fixes the Google-chain dimension-mismatch gap flagged during iteration 34's sweep. This closes out the last remaining item in iteration 34's "Security/cross-tenant" and "Data loss / correctness" deferred groups.

- **`createEmbeddingProvider`'s Google-in-chain dimension guard only covered OpenAI-model names, silently missing the equivalent Ollama local-model case.** When `preferredProviders` chains Google with an OpenAI-only model name (e.g. `text-embedding-3-small`), the factory already detects the mismatch and forces both legs to `GOOGLE_EMBED_DEFAULT_DIMENSIONS` (768) with a warning — safe because 768 is a value both OpenAI and Google can actually produce. Chaining Google with a known local-only Ollama model (`mxbai-embed-large`, `bge-m3`, `bge-large`, `snowflake-arctic-embed`, etc. — all fixed-dimension models that, unlike OpenAI/Google's newer embeddings, generally can't be resized on request) hit none of that guard's conditions, so `chainDimensions` passed through unchanged to both legs. Since this codebase has no static table of each Ollama model's real native output size, the two providers could end up reporting different `.dimensions` values with no warning at chain-build time — the mismatch would only surface later as a confusing dimension error deep inside `vectorDb.store()`, far from its actual cause. Fixed by detecting `preferredProviders.includes("google") && isLocalOnlyEmbeddingModelId(model)` and emitting an actionable warning (this codebase can't auto-correct to the right value the way it can for the known-768 OpenAI case, so it surfaces the risk instead of silently building a chain that may not work).

Regression tests added (`tests/embedding-providers.test.ts`, new describe block): asserts the warning fires for a `["ollama", "google"]` chain using `mxbai-embed-large`, and does not fire for the existing, unrelated `["openai", "google"]` chain case. Verified via `git stash` to fail without the fix (no warning emitted for the local-model case) and pass with it. tsc clean; biome clean (zero new findings). Related suites (embedding-providers, embedding-migration): 146 passed, no regressions.

---

## [2026.7.133] - 2026-07-07

### Fixed

Loop iteration 69 of the full-codebase review loop — fixes the `hubScorePenalty` CTE-path gap flagged during iteration 34's sweep.

- **`expandGraph`'s `hubScorePenalty` option (attenuate a high-degree hub hop's score instead of hard-skipping it) was silently ignored on the real production expansion path.** `expandGraphWithCTE` (used whenever FactsDB provides it — i.e. always in production; only absent for custom/mock lookups) is a SQL recursive CTE whose `hubDegreeCap` parameter is a hard `WHERE`-clause exclusion: any candidate node whose degree exceeds the cap is never returned by the query at all, so there was no way for the JS layer to "penalize instead of skip" a row it never received. The JS-side `ctePathMatchesHubGuards` re-validation (which exists to make CTE results match iterative BFS's hub-guard semantics exactly) then also always applied hard-skip filtering regardless of `hubScorePenalty`, discarding the row a second time even in the hypothetical case it had survived. The iterative BFS fallback — the only path that actually implemented `hubScorePenalty` — is only used when `expandGraphWithCTE` is absent, so both shipped "enhanced"/"complete" retrieval presets that configure attenuation got hard-skip instead in any real deployment. Fixed by disabling the SQL-level `hubDegreeCap` gate when `hubScorePenalty` is set (mirroring iterative BFS, which never filters at the query layer either — all its hub logic is JS-side) and extending `ctePathMatchesHubGuards` to accumulate the same `(1 - hubScorePenalty)` per-hub-hop attenuation multiplier BFS already computes, returned alongside its accept/reject verdict and applied to the CTE path's final score (`seedScore * decay * hubAttenuation`, matching BFS's formula exactly).

Regression test added (`tests/graph-retrieval-cte-hub-penalty.test.ts`, new file): a seed linked to a 3-out-degree hub (exceeding a `hubDegreeCap` of 2) linked onward to a 2-hop node — asserts the 2-hop node's score is attenuated (present, `score ≈ 0.25`) when `hubScorePenalty` is set, dropped entirely (legacy hard-skip) when it isn't, and unattenuated when `hubDegreeCap` is disabled. Verified via `git stash` to fail without the fix (the 2-hop node was dropped even in penalty mode, identical to hard-skip) and pass with it. tsc clean; biome clean (zero new findings). Related suites (graph-retrieval, graph-retrieval-cte-hub-penalty, graph-autolink, graph-tools-scope-security, graphql-link-scope-security): 70 passed, no regressions. Per the revised review cadence, the full background vitest suite runs every 10 iterations rather than every iteration — next full run at iteration 78.

---

## [2026.7.132] - 2026-07-07

### Fixed

Loop iteration 68 of the full-codebase review loop — fixes the `memory_store` active-task-ledger vault-closure bug flagged during iteration 34's sweep.

- **`memory_store`'s active-task-ledger mirror (`syncProjectStoreToActiveTaskLedger` in `register-store-tools.ts`, and `maybeRefreshProjectActiveTaskProjection` in `build-runtime.ts`) always used the plugin's *default*-vault `factsDb`/`vectorDb`, even when the fact itself was correctly stored in a named vault via `resolveToolVaultBackends`.** A `memory_store` call with `category: "project"`, a ledger-tracked key (e.g. `next`, `status`), and a `vault` param naming a non-default vault stores the fact row itself in the right place (`storeFactsDb.storeWithResult(...)`, already vault-resolved), but the two downstream ledger-sync steps that fire right after it closed over `factsDb`/`vectorDb` captured once at `registerStoreTools()`/`buildMemoryToolRuntime()` init time — silently mirroring the project-task ledger entry into the *default* vault instead. This split a named vault's active-task ledger across two SQLite databases: the vault's own ledger view would be missing entries that a `memory_store` call had just (invisibly) written to the default vault instead. `storeActiveCanonicalVector` already had the correct pattern (an explicit `factsDb`/`vectorDb` override parameter, documented specifically for this reason) — `syncProjectStoreToActiveTaskLedger` and `maybeRefreshProjectActiveTaskProjection` were the two call sites that never got it. Fixed by adding the same optional vault-backend override to both and threading the already-resolved `storeFactsDb`/`storeVectorDb` (from `resolveToolVaultBackends`, already computed earlier in `memory_store`'s handler) through at both call sites (the UPDATE/supersede branch and the main store branch).

Regression test added (`tests/memory-store-vault-active-task-ledger-isolation.test.ts`, new file, mirroring the existing `memory-store-vault-vector-isolation.test.ts` harness): stores a project-task ledger fact (`category: "project"`, `key: "next"`) via `memory_store` targeting a named vault, asserts the mirrored ledger fact lands in that vault's `FactsDB` and not the default vault's; a second test confirms the no-vault case still mirrors into the default vault. Verified via `git stash` to fail without the fix (the named-vault ledger fact was written to the default vault's FactsDB instead) and pass with it. tsc clean; biome clean (zero new findings). Related suites (memory-store-vault-active-task-ledger-isolation, memory-store-vault-vector-isolation, memory-store-merge-dedupe-vector, memory-store-early-validation, active-task-checkpoint, goal-context-injection, task-hygiene, facts-db): 275 passed, no regressions.

---

## [2026.7.131] - 2026-07-07

### Fixed

Loop iteration 67 of the full-codebase review loop — fixes the `syncMarkdownLedgerFromCheckpoint` half of the lost-update race flagged during iteration 34's sweep (sibling of iteration 66's `reconcileActiveTaskInProgressSessions` fix).

- **`syncMarkdownLedgerFromCheckpoint` (called by every `active_task_checkpoint` tool invocation to keep `ACTIVE-TASKS.md` in sync when the ledger mode is "markdown") read the file once, computed the active/completed arrays for its own checkpoint's entity, and wrote them back with no check that the file had changed since the read.** Two subagents checkpointing *different* tasks around the same time — an entirely ordinary scenario, since `active_task_checkpoint` is called by every subagent as it makes progress — could race: the second call's write only knew about the task it saw at read time, silently dropping whatever the first call had just written for its own, different task. Fixed the same way as iteration 66: extracted the per-checkpoint decision into a pure `planActiveTaskCheckpointSync()` helper (shared by the primary write attempt and the merge path) and switched the read/write pair from `readActiveTaskFile`/`writeActiveTaskFile` to `readActiveTaskFileWithMtime`/`writeActiveTaskFileOptimistic`, so a detected conflict re-derives this checkpoint's decision against the fresh file instead of overwriting it with data computed from stale state. The function's return type already had a `reason` field for this case — a conflict that exhausts `writeActiveTaskFileOptimistic`'s retries (vanishingly rare in practice) now correctly reports `synced: false, reason: "conflict"` instead of unconditionally claiming success.

Regression test added (`tests/active-task-checkpoint-sync-race.test.ts`, new file): spies on both `readActiveTaskFile` and `readActiveTaskFileWithMtime` (the pre-fix and post-fix read functions respectively, so the same test file proves the bug via `git stash` regardless of which one the code under test calls) to inject a synchronous concurrent checkpoint write for a different task right after the read resolves — the same cross-module `vi.spyOn` technique this suite already uses for `upsertProjectTaskKey` in `active-task-checkpoint.test.ts`. Asserts the concurrently-checkpointed task survives alongside the task being checkpointed. Verified via `git stash` to fail without the fix (the concurrent task was clobbered) and pass with it. tsc clean; biome clean (zero new findings). Related suites (active-task-checkpoint, active-task-checkpoint-sync-race, active-task, active-task-reconcile-race, active-task-reconcile-progress, task-hygiene): 187 passed, no regressions.

---

## [2026.7.130] - 2026-07-07

### Fixed

Loop iteration 66 of the full-codebase review loop — fixes the `reconcileActiveTaskInProgressSessions` half of the lost-update race flagged during iteration 34's sweep.

- **`reconcileActiveTaskInProgressSessions` (the heartbeat/cron job that moves orphaned "In progress" tasks to Failed when their subagent session transcript is gone) read `ACTIVE-TASKS.md` once, scanned it, and wrote back a freshly-computed active/completed array pair with no check that the file had changed since the read.** A concurrent writer — most plausibly a live `subagent_spawned`/`subagent_ended` checkpoint from `lifecycle/stage-cleanup.ts`, which already uses `writeActiveTaskFileOptimistic` precisely to avoid this — adding or updating a *different* task between the reconciler's read and its write would have that change silently clobbered: the reconciler's write only knew about the tasks present in its own stale snapshot. The codebase already has the fix for this shape of bug (`readActiveTaskFileWithMtime`/`writeActiveTaskFileOptimistic`, added for `stage-cleanup.ts`'s checkpoint writers) — `reconcileActiveTaskInProgressSessions` was simply never migrated onto it. Fixed by extracting the per-task reconcile decision into a pure `planActiveTaskReconciliation()` helper (shared by the primary progress-reporting scan and the merge path) and switching the read/write pair to `readActiveTaskFileWithMtime`/`writeActiveTaskFileOptimistic`, so a detected conflict re-derives the reconciliation decision against the fresh file instead of overwriting it with data computed from stale state. `services/active-task-checkpoint.ts`'s `syncMarkdownLedgerFromCheckpoint` has the same plain-read-then-write shape and is a separate call site — left open, tracked in the Deferred list below.

Regression test added (`tests/active-task-reconcile-race.test.ts`, new file): deterministically simulates the race by hooking the progress reporter's `setScanTotal()` callback — which fires synchronously right after the reconciler's initial read, before its scan loop runs — to perform a synchronous concurrent write adding a brand-new task the reconciler's in-memory snapshot never saw. Asserts the concurrently-added task survives in the final file alongside the correctly-reconciled orphaned task. Verified via `git stash` to fail without the fix (the concurrent task was clobbered — final active list came back empty) and pass with it. tsc clean; biome clean (zero new findings). Related suites (active-task, active-task-reconcile-progress, active-task-reconcile-race, active-task-checkpoint, task-ledger-facts, stage-cleanup-markdown-ledger): 218 passed, no regressions.

---

## [2026.7.129] - 2026-07-07

### Fixed

Loop iteration 65 of the full-codebase review loop — fixes the `prepareSubagentSpawn` injection-tracking/token-budget ordering bug flagged during iteration 34's sweep.

- **`services/context-engine.ts`'s `prepareSubagentSpawn` marked every candidate parent fact as "injected" for the child session before the real token budget was ever applied, so facts trimmed off by the budget were permanently hidden from that sub-agent.** The method called `buildContextBlock(topFacts, ..., undefined, injectedIds)` with no token budget, so `buildContextBlock`'s internal budget-trimming logic never ran and `injectedIds` collected the id of every candidate fact regardless of size. `markFactsInjectedForSession(...)` was then called with that full, untrimmed `injectedIds` list — only *after* that did a separate `trimBlockToBudget(rawBlock, tokenBudget)` call cut the block down to the real budget. Any fact whose text got trimmed off by that second pass had already been recorded as shown to the child session, so `filterFactsNotYetInjected` would exclude it from every future `prepareSubagentSpawn` call for that same child, even though it was never actually included in any context the sub-agent saw. The sibling `assemble()` method already computes its budget before calling `buildContextBlock` and passes it through directly — `prepareSubagentSpawn` was the one call site not following that pattern. Fixed by computing `tokenBudget` before the `buildContextBlock` call and passing it as the token-budget argument directly (matching `assemble()`), so `injectedIds` only ever contains facts that actually survive the budget; the now-redundant post-hoc `trimBlockToBudget` call (and its now-unused import) were removed, since `buildContextBlock` already returns a block that satisfies the budget.

Regression test added (`tests/context-engine.test.ts`, `prepareSubagentSpawn()` describe block): stores 10 facts with padding text under a token budget too tight to fit all of them, then asserts that a fact is marked injected (present in the caller-supplied `injectedFactIdsBySession` map) if and only if its text actually appears in the returned `contextAddition` — and that at least one fact was trimmed off but *not* marked injected. Verified via `git stash` to fail without the fix (all 10 facts marked injected regardless of the budget) and pass with it. tsc clean; biome clean (zero new findings). Related suites (context-engine, stage-capture, goal-context-injection): 48 passed, no regressions.

---

## [2026.7.128] - 2026-07-07

### Fixed

Loop iteration 64 of the full-codebase review loop — fixes the `health-dashboard.ts` liveness-marker mismatch flagged during iteration 34's sweep.

- **`memory_health`'s liveness queries used `valid_until` instead of the codebase's standard `superseded_at IS NULL` marker, so facts evicted by the daily-quota or token-budget-trim paths permanently showed as "active".** Daily-quota eviction (`backends/facts-db/crud.ts`) and token-budget trim (`backends/facts-db/maintenance.ts`) both retire a fact by setting only `superseded_at`, never `valid_until` — only the normal `supersede()` path (used when a fact is explicitly replaced by a newer one) sets both columns. Every liveness-dependent query in `tools/health-dashboard.ts` (`activeFacts`, `categoryDistribution`, `avgConfidence`, `orphanFacts`, `staleFacts`, `totalLinks`, and `lastPruneAt`'s `MAX()`) checked `valid_until` instead, so an evicted fact kept counting toward "active" totals and category/confidence/orphan/staleness stats forever, and eviction events never moved `lastPruneAt`. `supersededFacts` had the same gap in reverse — it never counted evicted facts as superseded at all. Fixed by switching every one of these queries to `superseded_at IS NULL` (active) / `superseded_at IS NOT NULL` (superseded), matching the predicate used consistently everywhere else in the codebase (e.g. `backends/facts-db/stats.ts`).

Regression test added (`tests/health-dashboard.test.ts`): stores one active fact and one evicted-but-not-superseded-via-`supersede()` fact (`superseded_at` set, `valid_until` left `null`, matching the real eviction paths' write pattern) — asserts `activeFacts` excludes it, `supersededFacts` counts it, and `lastPruneAt` reflects it. The existing `supersededFacts` test (previously encoding the old `valid_until`-based semantics) was updated to match the corrected behavior. Verified via `git stash` to fail without the fix (evicted fact counted as active, not superseded) and pass with it. tsc clean; biome clean (zero new findings). Related suites (health-dashboard, tool-search-wrapper-args): 41 passed, no regressions.

---

## [2026.7.127] - 2026-07-07

### Fixed

Loop iteration 63 of the full-codebase review loop — fixes the `extractItemArray` first-match-only bug flagged during iteration 34's sweep.

- **`utils/llm-json-array.ts`'s `extractItemArray` silently dropped items from every array element after the first one that needed nested envelope unwrapping.** When a parsed JSON array's elements don't all individually pass validation and aren't all JSON-encoded strings (the two cases already handled earlier in the function), it falls to a loop that recursively unwraps each element — but the loop `return`ed on the *first* element that successfully extracted anything, discarding whatever the remaining elements would have extracted. A batch LLM response shaped like `[{items:[A,B]}, {items:[C,D]}]` — one envelope per input chunk rather than a single flat array or envelope — would silently lose `C` and `D`. This function backs `parseStructuredItems`/`parseStructuredItemsAcceptingEmpty`, used by every structured-output parser in the codebase (self-correction, reinforcement analysis, feedback classification, proposal generation), so any of those could under-report results whenever a model split its output into multiple per-chunk envelopes instead of one combined one. Fixed by merging across every element instead of returning on the first, mirroring the array-of-JSON-strings case just above it in the same function (which already merges correctly).

Regression tests added (`tests/llm-json-array.test.ts`, new `extractItemArray` describe block): a multi-element array of `{items:[...]}` envelopes must return the union of all their items, not just the first envelope's; a mixed array of directly-valid items and envelope-wrapped items must also merge correctly. Verified via `git stash` to fail without the fix (both cases silently truncated to the first element's contribution) and pass with it. tsc clean; biome clean (zero new findings). Related suites (llm-json-array, feedback-signal-classifier, reinforcement-batch-analyze, self-correction-llm-parser, reflection, cmd-extract-reinforcement-batch, generate-proposals-scope-filter, generate-proposals-cli-status): 121 passed, no regressions.

---

## [2026.7.126] - 2026-07-07

### Fixed

Loop iteration 62 of the full-codebase review loop — fixes 2 more instances of the iteration-33 merge-embedding bug class, flagged during iteration 34's sweep as still present in `cli/cmd-distill.ts` and `cli/cmd-extract-reinforcement.ts`.

- **`cli/cmd-distill.ts`'s and `cli/cmd-extract-reinforcement.ts`'s batch-store paths re-embedded and stored the pre-merge text fragment instead of the actual merged fact text, exactly like the `memory_store` bug fixed in iteration 33.** Both files embed their candidate text *before* calling `factsDb.storeWithResult(...)`; when that call merges the new text onto an existing fact (`newlyStored: false`, `embeddingStale: true`), the persisted `entry.text` becomes the full merged content — but both files' skip check only bailed on the pure-dedupe case (`newlyStored === false && !embeddingStale`), letting the merge case fall through to `vectorDb.store()` using the stale pre-merge text and its already-computed vector. This left the vector backend encoding only the newly-distilled/analyzed fragment while the fact row's real, persisted text was the full merged content — the same cross-backend desync iteration 33 fixed for `memory_store`'s ADD path. Fixed identically: detect the merge case and re-embed from `entry.text` before calling `vectorDb.store()`.

Regression test added for `cmd-extract-reinforcement.ts` (`tests/cmd-extract-reinforcement-batch.test.ts`): mocks the LLM analysis response to return two `MEMORY_STORE` remediations whose text differs only by case, with `factsDb` configured for hash-based merge dedupe (matching `tests/memory-store-merge-dedupe-vector.test.ts`'s established convention) — asserts the vector backend receives the merged text, not the pre-merge fragment. Verified via `git stash` to fail without the fix and pass with it. `cli/cmd-distill.ts`'s identical fix was not given its own dedicated end-to-end regression test: `runDistillForCli` has no existing test harness in this codebase at all (it reads session files from `~/.openclaw/agents/*/sessions/` via `homedir()` with no injection point, and its extraction step calls an LLM) — building one from scratch for a fix that is a line-for-line mirror of the now-test-proven `cmd-extract-reinforcement.ts`/`register-store-tools.ts` pattern was judged disproportionate; verified instead via direct code inspection (identical variable-level structure) plus the full existing `cmd-distill`-adjacent test suite passing with no regressions. tsc clean; biome clean (zero new findings). Related suites (cmd-distill, distill-vector-dedupe, distill-chunk, distill-progress, distill-semantic-exit, cmd-extract-reinforcement-batch, memory-store-merge-dedupe-vector): 36 passed, no regressions.

---

## [2026.7.125] - 2026-07-07

### Fixed

Loop iteration 61 of the full-codebase review loop — closes the deferred `getSnoozeCandidates()` cross-tenant count leak in `buildMemoryNudge()`, left open since iteration 21 because `recall_events` has no scope column.

- **`buildMemoryNudge()`'s third signal (auto-snooze candidates) counted surfaced-but-never-referenced facts across every tenant, not just the caller's own scope.** Iteration 21 fixed the nudge's other two signals (duplicate-count, never-referenced-count) by scope-filtering their `facts` table queries directly, but explicitly deferred this third one: it's driven by `recall_events`, which has no scope/tenant column at all (only `session_key`), so it looked unscopeable without a schema change. The actual fix doesn't need one — `recall_events` only ever needs to resolve to real fact ids, and every one of those ids can be checked against the already-scoped `facts` table. Fixed by scope-filtering the `facts` lookup inside `enrichReferenceCountsFromFacts()` (threaded through `aggregateRecallStats()` → `getSnoozeCandidates()` → `buildMemoryNudge()`) and dropping any fact id that doesn't resolve in-scope from the stats map entirely, rather than just leaving its reference count at zero — so an out-of-scope fact can no longer influence the snooze-candidate list (or, via the same aggregated stats, a cross-domain-boost score) at all. `services/retrieval-v2.ts`'s separate, lower-severity use of `aggregateRecallStats()` for ranking is left unscoped for now (see updated Deferred note above) — the new `scopeFilter` parameter is optional and backward compatible, so that call site's existing behavior is unchanged.

Regression test added (`tests/memory-nudge.test.ts`): two tenants each store facts surfaced well past the snooze threshold but never accessed — tenant A alone has too few to trigger the nudge, but combined with tenant B's the total would cross the threshold. Verified via `git stash` to fail without the fix (the combined 5-fact count triggered the nudge for tenant A alone) and pass with it. tsc clean; biome clean (zero new findings). Related suites (memory-nudge, recall-signals): 6 passed, no regressions.

---

## [2026.7.124] - 2026-07-07

### Fixed

Loop iteration 60 of the full-codebase review loop — fixes the lower-severity sibling of iteration 35's change-feed cross-session IDOR, deferred at the time.

- **`memory_workshop`'s in-chat `revert_by_ordinal` action accepted a caller-supplied `sessionKey` param and used it to revert a *different* session's proposal without ever checking it against the caller's own trusted session identity.** `resolveWorkshopRevertSessionKey()` prioritizes an explicit `sessionKey` argument over the caller's real (spoof-proof) `api.context.sessionKey`/`sessionId` — by design, since some legitimate callers (the HTTP/RPC change-feed routes) need to accept a broadcast pseudo-session. Those routes were fixed in iteration 35 by additionally gating the resolved session through `isAuthorizedChangeFeedSessionKey()` before acting on it — but `tools/workshop-tool.ts`'s tool-call surface for the same action never got that same second check, so an agent tool call naming another session's key could revert that session's pending/applied persona proposal, tool/skill change, or crystallization by ordinal. Fixed by applying the identical `isAuthorizedChangeFeedSessionKey(sessionKey, chatSessionKey)` gate used by the HTTP/RPC routes.

Regression tests added (`tests/workshop-tool-revert-session-key.test.ts`, new file): seeds a real end-to-end revertible persona proposal (via `ProposalsDB` + a matching change-feed "proposed" entry) owned by one session, then calls `memory_workshop`'s `revert_by_ordinal` from a different trusted session with an explicit `sessionKey` override naming the victim's session — asserts the revert is rejected and the victim's proposal/change-feed status is untouched; a second test confirms the caller's own session can still revert their own change with no override. Verified via `git stash` to fail without the fix (the cross-session revert actually succeeded — `ok: true` — proving the vulnerability was live, not just theoretical) and pass with it. tsc clean; biome clean (zero new findings). Related suites (workshop-tool-revert-session-key, workshop-config, workshop-service, proposal-routes, proposal-gateway-methods): 43 passed, no regressions.

---

## [2026.7.123] - 2026-07-07

### Fixed

Loop iteration 59 of the full-codebase review loop — fixes the keyword-recall FTS-limit-before-scope-filter gap flagged during iteration 34's sweep, plus a deeper `node:sqlite` FTS5 parameter-binding bug discovered while fixing it.

- **Keyword recall (`memory_keyword_recall` and `memory_recall`'s keyword mode) applied its row limit to raw FTS5 hits before scope-filtering them, silently under-returning results in scoped multi-tenant deployments.** `keywordRecallResults` called `searchFts(..., { limit: recallLimit })` and only checked each hit's scope afterward, one at a time, via `searchFactsDb.getById(hit.factId, { scopeFilter })` — discarding any out-of-scope hit. `searchFts` itself already has a retry loop that widens its internal candidate window ("expand FTS LIMIT when post-filters reject most candidates") specifically to compensate for exactly this class of problem, but that loop only knew about the filters `searchFts` applied internally (entity, tag, superseded, snoozed) — it had no idea the caller was about to drop more hits for scope reasons, so in a busy multi-tenant deployment a caller could get back far fewer than `recallLimit` results (even zero) despite there being enough in-scope matches, if enough other tenants' facts happened to outrank them. Fixed by adding a `scopeFilter` option to `searchFts` itself, applied inside its own Phase 2 SQL filter (the same pass as entity/tag/superseded), so its existing expand-and-retry loop now correctly accounts for scope the same way it already does for every other filter.
- **While building the regression test above, found and fixed a separate, more fundamental bug: `node:sqlite`'s FTS5 virtual table integration silently ignores a *parameterized* `rowid IN (?, ?, ...)` constraint when combined with `MATCH`** — it returns every row that matches the FTS query regardless of the IN-list, whereas the equivalent *literal* `rowid IN (1, 2, ...)` filters correctly. `searchFts`'s Phase 3 snippet/matchInfo lookup used the parameterized form, so whenever Phase 2's own filters (entity, tag, superseded, or now scope) narrowed a fact's candidate set to rowids that were not the top bm25-ranked matches, Phase 3 silently returned snippet data for the *wrong* (unfiltered, top-ranked) rows instead — and since the final assembly step cross-checks against the correctly-filtered rowid list, this dropped the legitimately-matching fact from the results entirely rather than leaking the wrong one. This is not scope-specific: any keyword search whose entity/tag/superseded filters excluded the single best-ranked FTS candidate was silently losing results before this fix. Fixed by embedding the (always internally-sourced, numeric, never user-controlled) rowid list directly into the SQL string for that one clause instead of binding it as parameters, working around the node:sqlite quirk.

Regression test added (`tests/fts-search.test.ts`): 100 out-of-scope "noise" facts (strong, repeated exact-term matches guaranteed to outrank a diluted single-mention document, saturating `searchFts`'s initial 100-row candidate window) plus one in-scope fact set up to rank far worse; a scoped `limit: 1` query must still return the in-scope fact, not silently come back empty or leak the wrong tenant's data. Verified via `git stash` to fail without the fix (returned the out-of-scope tenant's fact, ignoring `scopeFilter` entirely) and pass with it. During development this test also caught the node:sqlite `rowid IN (?)` bug directly (isolated via a series of minimal raw-SQL repros comparing parameterized vs. literal IN-lists) before the scope fix alone could pass it. tsc clean; biome clean (zero new findings). Related suites (fts-search, cmd-doctor-fts, constrained-search-filters, facts-db, facts-db-modules, plugin-e2e, memory-tools-execute-boundaries, comprehensive-e2e, memory-journey-e2e): 310 passed, no regressions.

---

## [2026.7.122] - 2026-07-07

### Fixed

Loop iteration 58 of the full-codebase review loop — fixes the `memory_provenance` event_log leak flagged during iteration 34's sweep.

- **`memory_provenance`'s `buildDerivedFrom` could hand back another tenant's raw conversation text through a shared "global"-scope fact's provenance chain.** The `event_log` table has no scope/tenant column at all (only `session_id`), so unlike the FACT-to-FACT `DERIVED_FROM`/`CONSOLIDATED_FROM` edges in the same function — which are explicitly gated with `factsDb.getById(edge.sourceId, { scopeFilter })` before their content is ever traversed or revealed (per the existing "SECURITY: gate recursion on the source fact resolving in-scope" comments) — the `event_log`-sourced branch called `eventLog.getById(edge.sourceId)` and returned its live, potentially richer extracted text completely unconditionally. A fact promoted to `scope: "global"` is, by design, visible to every tenant in a multi-agent deployment, but the raw session event that produced it can still belong to one specific tenant's private conversation and may contain far more detail than what was distilled into the shared fact's own text. Any tenant able to see that global fact (which is exactly the point of `scope: "global"`) could call `memory_provenance` on it and recover the originating tenant's raw conversation snippet via `derivedFrom[].event_text`, bypassing scope entirely. Fixed by only performing the live `eventLog.getById()` lookup when either no multi-tenant scope restriction is active for this call (mirrors the same `!filter || (!filter.userId && !filter.agentId && !filter.sessionId)` "unrestricted" check already used in `scope-sql.ts`), or the fact this edge is attached to already resolved via a non-global, caller-identity-matched scope (i.e. it's confirmed to be this same tenant's own data). Otherwise the code now falls back to the edge's own stored `sourceText` snapshot — never any more revealing than the fact's own already-authorized text.

Regression tests added (`tests/provenance-tools.test.ts`): a "global"-scope fact viewed by a different tenant (`currentAgentIdRef: "tenantB"`) gets the safe `sourceText` snapshot, not the richer live event content; the same setup with no multi-tenant scoping active (`currentAgentIdRef: null`, matching the existing single-tenant test) still gets the live event text; and a tenant viewing their own non-global-scoped fact still gets the live event text for their own data. Verified via `git stash` to fail without the fix (the cross-tenant test's live event text, containing an internal-only detail, leaked through) and pass with it — the other two new tests, and all pre-existing tests in the file, passed on both sides of the stash, confirming no regression to legitimate single-tenant or same-tenant provenance tracing. tsc clean; biome clean (zero new findings). Related suites (provenance-tools, graph-tools-scope-security, verification-tools-scope-security, issue-tools-scope-security): 16 passed, no regressions.

---

## [2026.7.121] - 2026-07-07

### Fixed

Loop iteration 57 of the full-codebase review loop — fixes the ApiTap SSRF gap flagged during iteration 34's sweep.

- **`apitap-service.ts`'s `validateUrl` had no protection against SSRF to private/loopback/link-local hosts, including cloud metadata endpoints.** The gate run before `apitap_capture`/`apitap_peek` launch a real headless browser at an agent-supplied URL only checked `allowedPatterns`/`blockedPatterns` — glob-style matches against the URL's literal text (path keywords like `oauth`/`login`, by default). It never resolved the hostname, so a URL like `http://169.254.169.254/latest/meta-data/` or `http://10.0.0.5/admin` sailed through as long as its text didn't contain a blocked keyword, letting a compromised or misled agent point the capture browser at internal network targets or cloud-instance credential endpoints. Fixed by reusing `getBlockedVerificationHostReason` — the SSRF host guard `services/goal-health.ts`'s `http_ok` goal verification already uses (DNS-resolves the hostname, or reads an IP literal directly, and rejects loopback/private/link-local/unique-local addresses) — inside `validateUrl` before the pattern checks run. `validateUrl` is now async; its two call sites in `tools/apitap-tools.ts` (`apitap_capture`, `apitap_peek`) now `await` it.

Regression test added (`tests/apitap-service-ssrf.test.ts`, new file): blocks a literal loopback IP (no DNS lookup needed) and a literal link-local metadata IP; mocks `node:dns/promises`'s `lookup` to prove a hostname resolving to a private address is blocked and one resolving to a public address still passes through to (and can still be rejected by) the existing pattern checks. Verified via `git stash` to fail without the fix (the async signature change meant the old synchronous `validateUrl` returned a `Promise` object instead of a string, and the private/loopback checks never ran) and pass with it. tsc clean; biome clean (zero new findings). Related suites (apitap-service-ssrf, apitap-tools, apitap-store, goal-health-http-ok-dns-pinning, goal-stewardship-health): 68 passed, no regressions.

Note: this closes the common case, not a fully DNS-rebinding-proof one — `validateUrl` resolves the hostname once at validation time, but the external `apitap` CLI performs its own, later, independent navigation and resolution outside this process's control, so it doesn't pin the actual outbound connection to the validated IP the way `goal-health.ts`'s `http_ok` check does (which owns the request and can pass a custom `lookup` option to `node:http`/`node:https`).

---

## [2026.7.120] - 2026-07-06

### Fixed

Loop iteration 56 of the full-codebase review loop — fixes an oversized-result-set bug flagged during iteration 34's sweep.

- **`runRecallPipelineQuery`'s FTS-only abort early-return skipped the `.slice(0, limitNum)` every other exit path in the function applies.** In FTS-only mode (no semantic strategy), `sqliteResults` concatenates entity-lookup rows with FTS rows — each independently capped to `limitNum` by its own query, but the concatenation can hold up to `2 × limitNum` entries when both an entity lookup and an FTS search each return a full batch. Every other return point in the function re-slices to `limitNum` after obtaining `sqliteResults` for exactly this reason — except the abort-signal early-return reached after `await yieldEventLoop()`, which returned the raw, unsliced, un-deduped concatenation directly to the caller. A parent recall stage aborting mid-flight during that yield window would get back up to twice the requested result count, un-ranked and potentially containing duplicate-adjacent entity/FTS entries.

Regression test added (`tests/recall-pipeline.test.ts`): seeds `limitNum` entity-lookup results and `limitNum` FTS results (6 total for a limit of 3), schedules the abort via a `setImmediate` registered *before* the pipeline call (guaranteeing it fires before the pipeline's own `yieldEventLoop()` immediate, deterministically landing the abort at the exact early-return check), and asserts the returned result count never exceeds `limitNum`. Verified via `git stash` to fail without the fix (returned all 6 unsliced rows) and pass with it. tsc clean; biome clean (zero net-new against baseline — both files' pre-existing import-order findings predate this change, confirmed via `git stash`). Related suites (recall-pipeline, lifecycle-stage-recall, post-compaction-recall): 55 passed, no regressions.

---

## [2026.7.119] - 2026-07-06

### Fixed

Loop iteration 55 of the full-codebase review loop — fixes a needless full re-migration flagged during iteration 34's sweep.

- **`migrateEmbeddings`'s checkpoint-resume check rejected an exactly-completed checkpoint as "nothing to resume," forcing a full re-embed of every already-migrated fact.** The resume condition only accepted `checkpointState.offset < total` — but a checkpoint can legitimately be saved with `offset === total` (every fact processed) right before an interrupted final cleanup step (e.g. a crash between the last batch's checkpoint save and the trailing `checkpoint.clear()`). Since `offset < total` is false in that case, the resume logic was skipped entirely and `offset` stayed at its initialized `0`, silently re-embedding the whole dataset on the next run even though nothing needed it. The migration loop's own termination condition already treats `offset >= total` on the first `getBatch()` call as a clean, non-aborted drain (no warning logged) — so once resuming from `offset === total` was allowed, the loop exits immediately with zero wasted work and correctly finalizes (clearing the checkpoint) as if the run had just completed normally. Fixed by widening the resume condition to `offset <= total`, with a distinct, accurate log message for the exactly-completed case (the existing "MIXED-MODEL state" warning doesn't apply when there's nothing left unmigrated).

Regression test added (`tests/embedding-migration.test.ts`): loads a checkpoint with `offset` exactly equal to `total` (6 facts) and asserts `embedBatch` is never called, `processed`/`migrated` are `0`, and the checkpoint is still cleared — proving the run finalizes cleanly without re-embedding anything. Verified via `git stash` to fail without the fix (all 6 facts were re-embedded) and pass with it. tsc clean; biome clean (zero net-new against baseline for the source file; the test file's only new findings are 3 `as any` casts matching this file's own dominant, pre-existing 127-instance convention for the same mock types). Related suites (embedding-migration, reindex-shadow-table): 43 passed, no regressions.

---

## [2026.7.118] - 2026-07-06

### Fixed

Loop iteration 54 of the full-codebase review loop — fixes an authorization-lockout bypass flagged during iteration 34's sweep.

- **`parsePersonaProposalsConfig` silently reopened the full default `allowedFiles` allowlist when an operator explicitly configured an empty array.** `allowedFiles: []` is a legitimate configuration meaning "persona proposals may not write to any file" — but the parser treated a post-filter-empty result the same as "not configured," falling back to the full default allowlist (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`). Every consumer (`workshop-service.ts`, `persona-proposal-triage.ts`, `persona-tools.ts`, `cli/proposals.ts`, etc.) trusts this list via `.includes(...)` checks, so an operator who explicitly locked persona proposals out of every file would instead get every default file writable — the opposite of what was configured. This is the same "explicit empty array silently replaced by default" class already fixed for `maintenance.privacyRedaction.exemptCategories`/`exemptKeys`, just not yet applied to this sibling authorization allowlist. Fixed by returning the filtered array as-is (which may legitimately be empty) whenever the raw config value is an array at all, only falling back to the default when the field isn't an array/wasn't configured.

Regression test added (`tests/config.test.ts`): parses `personaProposals: {enabled: true, allowedFiles: []}` and asserts the resolved config keeps `allowedFiles` empty rather than refilling it with the default list. Verified via `git stash` to fail without the fix (returned the full 5-file default) and pass with it. tsc clean; biome clean (zero net-new against baseline — both files' pre-existing findings predate this change, confirmed via `git stash`). Related suites (config, persona-proposal-triage, persona-rule-router, proposals, dream-cycle-proposal-bridge, workshop-service): 295 passed, no regressions.

---

## [2026.7.117] - 2026-07-06

### Fixed

Loop iteration 53 of the full-codebase review loop — fixes a mislocated idempotency record flagged during iteration 34's sweep.

- **`generateAutoSkillForProcedure`'s apply path recorded a promoted skill's `relativePath` under the live `skillsAutoPath` even when the file was physically written under the quarantine path.** By default (`requireApprovalForPromote` unset or `true`), drafts are written under a quarantine/pending directory (`writeRelativePath`, resolved to `basePath` on disk) rather than the live skills tree — the function's own dry-run branch correctly computes its preview `relativePath` from `writeRelativePath`. But the actual (non-dry-run) write path called `allocateDraftSkillDir(basePath, options.skillsAutoPath, ...)`, passing the live `skillsAutoPath` instead of `writeRelativePath` as the path used to compute the *recorded* `relativePath` — so `markProcedurePromoted(proc.id, allocated.relativePath)` persisted a path under the live tree that the file was never written to. Any later `alreadyPromoted`/idempotency check reading `proc.skillPath` back would look in the wrong location, seeing it as missing and potentially re-promoting or losing track of the quarantined draft. The sibling `generateAutoSkills` (batch) already passes `writeRelativePath` correctly at the equivalent call site. Fixed by matching that sibling and the function's own dry-run branch.

Regression test added (`tests/procedure-skill-generator.test.ts`): runs a single-procedure `apply` promotion with the default quarantine mode (`requireApprovalForPromote: true`) and asserts both the returned `relativePath` and the persisted `procedure.skillPath` point under the quarantine path (not the live `skillsAutoPath`), matching where the file was actually written on disk. Verified via `git stash` to fail without the fix (recorded path pointed under the live skills dir where nothing was written) and pass with it. tsc clean; biome clean (zero net-new against baseline — both files' pre-existing import-order findings predate this change, confirmed via `git stash`). Related suites (procedure-skill-generator, procedure-promotion-policy, publish-dist-procedure-skill-generator): 59 passed (5 skipped, pre-existing), no regressions.

---

## [2026.7.116] - 2026-07-06

### Fixed

Loop iteration 52 of the full-codebase review loop — fixes a dead-code stale-lock-reclaim race flagged during iteration 34's sweep.

- **`withRegistryLock`'s stale-lock reclaim re-check ran *after* the file was already unconditionally deleted, so it provided no actual protection against a concurrent process's lock.** When a process notices the dispatch-lease lock file is stale (unmodified past `STALE_LOCK_MS`), it's supposed to re-verify staleness immediately before removing it — the intent (per the code's own comment) was to avoid deleting a lock another process refreshed or re-acquired in the window between the staleness check and the delete. But the old code called `unlink(lockPath)` *first*, then ran the "recheck" afterward on whatever (if anything) now existed at that path — both branches of that recheck simply `continue`d the loop either way, so the recheck was pure dead code and the unconditional `unlink` had already run regardless of what changed in between. A concurrent process that noticed the same staleness, deleted the old lock, and re-acquired a fresh one in that window would have its legitimate lock silently stolen. Fixed by capturing the lock file's mtime at the staleness decision, then immediately before deleting, re-stat'ing and comparing mtimes — only unlinking when the mtime is unchanged (i.e., still the same stale lock, not a fresh one). Also removed the now-fully-superseded `isLockStale` helper (dead code once its only call site was replaced by the direct mtime comparison) and extracted the shared `stat`-based mtime read into `getLockMtimeMs`.

Regression test added (`tests/task-queue-leases-stale-lock-race.test.ts`): mocks `node:fs/promises`'s `stat` to simulate a concurrent process refreshing the lock's mtime between the staleness check and the delete attempt (then cleaning up its own lock shortly after, so acquisition still eventually succeeds), and asserts the lock path is only ever `unlink`ed once — the caller's own legitimate final release — not twice (once wrongfully during the race, once legitimately after). Verified via `git stash` to fail without the fix (2 unlink calls observed instead of 1) and pass with it. tsc clean; biome clean (zero net-new against baseline — the source file's one pre-existing import-order finding predates this change, confirmed via `git stash`; the new test file has no findings at all). Related suites (task-queue-leases, task-queue-leases-stale-lock-race): 7 passed, no regressions.

---

## [2026.7.115] - 2026-07-06

### Fixed

Loop iteration 51 of the full-codebase review loop — fixes a write-side multi-tenant isolation break flagged during iteration 34's sweep.

- **`bootstrapProcedureIfMissing` auto-registered new procedures as `scope: "global"` regardless of the caller's actual tenant scope.** When `memory_procedure_feedback` is called with `registerIfMissing: true` against a procedure id that doesn't exist yet, it correctly scope-checks the *read* (`factsDb.getProcedureById(params.procedureId, params.scopeFilter)`) — but the subsequent `factsDb.upsertProcedure({...})` create call passed no `scope`/`scopeTarget` fields at all, and `upsertProcedure` defaults missing scope fields to `"global"` on insert. So a tenant-scoped caller (e.g. `scopeFilter: {userId: "alice"}`) auto-registering a new procedure would create one visible to every tenant, not just themselves — the opposite of the read-side scoping the same function already enforces. Fixed by deriving `scope`/`scopeTarget` from the caller's `scopeFilter` via the existing `scopeFieldsFromFilter` helper (the same pattern already used at every other tool call site that creates scoped records), defaulting to `global` only when no scope filter is present (unscoped/orchestrator callers).

Regression test added (`tests/procedure-feedback-tool.test.ts`): registers a new procedure with `scopeFilter: {userId: "alice"}` and asserts the stored row has `scope: "user"`/`scopeTarget: "alice"`, and that a different tenant (`bob`) scope-reading the same id gets `null`. Verified via `git stash` to fail without the fix (stored as `scope: "global"`) and pass with it. tsc clean; biome clean (zero net-new — the test file's one pre-existing formatting finding predates this change, confirmed via `git stash`). Related suite (procedure-feedback-tool): 8 passed, no regressions.

---

## [2026.7.114] - 2026-07-06

### Fixed

Loop iteration 50 of the full-codebase review loop — fixes a cross-tenant fact-content leak flagged during iteration 34's sweep.

- **`resolveRecallInjectionText` hydrated a fragment's parent fact via an unscoped `getById`, leaking a different tenant's fact content into recall/injection output.** When a search result is a "fragment" (a chunked child of a larger document), this function looks up the parent fact by ID to build a `[§ parent title]` prefix — but the `factsDb.getById(parentId)` call carried no scope filter, so a cross-tenant ID collision (or, more directly, `register-agent-verb-tools.ts`'s multi-vault fan-out path, which the file's own adjacent SECURITY comment already flags as having this exact risk) could substitute a foreign tenant's parent fact text into the caller's recall output. All three production call sites were affected: `tools/memory/register-agent-verb-tools.ts`'s `memory_retrieve` handler (which already computes a `scopeFilter` a few lines above for its own `getEntry` scope-check, but never passed it to this call), `services/recalled-context-assembler.ts`'s `finalizeInjectionMemoryContent` (which also already receives a `scopeFilter` parameter), and `lifecycle/stage-injection.ts`'s auto-recall injection path (which had no scope filter computed at all). Fixed by adding an optional `scopeFilter` parameter to `resolveRecallInjectionText`, threading `factsDb.getById(parentId, { scopeFilter })`, and wiring each of the three call sites to their already-available (or, for `stage-injection.ts`, newly-added via the existing `resolveRecallScopeFilter(ctx)` helper) scope filter.

Regression test added (`tests/fragment-recall.test.ts`): stores a real parent fact scoped to `tenantB`, then calls `resolveRecallInjectionText` on a fragment referencing it with a `tenantA` scope filter (parent hydration must be skipped, falling back to the fragment's own text) versus a matching `tenantB` scope filter (parent hydration succeeds, proving the fix doesn't break the legitimate same-tenant case). Verified via `git stash` to fail without the fix (tenant B's parent text leaked into tenant A's result) and pass with it. tsc clean; biome clean (zero net-new against baseline — the touched files' pre-existing import-order/formatting findings predate this change, confirmed via `git stash`). Related suites (fragment-recall, lifecycle-stage-injection, recalled-context-assembler, memory-recall-injection-hardening, memory-journey-e2e): 53 passed, no regressions.

---

## [2026.7.113] - 2026-07-06

### Fixed

Loop iteration 49 of the full-codebase review loop — fixes a cross-tenant goal-content leak flagged during iteration 34's sweep.

- **`resolveGoalsForSubagentContext` loaded every tenant's task-ledger facts unscoped when resolving which goal is linked to a subagent session.** It calls `loadTaskLedgerFromFacts(factsDb)` — which accepts an optional `scopeFilter` but silently returns every tenant's rows when it's omitted — then matches each task's `subagent` field against the calling session's key via `sessionRefMatches` (an exact match, after normalization, with a few "main"/"private" canonical aliases). Session keys are generated by convention (often from a task/spawn label), not randomly per tenant, so two unrelated tenants using the same spawn-label convention could plausibly end up with the same session key — in which case this function would happily resolve and inject the *other* tenant's linked goal (label, description, acceptance criteria) into a subagent's prompt context. The sibling `active-task-tools-loader.ts`'s `loadActiveTasksForTools` already threads a `scopeFilter` through the exact same call, with an explicit SECURITY comment about this gap. Fixed by adding an optional `scopeFilter` parameter to `resolveGoalsForSubagentContext`, threading it into `loadTaskLedgerFromFacts`, and having both call sites (`lifecycle/stage-goal-context.ts`, `lifecycle/stage-goal-stewardship.ts`) derive it via `buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg)` — the same non-caller-trusting pattern already used by every tool-context call site in the codebase.

Regression test added (`tests/goal-context-injection.test.ts`): seeds two tenants' active-task facts sharing an identical subagent session key, each linked to its own goal, and asserts `resolveGoalsForSubagentContext` with a scoped filter resolves only the caller's own tenant's goal. Verified via `git stash` to fail without the fix (both tenants' goals resolved) and pass with it. tsc clean; biome clean (zero net-new against baseline — the touched files' formatting/import-order findings all predate this change, confirmed via `git stash`). Related suites (goal-context-injection, goal-stewardship-integration, heartbeat-facts-ledger): 22 passed, no regressions.

---

## [2026.7.112] - 2026-07-06

### Fixed

Loop iteration 48 of the full-codebase review loop — fixes a pending-cap bypass flagged during iteration 34's sweep, and closes out the last remaining item from that sweep's "batch 4" deferred list.

- **`countPendingUnifiedProposals` could undercount pending proposals when a burst of recent `procedure-skill` candidates crowded them out of the default 100-row list window.** `listUnifiedProposals()` gathers persona/crystallization/tool/procedure-skill proposals, sorts everything by `createdAt` descending, and truncates to `limit` (default 100) — only *after* that truncation does `countPendingUnifiedProposals` filter out `procedure-skill` entries to compute the real pending count. Since procedure-skill's `createdAt` is derived from `lastValidated`/`updatedAt` (near-current for freshly-validated procedures), a large batch of recently-validated procedures could occupy the entire top-100 window, truncating away older but still-genuinely-pending persona/tool/crystallization proposals before the type filter ever saw them — undercounting the real pending total and letting `enforceMaxPendingCap` admit more proposals than the configured cap. Fixed by having `countPendingUnifiedProposals` request an effectively unlimited row count from `listUnifiedProposals` so the procedure-skill exclusion runs before any truncation, not after.

Regression test added (`tests/unified-proposals.test.ts`): seeds one old pending persona proposal alongside 100 recently-validated procedure-skill candidates (enough alone to fill the default list window) and asserts `countPendingUnifiedProposals` still returns `1`. Verified via `git stash` to fail without the fix (returned `0` — the persona proposal was truncated away before the type filter ran) and pass with it. tsc clean; biome clean (zero net-new against baseline — both files' pre-existing import-order findings predate this change, confirmed via `git stash`). Related suites (unified-proposals, workshop-service, proposal-gateway-methods, proposal-routes): 44 passed, no regressions.

---

## [2026.7.111] - 2026-07-06

### Fixed

Loop iteration 47 of the full-codebase review loop — fixes an inflated-diagnostics bug flagged during iteration 34's sweep.

- **`parseBatchContent` in `services/reinforcement-batch-analyze.ts` counted a `parseFailures` diagnostic for every batch that needed JSON repair, even when the repair fully recovered the batch.** The sibling `self-correction-batch-analyze.ts` only increments `parseFailures` at the two actual failure exits (the repair attempt throwing, or repair returning no items) — this file incremented it eagerly *before* even attempting the repair, and never reverted it on the `repaired.items !== null` success path. Since `parseFailures` feeds operator-facing diagnostics and an adaptive-maintenance A/B penalty, a batch that ultimately parsed fine (just needed one repair pass — a routine occurrence, not a real failure) was still counted against both, understating repair effectiveness and over-penalizing otherwise-healthy batches.

Regression test added (`tests/reinforcement-batch-analyze.test.ts`): mocks a non-JSON LLM response with a successful `attemptAnalysisJsonRepair` recovery and asserts `result.diagnostics.parseFailures` is `0`. Verified via `git stash` to fail without the fix (`parseFailures` was `1` despite full recovery) and pass with it. tsc clean; biome clean (zero net-new against baseline — both files' pre-existing import-order findings predate this change, confirmed via `git stash`). Related suites (reinforcement-batch-analyze, cmd-extract-reinforcement-batch, reinforcement-analysis): 29 passed, no regressions.

---

## [2026.7.110] - 2026-07-06

### Fixed

Loop iteration 46 of the full-codebase review loop — fixes a lost-pattern bug on an interrupted maintenance run, flagged during iteration 34's sweep.

- **`runReflection` recorded its input as "processed" even when a maintenance-run deadline cut the pattern-storage loop short, permanently losing any patterns extracted but never stored.** After the LLM extracts candidate patterns, `reflect()` embeds/dedupes/stores each one in a loop that checks `maintenanceRunDeadlineReached()` per iteration and `break`s if the run is out of budget. Regardless of whether the loop finished all candidates or broke early, the function unconditionally wrote `reflection_input_hash` afterward (gated only on `!opts.dryRun`) — so on the next run, an identical set of recent facts would hash to the same value, hit the "input unchanged, skip LLM call" fast path, and the deadline-interrupted candidates would never be re-extracted or stored. Fixed by tracking whether the loop broke early (`deadlineReached`) and skipping the hash write in that case, so the next run re-extracts from scratch instead of silently treating a partial run as complete.

Regression test added (`tests/reflection.test.ts`, extending the existing "runReflection maintenance run deadline (#75)" suite): forces the deadline to cross during the top-level LLM call (same fixture as the existing deadline test) and asserts `setMaintenanceState` is never called with `"reflection_input_hash"`. Verified via `git stash` to fail without the fix (hash was written despite the interrupted loop) and pass with it. tsc clean; biome clean (zero net-new — no pre-existing findings in either file). Related suites (reflection, reflection-throttle-429, dream-cycle): 133 passed, 1 skipped, no regressions.

---

## [2026.7.109] - 2026-07-06

### Fixed

Loop iteration 45 of the full-codebase review loop — fixes a severity-ordering bug flagged during iteration 34's sweep.

- **`IssueStore.list()` ranked severity-filtered results by recency alone, so a burst of newer lower-severity issues could push an older, more severe one out of a capped result entirely.** `getOpenCriticalAndHighIssues()` (used by `searchAmbientIssues`'s always-on critical baseline and `runIssueRetrievalStrategy`'s RRF fusion) calls `issueStore.list({severity: ["critical", "high"], limit})`, then re-sorts the *already-truncated* result by severity in JS — but the DB query itself applied `ORDER BY created_at DESC LIMIT ?` before that JS sort ever ran, so an older `critical` issue could already be excluded from the row set entirely if enough newer `high`-severity issues existed within the same severity filter. Re-sorting rows that were never selected doesn't recover the missing ones. Fixed by having `list()` order by severity rank (critical > high > medium > low/other) before recency, but *only* when the caller has already narrowed the query with a `severity` filter — unfiltered/no-severity callers (Mission Control's dashboard listing, the plugin-shutdown "open issues" summary) keep their existing pure recency ordering unchanged.

Regression test added (`tests/issue-store.test.ts`): seeds one older `critical` issue and three newer `high` issues (via fake timers for deterministic `created_at` ordering), calls `list({severity: ["critical", "high"], limit: 3})`, and asserts the older critical issue survives the cap and sorts first. Verified via `git stash` to fail without the fix (critical issue excluded from the capped result) and pass with it. tsc clean; biome clean (zero net-new against baseline — the source file's one pre-existing import-order finding and the test file's three pre-existing `noNonNullAssertion` warnings in unrelated `linkFact` tests both predate this change, confirmed via `git stash`). Related suites (issue-store, issue-tools, issue-tools-scope-security, ambient-retrieval, issues-1901-1904, open-issues-regression-gaps): 159 passed, no regressions.

---

## [2026.7.108] - 2026-07-06

### Fixed

Loop iteration 44 of the full-codebase review loop — fixes a data-destruction bug in a double-failure rollback path flagged during iteration 34's sweep.

- **`CrystallizationProposer.restoreProposal`'s rollback path could delete the only surviving copy of a just-restored skill.** When restoring a quarantined skill, the skill directory is first moved on disk (quarantine → active output tree), then the DB row is flipped to `installed`. If that DB update fails (e.g. the proposal's status changed underneath it), the rollback tries to move the skill directory back to quarantine — but if *that* rename also fails (e.g. a permissions issue, or the quarantine parent directory can't be recreated), the `catch` block called `removeCrystallizedSkillDir(restoreResult.outputPath)`, which deletes the skill directory at its *current* (active) location. Since the file was moved, not copied, out of quarantine, this was the only remaining copy — the "rollback" for a double failure permanently destroyed the data instead of leaving it in place for manual reconciliation. Fixed by removing the destructive cleanup call: on a failed rollback, the skill directory is now left at its current active-tree location (orphaned from the DB's still-`quarantined` status, but intact) instead of being deleted.

Regression test added (`tests/crystallization-proposer-restore-rollback-data-loss.test.ts`): mocks `node:fs`'s `renameSync` to let the forward restore succeed but fail specifically on the rename-back-to-quarantine call, combined with a mocked `restoreFromQuarantine` DB failure (the existing double-failure trigger), and asserts the skill's `SKILL.md` still exists at its restored location afterward. Verified via `git stash` to fail without the fix (directory deleted, assertion failed) and pass with it. tsc clean; biome clean (zero net-new against baseline — the source file's one pre-existing import-order finding predates this change, confirmed via `git stash`). Related suites (crystallization-proposer, crystallization-proposer-restore-rollback-data-loss): 36 passed (1 known pre-existing failure unrelated to this change — a read-only-directory chmod test that doesn't hold under a root test runner), no new regressions.

---

## [2026.7.107] - 2026-07-06

### Fixed

Loop iteration 43 of the full-codebase review loop — fixes a shutdown-safety gap flagged during iteration 34's sweep.

- **`WorkboardRpcClient.isAvailable()` fired a live network/process call during plugin shutdown instead of honoring `shouldAbort`.** Every RPC method (`listCards`, `createCard`, etc.) routes through `rpc()`/`runWorkboardGatewayCliCall()`, both of which check `workboardRpcSkipped(method, shouldAbort)` before doing any I/O — but `isAvailable()` on both the HTTP client and the CLI-fallback client skipped that check entirely, so a caller probing availability during plugin shutdown (including `createWorkboardRpcClient`'s own `resolveClient()`, which calls `isAvailable()` before every method to pick a transport) would still issue a real `fetch` or spawn a real `openclaw gateway call` process. The CLI client's `isAvailable()` also never passed its `shouldAbort` through to `runWorkboardGatewayCliCall` at all, so even a caller checking the option elsewhere had no way to short-circuit this specific call. Fixed by adding the same `workboardRpcSkipped("workboard.isAvailable", options?.shouldAbort)` guard used everywhere else in the file to both implementations, returning `false` immediately instead of probing.

Regression tests added (`tests/workboard-rpc-client.test.ts`, 2 new): one per client (HTTP, CLI), each constructing the client with `shouldAbort: () => true` and asserting `isAvailable()` resolves to `false` without calling `fetch`/`spawn`. Verified via `git stash` to fail without the fix (both probes fired) and pass with it. tsc clean; biome clean (zero net-new against baseline — the file's two pre-existing import-order/formatter findings predate this change, confirmed via `git stash`). Related suites (workboard-rpc-client, workboard-facts-sync): 11 passed, no regressions.

---

## [2026.7.106] - 2026-07-06

### Fixed

Loop iteration 42 of the full-codebase review loop — fixes a TOCTOU duplicate-run race flagged during iteration 34's sweep.

- **`runPendingDigestAutopilotCron` released its apply-mode lock before writing the guard-window timestamp, letting a concurrent invocation slip through and run a full duplicate apply pass.** The guard-window check (`readGuardTimestampMs`) runs *before* lock acquisition, and the guard timestamp is only written after a successful run — but the write happened in a block placed entirely *after* the `try/finally` that released the lock, so releasing the lock and writing the guard timestamp were two separate, un-synchronized steps. A second cron invocation starting in the gap between them would read the *stale* pre-run guard timestamp (still outside the guard window), pass its own guard-check, then successfully acquire the now-freed lock and run its own full apply pass — defeating the guard window's entire purpose of preventing duplicate applies. Fixed by moving the guard-timestamp write into the `finally` block, immediately before the lock release, so any subsequent lock-acquirer is guaranteed to observe the updated timestamp.

Regression test added (`tests/pending-digest-autopilot-cron-guard-lock-order.test.ts`): mocks `node:fs`'s `writeFileSync`/`rmSync` to record call order, runs a full successful apply-mode cron pass, and asserts the guard-file write happens before the lock-file removal. Verified via `git stash` to fail without the fix (guard write observed *after* lock release) and pass with it. tsc clean; biome clean (zero net-new against baseline — the source file's two pre-existing formatter/import-order findings predate this change, confirmed via `git stash`). Related suites (pending-digest-autopilot-cron, pending-digest-autopilot-cron-guard-lock-order, pending-digest-autopilot-cron-notification-write-failure, pending-digest-autopilot): 32 passed, no regressions.

---

## [2026.7.105] - 2026-07-06

### Fixed

Loop iteration 41 of the full-codebase review loop.

- **`cli/cmd-extract-directives.ts` advanced its scan cursor past session files that failed to read, permanently dropping any directives they contained.** The CLI's `cursorBlockedReason` gate already covered three failure modes for *rejected directive candidates* (`parser_or_model_failure`, `bounded_partial_retry`, `retryable_rejections`) but had no case at all for `result.failures` — the count of session files that `runDirectiveExtract` couldn't even read (or whose lines failed to `JSON.parse`), tracked separately in `services/directive-extract.ts` since that content was never actually scanned for directives in the first place. Without a matching block, the cursor was advanced to `getMaxMtime(filePaths)` unconditionally, past every candidate file regardless of whether it was successfully read — so on the next incremental run, `resolveExtractSessionFilePaths(cfg, days, cursor.lastSessionTs)` would exclude the failed file forever, silently losing whatever directives it held. The sibling `cli/cmd-extract-procedures.ts` already gets this right, gating cursor advancement on `(result.readFailures ?? 0) === 0`. Fixed by adding a new `"session_read_failure"` `cursorBlockedReason`, checked first (before the existing rejection-based reasons, since an unread file is a stronger "we don't know what we missed" case), gated on `(result.failures ?? 0) > 0`.

Regression test added (`tests/extract-directives-cli.test.ts`): one valid session file plus a directory named like a `.jsonl` transcript (passes the filename-based candidate filter but throws `EISDIR` on `readFileSync` — a portable way to force a read failure without platform-specific permission tricks); asserts `cursorBlockedReason: "session_read_failure"`, `cursorAdvanced: false`, and the scan cursor stays unset. Verified via `git stash` to fail without the fix (cursor was advanced despite the read failure) and pass with it. tsc clean; biome clean (zero net-new against baseline, one own-code `as any`→`as never` touch-up). Related suites (extract-directives-cli, extract-directives-cli-status): 13 passed, no regressions.

### Investigated and NOT fixed (see corrected Deferred entry below)

- The previously-listed "`subagent_spawned` only guards `Done` not `Failed`" / "shared `TERMINAL` set omits `failed`" items were investigated this iteration and found to describe *intentional, tested* behavior, not a bug — see the corrected note in the Deferred section a few versions back. Reverted before committing after 9 existing tests failed against the attempted fix.

Loop iteration 40 of the full-codebase review loop (first iteration of a new 20-iteration batch, per user request to continue) — fixes a cross-tenant fact-content leak flagged since loop iteration 9 as needing a schema change.

- **`memory_verified_list` broadcast every tenant's verified-fact content to every other tenant.** `verified_facts` had no scope column at all — verifying a fact (`memory_verify`) copied its text into that global table with no way to distinguish which tenant it belonged to, and `memory_verified_list` unconditionally listed every row regardless of who was asking. `memory_verify`/`memory_verification_status` already gated on the caller's scope for the fact *lookup* (via `factsDb.getById(..., {scopeFilter})`), which blocked copying a foreign fact's text in — but that only prevented the initial write; it did nothing to scope the *read* side once a fact was legitimately verified by its own tenant. Any other tenant calling `memory_verified_list` still saw its full canonical text (first 120 chars) alongside their own. Fixed with a real schema migration: `VerificationStore.initSchema()` now adds `scope`/`scope_target` columns to `verified_facts` (guarded via `PRAGMA table_info`, matching the codebase's established migration pattern; NULL/pre-migration rows default to `'global'`, i.e. visible to everyone, preserving existing behavior for already-verified facts). `verify()` now accepts and stores the source fact's `scope`/`scopeTarget` (threaded through from `memory_verify`'s already-scope-checked lookup, `memory_store`'s auto-verify path using the newly-stored entry's own scope, and the Mission Control dashboard's verify action); `update()` carries the original entry's scope forward onto new versions. `listLatestVerified()` now accepts an optional `scopeFilter` and filters via the same `scopeFilterClauseForAlias` helper used elsewhere in the codebase; `memory_verified_list` passes the caller's resolved scope filter through. Mission Control's own dashboard collectors intentionally keep calling `listLatestVerified()` unscoped (admin surface, same precedent as the iteration-35 change-feed fix) — verified visibility there is unaffected.

Regression tests added (`tests/verification-store.test.ts`, 4 new): default scope is `'global'` when unspecified; `update()` carries scope forward; `listLatestVerified()` with no filter returns every tenant's facts (admin case); with a scope filter, only returns the caller's own scope plus global facts, not a different tenant's. The scoped-filter test is the direct proof of the fix — verified via `git stash` to fail without it (all three tenants' facts returned, including the foreign one) and pass with it. tsc clean; biome clean (zero net-new against baseline). Related suites (verification-store, verification-tools-scope-security, verified-fact-triage, memory-store-early-validation, memory-store-merge-dedupe-vector, dashboard-routes, dashboard-server, health-dashboard, memory-store-event-log, memory-store-variant-queue, memory-store-vault-vector-isolation): 232 passed, no regressions.

---

## [2026.7.103] - 2026-07-06

### Fixed

Loop iteration 39 of the full-codebase review loop — fixes a data-loss bug on task completion.

- **`active_task_checkpoint`'s closing call silently dropped its own closing note, title, and goal link when a tracked task already had an active row.** `syncMarkdownLedgerFromCheckpoint`'s terminal-status branch (`services/active-task-checkpoint.ts`) calls `completeTask(active, checkpoint.entity)` to mark a task done, but `completeTask` (`services/active-task.ts`) only spreads the *stale, pre-call* active row — it has no way to know this call's fresh `next`/`title`/`relatedGoal` values, which the function already builds into a separate `entry` object from the checkpoint's current input. So calling `active_task_checkpoint({entity: "forge-99", status: "done", next: "PR #42 merged, verified in prod", title: "..."})` on a task whose active row currently held `next: "Run smoke tests"` produced a "## Completed" row in `ACTIVE-TASKS.md` still showing the *old* "Run smoke tests" and title, discarding the closing note supplied in that same call. Only affects `ledger: "markdown"` mode (the facts backend isn't affected, and the no-prior-active-row fallback branch already used the fresh values correctly — confirming this was an inconsistency, not intentional). Fixed by overlaying the fresh `entry.description`/`entry.next`/`entry.relatedGoal` onto `completeTask`'s result before writing, leaving its `status`/`subagent`/`updated`/handoff-clearing fields untouched.

Regression test added (`tests/active-task-checkpoint.test.ts`): checkpoints a task twice — once in-progress with an initial `next`, then again with `status: "done"` and a new closing `next`/`title` — and asserts the completed row reflects the closing call's values, not the stale ones. Verified via `git stash` to fail without the fix (completed row showed the stale "Run smoke tests"/title) and pass with it. tsc clean; biome clean (zero net-new). Related suites (active-task-checkpoint, task-ledger-facts, active-task): 211 passed, no regressions.

---

## [2026.7.102] - 2026-07-06

### Fixed

Loop iteration 38 of the full-codebase review loop — restores the `memory_workshop` tool, which was completely unusable for its main actions.

- **`memory_workshop`'s `approve`/`reject`/`quarantine`/`revise`/`undo`/`inspect` actions were always intercepted before `execute()` ran.** `utils/tool-search-wrapper-args.ts`'s Tool Search wrapper-argument-loss detector falls back to a coarse "sentinel_only" heuristic for any `memory_*` tool not listed in `MEMORY_TOOL_EXPECTED_ARG_KEYS` — that heuristic flags a call as wrapper-dropped whenever the params object contains a key named `id`, regardless of whether `id` carries a meaningful value. `memory_workshop` was never added to the map (unlike its sibling approve/reject tools — `memory_crystallize_approve`, `memory_tool_approve`, `memory_tool_reject`, etc. — which are all correctly listed), so every legitimate call using `id` (the normal, documented way to invoke these six actions) was silently intercepted and replaced with a canned "received empty or wrapper-only arguments" error — only `list`/`digest`/`revert_by_ordinal` (which don't use `id`) ever worked. Fixed by adding `memory_workshop: ["id", "ordinal"]` to `MEMORY_TOOL_EXPECTED_ARG_KEYS`, switching it to the precise "mapped" detection mode (which already has special-case handling to distinguish a genuine `id` tool argument from wrapper metadata).

Regression test added (`tests/tool-search-wrapper-args.test.ts`): a genuine `memory_workshop` `approve` call (`{action: "approve", id: "..."}`) must reach `execute()`, not the wrapper-dropped short-circuit. Verified via `git stash` to fail without the fix and pass with it. tsc clean; biome clean (zero net-new against baseline). Related suites (tool-search-wrapper-args, workshop-service, workshop-collectors, workshop-service-sync, workshop-config): 35 passed, no regressions.

---

## [2026.7.101] - 2026-07-06

### Fixed

Loop iteration 37 of the full-codebase review loop — fixes a PII/secret redaction gap flagged during iteration 34's sweep.

- **`redactAutopilotText`'s credential-keyword patterns never matched a JSON-serialized secret.** The `SECRET_PATTERNS` regex for `password`/`secret`/`token`/`api_key`/`authorization` required its `:`/`=` to follow the keyword with only whitespace in between (`\s*[:=]`). A JSON-serialized credential — `{"password":"hunter2"}` — has a closing quote between the keyword and the colon (`password":`), which `\s*` never matches, so the entire pattern silently failed to match and the secret passed through unredacted. This is reachable in practice: `redactAutopilotText` is called directly on captured shell/API command strings (`procedure-skill-recipe.ts`'s `args.command`) and other free text that can plausibly embed a JSON body with credentials (e.g. a captured `curl -d '{"password":"..."}'` invocation), and those redacted strings are written into audit logs, verification metadata, and skill-recipe artifacts. Fixed by widening the pattern to `[\s"']*[:=]`, tolerating an optional JSON closing quote (or single quote) between the keyword and the operator.

Regression test added (`tests/pending-autopilot-redaction.test.ts`, 4 cases): a bare JSON-serialized password, multiple JSON-serialized secret/token/api_key values, the original plain `key: value` form (no regression), and a JSON credential embedded inside a captured shell command. Verified via `git stash` to fail without the fix (3 of 4 cases leaked the secret) and pass with it. tsc clean; biome clean (zero net-new). Related suites (skill-quality-hardening, procedure-promotion-policy, procedure-skill-recipe, procedure-skill-generator, procedure-skill-workflow, pending-digest-autopilot-cron): 106 passed, no regressions.

---

## [2026.7.100] - 2026-07-06

### Fixed

Loop iteration 36 of the full-codebase review loop — fixes the next highest-severity item from the Deferred backlog: superseded facts resurfacing in `memory_recall`.

- **`backends/facts-db/links.ts`'s `getConnectedFactIds` (the legacy, non-CTE graph-traversal path) let a superseded (corrected/replaced) fact serve as an intermediate hop or resurface directly as a `memory_recall` result.** This function traverses `memory_links` with no join against `facts` at all, unlike the newer CTE-based `expandGraphWithCTE`, which explicitly filters `f.superseded_at IS NULL` at every hop specifically to prevent this. The legacy path is still the one exercised by default: `memory_recall` only uses the newer `expandGraph`/CTE path when `graphRetrieval.defaultExpand` is explicitly enabled — under the shipped default (`graph.enabled=true`, `graph.useInRecall=true`, `graphRetrieval.defaultExpand` unset/false), every ordinary `memory_recall` call goes through `getConnectedFactIds` followed by `getById(id, {asOf, scopeFilter})` to hydrate each connected id — and `getById` has no `superseded_at` check of its own either (its SQL is a bare `SELECT * FROM facts WHERE id = ?`, and its `applyLookupFilters` post-check only validates `asOf`/`scopeFilter`). So once a fact is superseded by a correction but a `memory_links` edge to it survives, the stale fact keeps resurfacing in recall results — silently undoing the correction for anyone relying on graph-linked recall. Fixed by joining `facts` and filtering `f.superseded_at IS NULL` in `getConnectedFactIds`'s neighbor-selection queries, mirroring `expandGraphWithCTE`'s exact pattern; falls back to the unfiltered queries when the `facts` table (or its `superseded_at` column) doesn't exist, matching the file's existing `denormDegreeStmt` fallback convention for minimal-schema tests.

Regression test added (`tests/facts-db-modules.test.ts`): a "seed" fact links to a "corrected" fact that has since been superseded by a "correction" fact; asserts traversal returns only `["seed"]`, with neither the superseded fact nor anything reachable only through it appearing. Verified via `git stash` to fail without the fix (returned `["seed", "corrected", "correction"]`) and pass with it. tsc clean; biome clean (zero net-new, 1 own formatting touch-up applied). Related suites (facts-db-modules, graph-retrieval, graph-tools-scope-security, graphql-link-scope-security, facts-db, dashboard-graph): 272 passed, 3 skipped, no regressions.

---

## [2026.7.99] - 2026-07-06

### Fixed

Loop iteration 35 of the full-codebase review loop — fixes the highest-severity item from iteration 34's Deferred backlog: a cross-session IDOR in the change-feed HTTP routes and gateway RPC methods.

- **`tools/proposal-routes.ts`'s `/plugins/memory-changes/list`/`/revert` and `tools/proposal-gateway-methods.ts`'s `hybrid-mem.changes.list`/`hybrid-mem.changes.revert` let a caller name an arbitrary `session`/`sessionKey` to read or revert a *different* session's proposal/change-feed history.** These endpoints derived their scoping session entirely from client-supplied input (`?session=` query param, or `body.session`/`body.sessionKey`/`params.sessionKey`, via `resolveWorkshopRevertSessionKey`, which prioritizes the explicit param over the caller's real session) — never checking it against the caller's own trusted session identity (`api.context.sessionKey`/`sessionId`, which the caller cannot spoof). Any caller who knew or guessed another session's key could list that session's full change history, or revert its pending/applied proposals (persona edits, tool/skill changes, crystallizations) by ordinal. Separately, the id-based revert path (`revertChangeById`) resolves purely by primary key with no session check of its own at all — even a properly-scoped caller could revert an arbitrary other session's change event just by supplying its id, since `revertChangeByOrdinal`'s scoped `getByOrdinal(sessionKey, ordinal)` lookup has no equivalent in the id-based path. Fixed by adding `isAuthorizedChangeFeedSessionKey()` (`services/workshop-config.ts`), which only allows the caller's own trusted session or the `__broadcast__` pseudo-session, applied to both the list-scoping session and (for id-based revert) the resolved event's actual `sessionKey` before reverting. Mission Control's dashboard is unaffected — it calls the change-feed service directly in-process and never goes through these caller-facing HTTP/RPC entry points, so its own legitimate cross-session admin access still works.

Regression tests added (6 new tests across `tests/proposal-routes.test.ts` and `tests/proposal-gateway-methods.test.ts`): list/revert-by-ordinal reject a session/sessionKey mismatched from the caller's trusted identity, and revert-by-id rejects an event belonging to a different session even when no explicit override is supplied. All 6 verified via `git stash` to fail without the fix (reachable, one variant even proceeding into an unrelated downstream error rather than being blocked upfront) and pass with it. Two pre-existing tests needed their mock `api.context` updated to a matching session identity, since they simulate a legitimate same-session call. tsc clean; biome clean (zero net-new against baseline, including 2 own new-code non-null-assertions converted to optional chaining to avoid new lint warnings). Related suites (proposal-routes, proposal-routes-body, proposal-gateway-methods, change-feed-revert, change-feed, change-feed-lifecycle-e2e, workshop-config, workshop-tool): 71 passed, no regressions.

---

## [2026.7.98] - 2026-07-06

### Fixed

Loop iteration 34 of the full-codebase review loop. This iteration's review fanned out into a very large multi-agent sweep covering nearly the entire repository (CLI commands, services, tools, routes, utils); one high-severity process-crash bug is fixed here, and the many other confirmed findings from the sweep are tracked below for upcoming iterations rather than combined into one commit.

- **`raceWithAbortSignal` (`utils/signal-race.ts`) could crash the whole host process on an unrelated, intentionally-non-fatal promise rejection.** The helper's internal cleanup call, `promise.finally(() => signal.removeEventListener(...))`, returns a *new* promise that rejects whenever the raced `promise` rejects — a separate promise object from the one `Promise.race` and the caller's own `await`/`.catch()` observe. Left unconsumed, that derived promise became a genuine unhandled promise rejection any time the raced promise rejected (regardless of whether the abort signal ever actually fired), which crashes the Node process under the default `--unhandled-rejections=throw` behavior. The only current call site, `lifecycle/stage-recall/run-recall.ts`'s `embed()` calls, wraps this helper in a `try/catch` specifically to make embedding failures non-fatal during recall-stage cancellation — but that try/catch never got a chance to matter, since the orphaned `.finally()` promise crashed the process independently of it. Fixed by attaching a no-op `.catch()` to the derived promise.

Regression test added: races a promise that rejects (via `setTimeout`) with a signal, listens for `process.on("unhandledRejection", ...)` during the call, and asserts none fired. Verified via `git stash` to fail without the fix (unhandled rejection observed) and pass with it. tsc clean; biome clean (zero net-new). Related suites (recall-pipeline, lifecycle-stage-recall, constrained-recall, degraded-recall): 59 passed, no regressions. Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (confirmed findings from iteration 34's sweep, not yet fixed — grouped by rough severity)

**Data loss / correctness:**
- ~~Lost-update race between the heartbeat/cron `reconcileActiveTaskInProgressSessions` and `active_task_checkpoint` on `ACTIVE-TASKS.md` (plain read-then-write, no optimistic-concurrency check unlike sibling writers).~~ — **fully fixed**: `reconcileActiveTaskInProgressSessions`'s half in loop iteration 66, `syncMarkdownLedgerFromCheckpoint`'s half in loop iteration 67 (see below).
- ~~`lifecycle/stage-cleanup.ts`'s `subagent_spawned` handler only guards against reopening a `"Done"` task, not `"Failed"`~~ — **investigated in loop iteration 41 and NOT a bug**: `subagent_spawned` reopening a `"Failed"` task is deliberate, tested behavior (`stage-cleanup-facts-ledger.test.ts`'s "subagent_spawned reopens Failed tasks when session metadata is present" / "...clears stale handoff when reopening Failed tasks") — a new subagent dispatched against a failed task's label is an explicit retry and is meant to reopen it. Separately, adding `"failed"` to the shared `TERMINAL` set in `services/task-ledger/canonical.ts` breaks `factNewerThan`'s timestamp-tie-break comparator (which prefers "terminal" status on a tie) — it would let a stale `"failed"` fact block a legitimate retry's fresh `"in_progress"` write when both share the same second-granularity `createdAt`, confirmed by 9 existing test failures across `task-ledger-facts.test.ts`/`stage-cleanup-facts-ledger.test.ts` when tried. If the narrower gap (an arbitrary `memory_store` call regressing a `Failed` project-task status via `mirrorMemoryStoreToActiveTaskLedger`'s guard at `task-ledger-facts.ts:136`, which is a *different* write path than `subagent_spawned`'s `syncActiveTaskEntryToFacts`) still needs closing, it must be done as a change local to that one guard, not via the shared `TERMINAL` set.
---

## [2026.7.97] - 2026-07-06

### Fixed

Loop iteration 33 (thirteenth iteration of the third batch) of the full-codebase review loop — resolves the merge-dedupe vector desync deferred at the end of iteration 32.

- **`memory_store`'s normal ADD path re-embedded and stored the pre-merge text fragment instead of the actual merged fact text.** When `storeWithResult()` merges a new `memory_store` call's text onto an existing fact (`newlyStored: false`, `embeddingStale: true` — the persisted `entry.text` becomes `existing.text + "\n" + textToStore`, truncated to 4000 chars), the ADD-path post-store block (`tools/memory/register-store-tools.ts`) re-embedded and stored the vector using the pre-merge `textToStore` and the vector already computed from it *before* the merge was known, not `entry.text`. This left the vector backend (LanceDB) encoding only the newly-added text fragment while the fact row's real, persisted text was the full merged content — silently desyncing the two backends for that fact, so vector recall on the merged-in portion of the text would never surface it. The classify-before-write UPDATE-merge branch already handled this correctly by re-embedding `newEntry.text`; the normal ADD path (the majority of `memory_store` calls) did not. Fixed by detecting the merge case (`storeResult.newlyStored === false && storeResult.embeddingStale === true`) and re-embedding from `entry.text` (the actual persisted content) instead of `textToStore`, mirroring the UPDATE-branch fix.

Regression test added: stores a fact, then stores a case-only-different duplicate with `onDuplicate: "merge"` configured (bypassing the cheap `hasDuplicate` pre-check, which would otherwise bounce the same hash match before `storeWithResult` runs), and asserts the vector backend's `store()` call receives the merged text, not the pre-merge fragment. Verified via `git stash` to fail without the fix and pass with it. tsc clean; biome clean (zero net-new against baseline). Related suites (facts-db, dedupe-policy, store-fact-dedupe-race, memory-store-event-log, capture-dedup-window, distill-vector-dedupe, memory-store-vault-vector-isolation): 235 passed, 3 skipped, no regressions. Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (carried over from iteration 27; still tracked for future iterations)

- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

---

## [2026.7.96] - 2026-07-06

### Fixed

Loop iteration 32 (twelfth iteration of the third batch) of the full-codebase review loop — picks up another deferred finding from iteration 27's multi-agent sweep.

- **Document-ingestion dedup (`memory_ingest_document`) had no scope predicate, leaking cross-tenant existence/count and blocking legitimate re-ingestion.** `countBySource()` (`backends/facts-db/housekeeping.ts`), used to detect "this exact file was already ingested" via a content-hash `source` fingerprint, ran with no scope filter at all — unlike the per-chunk store call a few lines later in the same file, which correctly resolves `docScope`/`docScopeTarget` via `resolveDefaultStoreScope` (Issue #1574/FR-006). In a multi-agent deployment, Tenant A ingesting a document permanently blocked Tenant B from ever ingesting the same byte-identical file (silently rejected as `skipped_duplicate`), and the rejection response's `chunkCount` disclosed how many chunks Tenant A's ingestion produced — a cross-tenant existence/count side-channel. Fixed by adding an optional `scopeFilter` parameter to `countBySource()` (default unrestricted, preserving the two other call sites — `context-engine.ts`'s session-key bookkeeping and `register-storage-maintenance.ts`'s global SLO metric — which are correctly unscoped) and threading the document's own resolved scope through it in `document-tools.ts`, hoisting the existing `resolveDefaultStoreScope()` call earlier so both the dedup check and the per-chunk stores share one computation.

Regression test added (Tenant A ingests, then Tenant B ingests the same byte-identical file and must not be rejected as a duplicate), verified via `git stash` to fail without the fix (Tenant B's ingestion returned `skipped_duplicate` with no `storedCount`) and pass with it. tsc clean; biome clean (2 own-code formatting/lint touch-ups applied, zero net-new issues against baseline — baseline actually had 4 pre-existing errors in these files that a `biome check --write` incidentally cleaned up as a side effect of reordering imports around the new ones). Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (carried over from iteration 27; still tracked for future iterations)

- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- `register-store-tools.ts`'s merge-dedupe path storing a mismatched text/vector pair.
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

## [2026.7.95] - 2026-07-06

### Fixed

Loop iteration 31 (eleventh iteration of the third batch) of the full-codebase review loop — picks up another deferred finding from iteration 27's multi-agent sweep.

- **`memory_record_episode`'s `scopeTarget` was derived independently from the declared `scope`, and ignored the caller's own explicit `sessionId`/`userId`/`agentId` params entirely.** `scope` was taken directly from the caller's tool param, but `scopeTarget` was computed as `scopeFilter?.sessionId ?? scopeFilter?.userId ?? scopeFilter?.agentId ?? null` — using only the internally-*resolved* scope filter (which, for this pair of tools, only ever reflects `currentAgentIdRef`/config, since `buildToolScopeFilter` is called with an empty `params: {}`), never the tool call's own `sessionId`/`userId`/`agentId` fields. A caller declaring `scope: "session", sessionId: "abc"` (both fields the tool's own schema explicitly supports) got a `scope_target` value unrelated to `"abc"` — in the common single-agent default config, the public-API "unscoped" sentinel (`__public_api_unscoped__`) leaked into the column instead. The episode was still recorded and the tool call succeeded, but it became permanently unfindable by any query actually scoped to that session, since `scopeFilterClausePositional` only matches `scope='session'` rows against a real session id. Fixed by deriving `scopeTarget` from whichever field actually corresponds to the declared `scope` (explicit param first, then the resolved scope filter's matching field), and excluding the sentinel from ever being stored as a real agent scope target (mirrors `scopeFieldsFromFilter`'s existing sentinel handling).

Regression tests added (session/user/agent scope each get the correct scopeTarget; the sentinel never leaks), verified via `git stash` to fail without the fix and pass with it — all three failed identically on the stash-out run, confirming the bug was reachable via the caller's own explicit params, not just an edge case. tsc clean; biome clean (one own-code formatting fix applied via `biome check --write`, zero net-new elsewhere). Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (carried over from iteration 27; still tracked for future iterations)

- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- `backends/facts-db/housekeeping.ts`'s `countBySource()` missing a scope predicate (cross-tenant document-ingestion dedupe/count leak).
- `register-store-tools.ts`'s merge-dedupe path storing a mismatched text/vector pair.
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

## [2026.7.94] - 2026-07-06

### Fixed

Loop iteration 30 (tenth iteration of the third batch) of the full-codebase review loop — picks up another deferred finding from iteration 27's multi-agent sweep.

- **`memory_store`'s embedding write ignored the caller's `vault` parameter, breaking vault isolation.** `memory_store` correctly resolves vault-scoped backends via `resolveToolVaultBackends(runtime, vault)` and inserts the fact row into the named vault's SQLite DB — but every call to `storeActiveCanonicalVector` (the wrapper around `storeCanonicalVectorForFact`) took no `factsDb`/`vectorDb` argument at all, so it always used the *default*-vault instances captured once in a closure at plugin init (`tools/memory/build-runtime.ts`). Storing a fact with `vault: "work"` therefore inserted the row correctly into the `work` vault's SQLite DB, but wrote its semantic embedding into the *default* vault's LanceDB instead — silently breaking the documented "vaults are isolated silos" guarantee (`services/vault-registry.ts`): the `work`-vault fact became permanently unreachable by semantic/hybrid recall from its own vault (only keyword/FTS still found it), while the default vault's LanceDB accumulated an orphan vector tied to a factId that doesn't exist in its own facts.db. Fixed by making `storeActiveCanonicalVector` require explicit `factsDb`/`vectorDb` parameters (matching the sibling `storeRegistryEmbeddings` helper's existing pattern) and threading the vault-resolved `storeFactsDb`/`storeVectorDb` through all four call sites in `register-store-tools.ts`.

Regression test added (asserts the named vault's mock `vectorDb.store` is called and the default vault's is not, plus the inverse sanity check for the no-`vault` case), verified via `git stash` to fail without the fix and pass with it. tsc clean; biome clean (zero net-new issues). Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (carried over from iteration 27; still tracked for future iterations)

- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- `backends/facts-db/housekeeping.ts`'s `countBySource()` missing a scope predicate (cross-tenant document-ingestion dedupe/count leak).
- `tools/memory/register-episode-tools.ts`'s inconsistent `scope`/`scopeTarget` derivation (episodes that become permanently unfindable).
- `register-store-tools.ts`'s merge-dedupe path storing a mismatched text/vector pair (separate from the vault-isolation fix above).
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

## [2026.7.93] - 2026-07-06

### Fixed

Loop iteration 29 (ninth iteration of the third batch) of the full-codebase review loop — picks up the next deferred finding from iteration 27/28's multi-agent sweep.

- **`tools/issue-tools.ts` had no scope-filter wiring at all**, unlike every other fact-touching tool subsystem (`graph-tools.ts`'s `memory_link` has an explicit "SECURITY" comment for this exact pattern; `tools/memory/*` threads a scope filter through every call). `IssueToolsContext` never received `currentAgentIdRef`/`buildToolScopeFilter` from `setup/tool-installers.ts`, so `memory_issue_link_fact` linked a caller-supplied `factId` with no existence or scope check whatsoever, and the auto-linking triggered by `memory_issue_create`/`memory_issue_update` (`services/issue-fact-correlation.ts`'s `autoLinkIssueToFacts`) searched and hydrated facts with no `scopeFilter` at all. In a multi-tenant deployment, either path could tie another tenant's fact into `issue.relatedFacts`, disclosed back to any caller via `memory_issue_list`/`memory_issue_get`. Fixed by wiring `currentAgentIdRef`/`buildToolScopeFilter` through the issue-tools installer (mirroring `graph-tools`/`provenance-tools`/`verification-tools`), threading a `scopeFilter` option through `autoLinkIssueToFacts`'s search and per-result `getById` re-check, and adding the same existence/scope guard `memory_link` already has to `memory_issue_link_fact`.

Regression tests added (cross-tenant link rejection, own-scope sanity check, and an auto-link cross-tenant check), verified via `git stash` to fail without the fix and pass with it. tsc clean; biome clean (zero issues in the new test file, zero net-new in the touched source files against baseline). Full background vitest suite: only the 3 known pre-existing unrelated failures.

### Deferred (carried over from iteration 27/28; still tracked for future iterations)

- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- `backends/facts-db/housekeeping.ts`'s `countBySource()` missing a scope predicate (cross-tenant document-ingestion dedupe/count leak).
- `tools/memory/register-episode-tools.ts`'s inconsistent `scope`/`scopeTarget` derivation (episodes that become permanently unfindable).
- `tools/memory/register-store-tools.ts`'s `storeActiveCanonicalVector` ignoring the `vault` parameter (cross-vault embedding leak/loss) and a merge-dedupe path storing a mismatched text/vector pair.
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

## [2026.7.92] - 2026-07-06

### Fixed

Loop iteration 28 (eighth iteration of the third batch) of the full-codebase review loop — picks up the two highest-severity deferred findings from iteration 27's multi-agent sweep.

- **`tools/public-api-routes.ts`'s session-observability HTTP route let a user-scoped caller read an arbitrary other session's data.** The route's only defense against untrusted `sessionId`/`agentId` query params was a catch-all check that rejected them solely when *all three* trusted identity headers (`x-openclaw-session-id`, `-agent-id`, `-user-id`) were absent. A caller authenticated with only `x-openclaw-user-id` (a user-scoped token not bound to one session/agent — the gateway's own supported identity model) defeated this check entirely: `GET .../session?sessionId=<other session>` with just that one header returned the target session's full audit/episode/capture/recall/injection report. Fixed by replacing the flawed three-header catch-all with two precise per-field checks — a `sessionId`/`agentId` query param is now only ever honored when the *matching* trusted header (`x-openclaw-session-id`/`x-openclaw-agent-id` respectively) is also present, closing the gap without touching the existing mismatch checks for when both are present but disagree.
- **`goal_update` had no terminal-status guard at all**, unlike `goal_assess`/`goal_complete`/`goal_abandon` (all fixed for exactly this class of race in #37 and iteration 27). A caller could freely rewrite a goal's `description`/`acceptanceCriteria`/`priority` after it was already completed/failed/abandoned — an audit-integrity gap, since the acceptance criteria a completed goal was actually judged against could silently change afterward. Fixed with the same pre-lock-check-plus-recheck-inside-the-lock pattern used for the other three tools, reporting "already `<status>`; not updated" instead of claiming success when the goal turns out to already be terminal.

Regression tests added for both (an HTTP-level bypass test plus a sanity test that a legitimately session-scoped caller is unaffected, and a terminal-goal-rewrite test), verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 27; still tracked for future iterations)

- `tools/issue-tools.ts` / `services/issue-fact-correlation.ts`'s missing `scopeFilter` on auto-linking searches (cross-tenant fact-ID disclosure via `issue.relatedFacts`).
- `backends/issue-store.ts`'s `transition()`/`update()` lacking compare-and-swap protection (cross-process race only).
- `backends/facts-db/housekeeping.ts`'s `countBySource()` missing a scope predicate (cross-tenant document-ingestion dedupe/count leak).
- `tools/memory/register-episode-tools.ts`'s inconsistent `scope`/`scopeTarget` derivation (episodes that become permanently unfindable).
- `tools/memory/register-store-tools.ts`'s `storeActiveCanonicalVector` ignoring the `vault` parameter (cross-vault embedding leak/loss) and a merge-dedupe path storing a mismatched text/vector pair.
- Lower-severity items: an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an unwired ESPHome YAML converter, an entity-lookup pre-filter that doesn't fan out across vaults in `register-recall-tools.ts`.

## [2026.7.91] - 2026-07-06

### Fixed

Loop iteration 27 (seventh iteration of the third batch) of the full-codebase review loop — a large multi-agent sweep across `lifecycle/`, `tools/`, and the goal state machine, following up on the terminal-status-guard theme established under issue #37.

- **`terminateGoal()` had no terminal-status guard, unlike every other status-mutating helper in the goal state machine.** `goal_complete`/`goal_abandon` both do a pre-lock `isTerminalStatus()` check in `tools/goal-tools.ts`, but `services/goal-registry.ts`'s `terminateGoal()` re-reads the goal fresh inside its lock and unconditionally overwrites `status` — the exact TOCTOU race window the `isTerminalStatus()`-inside-the-lock pattern (established for `linkSubagentToGoal`/`markGoalDispatchFailure` under #37, and `workboard-facts-sync.ts` in iteration 25) exists to close. Two calls racing on the same goal (e.g. `goal_complete` and `goal_abandon` both invoked before either write lands) could silently flip an already-terminated goal to a different terminal status and append a redundant, contradictory history entry, while both callers' post-completion side effects (memory flush, episode recording) fired as if each had authoritatively terminated the goal. Fixed by making `terminateGoal()` idempotent (a goal already terminal when re-read inside the lock is returned unchanged, no history append, no event-log entry), and updating both `goal-tools.ts` call sites to report "already `<status>`" instead of claiming success when the returned goal's status doesn't match what was requested.
- **`goal_assess`'s `computeAssessDecision` never re-checked terminal status against the lock-fresh goal.** The tool's pre-lock check (`if (isTerminalStatus(goal.status)) return ...`) only guards against a goal that was *already* terminal before the call started — same race window as above. Worse than the `terminateGoal` case: if the assessment/dispatch budget was exhausted or the circuit breaker tripped, the computed patch explicitly sets `status: "blocked"`, which would have silently *reopened* a goal a concurrent `goal_complete`/`goal_abandon` had just closed. Fixed by adding an `isTerminalStatus(fresh.status)` check at the top of `computeAssessDecision` (mirroring the pattern already used for the budget re-checks in the same function), returning a new `"terminal"` outcome that skips the assessment entirely.

Regression tests added for both fixes (including a TOCTOU race test for each, mirroring the `goal-subagent.test.ts`/`workboard-facts-sync.test.ts` pattern via `vi.spyOn` on the pre-lock read), verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found this iteration via a broad multi-agent sweep of `lifecycle/`, `tools/`, and `backends/`; tracked for future iterations)

- `tools/issue-tools.ts` / `services/issue-fact-correlation.ts`: `memory_issue_link_fact` and the auto-linking triggered by `memory_issue_create`/`memory_issue_update` call `factsDb.search`/`factsDb.getById` with no `scopeFilter` at all — the same recurring cross-tenant scope-gap pattern fixed repeatedly this loop, here allowing another tenant's fact IDs to be linked into (and disclosed via) `issue.relatedFacts`.
- `tools/goal-tools.ts`: `goal_update` has no `isTerminalStatus()` guard at all (unlike `goal_assess`/`goal_complete`/`goal_abandon`), so a caller can freely rewrite `description`/`acceptance_criteria`/`priority` on an already-terminal goal — an audit-integrity gap, though it doesn't touch `status` itself.
- `backends/issue-store.ts`: `transition()`/`update()` do a plain read-then-write with no compare-and-swap guard or transaction, unlike the same file's `linkFact()` (already fixed for this exact class of bug with an `IMMEDIATE` transaction). Cross-process only (same-process calls are synchronous with no `await` between read and write), but `IssueStore` is explicitly designed for multi-process access.
- `backends/facts-db/housekeeping.ts`'s `countBySource()` (used by `tools/document-tools.ts`'s document-ingestion dedupe) has no scope predicate — one tenant ingesting a document silently blocks every other tenant from ever ingesting the same byte-identical file, and discloses the other tenant's chunk count as a side channel.
- `tools/public-api-routes.ts`'s session-observability HTTP route: the trusted-header mismatch checks are only evaluated per-field, and the catch-all rejection only fires when *all three* trusted headers are absent — a caller authenticated with only `x-openclaw-user-id` can supply an arbitrary `sessionId`/`agentId` query param and read another user's session-observability report. Needs careful verification before a fix (auth-logic change, highest severity of the deferred items).
- `tools/memory/register-episode-tools.ts`: `memory_record_episode`'s `scope`/`scopeTarget` are derived independently (declared `scope` from the caller param, `scopeTarget` from an unrelated session>user>agent priority order on the runtime's own scope filter) instead of via the shared `scopeFieldsFromFilter()` helper every other scope-writing call site uses — in the common single-agent default config, this can silently write an episode that can never be found again by any query.
- `tools/memory/register-store-tools.ts`: `memory_store` with an explicit `vault` parameter stores the fact row in the named vault's SQLite DB but writes its embedding vector into the *default* vault's LanceDB (`storeActiveCanonicalVector` takes no vault-scoped DB argument), silently breaking vault isolation for semantic recall. A separate merge-dedupe path in the same file stores a vector embedded from pre-merge text under the post-merge (combined) `factId`, leaving the two backends' content out of sync for that fact.
- Several lower-severity/lower-confidence items also surfaced (an off-by-one output-line overwrite in `tools/apitap-tools.ts`, an inverted enabled/disabled detection in an ESPHome YAML converter not currently wired into any production path, an entity-lookup pre-filter that doesn't fan out across vaults) — not prioritized given their limited impact.

## [2026.7.90] - 2026-07-06

### Fixed

Loop iteration 26 (sixth iteration of the third batch) of the full-codebase review loop — two parallel `services/` sweeps: skill-validation/maintenance, and session/embedding/document/entity-enrichment.

- **`SkillValidator`'s security deny-rules never fired on indented code blocks.** All 14 `codeBlockOnly` `DENY_RULES` (`shell-eval`, `exec`, `spawn`, `rm-rf`, `credential-env-secret`, `curl-call`, `require-fs`, etc.) gate on `inCodeBlock`, which the fence-tracking loop only ever set via triple-backtick/tilde (` ``` `/`~~~`) fences — never via CommonMark's alternative 4-space/tab-indented code block syntax. A generated or malicious skill could bypass every one of these security checks (e.g. embed a `curl`+exfiltration command) simply by 4-space-indenting the dangerous line instead of fencing it. Fixed by adding a per-line indented-code check and gating the `DENY_RULES` loop (and the sibling `shell-subst` check) on `inCodeBlock || indentedCodeLine`, while leaving the fence-bookkeeping counters (`codeBlockLineCount`, `MAX_FENCED_BLOCK_LINES`) trained on true fences only.
- **`clearStaleLock()` treated `EPERM` the same as `ESRCH` when checking if a lock's owning PID was still alive.** `process.kill(pid, 0)` throws `ESRCH` when the process doesn't exist but throws `EPERM` when the process exists and the caller merely lacks permission to signal it. The maintenance auto-fixer's `clearStaleLock()` caught both as "process gone" and deleted the lock file, creating a real concurrency race against a live process before a VACUUM/checkpoint runs. `services/task-queue-watchdog.ts` already has the correct pattern (`isPidAlive()`, which returns `true` on `EPERM`); `clearStaleLock()` now reuses it instead of duplicating the (wrong) logic.
- **Session observability's episode timeline was permanently empty.** `buildSessionObservabilityReport()` tried to call `factsDb.getEpisodesBySession(...)` — a method that has never existed on `FactsDB` (repo-wide grep confirms the real API is `searchEpisodes(options)`). The optional-chained call always evaluated to `undefined`, so `episode_recorded` timeline entries and `captureSummary.episodesRecorded` were always empty/zero for every caller, silently, with no error (caught by the surrounding try/catch). Fixed by calling `factsDb.searchEpisodes({ since, limit })` and filtering by `sessionId` client-side (there's no session-scoped episode query; `Episode.timestamp` is Unix-seconds, unlike this file's millisecond timestamps elsewhere, so the fix also converts units correctly).

Regression tests added for all three fixes, verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Hardening (no regression test — could not construct an observable failure)

- `entity-enrichment-cli.ts`'s concurrent adaptive-catchup path counted a fact dequeued-but-never-attempted (its own `processFact` deadline check fired after `nextIdx++`) as `=== undefined` (i.e. not attempted) only for genuinely untouched slots, while a fact that got as far as `results[idx] = null` was counted as attempted — asymmetric with the sequential path's `if (result == null) continue;`. Traced the surrounding control flow closely: every reachable path to a `null` result is tied to a deadline check that, by construction, also halts the run on the very next check (same synchronous turn, the worker's own next loop iteration, or the post-`Promise.all` aggregate check), so this asymmetry has no observable effect in the current code — changed `=== undefined` to `== null` to match the sequential path anyway, since a future code change that adds any other early-return-`null` reason to `processFact` would silently reactivate a real "index skips an unattempted fact" bug otherwise. Full existing `tests/entity-enrichment-cli.test.ts` suite (18 tests) re-verified passing; no new test added since none could be made to fail without the change.

## [2026.7.89] - 2026-07-06

### Fixed

Loop iteration 25 (fifth iteration of the third batch) of the full-codebase review loop — picks up the first deferred finding from iteration 24's CHANGELOG entry.

- **`applyWorkboardGoalStatusUpdate()` could resurrect a completed/failed/abandoned goal.** Unlike every other `updateGoal()` call site that touches `status` (`goal-subagent.ts`'s `linkSubagentToGoal`/`markGoalDispatchFailure`, fixed under issue #37), this function had no `isTerminalStatus()` guard at all before writing a new status derived from a Workboard card's column. Since the default config has `workboard.bidirectional: true` and `workboard.syncGoals: true`, a user dragging a completed/failed/abandoned goal's card to a non-terminal column would silently reopen a goal the system or user had already closed. Fixed by adding the same pre-check-plus-re-check-inside-the-lock pattern the goal-subagent fixes already established: a `readGoal()` precheck before calling `updateGoal()`, and an `isTerminalStatus()` re-check inside `updateGoal()`'s mutator-function form (both `patch` and `historyEntry`) to close the TOCTOU race window between the precheck and the lock.

Regression tests added (including a TOCTOU race test mirroring the existing `goal-subagent.test.ts` pattern), verified via `git stash` to fail without the fix (goal resurrected to a non-terminal status) and pass with it. tsc clean; biome checked against the pre-existing baseline — zero net-new lint/format issues.

## [2026.7.88] - 2026-07-06

### Fixed

Loop iteration 24 (fourth iteration of the third batch) of the full-codebase review loop — a broad `services/` sweep (the largest, only partially-reviewed directory), specifically targeting the retrieval/recall pipeline given its history of scope-filter bugs elsewhere in this codebase.

- **Constrained-recall's candidate prefilter ignored the caller's scope entirely.** `getCandidateIdsByStructuredFilters()` (`backends/facts-db/search.ts`) builds the 1000-row candidate pool for `memory_recall`'s constrained-recall mode (triggered by an explicit `tag`/`category`/`entity` filter, or heuristically for filter-like queries) with no scope enforcement at all — unlike sibling queries in the same file, which already apply `scopeFilterClausePositional`. Since the pool is ordered by confidence/recency and capped at 1000 rows *before* the later scope-filtered hydration step, another tenant's higher-confidence or more-recent matching facts could fill the cap and silently starve the caller's own in-scope facts out of the result set entirely. Fixed by adding an optional `scopeFilter` to the function and threading the caller's scope filter through from `services/retrieval-orchestrator.ts` (it was already computed there, just never passed to this one call).
- **Vault-facts SPO triples (org-linked facts surfaced in prompt injection) leaked across tenant scope.** `services/vault-facts-resolver.ts`'s `resolveVaultFactsTriples()` calls `factsDb.getById(factId)` with no scope filter when resolving facts linked to an organization. Organization/contact rows aren't scoped themselves, but the facts linked to them are — the codebase already documents and handles this correctly elsewhere (`tools/memory/register-directory-tools.ts` has an explicit "SECURITY: scope-check each fact" comment), but `vault-facts-resolver.ts` was never updated to match. Since this SPO block is built on essentially every turn (default 200-token budget, gated only on a non-empty prompt), a fact one agent linked to an org (e.g. a key/value pair) could surface in another agent's injected context whenever that agent's prompt mentions the same org name. Fixed by threading a `scopeFilter` parameter through `resolveVaultFactsTriples()`/`resolveVaultFactsTriplesMulti()` → `services/recalled-context-assembler.ts`'s `finalizeInjectionMemoryContent()` → `lifecycle/stage-injection.ts` (computed there via the canonical `resolveRecallScopeFilter()`, not duplicated inline, to avoid the exact "local reimplementation drifts from the shared helper" bug fixed in iteration 20).

Regression tests added for both fixes, verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found this iteration, tracked for a future pass)

- `services/retrieval-v2.ts`'s `applyRetrievalV2` calls `aggregateRecallStats()` unscoped for cross-domain-boost scoring. Lower severity — it only adjusts the ranking of facts already scope-filtered upstream (the fact ids it scores are all in-scope), so this is a ranking-fairness quirk in multi-tenant setups rather than a data-exposure bug. (`aggregateRecallStats()` itself gained an optional `scopeFilter` parameter in loop iteration 61 to fix a real leak in `buildMemoryNudge()`'s snooze-candidate count — `retrieval-v2.ts` just doesn't pass one yet.)

## [2026.7.87] - 2026-07-06

### Fixed

Loop iteration 23 (third iteration of the third batch) of the full-codebase review loop — first pass over `extensions/memory-hybrid/utils/`, previously unreviewed in this loop.

- **The `"kubernetes"` tag-extraction pattern in `utils/tags.ts` had an unbounded regex alternation.** `/\bkubernetes|k8s\b/i` parses as `(\bkubernetes)|(k8s\b)` — the leading `\b` only binds to "kubernetes" and the trailing `\b` only binds to "k8s", unlike every sibling entry in `TAG_PATTERNS` (`z-wave`, `homeassistant`, `postgres`, etc.), which correctly bound each alternative on both sides. This let `extractTags()` mistag substrings: `"kubernetesish setup notes"` and `"renamed to myclusterk8s"` both incorrectly got tagged `"kubernetes"`. `extractTags()` runs on every stored fact's tag extraction path (`memory_store`, `cmd-store`, `cmd-extract-daily`, `cmd-distill`, auto-capture), so this affected live tagging, not just a theoretical edge case. Fixed by wrapping the alternation in a non-capturing group: `/\b(?:kubernetes|k8s)\b/i`.

Regression test added, verified via `git stash` to fail without the fix (mistagged both substring cases) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

## [2026.7.86] - 2026-07-06

### Fixed

Loop iteration 22 (second iteration of the third batch) of the full-codebase review loop — first pass over `extensions/memory-hybrid/config/parsers/`, previously unreviewed in this loop.

- **`wal.maxSizeBytes` was parsed nowhere, silently dropping a documented config option.** `WALConfig` (`config/types/core.ts`) declares `maxSizeBytes?: number` with the doc comment "Rewrite WAL when file size exceeds this limit (bytes, default: 16 MiB)," and it's genuinely consumed at runtime (`setup/plugin-service.ts`'s `wal.compactIfOversized(cfg.wal?.maxSizeBytes ?? 16 * 1024 * 1024)`). But `parseWALConfig()` only read `enabled`/`walPath`/`maxAge` — never `maxSizeBytes` — so `cfg.wal.maxSizeBytes` was always `undefined` and the 16 MiB default silently applied regardless of what an operator configured. Fixed by parsing the field with the same validation/default pattern already used for `maxAge`.
- **Stale doc comment on `WorkerLeasesConfig.enabled`** (`config/types/maintenance.ts`) claimed "default: true," but the actual system-wide default (`DEFAULT_WORKER_LEASES_CONFIG.enabled` in `services/worker-lease.ts`, and the parser's own `enabled: o.enabled === true`) is `false` — a deliberate opt-in feature. Corrected the comment to match the real, consistent behavior rather than changing behavior to match a comment that appears to have simply gone stale.

Regression test added for the `wal.maxSizeBytes` fix, verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found this iteration, tracked for a future pass)

- `maintenance.orchestrator.nightlyCycle.eventLogArchivalDays`/`eventLogArchivePath` (`config/parsers/maintenance.ts`, typed in `config/types/maintenance.ts`) are parsed correctly but never read anywhere — `setup/cli-context/cli-services.ts` builds `DreamCycleConfig`'s equivalent fields from the separate top-level `cfg.eventLog.archivalDays`/`archivePath` instead, so setting `nightlyCycle.eventLogArchivalDays` has zero effect. Not fixed this iteration since the correct resolution (wire the `nightlyCycle` fields up as an override, or remove them as duplicate/dead config surface) is a design call rather than an obvious bug fix.

## [2026.7.85] - 2026-07-06

### Fixed

Loop iteration 21 (first iteration of the third batch) of the full-codebase review loop — picks up the deferred finding from iteration 20's CHANGELOG entry.

- **`buildMemoryNudge()` (the session-start "memory nudge" feature) counted duplicate/never-referenced facts across every tenant instead of just the caller's own scope.** Unlike every sibling recall/capture call site, its two raw SQL `COUNT(*)` queries against the `facts` table had no scope filter at all, so a multi-tenant deployment with the nudge feature enabled would leak presence/volume signals about another tenant's stored facts (e.g. "6 facts have near-duplicate observations" surfaced to tenant A even when all 6 belonged to tenant B) into the current chat. Fixed by threading the same `resolveRecallScopeFilter()` result every other recall hook uses through `buildMemoryNudge()`, applying `scopeFilterClausePositional()` to both count queries.

Regression test added, verified via `git stash` to fail without the fix (leaked the combined cross-tenant count) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues (one pre-existing warning incidentally resolved as a side effect of the fix).

## [2026.7.84] - 2026-07-06

### Fixed

Loop iteration 20 (final iteration of this batch) of the full-codebase review loop — first pass over `extensions/memory-hybrid/lifecycle/`, previously unreviewed in this loop.

- **`registerAuthFailureRecall` dropped the operator-configured `autoRecall.scopeFilter` entirely in the single-agent/orchestrator case, potentially injecting another user's/session's stored credential facts into the current chat.** The hook computed its own scope filter inline instead of reusing the canonical `resolveRecallScopeFilter()` helper (already used by the compaction/recall hooks): when the detected agent was the orchestrator (the common single-agent case), it fell straight to `undefined` — no restriction at all — rather than resolveRecallScopeFilter's second branch, which still applies any configured `cfg.autoRecall.scopeFilter` (userId/sessionId) even outside multi-agent mode. Since this hook's whole purpose is searching for and injecting *credential* facts (SSH keys, tokens, passwords — gated on `category: "technical"` or `credential`/`ssh`/`token`/`api`/`auth`/`password` tags) the moment an auth failure is detected in the prompt, an operator relying on `autoRecall.scopeFilter` to keep different users'/sessions' credentials separate could have another tenant's credential fact surfaced directly into their chat. Fixed by replacing the local scope-filter computation with `resolveRecallScopeFilter(ctx)`, the same helper every other recall hook already uses.

Regression test added, verified via `git stash` to fail without the fix (search ran with no scope filter instead of the configured one) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

Also documented (no behavior change) the dead-code scope gap on `Subscription.statsUpdated` (`routes/graphql-server.ts`, flagged in iteration 18/19's CHANGELOG entries): its payload carries no scope-identifying data and there are still zero publish call sites anywhere in the plugin, so a real fix would mean designing a feature that doesn't exist yet. Left a comment for whoever eventually wires up stats-publishing instead of inventing a speculative scoping mechanism.

### Deferred (found this iteration, tracked for a future pass)

- `lifecycle/stage-memory-nudge.ts` / `services/memory-nudge.ts`'s `buildMemoryNudge()` runs raw, unscoped SQL (duplicate-fact and never-referenced-fact counts) with no scope filter, unlike every sibling recall/capture call site. In a multi-tenant deployment this leaks presence/volume signals (not fact content) about another tenant's stored facts into the current chat. Lower severity than the auth-failure fix above (counts only, no content) and gated behind `retrieval.recallFeedback.nudge.enabled` (default `false`).

## [2026.7.83] - 2026-07-06

### Fixed

Loop iteration 19 of the full-codebase review loop — picks up the first deferred finding from iteration 18's CHANGELOG entry.

- **`Query.relatedFacts` silently ignored `maxDepth` whenever `linkTypes` was also supplied.** That branch only inspected `factId`'s direct (1-hop) links, while the untyped branch does a real multi-hop `getConnectedFactIds` traversal — a caller requesting `relatedFacts(factId, maxDepth: 3, linkTypes: ["RELATED_TO"])` silently got 1-hop results instead of the requested 3-hop traversal. Fixed by replacing the direct-links filter with a proper BFS over the `linkTypes`-filtered link set, bounded to `maxDepth` hops, matching the untyped branch's depth semantics.

Regression test added, verified via `git stash` to fail without the fix (2-hop neighbor missing from the result) and pass with it. tsc clean; biome checked against the file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 18, still not fixed)

- `Subscription.statsUpdated` (`routes/graphql-server.ts`) has no scope filter, unlike the fact/link subscriptions — currently unreachable since `notifyGraphqlStatsUpdated`/`publishStatsUpdated` have no call sites anywhere in the plugin (dead code), but worth fixing before anyone wires stats-publishing in.

## [2026.7.82] - 2026-07-06

### Fixed

Loop iteration 18 of the full-codebase review loop — first pass over `extensions/memory-hybrid/routes/` (the GraphQL server), previously unreviewed in this loop.

- **The `relatedFacts` GraphQL query used an unchecked `factId` argument as a link-graph-traversal oracle.** Every other link-facing resolver (`Query.link`, `Query.links`, `createLink`, `deleteLink`) gates on `isLinkVisible()`, which requires both link endpoints to resolve under the caller's `scopeFilter` — specifically to prevent a caller from confirming a guessed/foreign fact id exists by probing whether it's linked to anything. `relatedFacts` never applied that check to its own `factId` root before traversing `memory_links` (via `getAllLinks`/`getConnectedFactIds`): only the *returned neighbors* were scope-checked, not the root being traversed from. A caller could supply another tenant's factId and get back any neighbor that happened to also be visible in their own scope, confirming the foreign id exists and is link-adjacent to their own data — the exact oracle the sibling resolvers were hardened against. Fixed by adding the same scope-visibility check on `factId` before any traversal, returning `[]` immediately when the root isn't visible to the caller.

Regression tests added, verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found this iteration, tracked for a future pass)

- `Query.relatedFacts` (`routes/graphql-resolvers.ts`) silently ignores its `maxDepth` argument when `linkTypes` is also supplied — that branch only inspects direct (1-hop) links instead of doing a real multi-hop traversal like the untyped branch does via `getConnectedFactIds`. Not a security issue (both branches still scope-filter correctly with the iteration 18 fix), just a documented-parameter inconsistency; fixing it properly requires either a `linkTypes` filter option on `getConnectedFactIds` or a hand-rolled BFS in the resolver.
- `Subscription.statsUpdated` (`routes/graphql-server.ts`) has no scope filter, unlike the fact/link subscriptions — currently unreachable since `notifyGraphqlStatsUpdated`/`publishStatsUpdated` have no call sites anywhere in the plugin (dead code), but worth fixing before anyone wires stats-publishing in.

## [2026.7.81] - 2026-07-06

### Fixed

Loop iteration 17 of the full-codebase review loop — closes out the last deferred finding from iteration 12's CHANGELOG entry, `backends/vector-db/vector-db-class.ts`'s shadow-table-swap concurrency gaps.

- **`swapShadowTable()` closed the LanceDB connection and renamed table directories on disk without excluding or draining concurrent readers**, unlike `optimize()`, which already holds an exclusive lock (`setOptimizeLock`) and waits for in-flight `search()`/`count()`/`getVectorsByFactIds()` calls to finish (`waitForReadersToDrain()`) before mutating table data for the same reason (issue #768). A concurrent read holding a reference to the table while a re-index swap ran could have its underlying Lance dataset files renamed or removed mid-read. Fixed by wrapping the swap in the same `setOptimizeLock`/`waitForReadersToDrain` protocol `optimize()` uses.
- **`swapShadowTable()` lacked the path-containment guard that `resetTableForReindex()` applies before its own destructive `rmSync()` calls.** Both methods derive the same on-disk table directories from `dbPath` and recursively delete them, but only `resetTableForReindex()` refused to do so outside `~/.openclaw/memory` (unless `OPENCLAW_HYBRID_MEM_DANGEROUS_PATHS=1`). Fixed by adding the identical guard to `swapShadowTable()`.
- **`count()` and `countSemanticQueryCacheRows()` released their reader-lock slot immediately on timeout, even though the underlying native `countRows()` call keeps running in the background** (it isn't cancellable). This let `waitForReadersToDrain()` (used by both `optimize()` and the newly-fixed `swapShadowTable()`) see zero active readers and proceed to prune/rename table data while an orphaned `countRows()` call could still be reading it — the same race `getVectorsByFactIds()` already avoids by transferring the reader slot to the orphaned promise's own settlement instead of releasing it early. Fixed by applying the same handoff pattern to both `count()` and `countSemanticQueryCacheRows()`.

All four fixes have regression tests verified via `git stash` to fail without the fix and pass with it. The pre-existing `vector-db-count-timeout.test.ts` regression test asserted the reader slot was released immediately on timeout (issue #1489's original fix) — that assertion was the opposite of the corrected behavior, so it was split into two tests: one confirming `count()` still returns promptly without hanging the caller, and a new one confirming the slot is now held until the timed-out call actually settles. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

## [2026.7.80] - 2026-07-06

### Fixed

Loop iteration 16 of the full-codebase review loop — picked up the fourth deferred finding from iteration 12's CHANGELOG entry.

- **`IssueStore.linkFact()`'s read-modify-write on the `related_facts` JSON column wasn't atomic.** It read the issue, appended the new fact id to the in-memory array, then wrote the whole array back — two separate auto-committed statements with no transaction between them. Two concurrent `linkFact()` calls on the same issue could both read the same array before either write committed, and whichever `UPDATE` landed last would silently discard the other's fact-id addition (lost update). Fixed by wrapping the read and write in a `BEGIN IMMEDIATE` transaction, the same pattern already applied to `facts-db/crud.ts`'s `storeFact()` and `edict-store.ts`'s `add()`.

Regression test verified via `git stash` to fail without the fix (no `BEGIN IMMEDIATE`/`COMMIT` calls were made during `linkFact()`) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 12, still not fixed)

- `backends/vector-db/vector-db-class.ts`'s `swapShadowTable()` closes the connection and renames table directories without draining in-flight readers or the path-containment guard `resetTableForReindex()` applies; `count()`/`countSemanticQueryCacheRows()` release their reader-lock slot immediately on timeout even though the underlying native call keeps running.

## [2026.7.79] - 2026-07-06

### Fixed

Loop iteration 15 of the full-codebase review loop — picked up the third deferred finding from iteration 12's CHANGELOG entry.

- **`EdictStore.add()`'s duplicate-text check-then-insert wasn't transactional**, unlike `facts-db/crud.ts`'s `storeFact()`, which already defends against the same class of bug. Two concurrent `add()` calls for identical (normalized) text could both pass the dedupe check before either INSERT committed, producing two rows with the same `normalized_text` and violating the method's documented "throws on duplicate text" contract. Fixed by re-running the dedupe check inside a `BEGIN IMMEDIATE` transaction that also does the INSERT, so the final duplicate decision is atomic with the write — mirroring `storeFact()`'s existing pre-check + in-transaction-recheck structure.

Regression test verified via `git stash` to fail without the fix (a mocked "no duplicate" pre-check let a second identical row through) and pass with it, using the same deterministic race-simulation technique as `tests/store-fact-dedupe-race.test.ts`. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 12, still not fixed)

- `backends/issue-store.ts`'s `linkFact()` does a non-atomic JS-level read-modify-write on a JSON column, risking lost updates under concurrent calls.
- `backends/vector-db/vector-db-class.ts`'s `swapShadowTable()` closes the connection and renames table directories without draining in-flight readers or the path-containment guard `resetTableForReindex()` applies; `count()`/`countSemanticQueryCacheRows()` release their reader-lock slot immediately on timeout even though the underlying native call keeps running.

## [2026.7.78] - 2026-07-06

### Fixed

Loop iteration 14 of the full-codebase review loop — picked up the second deferred finding from iteration 12's CHANGELOG entry.

- **`EventBus` didn't override `BaseSqliteStore.permanentClose()`, so plugin teardown couldn't actually terminate it.** `EventBus` tracks its own terminal state via a private `_terminallyClosed` flag (checked by its own `liveDb` getter override), separate from the base class's private `closePhase`/`_closed` fields. Calling the inherited `permanentClose()` (as `plugin-service.ts`'s `closeStorePermanently()` does during `stop()`/re-registration, issue #1550) closed the native SQLite handle and flipped the base class's own shutdown state — but never touched `_terminallyClosed`, so `EventBus`'s `liveDb` getter still saw `_dbOpen === false` and unconditionally reopened the handle on the very next call, silently resurrecting a database that was supposed to be permanently closed. Fixed by overriding `permanentClose()` to delegate to `EventBus`'s own already-terminal `close()`, which its `liveDb` getter does correctly respect.

Regression test verified via `git stash` to fail without the fix (`closed` stayed `false` and the next operation succeeded instead of throwing) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 12, still not fixed)

- `backends/edict-store.ts`'s duplicate-text check-then-insert isn't transactional and has no UNIQUE index, so concurrent writers can both pass the dedup check.
- `backends/issue-store.ts`'s `linkFact()` does a non-atomic JS-level read-modify-write on a JSON column, risking lost updates under concurrent calls.
- `backends/vector-db/vector-db-class.ts`'s `swapShadowTable()` closes the connection and renames table directories without draining in-flight readers or the path-containment guard `resetTableForReindex()` applies; `count()`/`countSemanticQueryCacheRows()` release their reader-lock slot immediately on timeout even though the underlying native call keeps running.

## [2026.7.77] - 2026-07-06

### Fixed

Loop iteration 13 of the full-codebase review loop — picked up the first deferred finding from iteration 12's CHANGELOG entry.

- **`memory_procedure_feedback` had no scope check on `procedureId`.** `procedureFeedback()` fetched the target procedure via `getProcedureById()` with no scope filter at all, unlike the sibling `memory_recall_procedures` search path (which already builds a `scopeFilter` via `buildToolScopeFilter()`). Any caller that knew (or was given) another tenant's scoped procedure id could flip its confidence/success/failure counters and read back its `avoidanceNotes`. Fixed by adding an optional `scopeFilter` to `getProcedureById()` (reusing the existing `scopedRowMatchesFilter()` helper), threading it through `procedureFeedback()`, and adding the same `userId`/`agentId`/`sessionId`/`confirmCrossTenantScope` parameters + `buildToolScopeFilter()` resolution to the `memory_procedure_feedback` tool that `memory_recall_procedures` already has. An out-of-scope procedure now reports `procedure_not_found` rather than being silently mutated — consistent with how other scoped lookups in this codebase avoid disclosing whether a foreign-tenant record exists.

Regression test verified via `git stash` to fail without the fix (feedback succeeded and mutated another tenant's procedure) and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (carried over from iteration 12, still not fixed)

- `backends/event-bus.ts`'s `EventBus` doesn't override the inherited `permanentClose()`, so a stale reference can silently reopen a "permanently closed" database during teardown.
- `backends/edict-store.ts`'s duplicate-text check-then-insert isn't transactional and has no UNIQUE index, so concurrent writers can both pass the dedup check.
- `backends/issue-store.ts`'s `linkFact()` does a non-atomic JS-level read-modify-write on a JSON column, risking lost updates under concurrent calls.
- `backends/vector-db/vector-db-class.ts`'s `swapShadowTable()` closes the connection and renames table directories without draining in-flight readers or the path-containment guard `resetTableForReindex()` applies; `count()`/`countSemanticQueryCacheRows()` release their reader-lock slot immediately on timeout even though the underlying native call keeps running.

## [2026.7.76] - 2026-07-06

### Fixed

Loop iteration 12 of the full-codebase review loop: a cluster of scope-filter gaps in code paths that read/write facts outside `tools/` (the previously-audited surface) — `setup/register-hooks.ts`, `services/context-engine.ts`, and two `backends/facts-db/` write paths.

- **`after_compaction` hook's post-compaction summary leaked cross-tenant facts** when `memoryTiering.enabled` was `false` and no recent prompt was tracked: two of the three fallback branches passed `scopeFilter` to `factsDb.search()`/`getHotFacts()`, but the third fell back to `factsDb.list(8)`, which had no scope parameter at all and returned the most recent facts across every tenant. The same unscoped `factsDb.list()` calls existed in `services/context-engine.ts`'s `assemble()` (context-injection fallback), `compact()` (post-compaction summary), and `prepareSubagentSpawn()` (parent-context seeding for new sub-agents — the most exploitable of the three, since it runs on every sub-agent spawn when `autoRecall` is disabled). Fixed by adding an optional `scopeFilter` to `FactsDB.list()`/`listFacts()` (mirroring `getHotFacts()`/`search()`) and threading the caller's scope filter through all four call sites.
- **Quota-overflow eviction (`onOverflow: "evict-lowest-confidence"`) could supersede another tenant's fact.** When a source hit its `maxPerDay` quota, `storeFact()` selected the globally lowest-confidence active fact for that `source` as the eviction victim, with no scope check — a quota trip in one tenant's scope could soft-delete a different tenant's fact that merely shared the same `source` string. Fixed by restricting the eviction candidate query to the same scope bucket as the incoming write.
- **Entity-based auto-linking (`memory_store`'s `autoLinkEntities`, Issue #154) created `RELATED_TO`/`INSTANCE_OF` graph edges across tenant boundaries.** The entity-mention co-occurrence block and `autoDetectInstanceOf()` both called `findEntityAnchor()` with no scope filter, unlike the sibling entity+key conflict/supersede block later in the same function, which correctly scoped its query. Any two tenants storing facts that mention the same known entity string (e.g. a common term) would get a persistent graph edge linking their otherwise-isolated facts. Fixed by threading the new fact's `scope`/`scopeTarget` through `findEntityAnchor()` (reusing the existing `episodeCandidateScopeClause()` helper) and `autoDetectInstanceOf()`.

All four fixes have regression tests verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found this iteration, tracked for a future pass)

Background review agents also surfaced several findings not fixed in this iteration, kept out to keep this commit reviewable:
- `services/procedure-feedback-tool.ts` / `backends/facts-db/procedures/crud.ts`'s `procedureFeedback()` has no scope check on `procedureId` (unlike the sibling `memory_recall_procedures` search path) — lower urgency since exploiting it requires already knowing a foreign tenant's procedure UUID, which the properly-scoped search tool won't disclose.
- `backends/event-bus.ts`'s `EventBus` doesn't override the inherited `permanentClose()`, so a stale reference can silently reopen a "permanently closed" database during teardown.
- `backends/edict-store.ts`'s duplicate-text check-then-insert isn't transactional and has no UNIQUE index, so concurrent writers can both pass the dedup check.
- `backends/issue-store.ts`'s `linkFact()` does a non-atomic JS-level read-modify-write on a JSON column, risking lost updates under concurrent calls.
- `backends/vector-db/vector-db-class.ts`'s `swapShadowTable()` closes the connection and renames table directories without draining in-flight readers or the path-containment guard `resetTableForReindex()` applies; `count()`/`countSemanticQueryCacheRows()` release their reader-lock slot immediately on timeout even though the underlying native call keeps running.

## [2026.7.75] - 2026-07-06

### Fixed

Loop iteration 11 of the full-codebase review loop.

- **`memory_store`'s normal ADD path never enrolled new facts in the verification store.** The `maybeAutoVerify` auto-enrollment closure (`verification_tier: "critical"` or `cfg.verification.autoClassify`) was only invoked from the classify-before-write UPDATE branch, never from the far more common path where a brand-new fact is stored. Callers passing `verification_tier: "critical"` on a genuinely new fact got silent no-op behavior instead of the promised auto-verification. Fixed by invoking `maybeAutoVerify` on the ADD path too, mirroring the existing UPDATE-branch call. Regression test added, verified via `git stash` to fail without the fix and pass with it.
- **`config-set`/`config-mode`/`config-set-help` CLI commands ignored `OPENCLAW_HOME`/`OPENCLAW_CONFIG` and always read/wrote `~/.openclaw/openclaw.json`**, unlike `verify` (and `config-view`'s config path, now aligned too), which already resolve the config path via the 3-way env-var chain. Operators running with a non-default `OPENCLAW_HOME` had their `config-set`/`config-mode` calls silently apply to the wrong file. Fixed by routing all four handlers through the existing `resolveOpenclawJsonPathForWorkspace()` helper instead of a hardcoded path. Regression test added, verified via `git stash` to fail without the fix and pass with it.
- **`WorkboardRpcClient`'s HTTP/CLI transport pin never expired.** `createWorkboardRpcClient()` probes HTTP first, falls back to the `openclaw gateway call` CLI subprocess, then caches whichever transport answered — for the lifetime of the plugin process (the client is created once and reused by a long-running sync loop that can run for days/weeks). If HTTP was down at startup and later recovered, every subsequent call kept paying the CLI-subprocess cost forever instead of switching back. Fixed with a 5-minute TTL on the cached pin so a recovered transport is picked up on the next call after expiry, without adding retry logic for failure modes neither underlying transport actually produces (both `createWorkboardHttpRpcClient` and `createWorkboardGatewayCliRpcClient` already swallow their own errors and return null/empty results rather than throwing). Regression test added, verified via `git stash` to fail without the fix (stayed pinned to CLI past the TTL boundary) and pass with it.

tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

---

## [2026.7.74] - 2026-07-06

### Fixed

Loop iteration 10 of the full-codebase review loop, closing out the remaining items from iterations 8-9's systemic missing-scope-filter sweep of `tools/`.

- **`memory_retrieve`'s `getEntry` closure omitted the scope filter on 2 `getById` calls** even though the same handler already builds one for the initial retrieval a few lines earlier. Exploitability is narrow today (ids reaching `getEntry` are normally already scope-vetted by the prior retrieval), but the multi-vault fan-out path (`vault: "all"`) could substitute a different tenant's fact if two vaults' fact ids ever collided. Fixed by passing `{ scopeFilter }` to both calls, matching the pattern used everywhere else this session — no dedicated regression test added here (see Note below).
- **`memory_recall`'s `includeCold: false` (the default) didn't apply to facts introduced by graph expansion:** the cold-tier exclusion filter ran once, before both the new BFS (`expandGraph`) and legacy (`getConnectedFactIds`/`getById`) graph-traversal branches, and neither branch checks tier when appending newly-discovered facts to the result set. Under the default config (`graph.useInRecall=true`, `graphRetrieval.defaultExpand=false`), a cold-tier fact linked to a matched warm/hot fact would appear in `memory_recall` output despite `includeCold: false`. Fixed by re-applying the tier filter after graph expansion.
- **`memory_ingest_document` always stored every chunk at global scope**, unlike `memory_store` (explicit scope param) and conversational auto-capture (already fixed for the same class of bug under Issue #1574/FR-006) — every document ingested in a multi-tenant deployment was globally recallable by any tenant. Fixed by deriving scope from `multiAgent.defaultStoreScope` via the same `resolveDefaultStoreScope()` helper auto-capture already uses, rather than adding a new caller-facing scope parameter (ingestion is a bulk/automated operation, not a single deliberate action like `memory_store`).

Both `memory_recall` and `memory_ingest_document` fixes include regression tests verified via `git stash` to fail without the fix and pass with it. tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

**Note on `memory_retrieve`:** this is the one fix in the loop without a dedicated automated regression test. The tool has no existing test infrastructure at all (a gap worth flagging on its own), and the fix itself is the same 2-line `getById(id, { scopeFilter })` pattern already covered by 6+ regression tests elsewhere in this session — building a full `memory_retrieve` test harness from scratch was judged disproportionate effort for validating an already-low-severity, already-proven-correct mechanism. Verified instead via direct code reading and `tsc`.

### Deferred (found and verified across iterations 8-9, tracked for a dedicated pass)

- **`verified_facts` has no scope column:** `memory_verified_list` lists every row regardless of tenant. Needs a schema migration (a `scope`/`scope_target` column plus backfill), not a quick patch.
- **`tools/memory/register-store-tools.ts`'s `maybeAutoVerify`** only runs on the classify-before-write UPDATE branch, never on the normal ADD path — a functional no-op (`verification_tier: "critical"` silently does nothing for ordinary new stores), not a cross-tenant leak. Lower priority than the security items above; still open.
- **Full `memory_retrieve` test coverage** (see Note above) — this tool has zero existing tests and is a large surface (1700+ line sibling `register-recall-tools.ts` file); worth a dedicated test-writing pass independent of any specific bug fix.

This closes out the systemic scope-filter theme found in iterations 8-9. Diminishing returns are being reached for this specific theme — the loop will broaden back to general full-codebase sampling (or wrap up per the original "until diminishing returns" instruction) starting next iteration.

### Changed

- Version bumped to 2026.7.74.

---

## [2026.7.73] - 2026-07-06

### Fixed

Loop iteration 9 of the full-codebase review loop, continuing the systemic missing-scope-filter pattern found in iteration 8's `tools/` sweep.

- **`memory_verify`/`memory_verification_status` could read and copy another tenant's fact text:** both called `factsDb.getById(factId)` with no scope filter, so any caller could verify (copying its full text into the global `verified_facts` table) or probe the verification status of a fact belonging to a different tenant/scope. Fixed by scope-checking the fact before either operation proceeds. Note: `verified_facts` still has no scope column of its own, so `memory_verified_list` itself still broadcasts every tenant's already-verified facts — that needs a schema migration and is tracked separately below, not fixed here.
- **`memory_provenance` could trace another tenant's full fact history:** `getProvenance()` reads `facts.text` via raw SQL, bypassing `FactsDB.getById()`'s scope enforcement entirely, and `buildProvenanceChain`/`buildDerivedFrom` recursively traced `DERIVED_FROM`/`CONSOLIDATED_FROM` edges with no scope check on any hop. Fixed by threading a scope filter into `getProvenance()`'s own raw query and gating every recursive hop (including the `CONSOLIDATED_FROM` chain, which had a second, narrower gap: even after the live-lookup fix, its `factText` fallback could still surface an out-of-scope edge's own stored `sourceText` snapshot if a chain ever reached one).
- **`active_task_list`/`active_task_get`/`propose_goal` leaked every tenant's task ledger when `activeTask.ledger: "facts"`:** `loadActiveTasksForTools()` called `loadTaskLedgerFromFacts(factsDb)` with no scope filter (the function accepts one as an optional 3rd argument), so every agent saw every other tenant's active tasks. Fixed by threading a scope filter through from the tool context.
- **`goal_complete`/`goal_abandon` always recorded their outcome episode at global scope:** unlike the sibling `memory_record_episode` tool (which lets the caller pick a scope, falling back to the caller's own resolved identity), these two had no scope param at all and called `factsDb.recordEpisode()` with none of `scope`/`scopeTarget`/`agentId`/`userId`/`sessionId` set. Fixed to always derive scope from the caller's own resolved identity, matching `memory_record_episode`'s no-explicit-scope fallback behavior.

All four fixes include regression tests verified to fail without the fix and pass with it (via `git stash` before/after comparison). tsc clean; biome checked against each file's pre-existing baseline — zero net-new lint/format issues.

### Deferred (found and verified, tracked for a dedicated pass — not abandoned)

- **`verified_facts` has no scope column:** `memory_verified_list` lists every row in that table regardless of tenant. Needs a schema migration (a `scope`/`scope_target` column plus backfill) rather than a quick patch, since the table predates the multi-tenant scope system.
- Remaining items carried over from iteration 8, not yet reached: `tools/document-tools.ts` (`ingestSingleDocument` never sets `scope`/`scopeTarget`, defaulting every ingested chunk to global), `tools/memory/register-agent-verb-tools.ts` (`memory_retrieve`'s `getEntry` closure omits `scopeFilter` on 2 `getById` calls — narrow multi-vault-collision risk), `tools/memory/register-store-tools.ts` (`maybeAutoVerify` only runs on the classify-before-write UPDATE branch, never on ADD — a functional no-op, not a leak), `tools/memory/register-recall-tools.ts` (`memory_recall`'s `includeCold=false` filter isn't re-applied to graph-expansion-appended facts).

### Changed

- Version bumped to 2026.7.73.

---

## [2026.7.72] - 2026-07-06

### Fixed

Loop iteration 8 of the full-codebase review loop. This iteration covered `config/parsers/`, and the agent-facing `tools/` directory — the MCP tool surface the agent actually calls (memory_link, memory_graph, memory_path, memory_directory), distinct from the `routes/` GraphQL dashboard API already covered in iteration 7. Found a systemic pattern: several tool families never had multi-tenant scope filtering wired in at all, unlike `tools/memory/*`, which threads a scope filter through every read.

- **`autoClassify.batchSize` of `0` or negative hangs the classify loop forever:** `parseAutoClassifyConfig()` only checked `typeof === "number"` with no lower bound, unlike every other stride/threshold field in the same parser. `services/auto-classifier.ts` does `for (i = 0; i < others.length; i += config.batchSize)` — a non-positive stride never advances `i`, and the direct CLI classify path has no maintenance-run deadline to break out of it, so a config file with `batchSize: 0` (a plausible attempt to "disable" batching) hangs the process while repeatedly re-issuing the same LLM call. Fixed to floor at 1, matching the codebase convention. Also fixed the same missing lower bound on `minFactsForNewCategory` (a non-positive value silently made every single-instance category proposal "qualify," flooding the taxonomy).
- **`memory_directory`'s `org_view` operation leaked cross-tenant fact text:** it called `factsDb.getById(id)` with no scope filter for facts linked to an organization, unlike the sibling `memory_promote`/`memory_forget` handlers in the same file, which correctly scope-check. Any agent could view another tenant's fact text/category (truncated to 240 chars) via an org that happened to have a foreign-tenant fact entity-linked to it.
- **`memory_link`, `memory_graph`, and `memory_path` had no scope filtering wired in at all:** unlike `tools/memory/*`, `graph-tools.ts`'s plugin context never carried `currentAgentIdRef`/a scope-filter builder, so none of its three tools could enforce scope even in principle. Since `memory_links` carries no scope column of its own (it just connects two independently-scoped facts), this meant: `memory_link` could tie a caller's fact to another tenant's fact (or discover the foreign id exists); `memory_graph` disclosed a linked fact's full text/category regardless of scope, both directly and via BFS-connected ids; `memory_path` could resolve and traverse through an out-of-scope fact as a path endpoint or intermediate hop. Fixed by threading `currentAgentIdRef`/`buildToolScopeFilter` into the tool context (via `setup/tool-installers.ts`) and scope-checking every fact/link endpoint; `memory_path`'s fix only needed to scope-bind `getById` (and entity-name `lookup`) since `shortest-path.ts`'s BFS already re-validates every hop through `getById` before accepting it (originally to exclude superseded facts) — no changes needed inside `shortest-path.ts` itself.

### Deferred (found and verified this iteration, carried into the next iteration — NOT abandoned, tracked for prompt follow-up given severity)

The same "review agent has no scope-filter access" pattern was found in several more tool files; each needs its own careful fix + test pass rather than a rushed batch:

- `tools/verification-tools.ts` — `memory_verify`/`memory_verified_list` read/store fact text via an unscoped `getById` and a scope-less `VerificationStore`.
- `tools/provenance-tools.ts` — `memory_provenance`/`buildProvenanceChain`/`buildDerivedFrom` call `getById` unscoped, returning cross-tenant fact text and its derivation chain.
- `tools/document-tools.ts` — `ingestSingleDocument`'s `storeWithResult` never sets `scope`/`scopeTarget` (defaults to `"global"`), unlike `memory_store` — every ingested document chunk is globally recallable in a multi-tenant deployment.
- `tools/task-hygiene-tools.ts` + `services/active-task-tools-loader.ts` — `loadTaskLedgerFromFacts` accepts an optional `scopeFilter` but is called without one when `activeTask.ledger: "facts"`, leaking all tenants' task facts.
- `tools/goal-tools.ts` — `goal_complete`/`goal_abandon` call `factsDb.recordEpisode` with no scope/agentId/userId/sessionId, unlike the sibling `memory_record_episode` tool, defaulting the episode to global scope.
- `tools/memory/register-agent-verb-tools.ts` — `memory_retrieve`'s `getEntry` closure omits `{scopeFilter}` on two `getById` calls; narrow exposure today (ids reaching it are already scope-vetted), but a latent risk in the multi-vault fan-out path if a fact id collides across two tenants' vaults.
- `tools/memory/register-store-tools.ts` — `maybeAutoVerify` (enrolls a stored fact for `verification_tier: "critical"`/auto-classify) is only invoked on the classify-before-write UPDATE branch, never the normal ADD path — a functional bug (not a leak): critical-verification requests on ordinary new stores silently no-op.
- `tools/memory/register-recall-tools.ts` — `memory_recall`'s `includeCold=false` (default) cold-tier exclusion filter runs once before graph expansion, and is never re-applied to facts graph expansion subsequently appends — a cold-tier fact within `graph.maxTraversalDepth` hops of a matched warm fact leaks into the response despite `includeCold: false`, under the default config (`graph.useInRecall=true`, `graphRetrieval.defaultExpand=false`).

### Changed

- Version bumped to 2026.7.72.

---

## [2026.7.71] - 2026-07-06

### Fixed

Loop iteration 7 of the full-codebase review loop. This iteration covered the GraphQL dashboard API (`routes/`) and the conversational lifecycle capture/recall path (`lifecycle/`).

- **GraphQL fact and link subscriptions leaked data across tenant/scope boundaries:** `Subscription.factCreated`/`factUpdated`/`linkCreated` only filtered on caller-supplied schema arguments (`category`, `scope`, `sourceId`/`targetId`), never on the caller's own resolved `context.scopeFilter` — unlike every Query/Mutation resolver in the same file, which explicitly threads `scopeFilter` through. A caller with no arguments on `factCreated`/`factUpdated` received every fact stored or updated by any tenant, in full (including `text`), in real time; `factDeleted` similarly exposed every tenant's deletions by id/category. Fixed by deriving visibility from the actual stored scope on every subscription payload (adding `scope`/`scopeTarget` to the `factDeleted` publish payload so it survives past deletion), matching the fail-closed default used everywhere else in the GraphQL layer.
- **GraphQL link queries and mutations had no scope check at all:** `Query.link`, `Query.links`, `Fact.links`/`linkedFrom`, `stats.totalLinks`, `createLink`, and `deleteLink` all operated on `memory_links` rows directly with no visibility check, unlike `deleteFact`/`supersedeFact`'s explicit "SECURITY: scope-check before deleting" guards in the same file. Since a link connects two independently-scoped facts and carries no scope column of its own, any caller could read, create, or delete a link touching another tenant's fact just by knowing or guessing its id — including planting a link tying another tenant's fact into their own graph. Fixed by adding a shared `isLinkVisible()` check (both endpoints must resolve under the caller's `scopeFilter`) and applying it everywhere links are read, written, or deleted.
- **Conversational auto-capture silently stopped working after the first few turns of a session:** `agent_end` rescans the *entire* session's message history every time (not just the new turn), builds a priority-sorted candidate list, then took `.slice(0, 3)` **before** checking which candidates were already-stored duplicates. Because the sort is stable, a session's first ~3 capturable statements permanently occupied that window on every later call — once stored, they were skipped as duplicates, but no later-turn statement ever got a chance to enter the top-3 slice. Fixed by walking the full candidate list and stopping once 3 genuinely new candidates are prepared, instead of pre-slicing.
- **Credential-store nudge (`stage-credential-hint.ts`) used a different session-key fallback than its own writer:** the writer (`stage-capture/run-capture.ts` and every other lifecycle stage with this pattern) resolves the session key as `resolveSessionKey(event, api) ?? ctx.currentAgentIdRef.value ?? "default"`, but the credential-hint reader omitted the `currentAgentIdRef` fallback. On any turn where the event/context carries no resolvable session id but `currentAgentIdRef` is set (routine after `stage-setup.ts` runs, e.g. cron/heartbeat turns), the pending-hint file was written under `hash(agentId)` but read under `hash("default")` — silently orphaning the file and permanently suppressing the nudge for that session. Fixed the reader to use the same fallback chain as the writer.

### Deferred (found, need separate design confirmation before implementing)

- **Episodic auto-capture can create unbounded duplicate episodes in long-running sessions:** like conversational auto-capture, the episodic success/failure scanner rescans the entire session history every `agent_end` call, but its duplicate guard only looks back 5 minutes (`searchEpisodes({..., since: now - 300})`). Once a session runs past 5 minutes since an episode was first recorded, the same historical message (e.g. an early "tests passing" or error) falls outside that window and gets re-recorded as a fresh duplicate on every subsequent call. The correct fix needs a design decision — either track a per-session last-scanned-message marker (only scan new content since the previous call), or drop the time bound entirely in favor of a session-lifetime dedupe — and either changes existing repeat-detection behavior, so it needs its own test pass rather than a rushed patch.

### Changed

- Version bumped to 2026.7.71.

---

## [2026.7.70] - 2026-07-06

### Fixed

Loop iteration 6 of a self-paced review loop, expanded per user request to cover the full codebase (not just recent commits) for up to 10 more iterations or until diminishing returns. This iteration covered the core facts-db data layer and the credential auto-capture/vault path.

- **Contact profile updates always stamped `source_date` to now, even when the update carried no `source`:** `applyContactProfileFields()` in `backends/facts-db/entity-layer.ts` unconditionally set `source_date = now` on every UPDATE, unlike the INSERT path which only sets it when a `source` is actually supplied — an update with no source info falsely implied the contact's original source had just been reconfirmed. Fixed to only stamp `source_date` when `source` is provided, mirroring the INSERT path.
- **Entity-mention cleanup (`contacts audit`/`cleanup`) could remove a mention that ingestion correctly kept:** the substring-duplicate filter in `processEntityMentionsForFact()` only checked textual containment and offset nesting, missing the word-boundary check that the write-time equivalent (`isContainedByLongerMention`) already enforces — so a mention like "Ann" embedded inside a longer "Annabelle" mention (no real word boundary between them) was kept at write time but incorrectly deleted by a later audit/cleanup pass. Fixed the cleanup filter to reuse the same word-boundary-aware check. Updated one existing test whose fixture relied on the old, less precise behavior, and added a new test confirming a genuine word-boundary-contained substring is still correctly rejected.
- **The credential auto-capture pattern list had real coverage gaps:** `CREDENTIAL_PATTERNS` in `services/auto-capture.ts` (used to gate whether text is credential-like enough to route to the encrypted vault instead of being stored as a plaintext fact) had no entries for AWS-style access keys, PEM private-key blocks, database connection strings with an embedded password, or a bare (non-`Bearer`-prefixed) JWT — even though a broader pattern list used elsewhere for capture-filtering already recognized most of these formats. Added all four as new vault-routing patterns.
- **`extractCredentialMatch()` could extract far more than the actual secret for one pattern:** the "host/email + password|token|key" pattern had no capture group, so its greedy `.*` caused the extracted "secret" to span from an email address through to the real credential value (including any names or other text in between) — that whole span, not just the isolated token, got written into the encrypted vault. Fixed by adding capture groups to isolate just the secret for both this pattern and the new connection-string pattern. Added regression tests for all of the above using fabricated example values.

### Deferred (found, need separate design confirmation before implementing)

- **Orphaned credential-vault pointer can permanently block re-capturing a credential:** if `credential_delete`'s best-effort pointer-fact cleanup fails (silently logged only), a stale pointer fact survives with no backing vault entry; a later legitimate re-capture for the same service/type stores a fresh vault secret, but `abortCredentialVaultWriteOnPointerDedupe()`'s "pointer text unchanged = redundant" heuristic then deletes that fresh secret, since it can't distinguish "pointer is accurate" from "pointer is stale." The abort behavior itself is intentional and covered by an existing test for a different (legitimate) scenario, so the real fix belongs in making `credential_delete`'s cleanup reliable, not in loosening the abort check.
- **Manual `credential_store`/`credential_get`/`credential_delete` tool calls don't normalize `service` the way auto-capture paths do:** `validateAndNormalizeServiceName()` is applied in `auto-capture.ts` and `credential-scanner.ts` but not in `tools/credential-tools.ts`, and the vault table has no case-insensitive collation — the same logical service captured via both paths can end up as two differently-cased rows, and `credential_delete` (exact match) would only remove one. Normalizing in `credential-tools.ts` would change accepted-input behavior for existing callers and needs its own test pass before landing.
- **Tool-call credential scanning misses JSON-structured Bearer/JWT auth headers:** the tool-call scanner's only Bearer/JWT pattern requires literal `curl ... -H "Authorization: Bearer ..."` shell syntax, and the value-flattening helper it runs against drops object keys (so a JSON `{"headers":{"Authorization":"Bearer ..."}}` call loses the "Authorization" context entirely) — a token passed via a non-curl, JSON-structured tool call is never routed to the vault from this capture path.
- **Two facts-db dedupe/merge concurrency races** in `backends/facts-db/crud.ts`: (1) the merge path reads the existing fact's text outside any lock and writes a precomputed merged string, so two concurrent merges into the same fact can silently discard one side's appended text (last-write-wins instead of both merging in); (2) the in-transaction dedupe recheck (added specifically to close the original insert race) treats a "merge" outcome identically to "skip," dropping the new text entirely instead of merging it. Both require a careful look at the transaction/locking model to fix without introducing a new race or deadlock risk.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.70**.

---

## [2026.7.69] - 2026-07-06

### Fixed

Loop iteration 4 of a self-paced 10-iteration review loop, focused on the `cron-jobs.ts` `--verbose` rollout and a self-review of the two prior iterations' own (not-yet-independently-reviewed) commits.

- **`weekly-pending-digest-autopilot`'s cron job never got the `--verbose` flag it was specifically fixed to support:** the 2026.7.63 progress-logging pass added correct `--verbose`/`--json` stream-routing to `digest autopilot-cron` in `register-digest.ts` (progress mirrors to stderr under `--json`, keeping stdout pure JSON), but the actual scheduled cron command string in `cli/install/cron-jobs.ts` was never updated to pass `--verbose` — so the fix never reached the one place it needed to run. Added `--verbose` to the job's command string.
- **The maintenance-redaction fix from iteration 3 only covered `cmd-extract-daily.ts`'s direct (non-batched) store path — the classify-before-write batched path still leaked unredacted text:** when `cfg.store.classifyBeforeWrite` is enabled and a line has a pre-existing similar fact (routing it through `flushPendingExtractClassify` instead of the direct store branch), the vector-store writes (both the default/ADD branch and the UPDATE branch) and the UPDATE branch's `factsDb.storeWithResult` call all used the raw, unredacted `trimmed`/`extracted.value` variables instead of the already-redacted `storePayload.text`/`storePayload.value` — so a fact stored through this path had a correctly-redacted `text` column in facts.db but a leaked, unredacted copy in LanceDB (and, for UPDATEs, an unredacted `value` column too). Fixed all three call sites in `cli/cmd-extract-daily.ts` to consistently use `storePayload`'s already-redacted fields. Added a regression test that reproduces the exact routing (a pre-existing similar fact by entity+key) and verifies it fails without the fix.
- No new correctness bugs found in a self-review of the maintenance-inventory collision-group aggregation or the `resolveContradictionsAutonomously` `scanned`/`total` fields from iteration 3 — both confirmed correct by direct code inspection.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.69**.

---

## [2026.7.68] - 2026-07-06

### Fixed

Loop iteration 3 of a self-paced 10-iteration review loop, focused on the maintenance PII-redaction wiring and the resolve-contradictions --auto heartbeat/summary reporting.

- **Three maintenance commands silently bypassed `maintenance.privacyRedaction` entirely:** `cli/cmd-extract-daily.ts` never called `maybeRedactMaintenanceFactText()` at all (the whole command bypassed redaction even when enabled), and the `MEMORY_STORE`/`PATTERN_FACT` remediation-apply paths in `cli/cmd-extract-reinforcement.ts` and `cli/cmd-selfcorrection.ts` stored LLM-derived fact text with no redaction call, even though sibling paths in the same files (reinforcement's praise-fact store, distill, extract-directives) already honored it. Wired `maybeRedactMaintenanceFactText()` into all three, mirroring the existing `cmd-distill.ts` pattern (redact before dedup/embed/store, using each fact's own category/key for exemption lookups). Added regression tests to `tests/extract-daily-cli-heartbeat-diagnostics.test.ts` and `tests/reinforcement-analysis.test.ts`.
- **`resolve-contradictions --auto`'s live heartbeat and final summary silently used two different denominators under the same "total" label:** `resolveContradictionsAutonomously()`'s `onProgress` reports `total: unresolved.length` (every unresolved-contradiction row scanned), but the function's own returned `total` field only counts pairs where both facts still exist — a genuinely different, smaller number whenever a contradiction row references an already-deleted/pruned fact. An operator watching `--verbose` output would see e.g. `processed=10/10` live, then `contradiction-auto summary total=8 ...` at completion — an apparently-shrinking total with no explanation. Added a `scanned` field to `ResolveContradictionsAutoResult` (matching the live heartbeat's denominator) and updated the final summary log line in `register-reflection-pipeline.ts` to print both `scanned=` and `total=` explicitly. Added a regression test reproducing the divergence with a hard-deleted (not just superseded) fact.
- No new correctness bugs found in a fresh review of the maintenance redaction config/type wiring itself, or in the reflection-pipeline/digest heartbeat code beyond the one finding above.
- **Process note:** an intermediate `biome check --write` pass on two of the files above reordered their entire import blocks as a side effect of an unrelated formatting fix, which silently reintroduced a stale-state hang in `cmd-selfcorrection.ts` caught by `tests/self-correction-m3-hardening-1876.test.ts` (5 tests timing out). Root-caused via bisection (stash/restore) and fixed by reapplying only the intended logic changes on top of the original, unreordered import block — a reminder that blanket auto-format fixes are not risk-free in this codebase and should be verified with the full affected test suite, not just typecheck.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.68**.

---

## [2026.7.67] - 2026-07-06

### Fixed

- **Loop iteration 2 (of a self-paced 10-iteration review loop):** `weekly-crystallization-skills-rescan`'s maintenance-inventory catalog entry claimed it mutated nothing (`mutates: {sqlite: false, ...}`, no `collisionGroups`), but its command (`openclaw hybrid-mem skills rescan` → `CrystallizationProposer.rescanInstalledSkills()`) writes to the same `CrystallizationStore` sqlite file (`crystallization_proposals` table) that `weekly-persona-proposals` also writes to via the same `CrystallizationProposer` class — a real concurrent-write collision risk the inventory report was hiding from operators. Added a `crystallization-store-writer` collision group to both entries in `services/maintenance-inventory.ts` and corrected the rescan entry's `mutates.sqlite` to `true` (it does write sqlite, just not the shared `facts.db` — kept out of the generic `sqlite-writer`/`memory-facts-writer` groups since those are reserved for facts.db writers). Added a regression test.
- No new correctness bugs found in a fresh scan of the heartbeat/progress-reporting additions to `sensor-sweep`, `self-correction-run`, `generate-proposals`, `tier-compact`, and `vectordb-optimize`, or in a solo re-review of the tooling-blocker commit's other files.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.67**.

---

## [2026.7.66] - 2026-07-06

### Added

- Regression test coverage for the 2026.7.65 fix batch, added during a follow-up self-paced review loop (iteration 1 of 10) that scanned the 2026.7.65 commit itself for new bugs (none found — see below) and gaps in test coverage (four found and closed):
  - `tests/contradiction-detection.test.ts`: a `key="notes"` fact whose value contains a blocklisted substring (e.g. `robot@ops-bot.internal`) now has explicit coverage proving contradiction detection/repair still runs normally for non-`email` keys.
  - `tests/memory-store-early-validation.test.ts`: the `memory_store` tool's system-sender guard now has direct coverage — an explicit `key="email"` call with a blocklisted `value` is nulled out, while a genuine email pair is stored unaffected.
  - `tests/system-sender-email.test.ts` (new file): direct unit coverage for `isSystemSenderEmail()`, including the broadened `no.reply@`/`no_reply@`/`donotreply@` variants added in 2026.7.65.
  - `tests/contacts-profile-enrichment.test.ts`: a single-PERSON-mention fact whose text contains 2+ distinct emails now has explicit coverage proving the contact's email stays `null` (ambiguous) rather than picking the first address.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.66**.

---

## [2026.7.65] - 2026-07-06

### Fixed

Follow-up `/code-review` pass over the previous three releases (2026.7.62–.64), running 10 independent finder angles over the full diff. Findings below are ranked by how many independent angles independently flagged the same defect (higher = more confidence):

- **`lifecycle sync github --json` leaked adapter progress onto stdout, corrupting the JSON report (flagged by 4 angles):** the new real logger wired into `syncLifecycleFromGitHub` wrote unconditionally via `console.log`, unlike the sibling `digest autopilot-cron` fix in the same release which routes progress to stderr under `--json`. Fixed in `cli/commands/manage/register-lifecycle.ts` to route `logger.info` to stderr when `--json` is set, matching the established pattern. Added a regression test asserting stdout stays pure, parseable JSON.
- **Contact-profile email extraction only ever looked at the first regex match (flagged by 4 angles):** `parseContactProfileHints()` picked the first email in the text and only checked it against the system-sender blocklist — it never got the multi-distinct-address ambiguity guard that `fact-extraction.ts` received in 2026.7.64, so a roster or sender/recipient pair could still attribute the wrong address to the mentioned person. Fixed in `utils/contact-profile-patterns.ts` to mirror `fact-extraction.ts`'s logic exactly (collect all matches, only extract when exactly one distinct non-blocklisted address remains).
- **System-sender blocklist guard in contradiction detection applied to every fact key, not just `email` (flagged by 2 angles):** `detectContradictions()` and `repairUndetectedContradictions()` in `backends/facts-db/contradictions.ts` called `isSystemSenderEmail()` on any fact's value regardless of its key, so a `key="notes"` fact whose text happened to contain a blocklisted substring (e.g. "escalate to robot@ops-bot.internal") would silently skip contradiction detection/repair entirely. Scoped both guards to `key === "email"` only.
- **`memory_store` tool bypassed the system-sender guard entirely:** an LLM-supplied `key`/`value` pair in `tools/memory/register-store-tools.ts` took precedence over `extractStructuredFields()`'s own blocklist via a `??` fallback, so a direct `memory_store` call with `key: "email", value: "noreply@..."` was never caught. Added the same guard used in `cmd-distill.ts`.
- **Redaction's `exemptKeys` check was case-sensitive against un-normalized LLM output (flagged by 2 angles):** `maybeRedactMaintenanceFactText()` compared `fact.key` verbatim against the lowercase default `exemptKeys` list, so an LLM-emitted key like `"Email"` would not match and got redacted even with the default exemption configured. Fixed to compare case-insensitively.
- **An explicit empty `exemptKeys`/`exemptCategories` array was silently replaced by the default list (flagged by 2 angles):** `parseStringList()` collapses any empty array (including one an operator explicitly configured) to `undefined`, so `parseMaintenancePrivacyRedactionConfig()`'s `?? [default]` fallback masked an intentional opt-out. Fixed to check `Array.isArray` directly for this one config so an explicit `[]` is honored.
- **Cron ledger reconciler could validate with a missing log file instead of skipping (flagged by 2 angles):** the 2026.7.62 tooling-blocker fix replaced a combined `continue` guard with a narrower fallback, but as a side effect, an entry whose exit ledger is resolvable/exists but whose paired `.log` file is missing (rotated away, no replacement artifact pair found) now fell through to validation with `logPath: undefined` instead of being left alone — risking a false correction from incomplete evidence. Restored the skip for this specific case in `services/cron-maintenance-reconciler.ts`, while keeping the original zero-artifacts tooling-blocker fallback intact. Added a regression test.
- **System-sender blocklist regex missed common variants:** `no.reply@`, `no_reply@`, and `donotreply@` were not matched by the `no-?reply` pattern. Broadened `utils/system-sender-email.ts`'s regex to cover them.
- Minor observability fixes carried over from the same pass: `consolidation.ts` now emits a final progress tick before a maintenance-deadline-triggered stop (previously the heartbeat's last reported cluster index froze one behind the actual abort point); `cli/cmd-extract-daily.ts`'s `daysProcessed` counter no longer freezes when several consecutive recent days have no memory file (it's now updated unconditionally per day scanned, not only on a successful scan); `register-credentials-scope.ts`'s scope-promote heartbeat now ticks on the final partial chunk instead of only every 100 items.
- Fixed a test in `tests/fact-extraction.test.ts` whose title claimed "still extracts the single email" while its assertion actually expected `null` — the assertion (and the inline comment above it) reflects the intended, deliberately conservative design (a sender/recipient pair with one blocklisted address stays ambiguous by design); only the title was wrong.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.65**.

---

## [2026.7.64] - 2026-07-06

### Fixed

- **Mis-attributed emails caused false contradictions and corrupt org-level `key=email` facts (#2062):** `extractStructuredFields()`'s email heuristic grabbed the *first* email address in any text with no context awareness — so a payment-notification email mentioning a company (sender: a `noreply@`/automation address) or a multi-person contact-roster listing (several people's emails in one text) could get stored as if that address were the mentioned org's own `key=email` fact. Two org-level facts extracted this way from unrelated source text (a notification sender address, and a roster member's personal address) then looked like a genuine, alarming contradiction over "the org's real email," when neither was ever the org's email at all.

  Fixed at the root cause in `services/fact-extraction.ts` (shared by `memory_store`, `distill`, `extract-daily`, and CLI `store`): the email heuristic now skips assigning a scalar `key=email` when (a) the matched address is a system/notification sender (`noreply@`, `robot@`, `mailer-daemon@`, etc. — new `utils/system-sender-email.ts` blocklist), or (b) the text contains 2+ distinct email addresses (ambiguous — e.g. a sender/recipient pair, or a multi-person roster) — falling through to phone/entity heuristics instead of guessing. Applied the same blocklist to `parseContactProfileHints()` (contact-profile enrichment) and to `distill`'s LLM-sourced `entity`/`key`/`value` (which bypasses the regex heuristic entirely, so needed its own guard). Also added the same blocklist as a skip condition in `backends/facts-db/contradictions.ts`'s write-time detection and nightly repair pass, so a system-sender value can no longer compete in a contradiction against a genuine one — covering facts already corrupted before this fix, not just preventing new ones.

  Deliberately out of scope for this pass (would need a larger, separately-confirmed design): a typed email-key taxonomy (`contact_email`/`mail_sender`/`primary_email` instead of a flat `email` key) and Swedish/English mail sender/recipient pattern parsing (`från X till Y` / `from X to Y`) — both P1 items from the original report that ripple into recall queries, tools, and docs beyond what a blocklist/ambiguity guard needs to touch.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.64**.

---

## [2026.7.63] - 2026-07-06

### Fixed

- **Maintenance PII redaction was unconditional and corrupted stored facts (#2055):** `distill`, `extract-directives`, and `extract-reinforcement` ran every extracted fact through `redactMaintenancePrivateText()` before storing it, replacing emails/home-paths/private-IPs with literal placeholder tokens (`[redacted-email]`, etc.) — with no config to disable it. For a personal-memory system this was actively counterproductive: the placeholder is stored as the fact's permanent `text`/`value`, which is useless on recall and creates false "ambiguous" contradiction pairs against the same contact's real address stored via `memory_store` (which was never redacted, nor is CONTACTS.md sync — so the corruption was also inconsistent). Actual secrets already go through the separate, deliberately opt-in credential vault; this regex scrub was never what protected those.

  Added `maintenance.privacyRedaction` config (`enabled`, `exemptCategories`, `exemptKeys`) — **default `enabled: false`** — and a new `maybeRedactMaintenanceFactText()` helper that the three call sites now use instead of the unconditional function. Redaction can still be turned on for deployments that want it, with `category`/`key` exemptions (defaults: `entity` category, `email`/`phone`/`mobile` keys) so contact facts stay legible even when enabled.
- **`resolve-contradictions` degraded-backlog triage hint suggested a nonexistent `--limit` flag:** `contradiction-progress-summary.ts`'s `backlog_alert` hint read `resolve-contradictions --details --limit 20`, but the command has no `--limit` option (only `--details`, which already implies listing every ambiguous row). Removed the bogus flag from the hint.
- **Maintenance commands too often looked hung when they weren't:** an audit of all ~25 maintenance CLI commands (cron steps run inside `cron-job-bash-harness.ts`'s tee'd-log bash wrapper) found most had no progress output during long LLM/network calls, so an operator watching the log had no way to tell a slow-but-working run from a stuck one. `distill`, `reflect-meta` (both modes), `enrich-entities`, `dream-cycle`, `record-storage-sample`, and `skills rescan` already had adequate coverage; the rest are now fixed, using the existing `runMaintenanceHeartbeat` house pattern (start/60s-tick/complete-or-failed lines, verbose-gated) from `cli/commands/manage/maintenance-heartbeat.ts`:
  - `build-languages`, `backfill-decay`, `reembed-vectorless` already had a working heartbeat that cron never enabled (missing `--verbose`) — now passed in `cron-jobs.ts`. `reembed-vectorless` matters most here: up to 1000 embedding-API calls were running fully silent.
  - `resolve-contradictions --auto`, `reflect`, `reflect-rules`, `generate-proposals` had no heartbeat mechanism at all despite blocking LLM calls; `self-correction-run` and `extract-reinforcement` had only a per-batch start marker with no ticker during a single slow batch. All now wrap their blocking call(s) with a heartbeat, with `onProgress` threaded through where useful (contradiction counts, cluster progress, batch index).
  - `extract-daily` gained a heartbeat, and its diagnostics (previously only sent through a `sink` that the default orchestrator cron path replaces with a no-op) now also reach `logger`, so warnings survive under the consolidated `maintenance-nightly` job.
  - `compact`, `vectordb-optimize`, `scope promote`, `consolidate`, `sensor-sweep` had no `--verbose` option at all — added, plus a heartbeat. `consolidate` was the sharpest case (one LLM call per cluster, zero flag to enable anything); `sensor-sweep` was mischaracterized as fast ("no LLM") but Tier 1 makes up to ~7 sequential `gh` CLI calls and could run 100+s silently.
  - `lifecycle sync github` — the highest-risk finding — had an unbounded per-row/per-repo `gh api` loop with its one internal log line silently dropped (the CLI wrapper never passed a real logger). Now passes a real logger, reports scope up front, and ticks progress via `onProgress`.
  - `digest autopilot-cron` already had a rich internal step ledger, but it only wrote to a private artifact file the operator never watches. Its `logLine` calls now also reach an optional `onProgress` sink; the CLI's `--verbose` routes that to stdout (or stderr when `--json` is set too, so the JSON summary on stdout stays parseable).

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.63**.

---

## [2026.7.62] - 2026-07-06

### Fixed

Root-cause review of a failed `workshop-approval-reminder` maintenance run (reported: "tooling blocker — no evidence the step ran"). The isolated cron session had no top-level exec/bash tool this run, so the only remaining path was the deferred `tool_call`/ToolSearch wrapper — a surface the #1961/#1962 harness fix deliberately forbids because it silently drops arguments (upstream #96115/#53408). The agent retried the forbidden wrapper three times, then reported failure in free text only; no HM_EXIT/HM_LOG artifacts were ever written. Following the trail through the harness, reconciler, and inventory code turned up four related gaps, now fixed:

- **`cron-job-bash-harness.ts` TOOLING guidance was a dead end:** it told the agent to use the exec tool and forbade the deferred wrapper, but gave no instruction for what to do when no direct exec tool is available at all. Added an explicit bounded fallback: reply `TOOLING_BLOCKED: <reason>` and stop, instead of repeatedly retrying a surface already known to be broken.
- **`cron-maintenance-reconciler.ts`'s false-OK repair silently skipped exactly this failure signature:** when a scheduled run produced *zero* HM_EXIT/HM_LOG artifacts anywhere (the harness never started), `reconcileCronRunLedger` `continue`d past the entry instead of correcting it — leaving a misleading `status:"ok"` ledger row uncorrected forever. It now falls through into the existing `missing_exit_ledger` validation path so these runs are caught the same way an empty-but-present exit ledger already is.
- **`maintenance-inventory.ts`'s job catalog was missing `workshop-approval-reminder`** (plus, found in the same pass, `weekly-crystallization-skills-rescan` and `daily-lifecycle-sync`) — `hybrid-mem maintenance inventory` silently omitted these jobs entirely, so operators had no visibility into their schedule or last-run status.
- **`hybrid-mem-cron-default-job-steps.ts`'s required-step map was missing 11 of the ~20 defined maintenance cron jobs**, including `workshop-approval-reminder` itself, `monthly-consolidation`, and `daily-lifecycle-sync` — `reconcile-cron-ledgers`/`verify --reconcile` had no per-step mapping for these and fell back to cruder any-step-failed validation, or skipped entirely for jobs also missing from the catalog.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.62**.

---

## [2026.7.61] - 2026-07-05

### Fixed

A full code-review pass (8 parallel finder angles + verification) over the 2026.7.60 fixes below found and corrected three issues before merge:

- **The #2049 fix's repair-trigger condition was initially widened to include ID-set drift**, which would have let plain `verify --fix` (no `--reconcile`) silently delete/rebuild orphan vectors — bypassing the existing, deliberate `--reconcile` opt-in gate (with its own conservative/balanced/aggressive budget policy) that `verify --reconcile --fix` already provides for that exact destructive/expensive operation. Reverted `applyStorageStructuralFixIfNeeded`'s trigger to pure structural (non-orphan) drift only (`hasStructuralDrift`, unchanged from before 2026.7.60); ID-set drift is still reported as a failing issue pointing at `verify --reconcile --fix`. Also fixed a duplicate-issue overlap where `duplicateIdExtraRows` and `hasStructuralDrift` could both fire for the same root cause.
- **The #2050 fix's `jobMatchesPluginJobId()` initially fell back to matching a job's plain `name`** against the maintenance job catalog (mirroring `maintenance inventory`'s existing lookup), which could let an unrelated, user-created cron job that happens to share a catalog job's name (e.g. "maintenance-nightly") be reported as satisfying `cron-health`'s check. Simplified to check `pluginJobId`/`id` only — confirmed via `cron-jobs.ts` that `id` is always set to the canonical `pluginJobId` for plugin-managed jobs, so the name fallback was both unnecessary and a false-positive risk.
- **`verify`'s "Dream cycle + MEMORY_INDEX.md" line and an adaptive-sizing sample-model entry (`llm-models.ts`) still read the unfiltered, includes-disabled-providers tier list** — the same #2048 bug pattern, left in place a few lines below that fix. Both now use the filtered list, matching `dreamEffective` (which was already correct).
- **`doctor`'s `withTimeout()` checks could race a hung LanceDB/WAL call but never cancel it**, and `doctor`'s action was never wrapped in `withExit` (no `process.exit`), so the CLI process could still hang even after printing a correct, bounded report. Wrapped the action in the existing `withExit()` helper (already used by other CLI commands) so a real `openclaw hybrid-mem doctor` invocation actually terminates, without affecting tests that invoke the handler directly in-process. Also corrected the `DOCTOR_CHECK_TIMEOUT_MS` doc comment: synchronous `node:sqlite` calls (e.g. the fact-count check) block the JS thread and can't be preempted by `Promise.race`; those are bounded separately by SQLite's own 30s busy-handler, not by the 15s value introduced in 2026.7.60.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.61**.

---

## [2026.7.60] - 2026-07-05

### Fixed

- **Distill's in-flight-abort deadline stop was misclassified as a hard error (#2046):** the batch loop passes `getMaintenanceRunAbortSignal()` into the LLM call so it can be aborted when the orchestrator-wide deadline fires mid-call, but the resulting error landed in the generic `catch` block and was counted as `hardBatchFailures` (kind=`other`) instead of the existing `deadlineTruncated` classification — turning an expected, resumable deadline stop into a hard `distill partial failure`. The catch block now checks `maintenanceRunDeadlineReached()` first and routes to the non-blocking deadline path, matching the pre-batch check that already handles this correctly. `maintenance step <name>`'s hidden 4-minute default runtime budget (unaffected by `--force`) is now documented in its `--help` description, with a pointer to `--max-runtime-min` for clearing a full backlog in one run.
- **`distill.defaultModel` silently overrode `distill.modelTier` and disagreed with `config`/`verify` reporting (#2047):** `cmd-distill.ts` let `distill.defaultModel` win over the tier-resolved model unconditionally — including models from a disabled provider — while `config`/`verify` only ever reported the `distill.modelTier` result, so the two could name completely different models. Added `resolveDistillDefaultModel()` (`config/index.ts`) as the single resolver both the real run and `config`/`verify` now call; it also refuses to hand a disabled provider's model to `distill.defaultModel`, falling through to the tier result and surfacing a warning instead.
- **`verify` showed disabled-provider models as members of the "Effective tier lists" (#2048):** that summary line (and the "First choice per tier" line) was built from `getLLMModelPreferenceUnfiltered()`, which intentionally does not exclude `llm.disabledProviders` — so a disabled Gemini/Azure model configured in `llm.default`/`llm.heavy` still appeared as if it were part of the live fallback chain. The summary now uses the filtered `getLLMModelPreference()` result, with configured-but-disabled candidates broken out onto their own clearly-labeled line.
- **`verify --fix`/`verify` never surfaced SQLite/LanceDB ID-set drift (vector/sqlite orphans, duplicate Lance IDs) as a failure, and the exit code silently stayed 0 while `health` kept failing DB sync (#2049):** `logStorageSyncMetrics` detected and printed this drift but never touched `state.allOk`/`state.issues`, so `verify` (and `verify --fix`) reported success regardless. Fixed by marking `allOk=false` with an actionable remediation command (`verify --reconcile --fix` — orphan deletion/rebuild stays behind that explicit, budget-gated opt-in, same as before) whenever ID-set drift, embedding drift, structural drift, or duplicate Lance IDs are detected, and by re-checking the post-repair snapshot so drift remaining after a budget-limited `--fix` pass is reported honestly instead of a bare exit 0.
- **`maintenance cron-health` reported the nightly job missing on modern (SQLite-backed) cron stores (#2050):** `readOpenClawCronStore()` normalizes 2026.6.8+ SQLite cron rows to `job.id` and never populates `job.pluginJobId` (that field is legacy-JSON-store-only), but `cron-health`'s lookup only checked `job.pluginJobId === id`, so it always reported the job missing even though `cron-jobs.ts` sets `job.id` to the same canonical id at creation/normalize time. `cron-health` now also checks `job.id === id` via a new `jobMatchesPluginJobId()` helper (`maintenance-inventory.ts`).
- **`doctor` could hang indefinitely behind a wedged LanceDB/WAL lock (#2051):** the LanceDB/WAL-touching checks (vector DB connectivity, storage-sync snapshot, alias Lance diagnostics, WAL read/write probes) had no bound, so a lock left behind by a stuck maintenance run left `doctor` itself hanging instead of diagnosing the problem. Each of those checks is now wrapped in a 15s `withTimeout()` and reports a bounded, actionable failure pointing at a possible stuck maintenance/distill process; `doctor`'s action is now wrapped in the existing `withExit()` helper so the CLI process actually terminates afterward instead of hanging behind an abandoned native call that `withTimeout` can race but not cancel. (Purely-synchronous `node:sqlite` calls, e.g. the basic fact-count check, are unaffected by `withTimeout` — they're bounded separately by SQLite's own 30s busy-handler.)

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.60**.

---

## [2026.7.59] - 2026-07-05

### Fixed

- **`distill` still reported a hard `failed` status for a deadline-limited stop with real progress (#2043 follow-up):** 2026.7.58 fixed distill's wasted retries on a known-bad primary model, but a code-review pass over that PR found the step's *semantic outcome* was never touched — a run that stopped solely because the maintenance-run deadline was reached (with no other model/batch error) still incremented the same `batchFailures` counter used for genuine errors, so it always resolved to `semantic=partial` and failed the orchestrator step, reproducing the exact symptom #2043 reported. `cmd-distill.ts` now tracks genuine implementation/model errors (`hardBatchFailures`) separately from deadline-only stops (`deadlineTruncated`); a deadline-only stop with no hard failure now reports `semantic=monitoring` (non-blocking) via a new `monitoring` flag on the shared `LightJobRunParams`/`resolveLightJobRunOutcome` bridge (`services/maintenance-job-run/light-job-run-bridge.ts`), while cursor-advancement and "last successful run" bookkeeping remain conservative (still gated on any stoppage, deadline or error, exactly as before).
- **`cron-exit-validator`'s reflect-rules check was missing the `valid_no_actionable_rules` exemption (#2043 follow-up):** `maintenance-step-runners.ts` and `semantic-outcome.ts` both exempt `zero_rules_reason=insufficient_patterns` and `zero_rules_reason=valid_no_actionable_rules` from failure (the model ran fine and legitimately found nothing to extract), but `cron-exit-validator.ts`'s post-hoc log check only exempted `insufficient_patterns` — a pre-existing inconsistency surfaced by the same code-review pass. A healthy `valid_no_actionable_rules` run could be flagged as a semantic failure by this validator while the orchestrator and CLI paths correctly treated it as success. Both reasons are now exempted consistently across all three copies of this check.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.59**.

---

## [2026.7.58] - 2026-07-05

### Fixed

- **`passive-observer` reported a deadline-limited stop as a hard failure (#2043):** a maintenance-run-deadline stop mid-scan incremented the same `errors` counter used for real per-session failures (stat/read errors), so a healthy truncated run (`stored=54 scanned=487 errors=1`) was indistinguishable from an actual error and always failed the step. `ObserverRunResult` now tracks `deadlineStopped` separately from `errors`; a deadline-only stop reports `semantic=monitoring` (non-blocking) instead of `semantic=partial`, while real per-session errors still fail the step as before (`services/passive-observer.ts`, `setup/plugin-service.ts`, `setup/cli-context/cli-services.ts`).
- **`distill` made zero progress across multiple batches before exhausting its deadline (#2043):** every batch retried the primary model from scratch even after it had already timed out earlier in the same run, burning ~90s of retry/fallback cost per batch on a model already known to be unavailable and leaving the fallback too little of the remaining budget to ever complete a block. `runDistillForCli` now remembers a primary timeout/connection-error for the rest of the run and routes subsequent batches straight to the fallback chain (`cli/cmd-distill.ts`).
- **`enrich-entities` failed on a healthy, mostly-successful, budget-limited stop (#2043):** any nonzero `llmFailures` unconditionally counted as a hard failure, so a run that processed 90 facts with 2 transient LLM errors (`stopReason=time_budget`) failed the step exactly like a run that made no progress at all. `isEntityEnrichmentHardFailure` now tolerates a small LLM-failure rate (≤5%) on a budget-limited stop with real progress, and `entityEnrichmentSemanticStatus` reports a clean budget-limited stop as `monitoring` (resumable, checkpointed) rather than `success` or a hard failure (`services/entity-enrichment-adaptive.ts`).
- **`reflect-rules` reported `semantic=success` despite a real model-output parse failure (#2043):** `zero_rules_reason=invalid_response_format` (the model responded but its output couldn't be parsed at all) was explicitly exempted from failure whenever `status=degraded` and the model returned some output — silently reporting a broken week's rule extraction as `ok`. This carve-out is removed from all three places it was duplicated (`cli/commands/manage/maintenance-step-runners.ts`, `services/maintenance-job-run/semantic-outcome.ts`, `services/cron-exit-validator.ts`); `invalid_response_format` is now treated the same as any other degraded run, while the legitimate "nothing to extract" cases (`insufficient_patterns`, `valid_no_actionable_rules`) remain non-failing.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.58**.

---

## [2026.7.57] - 2026-07-05

### Fixed

- **`maintenance step <name> --force --verbose` still timed out under a 300s verification harness (#2041):** #2038/2026.7.56 added progress diagnostics to distill/enrich-entities/extract-implicit/passive-observer, but all four steps were still bounded only by the *orchestrator's* default per-step budget — 15 minutes for an isolated `maintenance step` diagnostic run — so a step doing legitimate, deadline-respecting work at the 5-minute mark would still be killed by an external supervisor wrapping the process in a fixed 300s timeout, turning an actionable partial/failed result into an opaque `exit=124`. `DEFAULT_STEP_MAX_RUNTIME_MIN` (`cli/commands/manage/register-maintenance-orchestrator.ts`) is now **4 minutes**, not 15 — scoped only to the isolated `maintenance step <name>` diagnostic command (`cycle`/`nightly`/`full` are unaffected). All four steps already abort in-flight LLM calls and stop their batch/session/chunk loops promptly once the orchestrator-wide deadline fires, so this single default change is enough to make every registered step's isolated verification run finish — completed or actionably failed — inside a 300s external window. Operators who want the previous 15-minute (or longer) budget for a real backlog-clearing run can still pass `--max-runtime-min` explicitly.
- **`extract-implicit`'s own soft deadline exactly matched a common external timeout (#2041):** independent of the orchestrator-wide budget above, `implicitFeedback.maxWallClockSeconds` defaulted to exactly 300 seconds — the same round number a verification harness would naturally choose — leaving zero margin for the function's own graceful-stop path (final progress emit, trajectory/session bookkeeping, DB commit, process exit) to complete before an external 300s timeout kills the process. Default is now 240s (`config/parsers/features.ts`, `cli/cmd-feedback.ts`).
- **`distill`'s pre-batch session-scan phase had no deadline check (#2041 review finding):** reading and tokenizing every candidate session file is synchronous CPU/file-I/O work with no LLM calls, so it never consulted the maintenance-run deadline; a wide `--days` catch-up window after an upgrade could in principle spend a meaningful slice of a tight verification budget here before the batch loop ever got a chance to check it. It now checks the deadline per file and, if truncated, surfaces an actionable `distill partial failure (session scan aborted: ...)` instead of silently under-reporting how many sessions were scanned. Two follow-up review passes then caught that (a) this could double-count the failure if the subsequent batch loop's own deadline check also fired on its first iteration — the batch loop now skips entirely once the scan phase has already recorded the deadline truncation, instead of logging a second, spurious "stopping batch loop" line; and (b) the returned `sessionsScanned` (and the `semantic_empty`/dry-run log lines) still reported the full candidate count instead of how many files were actually read before truncation, directly contradicting the "not silently under-reporting" goal above — both the job-run ledger and operator-facing log lines now use the truncated count when the scan was cut short.
- **`repair-vectors` and `reembed-vectorless` had no deadline check at all (#2041 review finding):** both steps loop over up to 200/1000 vectorless facts calling the embedding provider with zero `maintenanceRunDeadlineReached()` checks — the same class of unbounded-loop bug the rest of this release fixes for distill/enrich-entities/extract-implicit/passive-observer. Both now stop early and report `deadlineHit=true semantic=partial` (an actionable failure) instead of silently running past the step budget.
- **`closed-loop-analysis` never wired up the wall-clock check its own implementation already supports (#2041 review finding):** `runClosedLoopAnalysis()` accepts a `wallClockCheck` callback specifically to bail out of a large 30-day backlog scan early, but the maintenance step runner never passed one, so the mechanism was dead code from this call site. It now passes `() => maintenanceRunDeadlineReached()`, matching how `implicit-feedback-collapse` already wires the same deadline through.
- Four documentation/schema sites still said `maxWallClockSeconds` defaulted to 300 after the fix above changed it to 240: `docs/CONFIGURATION.md`'s example config and options table, `openclaw.plugin.json`'s JSON-schema description, and `config/types/features.ts`'s TSDoc comment. All four now say 240.

### Added

- **Deadline/budget reporting in maintenance progress logs (#2041):** every throttled progress line for `enrich-entities`, `extract-implicit`, `distill`, and `passive-observer` now reports `deadlineRemaining=<N>s` (or `unbounded` outside an orchestrator run), via a new `formatRemainingMaintenanceRunSecLabel()` helper (`utils/maintenance-run-deadline.ts`), plus `enrich-entities`' current `stopReason` and `extract-implicit`'s current `waitReason` — so an operator watching a live run can see the configured work budget and the reason progress has stalled, not just processed/total counters. `passive-observer` also gained an unthrottled start-of-run marker (matching `distill`'s existing one) reporting session count and deadline immediately, since its prior first progress line could otherwise be up to ~60s into the run — too late for a verification window tighter than that.

### Notes

- A code-review pass over the broader maintenance-orchestrator subsystem (prompted by this issue) also surfaced a lower-severity gap left as follow-up rather than fixed here: `evolution-pass`'s neighbor-LLM loop has no explicit deadline check in its own loop (though its LLM calls already carry the shared abort signal, so it degrades to heuristic-only after the deadline rather than hanging). `enrich-entities` still reports `semantic=success` for a time-budget stop as long as some progress was made and no calls failed outright, which does not by itself distinguish "small backlog, fully cleared" from "huge backlog, only the first batch touched" from the exit code and `semantic=` token alone — an intentional design choice for incremental catch-up (#2009) that a future issue may want to revisit with a distinct semantic token for "truncated with backlog remaining." (`repair-vectors`/`reembed-vectorless`, by contrast, always throw an actionable partial failure on `deadlineHit`, per the Fixed entry above — they don't share this ambiguity.)
- `repair-vectors`, `reembed-vectorless`, and `distill`'s session-scan phase each independently reimplemented the same "stop iterating once the maintenance-run deadline is reached" loop, with two different flag shapes (a boolean in the first two, a `-1`-sentinel index in the third) — a second review pass found this and factored it into one shared `runUntilMaintenanceDeadline()` helper (`utils/maintenance-run-deadline.ts`, with its own direct unit tests) that all three now call, so the truncation behavior can't drift out of sync between them again.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.57**.

---

## [2026.7.56] - 2026-07-05

### Fixed

- **`--max-runtime-min` bypassed the default cap on an empty string (#2031 follow-up):** `??` only falls back on null/undefined, so `--max-runtime-min=""` (e.g. a script interpolating an unset variable) silently produced no time budget at all for `maintenance step <name>`, instead of the intended 15-minute default.
- **`passive-observer` could report a false-positive truncated run (#2032 follow-up):** the maintenance-run deadline was checked before confirming a session actually had pending content, so hitting the deadline while only already-caught-up trailing sessions remained still reported an errored/truncated run even though no work was actually lost. The pending-content check now runs first.
- **`distill`'s heartbeat couldn't distinguish a retried batch from new content (#2038):** on failure, distill shrinks the batch and retries the *same* block range without advancing its cursor, but the heartbeat's "batch N" counter still incremented every attempt — so "batch 1, batch 2, batch 3" in the logs looked like forward progress through 1268 blocks when it was actually the same stuck range being retried 3 times. The heartbeat now also reports the block index the current attempt starts at, so an operator can see it staying constant across "batch" numbers.
- **`enrich-entities` and `extract-implicit` only surfaced the generic orchestrator heartbeat (#2038):** unlike `distill` and `passive-observer`, a `maintenance step enrich-entities`/`extract-implicit --force --verbose` run showed no counters of its own for the whole step duration. Both functions already accepted an `onProgress` callback; the maintenance step-runner registrations now wire a throttled-logging callback into it (same ~60s cadence as `passive-observer`'s progress log), so long runs report `processed=N/M`-style counters instead of only "still running after Ns".

### Notes

- Retroactively closed #2032 and #2033: both were already fixed by #2034 (shipped in 2026.7.51) and refined by later PRs in this series, but the PR bodies referenced the issues by number without a closing keyword, so they never auto-closed.
- #2038's remaining acceptance criteria (distill completing within a tight default verification budget, or exposing a dedicated smoke-test work limit) are not addressed here: every step run via `maintenance step <name>` is already bounded to a 15-minute default (overridable via `--max-runtime-min`, e.g. `--max-runtime-min 4` for a ~240s smoke check) and exits non-zero with an actionable reason when that budget is exceeded — operators who need a tighter check should pass that flag explicitly.
- An initial hypothesis attributing distill's stuck-batch symptom to a stale `MiniMax-M2.7-highspeed` context-window catalog entry was investigated and **rejected**: `tests/m27-live-catalog-limits.test.ts` empirically verified against the live API (dated after the release notes that motivated the hypothesis) shows `-highspeed` matches full `MiniMax-M2.7`'s 262k input / 128k output ceiling, so no catalog change was made.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.56**.

---

## [2026.7.55] - 2026-07-05

### Changed

- **De-duplicated `passive-observer`'s progress-log throttle:** the per-session and per-chunk progress log call sites (added across #2032 and its follow-up) each re-implemented the same "compute now, compare against last-logged time, update, log" logic independently, risking the two drifting out of sync (e.g. one throttled correctly while the other floods again after an unrelated edit). Both now call a single shared `logThrottledObserverProgress()` closure. No behavior change.
- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.55**.

---

## [2026.7.54] - 2026-07-05

### Fixed

- **`passive-observer` progress logging went silent for the entire span of a single multi-chunk session:** the throttle added for #2032 was only re-checked once per session (at the top of the outer loop), so a session with many chunks — each a full LLM round-trip via `chatCompleteWithRetry` plus an embedding call — could run for its entire multi-minute duration with zero progress lines, reproducing the exact "live run indistinguishable from a hung one" problem this logging exists to close. The throttle is now also re-checked inside the per-chunk loop.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.54**.

---

## [2026.7.53] - 2026-07-05

### Fixed

- **`--include`/`--force` skip-check only fired when *all* requested steps failed to run:** the #2031/#2032 diagnostic on `maintenance cycle/nightly/full --include x,y --force` used `every(...)` over the requested step names, so a partial run — e.g. two named steps where one ran fine and the other was locked — silently reported success. It now flags **any** requested step that didn't run.
- **`deferred` status wasn't treated as "didn't run":** a requested step pushed as `deferred` (time budget exceeded, or preemptively deferred by the rate-limit circuit breaker before its runner was ever invoked) fell through to the generic exit code instead of the specific "selected step(s) did not run" diagnostic. `deferred` now joins the missing/`skipped_*` cases; `failed`/`rate_limited` are intentionally excluded since those did invoke the runner and are already reflected in the exit code.
- Removed a pre-existing unused import (`readStepGuardTimestampMs`) in `register-maintenance-orchestrator.ts`, found during this review pass.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.53**.

---

## [2026.7.52] - 2026-07-05

### Fixed

- **`--include`/`--force` skip-check had a blind spot for a wrong-tier or misspelled step name:** the #2031 fix in `maintenance cycle/nightly/full --include x --force` filtered the orchestrator's step results down to the requested names before checking whether any of them ran; a name that belongs to a tier not requested (e.g. `cycle --include <nightly-only-step> --force`) or that `--exclude` also removed never produces a result at all, so the filtered list was empty and the check silently never fired — reintroducing the exact false-success bug #2031 closed, just one step quieter. The check now looks up each requested name individually and reports a step with no result as "no result (wrong tier, excluded, or unregistered runner)".
- **`--max-runtime-min 0` deferred every step instead of running with no budget:** `"0"` is a truthy, finite numeric string, so it produced a zero-minute `maxRuntimeMs`, which the orchestrator's "time budget exceeded" check treats as already exceeded before the first step starts — deferring every step, including the one a `maintenance step <name>` invocation was meant to run. A non-positive `--max-runtime-min` is now treated the same as "no budget", consistent with how a non-positive guard interval is already treated elsewhere in the orchestrator.
- **`passive-observer` per-session progress could flood the maintenance log:** the #2032 progress line logged unconditionally for every session with unread content; a multi-agent backlog could emit hundreds of lines in one run. Progress is now throttled to the same ~60s cadence as the orchestrator's existing per-step heartbeat.

### Changed

- Lock-owner detail (pid/host/held-duration/staleness/path) was formatted independently in the orchestrator's `skipped_guard` summary and in `maintenance status`'s lock listing; both now call a single shared `formatStepLockDetail()` in `cron-guard.ts` so the two surfaces can't drift out of sync.
- Corrected `maintenance status`'s `-v, --verbose` option description: active/stale maintenance locks are (and always were) shown unconditionally whenever present, not gated behind `--verbose` as the earlier wording implied — only the "no strict findings" log-health detail line is verbose-gated.
- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.52**.

---

## [2026.7.51] - 2026-07-05

### Fixed

- **`maintenance step <name> --force` no longer exits 0 when the selected step didn't run (#2031):** a targeted step blocked by a lock, feature gate, or dependency reported `skipped_guard`/`skipped_gate`/`skipped_dep` while still exiting 0, so a verification harness could believe a step had been tested when the orchestrator only skipped it. `maintenance step <name>` now exits non-zero when the selected step didn't execute (pass `--allow-skip` to treat this as a non-strict status check), and the lock-skip summary now includes the lock owner's pid, hostname, hold duration, staleness, and lock path so an operator can tell a real concurrent run from an abandoned lock.
- **`passive-observer --force` had no bounded runtime or mid-run progress (#2032):** a first-run backlog across many agents' sessions could keep a targeted `maintenance step passive-observer --force --verbose` run going for 12+ minutes with only generic `still running after Ns` heartbeats. `maintenance step <name>` now defaults `--max-runtime-min` to 15 (overridable) for these isolated diagnostic runs, passive-observer logs per-session phase/counter progress (`session N/M ... chunksProcessed=... factsStored=...`), and a run truncated by the maintenance-run deadline is now counted as an error instead of returning a silent "ok" that hides unprocessed sessions.
- **`maintenance status` no longer claims "All maintenance jobs healthy" while log analysis is failing (#2033):** cron-cadence freshness and `analyze-maintenance-logs`'s strict findings were reported independently, so an operator could see a green `status` and miss a recent strict failure from the same window. `status` now folds in a 24h log-health check (via the same analyzer `analyze-maintenance-logs` already uses) and no longer prints the unconditional healthy line when strict findings exist; the text and `--json` output both distinguish scheduler freshness from log/semantic health. `status` also now lists any active/stale maintenance step locks, since those are exactly what would make a subsequent `maintenance step --force` report `skipped_guard`.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.51**.

---

## [2026.7.50] - 2026-07-05

### Fixed

- **distill partial failure now surfaces the concrete cause (#2024):** the batch loop captured only `partialFailure`, so the ledger showed `distill partial failure (… semantic=partial)` with no root cause. The first concrete batch-failure reason (error kind + model + message, or maintenance-deadline / context-overflow) is now captured, persisted into the job-run `semanticReason`, and folded into the step-runner throw. `buildJobRunId` fingerprints are sanitized so run ids can no longer be malformed like `job-distill-::14:fal` (cap kept at 8 chars so hash-fingerprinted checkpoint dirs stay stable across upgrade).
- **`analyze-maintenance-logs` false-positive missing-exit-ledger (#2025):** aggregate `<job>.cron.log` files have no sibling `.exit.txt`; each run records an `HM_RUN_SUMMARY` referencing its own per-run ledger. The analyzer now validates each in-window run's `exit=` path, suppressing the anomaly when the ledger exists and flagging a genuinely-missing one pegged to its exact run id/timestamp.
- **`maintenance full --verbose` CPU-active but log-silent (#2026):** each orchestrator step now emits `start` / `still running after Ns` / `complete` heartbeat lines; the analyzer's progress regexes were broadened to recognize the generic `maintenance-orchestrator:` marker so a live CPU/LLM-bound step is classified as running rather than stale/hung.
- **store dedupe vectorThreshold plumbed on the live path (#2027):** the `memory_store` write path now resolves source/scope-filtered vector neighbour candidates from the already-computed embedding and passes them into write-time dedupe, so the configured `vectorThreshold` actually runs instead of silently degrading to lexical-only. Write-time vector dedupe is skipped when an explicit `supersedes` is provided so a near-identical correction cannot be swallowed as a dedupe no-op.

### Added

- **`maintenance step <name>` (#2028):** run exactly one named maintenance step in isolation (bypasses that step's cadence guard; inherits `--verbose`/`--json`). Unknown names exit non-zero and print the valid step list. Named `step` to avoid colliding with the `maintenance run` JobRun-inspection group and the `steps` list command.
- **Verbose distill progress/heartbeat (#2029):** distill emits a start marker, a periodic block-count heartbeat, and a final status/counter summary in verbose runs so a long LLM-bound batch is distinguishable from a hung one. Only counts/status are logged — never raw fact text.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.50**.

---

## [2026.7.33] - 2026-07-03

### Fixed

- **`hybrid-mem upgrade` no longer 404s (#2021):** the standalone upgrade path and every "manual upgrade" fallback message referenced `openclaw-hybrid-mem-upgrade`, a package that was never published to npm, so `openclaw hybrid-mem upgrade <version>` failed with `npm error 404` and the printed fallback command could not run. Both now use the published, in-repo `openclaw-hybrid-memory-install` package (`STANDALONE_UPGRADE_PACKAGE`), which npm-packs the target version straight into the extensions tree the gateway loads.
- **Extensions-canonical hosts: no more duplicate plugin tree (#2021).** When the gateway loads the plugin from `~/.openclaw/extensions/openclaw-hybrid-memory`, a leftover `~/.openclaw/npm/projects/openclaw-hybrid-memory` copy (typically from `openclaw plugins install`, which targets `npm/projects`) triggered gateway "duplicate plugin id" / "plugin entry path escapes plugin root" errors. `hybrid-mem upgrade` and `hybrid-mem verify --fix` now **remove** the redundant npm-project tree (guarded: only when extensions is canonical and not older than the npm-project copy) instead of merely re-pinning it, which had left the duplicate in place.

### Changed

- **Dual-install reconciliation guidance no longer recommends `openclaw plugins install` (#2021).** On extensions-canonical hosts that command reinstalls into `npm/projects` and recreates the very duplicate it was meant to fix; the guidance now points operators at `openclaw hybrid-mem verify --fix` / `openclaw hybrid-mem upgrade` and an explicit manual `rm -rf` fallback.
- **Docs:** `docs/UPGRADE-PLUGIN.md` gains a single blessed "Extensions-canonical hosts (Maeve/Doris layout)" upgrade section.
- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.33**.

---

## [2026.7.32] - 2026-07-03

### Fixed

- **Persona proposal routing bias:** the durable-rule router already classified operational guidance to `AGENTS.md`/`TOOLS.md`, but `resolvePipelineProposalTarget()` only recorded the suggestion as advisory, so every pipeline-generated rule (dream-cycle, self-correction, reinforcement) still landed in `SOUL.md` via `inferTargetFile()`'s default. Confident routing suggestions now **retarget** the proposal onto the recommended operational file when it is allowlisted. Retargeting is intentionally limited to `AGENTS.md`/`TOOLS.md` (the destinations upstream target inference cannot produce); routing among the identity files stays advisory so it never overrides a deliberate `USER.md`/`IDENTITY.md` choice.

### Changed

- **`personaProposals.allowedFiles`** now accepts and defaults to the operational authority files as well: `["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md"]`. Human approval is still required before any file is written (`autoApply` stays off by default); narrow the list to keep proposals away from operational files.

---

## [2026.7.31] - 2026-07-03

### Added

- **Structured contact profiles (#2014):** `contacts` rows carry phone/role/board fields; email/phone/role merge from `memory_store` / auto-capture (gated by `contacts.profileEnrichment`); prefix dedup for NER (`Daniel` → `Daniel Thunberg`); `contacts list|suggest-merges|merge|import|sync` CLI (`merge` accepts a contact id **or** a name); per-org summary roster fact with `PART_OF` links from each person's roster fact (`--no-part-of` to skip); richer `memory_directory` (`list_contacts`, grouped `org_view`); `contacts.*` config block (`profileEnrichment`, `requireSurname`, `importPath`).
- **Storage sync diagnostics & repair:** unified SQLite ↔ LanceDB drift detection (ID-set, row-count, embedding, structural) and a policy-driven storage-repair pipeline wired into `hybrid-mem verify` / `doctor`; retrieval-alias rebuild CLI (`rebuild-aliases`).
- **Context engine:** synchronous ContextEngine registration to win the plugin cold-start race (#273); root `hybrid-mem --version` flag with GitHub/npm update notices.

### Fixed

- `contacts merge` now repoints `facts.entity_contact_id` (not just NER mentions) before deleting the merged-away contact, so no fact is left pointing at a deleted contact row.
- Contact-import roster stores are idempotent on re-run (deduped stores no longer create duplicate facts or `PART_OF` links).
- **Packaging:** `index-version-cli.ts` (the `hybrid-mem --version` fast-path added in #2013) was missing from `package.json` `files`, failing `verify:publish` and blocking the npm publish for this release (originally tagged 2026.7.30; re-cut as 2026.7.31 after the fix).

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.7.31**.

---

## [2026.6.292] - 2026-06-29

### Fixed

- **Install-index drift after upgrade (#2008):** New helper `cli/install/install-index-reconcile.ts` detects stale entries in the legacy `${stateDir}/plugins/installs.json` sidecar (e.g. an old npm-project install at `~/.openclaw/npm/projects/openclaw-hybrid-memory/...`) and atomically drops them after backing the sidecar up. This stops OpenClaw core state migrations from emitting the persistent warning "Left plugin install index in place because shared SQLite state has conflicting plugin install metadata for: codex, openclaw-hybrid-memory" on every Gateway restart after an extension upgrade. Wired into `runUpgradeForCli`, `runInstallForCli`, and the `verify` infrastructure section; new CLI subcommand `openclaw hybrid-mem install-index reconcile [--dry-run] [--plugin-id <id>]` for manual repair. Sidecar and npm-project paths resolve via `OPENCLAW_HOME` / config path env vars (aligned with verify); embedded `plugins[].installRecord` legacy shapes reconcile correctly.
- **Dual plugin install metadata drift (#2008):** Upgrade and `verify --fix` also reconcile stale npm-project pins when extensions is canonical; dual-install warnings include targeted repair commands (`openclaw plugins install`, `hybrid-mem upgrade`, `verify --fix`, `install-index reconcile`).
- **Enrich-entities incremental catch-up (#2009):** `isEntityEnrichmentHardFailure` / `entityEnrichmentSemanticStatus` shared helpers so bounded runs with `stopReason=exhausted`, `processed>0`, and `llmFailures=0` no longer fail maintenance, CLI exit code 2, or cron guard validation (including legacy logs that still emit `semantic=partial`). Hard failure remains for `llmFailures>0` or budget stops with zero facts processed. Missing `processed` in older logs no longer triggers a false hard failure.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.292**.

---

## [2026.6.291] - 2026-06-29

### Fixed

- **Auto-classify MiniMax-M2.7-highspeed thinking-only output (#2006):** `services/auto-classifier.ts` `completeClassifyJsonArray` helper applies MiniMax `thinkingMode: "disabled"`, `Math.min(800, 80 * n)` output budget, `stripThinkingWrapperBlocks` + parse, and a single retry on parse failure for both `classifyBatch` and `discoverCategoriesFromOther`. `classifyBatch` now fails the batch when the JSON array length does not match the fact count (no silent partial success). `utils/llm-json-array.ts` `stripThinkingWrapperBlocks` strips unclosed <redacted_thinking> / `<thinking>` / `<reasoning>` suffixes and preserves JSON array tails after truncated reasoning. Tests: `tests/auto-classifier-thinking-retry.test.ts` (12 cases) and 14 cases in `tests/llm-json-array.test.ts`. Documented M2.7-highspeed as unsuitable for batch JSON auto-classify in `autoClassify.model` help text.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.291**.

---

## [2026.6.290] - 2026-06-29

### Added

- **Persona rule router (#2002):** Destination classifier for durable-rule persona proposals — authority-bucket routing, cross-surface semantic dedup, contradiction detection against reflection rules, and advisory retarget suggestions (e.g. GitHub issue workflow rules → `AGENTS.md`).

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.290**.

---

## [2026.6.276] - 2026-06-27

### Fixed

- **Graph config schema (#1997):** Add missing `coOccurrenceWeight`, `autoSupersede`, and `hubScorePenalty` to `openclaw.plugin.json` graph schema so Maeve-style configs pass gateway validation (`additionalProperties: false`).

### Added

- **Schema parity gate:** `plugin-graph-schema-parity.test.ts` + `GRAPH_CONFIG_INPUT_KEYS` assert parser-accepted graph keys exist in the plugin manifest; wired into `verify:gate` so schema drift is caught before release.

---

## [2026.6.275] - 2026-06-27

### Fixed

- **Upgrade dual install paths (#1989):** Use post-install `installedPluginDir` for bundle verify, workspace refresh, npm pin checks, and CLI output; rollback cleans extensions install on failure.
- **Graph auto-link (#1994):** When a store vector exists, semantic auto-linking no longer falls back to classification heuristics after an empty embedding search — similarity threshold is enforced.

### Added

- **Graph config (#1993–#1995, merged from #1996):** `autoLinkStrength` + `autoLinkSimilarityThreshold` (legacy `autoLinkMinScore` deprecated); embedding-gated `autoLinkSemanticallySimilarFacts`; canonical `createOrStrengthenRelatedLink`; `autoSupersede` contradiction rows; enhanced/complete presets align GraphRAG (`defaultExpand`, `retrieval.strategies` includes `graph`); boot warnings via `warnGraphRecallConfigMisconfiguration`.
- **Verify (#1989):** Warn when npm-project and extensions plugin copies both exist.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.275**.

---

## [2026.6.274] - 2026-06-27

### Fixed

- **Upgrade dual install paths (#1989):** After install, upgrade uses `resolveInstalledPluginDir` for bundle verify, workspace skill/TOOLS refresh, npm pin bundle check, and returned `pluginDir` instead of the stale pre-move npm path.
- **Upgrade rollback:** Removes extensions-target install copy on failure when it differs from the pre-upgrade path.

### Added

- **Verify:** Warns when npm-project and `~/.openclaw/extensions` plugin copies both exist (version mismatch or duplicate at same version).

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.274**.

---

## [2026.6.273] - 2026-06-27

### Fixed

- **Goal corrupt-report ledger (#1988):** `repairQuarantinedGoalFile` removes persisted `_corrupt-reported.json` entries so restored goals are not suppressed after restart; quarantine runs before ledger write so failed renames can retry.
- **Verify `--fix` (#1987):** Removes only the goal index drift warning instead of popping the last warning (e.g. event-loop lag).
- **Error reporter dedupe (#1988):** 24h chronic dedupe applies only to `invalid_goal_registry_entry`, not all fingerprinted warnings.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.273**.

---

## [2026.6.272] - 2026-06-27

### Fixed

- **Goals / active-tasks reliability:** `goal-context`, `goal-stewardship`, and `active-task-injection` are protected from the 800ms optional hook skip; stages cap wall-clock via budget-aware timeouts.
- **Active-task coherence:** Persist up to 3 incoherent rows per turn before injection; tightened terminal inference heuristics; reconcile progress telemetry uses correct action/previous status.
- **Upgrade rollback (#1985):** npm-project `package.json` / lockfile restored when pin verification fails; workspace refresh failure rolls back plugin + npm pin.
- **Verify:** Pending error-reporter queue counted from on-disk JSONL when reporter is cold; quarantined corrupt goal files surfaced as warnings.

### Added

- **`goals doctor --repair-corrupt`:** Restore quarantined `*.json.corrupt` goal files that parse as valid Goal JSON; rebuilds goal index after repair.
- **Dashboard infrastructure card:** Pending telemetry queue depth and quarantined goal count on Mission Control overview.
- **`doctor` CLI:** Error-reporter pending queue and goal quarantine checks with fix hints.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.272**.

---

## [2026.6.271] - 2026-06-27

### Fixed

- **Upgrade reliability (#1985):** `hybrid-mem upgrade` passes `OPENCLAW_EXTENSIONS_DIR` to the standalone installer, verifies bundled assets before deleting backup, fails on workspace refresh errors, and **requires** npm-project pin + bundle verification (rollback on failure).
- **Maintenance CLI deprecation (#1983):** Cron template and `verify --fix` normalize `analyze-maintenance-logs` → `maintenance analyze-logs`.
- **Validate-exit (#1982):** Empty HM_EXIT with wrapper abort before `hm_step` reports `failureClass: wrapper_aborted_before_steps` instead of misleading missing-step errors.
- **Goal assess (#1981):** Null-safe params and corrupt goal JSON return structured tool errors instead of throwing on `.trim()`.
- **Episode contradictions (#1976):** Scoped `memory_record_episode` failure scans no longer build invalid SQL (`AND AND`).
- **Corrupt goal telemetry (#1977):** Quarantine corrupt goal files to `.json.corrupt` and dedupe error-reporter captures per file.
- **Error reporter drain (#1978):** Adaptive shutdown flush, multi-attempt startup drain, fingerprint dedupe in pending queue, **`hybrid-mem verify` reports pending count**.
- **before_agent_start budget (#1979):** 12s gateway hook budget caps setup/recall; **all optional prepend stages** skip under budget pressure with per-stage slow logging.
- **Workboard shutdown (#1980):** Suppress RPC/update warnings during gateway shutdown; stop timers before error-reporter flush.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.271**.

---

## [2026.6.270] - 2026-06-27

### Fixed

- **Active-task tools (facts ledger):** `loadActiveTasksForTools` destructures `{ active }` from `loadTaskLedgerFromFacts` so `active_task_list` / `active_task_get` no longer throw at runtime.
- **Active-task ledger split-brain:** Default `activeTask.ledger` is now `facts`; `active_task_checkpoint` syncs `ACTIVE-TASKS.md` when `ledger: markdown` so stored tasks appear in injection and file-based tools.
- **Active-task injection:** Tasks with missing `task_updated` (`Unknown`) are no longer treated as stale; generic-title projection filter no longer hides tasks from injection; checkpoint default title uses humanized entity label instead of `"Project task"`.
- **Goal stewardship heartbeat:** Fall back to compact `<active-goals-summary>` when stewardship bundle is empty or dispatch rate-limited, so heartbeat turns still recall registered goals.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.270**.

---

## [2026.6.261] - 2026-06-26

### Fixed

- **Dashboard startup (#1968):** Destructure `embeddingRegistry` in plugin service context so Mission Control starts instead of failing with `ReferenceError: embeddingRegistry is not defined`.
- **Install config schema (#1969):** Stop merging OpenClaw-invalid `flushEveryCompaction` into core `compaction.memoryFlush`; strip legacy keys on `hybrid-mem install`.
- **Consolidation LLM:** Pass the `openai` client parameter to `chatCompleteWithRetryDetailed` instead of undefined `opts.openai`.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.261**.

---

## [2026.6.260] - 2026-06-26

### Fixed

- **Audit health strict mode (#1955):** Add `audit health --strict-errors` so weekly cron fails only on errors/degraded status, not sustained store-backlog warnings; cron normalize migrates stale `--strict` jobs.
- **Continuous verification model (#1956):** `resolveVerificationModel()` skips disabled providers; all-UNCERTAIN cycles classify as monitoring (`all_uncertain`) instead of silent success.
- **Distill truncation (#1959):** Bounded retry/split on `finish=length`, output-token floor, `truncatedBatches` logging, and `partialFailure` when output is truncated.
- **Cron delivery (#1961, #1962):** Bash harness forbids deferred `tool_call`; maintenance-nightly and workshop-approval-reminder use exec/bash-only guidance and digest harness.
- **memory_procedure_feedback procedure_not_found (#1965):** Unknown `procedureId` returns `isError: true` with actionable text and stable `details.hint`; prevents agent tool retry loops.
- **Maintenance observability (#1960):** Unified maintenance cycle tick logs success (info) and skip reasons (debug).
- **writeFileSync regression (#1963):** Regression test ensures maintenance modules import `writeFileSync` from `node:fs`.

### Added

- **Extract-implicit ETA (#1957):** Orchestrator summary includes `sessionsRemaining` and `estimatedRunsToComplete` on graceful `maxWallClock` partials.
- **Contradiction backlog alert (#1958):** Auto summary emits `backlog_alert` and triage command when ambiguous backlog exceeds threshold with no auto-progress.
- **Procedural memory first-run capture (#1967):** `memory_procedure_feedback` accepts optional `registerIfMissing` with `taskPattern` + `steps[]` to register a draft procedure and record feedback in one call.
- **Procedures workflow docs (#1966):** Tool schema and bundled `hybrid-memory` SKILL document recall → feedback vs first-run paths and anti-patterns.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.260**.

---

## [2026.6.259] - 2026-06-25

### Fixed

- **Extract-implicit trajectory LLM (#1953):** Bounded concurrency (4 workers), per-trajectory timeout (~30s), and wall-clock watchdog so one hung call cannot block the nightly run for hours; scan cursor advances on sessions processed, not visited.
- **Maintenance run deadline (#1953 follow-up):** Orchestrator-wide deadline with cooperative abort signal; per-step timeouts capped by remaining run time across auto-classify, distill, passive-observer, entity-enrichment, consolidation, incident batch analysis, reinforcement/self-correction batch loops, and inter-step LLM cooldown.
- **Auto-classify:** Nightly path uses `chatCompleteWithRetry` with maintenance timeouts; preserves `"[]"` fallback when the assistant message is stripped as an empty placeholder.
- **Incident batch analysis:** Retries and batch splits stop when the orchestrator deadline is reached.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.259**.

---

## [2026.6.258] - 2026-06-25

### Fixed

- **Maintenance nightly exit codes (#1949):** Treat `extract-implicit` budget-cap partial runs (`maxWallClock`, session/signal/trajectory caps) as successful monitoring steps instead of failures; stop counting continuous-verification LLM downgrades to `UNCERTAIN` as errors and do not fail nightly when all facts receive uncertain verdicts; run orchestrator `audit-health` non-strict (warnings only) while still failing on report errors. Cron exit validator ignores legacy `all_uncertain` degraded machine-status lines.
- **memory_store empty args (#1950):** Require string `text` before validation so streaming-parser `{}` or malformed args return structured `invalid_text` instead of throwing on `undefined.trim()` or coercing objects to `[object Object]`.
- **Maintenance guard (#1949 review):** Allow cron guard advancement when summary validation reports monitoring-only degraded semantics with no blocking issues.

---

## [2026.6.256] - 2026-06-25

### Fixed

- **GraphQL auth:** Anonymous mutations (`{ deleteFact(...) }`) now require `dashboard.token`.
- **GraphQL pruneFacts:** Requires valid `olderThan`; no longer deletes all facts when omitted or unparsed.
- **GraphQL mutations:** Index LanceDB on create/import/update; delete vectors on supersede/delete; publish subscription events.
- **GraphQL queries:** `search`/`semanticSearch` scope filter; `entityFacts`/`relatedFacts` active-only; `graph` includes `memory_links`.
- **Crystallization tool:** `getRawDb()` required only when worker leases are enabled.

---

## [2026.6.255] - 2026-06-25

### Fixed

- **Mission Control write auth:** Optional `dashboard.token` requires Bearer/`X-Dashboard-Token` on verify/forget/workshop/GraphQL POST routes.
- **Distill vector dedupe (degraded):** Scoped neighbour filtering before unscoped `hasDuplicate`; unscoped hits no longer skip writes.
- **GraphQL updateFact:** Artifact/reasoning-trace text always rejected; legacy source bypass no longer skips text guard.
- **Auto-capture WAL:** Dedup-window peek before WAL write avoids orphan WAL entries on skip.
- **Dashboard forget/GraphQL delete:** LanceDB vectors removed when facts are forgotten or deleted.
- **Passive observer:** Session-scoped vector dedupe validates live facts before treating matches as duplicates.
- **GraphQL expiry filters:** `facts`/`search` compare `expiresAt` in unix seconds (not milliseconds).
- **GraphQL updateFact:** Removes LanceDB vector for superseded fact id after in-place edit.

### Changed

- **Pre-store guard:** Artifact/reasoning-trace text blocked even when `allowPreStoreGuardBypass` is set (category/source bypass unchanged).
- **GraphQL auth:** `dashboard.token` required only for mutations; read-only queries work without a token.

---

## [2026.6.254] - 2026-06-25

### Fixed

- **memory_store WAL routing:** Use bound `walWrite`/`walRemove` helpers when the default WAL handle is null (fixes test regressions and legacy tool registration paths).
- **Capture dedup window:** Gracefully skip SQLite transaction wrapper when `factsDb.getRawDb()` is unavailable (passive-observer, stage-capture, maintenance CLI mocks).
- **Config guards:** Optional-chain `lifecycle.fragmentEmbedding`, `provenance`, and `verification` in memory_store.
- **Live MiniMax tests:** Opt-in via `RUN_LIVE_MINIMAX_TESTS=1`; update ceiling probes and fetch timeouts.

### Changed

- Version set to **2026.6.254**.

---

## [2026.6.253] - 2026-06-25

### Fixed

- **Distill dedupe QA (#1945, #1947):** Restore `vectorDb.hasDuplicate` when `fuzzyDedupe` is disabled; redact maintenance-private text before the lexical pre-check; increment `skipped` when `storeWithResult` returns `skipped`.
- **Distill vector fallback:** Skip useless `hasDuplicate` when LanceDB schema is invalid (it always returns false); only use the fallback when schema is valid.
- **Distillation entity drift:** Require compatible entity slugs (prefix relationship) for vector dedupe — same key alone is no longer enough across unrelated projects.
- **Project-state LWW overload heuristic:** Flag asymmetric ref splits (e.g. 2+1) while still allowing symmetric 2+2 queue drift (#1945).

### Changed

- Version set to **2026.6.253**.

---

## [2026.6.252] - 2026-06-25

### Fixed

- **Project-state LWW entity-reuse heuristic (#1945):** Count distinct PR/issue refs per fact instead of across both facts in a pair, so legitimate project-state transitions no longer false-positive as `possible-entity-reuse`.
- **Distill vector dedupe (#1947):** Wire LanceDB neighbour candidates into `storeWithResult`, restore `hasDuplicate` fallback when vector search degrades, pass structured fields into the lexical pre-check, and allow distillation project facts to vector-dedupe across entity slug drift while preserving the #1276 guard for other sources.

### Changed

- Version set to **2026.6.252**.

---

## [2026.6.250] - 2026-06-25

### Fixed

- **Maintenance nightly abort on degraded contradiction backlog (#1942):** `resolve-contradictions` no longer throws when the ambiguous backlog crosses the degraded threshold, so `maintenance-nightly` continues through downstream steps and cron guard files advance while operators still receive degraded telemetry.
- **Monitoring-only maintenance signals:** Introduced non-blocking `semantic=monitoring` for operational signals (degraded contradiction backlog, transient `record-storage-sample` unavailability) that surface in validation without aborting the orchestrator or blocking guard advancement.
- **`reflect-rules` tolerated flake:** Orchestrator runner no longer treats tolerated `invalid_response_format` flakes (non-empty model response) as fatal semantic failures.
- **Legacy cron `resolve-contradictions` exit code:** Standalone CLI preserves shell exit `2` on degraded backlog; cron wrappers (`HM_JOB` set) keep shell exit `0` so `nightly-memory-sweep` does not abort under `set -e`.

### Changed

- Version set to **2026.6.250** (replaces invalid npm version `2026.250`).

---

## [2026.6.241] - 2026-06-24

### Fixed

- **Gateway registration regression (#1938):** `hasBoundMemoryToolHelpers()` rejected pre-bound memory tool contexts when `wal` was present, causing `registerMemoryTools: Missing required legacy helper functions` on cold gateway start in **2026.6.240**. Bound helpers are now authoritative; legacy mode is detected only when those helpers are missing.
- **Crystallization tool contract (#1939):** Added `memory_crystallize_restore` to `contracts.tools` / `AGENT_TOOL_CONTRACT_NAMES` so OpenClaw 6.x no longer warns about an undeclared runtime tool.
- **Workboard cold-start probe (#1940):** Deferred the initial Workboard availability probe by 60s and retry up to 3 times with 15s backoff so sync arms after other gateway plugins finish loading, without requiring a manual re-register.

### Changed

- Version set to **2026.6.241**.

---

## [2026.6.240] - 2026-06-24

### Fixed

- **Maintenance orchestrator guard writes (`writeFileSync is not defined`, #1934):** `extensions/memory-hybrid/services/cron-guard.ts` called `writeFileSync` in `writeStepGuardTimestampMs()` without importing it from `node:fs`. Successful maintenance steps then threw at the post-step guard write, causing nightly maintenance to report widespread failures (including `vectordb-optimize` and `repair-vectors`) even when the step runner succeeded. Restored the import and added unit/integration regression tests plus a CI Maintenance Gate (`tsc --noEmit` on scoped files + guard/orchestrator tests).

### Changed

- **Full-tree TypeScript check:** Cleared ~325 `tsc --noEmit` errors across CLI, services, tools, and tests so CI typecheck is enforceable again (stale typings, test mocks, and latent strictness mismatches).
- Version set to **2026.6.240**.

### Upgrade note

- After upgrading from **2026.6.170** / **2026.6.171**, **rerun maintenance once** (`openclaw hybrid-mem maintenance run --force --tiers nightly,cycle`) or wait for the next `maintenance-nightly` cron so vector/storage steps can complete and guard files are written. See [release-notes-2026.6.240.md](release-notes/release-notes-2026.6.240.md).

---

## [2026.6.171] - 2026-06-21

### Fixed

- **memory_search_episodes throws `sanitizeFts5QueryForFacts is not defined`:** `backends/facts-db/episodes.ts` referenced the FTS5 query sanitizer from `backends/facts-db/fts-text.ts` without importing it, so episode search with a query exploded. Added the missing import alongside the existing sibling in `fact-queries.ts`. Smoke tests cover plain queries, special-character queries, null bytes, and FTS5 operators, plus unit coverage of `sanitizeFts5QueryForFacts`.

- **memory_recall_timeline throws `requires an authenticated session context` from OpenClaw gateway invocations:** The OpenClaw gateway tool context does not inject `api.context.sessionId`. The tool previously hard-failed; it now falls back to cross-session timeline recall (recency-windowed, default 14 days — the path `recallNarrativeSummaries` already supports with `sessionId: null`). The existing security invariant is preserved: a caller-supplied `sessionId` is still rejected when no authenticated context is available, and must still match the authenticated context when one is present.

- **memory_session_observability hard-fails with cryptic error:** Per-session observability has no cross-session equivalent, so it still requires a `sessionId`. The error message now explains how to recover (pass `sessionId` as a parameter or invoke from an authenticated session context).

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.171**.

### Notes

- Supports the OpenClaw gateway memory/RSS incident follow-up: hybrid-memory is the canonical memory layer, so recall / timeline / episode search smoke must be reliable.

---

## [2026.6.170] - 2026-06-17

### Fixed

- **#1925 verify false positives:** Standalone plugin cron jobs (`workshop-approval-reminder`, pending digests, log analyzer, sensor sweep, lifecycle sync) are no longer flagged as superseded legacy jobs or disabled by `verify --fix` under consolidated orchestrator mode. Workboard verify/sync falls back to `openclaw gateway call` when HTTP `/rpc/*` is unavailable on OpenClaw 6.8+. Summary.json warnings are scoped to harness-enabled cron payloads and the most recent nightly run only.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.170**.

---

## [2026.6.161] - 2026-06-16

### Fixed

- **#1923 OpenClaw 6.8+ cron store:** `verify`, `verify --fix`, install, maintenance inventory, dashboard, cron guard sync, and active-task wake scheduling now read/write the live OpenClaw cron store (`~/.openclaw/state/openclaw.sqlite`) when legacy `jobs.json` has been migrated, instead of creating a transient JSON file that OpenClaw immediately archives.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.161**.

---

## [2026.6.160] - 2026-06-16

### Added (Epic #1918 — ClawMem-inspired memory cycle)

- **#1910 Retrieval v2**: intent classifier (`WHY`/`WHEN`/`ENTITY`/`WHAT`/`GENERAL`), composite score (v1 shadow / v2 active), BM25 strong-signal bypass (semantic skip only; composite/MMR still run), MMR diversity demotion, position-aware cross-encoder rerank blend, `OPENCLAW_HM_VERBOSE` structured logging, recall stage stats + `/api/viewer/recall-stats`, labeled corpus + NDCG gate in `tests/perf/recall-benchmark-gate.test.ts`.
- **#1911 Agent verbs**: `memory_retrieve`, `memory_pin`, `memory_snooze`, `diary_write`, `diary_read` with `pinned_at` / `snoozed_until` columns.
- **#1912 Context boundary**: 5-layer injection filter, structured `<vault-context>` wrapper inside recalled-context blocks, vault-facts SPO helpers.
- **#1913 Maintenance lane**: `maintenance_runs` audit journal, doctor maintenance-health warnings, `evolution-pass` + `per-folder-context` in plugin cycle runners.
- **#1914 Semantic lifecycle**: per-content-type half-lives, quality/evolution columns, A-MEM heuristic + nano-LLM neighbor evolution (`lifecycle.evolution.mode`), fragment embedding + recall UX (parent context, prefer fragments), `hybrid-mem status` evolution counts, `parent_fact_id` migration.
- **#1915 Conversation mining**: `hybrid-mem mine <path>` CLI with transcript parsers and idempotent content-hash ingest.
- **#1916 Recall feedback**: recall signals, memory nudge system, contamination guard, closed-loop `applyToRecall` rule boosts in retrieval v2.
- **#1917 Operator DX**: multi-vault fan-out, per-vault WAL paths, vault registry teardown on reload, per-WAL circuit breaker sentinels (`{walPath}.disabled`), doctor retrieval-health block, `hybrid-mem bootstrap`, `hybrid-mem focus`.

### Changed

- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.160**.

### Notes

- All behavioral features ship behind conservative config defaults (`compositeScore.v: 1`, `bypass.enabled: false`, `diversity.enabled: false`, `reranker.kind: llm`).
- Cross-encoder rerank defaults to `Qwen3-Reranker-0.6B-Q8_0` (Apache 2.0) when `reranker.kind: cross-encoder` is set.

---

## [2026.6.55] - 2026-06-05

### Added

- **Two-tier OpenClaw version check**: `RECOMMENDED_OPENCLAW_VERSION` (**2026.6.1**) logs at startup when the gateway meets the **2026.5.0** floor but is below the recommended tier (Skill Workshop, skills snapshot hot-reload, Dreaming tab).
- **Gateway memory diagnostics HTTP routes**: `GET /plugins/memory-public/process-memory` and `GET /plugins/memory-public/memory-diagnostics` (RSS/heap/native breakdown, reregister metrics, leak hints for monitoring).
- **`docs/MEMORY-LEAK-OPERATIONS.md`**: production RCA summary and operational checklist.

### Fixed

- **SQLite facts.db pragmas**: clamp `OPENCLAW_FACTS_CACHE_SIZE_KB` / `OPENCLAW_FACTS_MMAP_SIZE` to on-disk DB size to prevent multi-hundred-MB anonymous over-reservation.
- **Lance shadow table cache**: cap at 4 entries during bulk re-index to avoid unbounded native handle growth.
- **Maintenance backfill CLI migrations** and related workshop/proposal pipeline fixes on the maintenance branch.

### Changed

- **Maintenance CLI overrides ([#1798](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1798), [#1799](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1799)):** scan-style commands share `--force` (preferred) and legacy `--full` to bypass 23h scan cooldown and incremental watermarks; `run-all` propagates overrides; cron QA harness injects `--force`.
- Bumped plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.6.55**.

---

## [2026.6.20] - 2026-06-02

### Added

- **Adaptive catch-up for entity enrichment and vectorless re-embed** ([#1792](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1792), [#1791](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1791), [#1738](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1738)): pressure-aware batch sizing, pacing, and SLO repair summaries for maintenance catch-up workloads.

### Fixed

- **Extract-directives vector dedupe** and maintenance CLI diagnostics ([#1794](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1794), [#1788](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1788)–[#1790](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1790)).
- **Weekly persona proposals** no longer mask `generate-proposals` LLM failures as success with zero proposals ([#1793](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1793)).
- **Nightly dream-cycle** durable exit/validation markers for mid-stage interruptions ([#1783](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1783)).
- **Resolve-contradictions** actionable unresolved buckets in output ([#1782](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1782), [#1781](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1781)).
- **Agent-end narrative hook**: restore `getCronModelConfig` ([#1778](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1778), [#1775](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1775)).
- **Embedding path** no longer retries non-ASCII `ByteString` serialization failures ([#1777](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1777), [#1776](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1776)).

### Changed

- Bumped plugin package, lockfile, plugin manifest, and installer package versions to **2026.6.20**.
- Added release notes at `release-notes/release-notes-2026.6.20.md`.

---

## [2026.5.311] - 2026-05-31

### Fixed

- **Plugin registration must be synchronous** ([#1768](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1768) follow-up, [#1773](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1773)): restored synchronous `register()` for OpenClaw gateway compatibility. Hot-reload teardown blocks up to **TEARDOWN_WAIT_MS** (6s) before reopening database handles via `blockReloadTeardownBeforeOpen()`.
- **Hot-reload database reuse under `reuse-databases` policy**: compare parse-time config snapshots instead of bootstrap-mutated runtime `cfg` (e.g. auto-injected empty `llm` tiers), and normalize non-enumerable `credentials.encryptionKey` so re-register can reuse handles when plugin config is unchanged.
- Reload-coordinator tests use bounded waits only (no infinite `timeoutMs=0` in sync paths — vitest cannot interrupt `Atomics.wait` loops).
- Bumped plugin package, lockfile, plugin manifest, and installer package versions to **2026.5.311**.

### Notes

- **2026.5.310** could fail gateway startup with `Error: plugin register must be synchronous` because register briefly returned a Promise. Upgrade to **2026.5.311** immediately if you hit that error.

---

## [2026.5.310] - 2026-05-31

### Added

- **Entity extraction quality pipeline** ([#1693](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1693), [#1702](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1702)): quality gate, canonicalization, cleanup/backfill tooling, and support for non-PERSON/ORG entity types so the facts graph stays cleaner as extraction volume grows.
- **Smarter entity enrichment scheduling** ([#1690](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1690), [#1727](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1727)): `enrich-entities` can prioritize by tier, access, and importance, with catch-up modes for backlog recovery.
- **Autonomous contradiction resolution** ([#1692](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1692), [#1701](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1701)): `resolve-contradictions` can autonomously resolve a large share of ambiguous pairs using safe policies plus LLM adjudication, reducing manual triage queues.
- **Audit-health diagnostics expansion** ([#1735](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1735), [#1736](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1736), [#1737](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1737), [#1738](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1738), [#1739](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1739)): richer reports for unconfigured categories, implicit-feedback pattern bloat, stop-word-like entity labels, vectorless-ratio SLO breaches, and per-reason blocked-procedure breakdowns.
- **Parseable storage dry-run semantics** ([#1683](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1683), [#1728](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1728)): `--force` dry-run paths emit machine-readable skip reasons for automation and wrapper jobs.
- Added detailed release notes at `release-notes/release-notes-2026.5.310.md`.

### Changed

- Bumped plugin package, lockfile, plugin manifest, and installer package versions to **2026.5.310**.
- **`--force` bypasses internal guard timeouts** ([#1688](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1688), [#1741](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1741)): force now skips per-command idle/guard timeouts—not just idempotency checks—so operators can unblock stuck maintenance without editing cron wrappers.
- **Monthly consolidation throughput tuning** ([#1733](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1733), [#1747](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1747), [#1761](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1761)): reduced default `enrich-entities` batch from 500 → 25 for live gateways so consolidation completes within realistic cron windows.
- **Maintenance log analysis scope** ([#1685](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1685), [#1729](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1729)): `analyze-maintenance-logs` ignores manual-qa/auxiliary directories and non-canonical log filenames, reducing false findings from test artifacts.
- **Similar-sweep memory bounds** ([#1695](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1695), [#1713](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1713)): OpenAI provider similar-sweep map cache is capped to prevent unbounded growth on long-running gateways.
- **Gateway log noise reduction** ([#1691](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1691), [#1719](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1719)): duplicate gateway provider messages are logged once per process.
- **Weekly reflection model routing** ([#1720](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1720), [#1723](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1723)): LLM steps preserve the fallback chain when MiniMax is configured as primary.
- **Persona digest transparency** ([#1742](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1742), [#1756](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1756)): weekly pending digest surfaces a truncation marker when persona proposals are omitted instead of silently hiding them.
- **Nightly dream-cycle implicit-feedback caps** ([#1706](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1706), [#1711](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1711)): follow-up runtime caps and incremental progress reporting keep long implicit-feedback passes observable and bounded.

### Fixed

- **Maintenance honesty and wrapper exits** ([#1705](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1705), [#1708](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1708), [#1722](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1722), [#1724](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1724), [#1712](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1712), [#1730](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1730)): nightly dream-cycle continuous verification no longer passes when every check is uncertain/with errors; `extract-directives` partial/cursor-not-advanced states no longer exit 0; `hybrid-mem-cli-job` writes the final ledger even when a step fails under `errexit`.
- **Re-embed vectorless resilience** ([#1731](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1731), [#1748](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1748), [#1771](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1771)): fast-fail via circuit breaker on embedding-provider 500s; maintenance validation surfaces concrete failure reasons instead of opaque skips.
- **Self-correction model compatibility** ([#1714](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1714), [#1715](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1715), [#1718](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1718), [#1726](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1726), [#1760](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1760), [#1767](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1767)): strips MiniMax M2.7-highspeed thinking tokens; restores fallback chains when a single model was the sole execution path; handles oversized incident prompts more safely.
- **MiniMax chat abort noise** ([#1694](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1694), [#1725](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1725)): single `chatComplete` aborts are classified/degraded gracefully instead of flooding GlitchTip (HYBRID-MEMORY-441).
- **Goal registration robustness** ([#1684](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1684), [#1703](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1703)): `goal_register` ignores `_global_dispatch_rate_limit.json` in the goals directory instead of failing the whole registration pass.
- **Tool-effectiveness workflow DB path** ([#1707](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1707), [#1710](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1710), [#1766](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1766)): follow-up reads `workflow-traces.db` (the actual workflow store) instead of the legacy `*-workflows.db` filename.
- **Entity mention hygiene** ([#1740](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1740)): enrichment normalizes and deduplicates mentions before writing `fact_entity_mentions`.
- **Reflect-rules observability** ([#1704](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1704), [#1709](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1709)): successful nightly dream-cycle runs with zero rules now include diagnostics instead of appearing silently healthy.
- **Hot-reload bootstrap race** ([#1768](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1768)): plugin re-registration no longer opens FactsDB before the connection is ready (“database connection is not open”).
- **Background SQLite handle lifetime** ([#1721](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1721)): GlitchTip background tasks no longer operate on closed SQLite handles.

### Notes

- This release includes **~45 commits** on `main` since **2026.5.280**, spanning maintenance reliability, entity graph quality, contradiction triage automation, and MiniMax/self-correction hardening.
- No schema version bump: existing SQLite/LanceDB databases migrate in place. Restart the gateway after upgrading npm packages.

---

## [2026.5.280] - 2026-05-28

### Added

- Added detailed release notes at `release-notes/release-notes-2026.5.280.md`.
- Added/packaged comprehensive maintenance semantics coverage for wrapper/ledger/guard behaviours.
- Added progress heartbeat logging for silent maintenance phases.

### Changed

- Bumped plugin package, lockfile, plugin manifest, and installer package versions to **2026.5.280**.
- Clarified legacy category remap policy for forge/episode-style categories.
- Improved operator-facing maintenance result vocabulary and evidence quality.

### Fixed

- Fixed self-correction handling of non-strict LLM JSON and cooldown-skip reporting.
- Fixed extract-reinforcement degraded-success semantics when incidents produce no annotations/fallback.
- Hardened extract-directives against untrusted metadata/chat fragments being stored as durable rules.
- Scoped persona proposal generation to avoid cross-agent/user contamination.

### Notes

- Packages merged work from PRs #1642, #1643, #1644, #1648, #1649, #1650, and #1651.

---

## [2026.5.242] - 2026-05-24

### Changed

- Bump plugin package, plugin manifest, installer package, and lockfile versions to **2026.5.242**.
- Added release notes for **2026.5.242** at `release-notes/release-notes-2026.5.242.md`.

---

## [2026.5.241] - 2026-05-24

### Changed

- Bump plugin package, plugin manifest, installer package, and lockfile versions to **2026.5.241**.
- Added release notes for **2026.5.241** at `release-notes/release-notes-2026.5.241.md`.

---

## [2026.5.240] - 2026-05-24

### Added

- **Active-task live-state reconciliation** ([#1625](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1625), [#1628](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1628)): added an opt-in reconciliation path that can check referenced GitHub issues and PRs during normal active-task render/hygiene flows, then checkpoint terminal rows when the live issue or PR is already closed or merged. This reduces the stale-task window without waiting for the next deep verification pass.
- **Active-task selection diagnostics** ([#1617](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1617), [#1553](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1607)): added targeted project-fact querying and instrumentation around active-task selection so operators can see how ledger facts collapse into injected rows and where stale candidates are filtered.
- **Memory pressure diagnostics** ([#1551](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1551), [#1597](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1597)): added a native-memory pressure snapshot to help diagnose recall-budget exhaustion, LanceDB/vector pressure, and fixed-block behavior before it becomes an outage.
- **FTS and verification repair tools** ([#1601](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1601)): added doctor checks for FTS consistency and safer verified-reconcile delete confirmation, giving operators a clearer path to repair index drift without accidental data loss.
- **Operator architecture map** ([#1599](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1599)): added a compact operator-facing architecture map for the plugin, making the moving parts easier to inspect during incident response and maintenance.
- **Auto-skill generation hardening and Skill Creator v2 alignment** ([#1549](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1549)): added stricter generated-skill shape, recipe validation, prompt-injection scanning, aggressive progressive disclosure, eval sidecars, and publish/dist smoke coverage.

### Changed

- **Active-task fact grouping is deterministic** ([#1624](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1624), [#1628](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1628)): task facts with tied timestamps now use stable secondary ordering and terminal-status preference so stale in-progress rows cannot beat a same-bucket done checkpoint.
- **Capability hints are session-only by default** ([#1604](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1604)): reduced the risk of capability hint content being treated as durable memory or leaking into contexts where it does not belong.
- **Active-task injection is stricter**: active-task projection now skips stale rows, filters by active-task source, requires a real status key, and canonicalizes fact labels before injection.
- **Large core areas were split into focused modules** ([#1619](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1619)): refactored conflict-prone core modules so future maintenance and PR repair work can be smaller, more reviewable, and less likely to collide.
- **Fixed-block and recall-budget handling is more bounded**: added fixed-block caps and context-audit reporting so recall pressure is visible instead of silently consuming the prompt budget.
- **Plugin, manifest, installer, and lockfile versions** are aligned to **2026.5.240**.

### Fixed

- **Goal lifecycle crash** ([#1623](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1623)): fixed a TypeError in updateGoalOnSubagentEnd that could crash goal finalization when subagent completion data was incomplete.
- **JSON stdout cleanliness** ([#1618](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1618), [#1621](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1621)): tee output now goes to stderr in JSON mode so scripts can safely parse stdout.
- **Credential-like fallback storage** ([#1591](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1591), [#1590](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1590)): prevented credential-looking content and credential_get secrets from being captured through normal memory fallback/tool-result paths.
- **NOOP/classification/artifact memory pollution** ([#1560](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1560), [#1561](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1561), [#1596](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1596), [#1610](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1610)): added universal pre-store guards so classification decisions, NOOP notes, and generated artifacts do not become durable memories.
- **memory_store validation path** ([#1589](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1589)): added early input validation before WAL, embedding, or DB writes, avoiding partial side effects for invalid input.
- **Hot/progressive recall self-reinforcement** ([#1559](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1559), [#1595](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1595)): fixed a path where recalled memory blocks could reinforce low-value or garbage memories back into hot/progressive context.
- **Prompt-injection hardening for recalled memory** ([#1592](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1592)): hardened recalled memory blocks so retrieved facts are presented as data, not executable instructions.
- **WAL replay and breaker persistence**: fixed WAL replay metadata handling, health checks, and breaker persistence; also prevented WAL replay from globalizing scoped facts ([#1574](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1574), [#1588](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1588)).
- **Pending error visibility** ([#1600](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1600)): persisted pending error reports and surfaced WAL initialization failures more clearly.
- **Duplicate SQLite handles** ([#1564](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1564)): prevented duplicate SQLite handles after hybrid-memory plugin re-registration.
- **PR hygiene accuracy** ([#1555](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1555), [#1598](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1598)): PR hygiene now verifies live review threads before marking a PR as waiting.
- **Dependency security updates**: bumped qs to 6.15.2 and protobufjs in the plugin dependency tree ([#1612](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1612), [#1613](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1613)).

### Notes

- This release includes the full delta from v2026.5.190 through merged PR #1628.
- The active-task live-state reconciliation is intentionally bounded and failure-tolerant: missing GitHub credentials or exhausted request budget should degrade to the previous behavior rather than break projection.

---

## [2026.5.190] - 2026-05-19

### Added

- **Generated skills lifecycle** ([#1347](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1347)–[#1353](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1353), [#1440](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1440), [#1447](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1447), [#1446](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1446)): content gates, validation/eval harnesses, activation telemetry, outcome-aware evidence scoring, unified section taxonomy, disk reconciler, lifecycle recovery, and atomic `SKILL.md` + sidecar writes with completion markers.
- **Procedure & promotion pipeline** ([#1450](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1450), [#1454](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1454), [#1455](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1455), [#1458](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1458), [#1453](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1453), [#1460](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1460), [#1339](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1339)): risk-aware procedure scoring, skills CLI queue UX (reject/approve/description), nested promotion validation with context signals, evidence-hash milestones, idle-skill archival with `skillTTLDays`, procedural pipeline MVP, and safe promotion policy.
- **Crystallization & workflow stores** ([#1459](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1459), [#1456](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1456), [#1457](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1457), [#1444](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1444)): `schema_meta` migrations, supersede older installs via `listByPatternId`, atomic approval/install, YAML multiline patch + H1 rename.
- **Autopilot & triage** ([#1335](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1335)–[#1338](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1338), [#1346](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1346)): pending-digest foundation, digest autopilot skeleton, verified-fact and persona triage adapters, hardened weekly pending-digest cron wrapper.
- **Operator & product surfaces** ([#1317](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317), [#1320](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320), [#1318](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318), [#1316](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316)): doctor flow, session observability CLI, quality reporting, telemetry/sync tooling, quick-start guide, onboarding/status visibility improvements.
- **Tests:** high-impact regression suite, comprehensive e2e coverage, model-tier classification tests ([#1535](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1535)), WAL fsync close regression ([#1525](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1525)).

### Changed

- **Procedural memory / skill promotion:** `staticValidation` now reflects only the generated-skill static/recipe validation gate; unrelated defer/reject gates (low confidence, vague triggers, noisy traces, external side-effect approval) no longer mark `staticValidation` as failed.
- **Procedural extraction:** session success aggregation is any-failure-wins; re-scanning historical JSONL can lower workflow/procedure success rates when a later success followed an earlier failure in the same session.
- **Module architecture** ([#1531](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1531), [#1534](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1534)): split oversized CLI, dashboard, facts-db procedures, and lifecycle modules; similar-sweep PR guardrails and overlap checks documented in `docs/SIMILAR-SWEEP-PR.md`.
- **Cost optimization** ([#1319](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319), [#1314](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1314)): performance improvements and operator playbook wired into core docs.
- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.190** (lockfile aligned).

### Fixed

- **Similarity-sweep hardening** (JSON/parse/await guards): sensor sweep HA + weather boundaries ([#1476](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1476), [#1512](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1512)), backfill analyze-feedback JSONL ([#1472](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1511)), distill JSON parse ([#1471](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1510)), language-keywords merge ([#1477](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1513)), procedure `avoidance_notes` ([#1470](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1509)), config/features `runConfigView` await ([#1496](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1524)), extract missing-await ([#1493](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1521)).
- **Atomic & crash-safe writes:** stage-capture skill directories ([#1498](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1526)), self-correction extract/run ([#1499](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1527)), workspace skill install copy ([#1500](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1528)), skill markdown/sidecars ([#1441](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1441), [#1462](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1462)).
- **Vector DB & embeddings** ([#1495](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1523), [#1469](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1469), [#1517](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1517), [#1518](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1518), [#1324](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1324)): narrow pre-init guards to `lanceInitFailed`, semantic-cache table tolerance, count/ONNX load timeouts, transactional fact lifecycle + bulk vector delete + LanceDB UUID predicate hardening.
- **Retrieval & aliases** ([#1507](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1507), [#1522](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1522)): breadcrumb failures logged without swallowing semantic embed; `AliasVectorIndex.ensureInitialized()` closed-state race guard.
- **Procedures DB** ([#1515](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1515), [#1487](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1487)): normalize `procedure_type` and `skill_state` enum drift from legacy rows.
- **CLI & JSON output** ([#1520](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1520), [#1519](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1519), [#1492](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1492)): verify diagnostics on stderr for `--json`; corrections config no longer pollutes stdout.
- **Bootstrap & runtime** ([#1514](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1514), [#1480](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1480)): dedupe Ollama auto-start, spawn error handling, `child.unref()`; provider-router health probe uses `AbortSignal.timeout` (no dangling timers).
- **Guards & multi-agent** ([#1505](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1505), [#1504](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1504)): `sessionRefMatches` distinguishes main checkpoint vs Telegram session; pre-finalization guard avoids false blocks from `related_session` in multi-agent setups.
- **Storage concurrency** ([#1506](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1506), [#1465](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1465)): `SQLITE_BUSY` retry in `FactsDB.store` / `storeFact`.
- **Dashboard** ([#1529](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1529), [#1501](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1501)): close TOCTOU window in Lance size cache check.
- **Skill safety & crystallization** ([#1445](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1445), [#1461](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1461), [#1442](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1442)–[#1449](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1449)): PEM/dotfile/loopback/email allow-list validation, frontmatter HTML-comment prefix, slug collision, symmetric procedure task similarity, canonical `outputDir` paths.
- **Dream cycle, stewardship & active tasks** ([#1309](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1309)–[#1323](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323), [#1310](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1310)–[#1313](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1313)): CLI timer cleanup (no hangs), upgrade/export/uninstall safety, classification mutation + vector cleanup, dream-cycle integrity/idempotency, cron orchestration visibility, stewardship/active-task hardening.
- **Misc:** context engine registration unhandled promise ([#1508](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1508)), recall stall probe logging ([#1325](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1325)), false-positive vs user-correction telemetry ([#1452](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1452)), workflow-pattern duplicate detection perf ([#1451](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1451)).

### Security

- **Skill safety validation** ([#1445](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1445), [#1461](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1461)): case-insensitive PEM detection, dotfile/tilde path rules, loopback IP exclusion, configurable email allow-list for generated skills.

---

## [2026.5.101] - 2026-05-10

### Changed

- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.101** (lockfile aligned).

---

## [2026.5.100] - 2026-05-10

### Fixed

- **Active-task continuity / hygiene** ([#1270](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1270), [#1272](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1272), [#1273](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1273), [#1274](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1274), [#1276](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1276)): add `active_task_checkpoint`, auto-register long-running workflows, reduce stale/deduplicated task entities, and improve snapshot/render reliability.
- **Goal stewardship verification / finalization guards** ([#1271](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1271), [#1278](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1278)): add `verify --fix` heartbeat cron installer and block premature finalization while external work remains unfinished.
- **Memory storage / recall / vector correctness** ([#1264](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1264), [#1265](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1265), [#1266](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1266), [#1267](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1267), [#1277](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1277)): harden WAL replay idempotency, fix memory integrity gaps across prune/recall/merge, and complete vector lifecycle cleanup across CLI and maintenance paths.
- **Issue sweep / stewardship observability** ([#1285](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1285), [#1287](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1287)): tighten `issue_sweep` matching to avoid false positives and record explicit per-goal stewardship outcomes.

### Changed

- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.100** (lockfile aligned).

---

## [2026.5.94] - 2026-05-09

### Fixed

- **Re-index safety** ([#1246](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1246), [#1250](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1250)): non-destructive shadow-table rebuild with validation before atomic swap; live LanceDB is not wiped on partial failure.
- **Embedding migration & CLI** ([#1247](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1247), [#1251](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1251)): `aborted` / `abortReason` / `processed` on `migrateEmbeddings`; re-index exits non-zero and refuses swap when migration aborts; clearer operator messaging.
- **VectorDB reconnect during migration** ([#1248](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1248), [#1252](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1252)): tolerate routine `closeGeneration` bumps with transparent reconnect; verify Lance is writable after reconnect; optional `OPENCLAW_HYBRID_MEM_DEBUG_CLOSE=1` stack on `VectorDB` close.
- **Tier compact vs LanceDB optimize** ([#1249](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1249), [#1253](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1253)): primary command `tier-compact` with `compact` alias; maintenance overview lists `vectordb-optimize`; stats shows `Last vectordb-optimize`; timestamp files for both commands.

### Added

- **Reflection dedupe throttling** ([#1229](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1229)): Adaptive backoff and circuit breaker for embedding-backed reflection dedupe during dream-cycle when provider returns 429s.
  - Circuit breaker triggers after 10 consecutive 429s, stops processing and defers remaining rows to next run
  - Adaptive throttle increases from 200ms baseline to 10s maximum after each 429
  - Per-run row limit of 2000 prevents unbounded backlog work
  - Enhanced logging shows 429 counts, throttle delays, and deferred rows
  - New test suite validates throttling behavior
- **`record-storage-sample` CLI** and **daily cron** (`daily-storage-growth-sample`) so `audit health` can compute **7d storage deltas** without relying on weekly audit-only inserts.
- **Sunday maintenance crons**: `weekly-implicit-feedback-collapse` (`reflect-meta --collapse-implicit-feedback --include-legacy`) and `weekly-vectordb-optimize-sunday`.
- **Default memory categories**: `forge`, `monitoring`, `ops_status`, `ops_summary`, `coding_task`, `quality_loop`, `topic_labels` (remap legacy `forge_*` → `forge` via `categories remap`).
- **Operator doc**: `docs/AUDIT-REMEDIATION-SPIKES.md` (runbook + spike notes).

### Changed

- **Audit health**: larger implicit-feedback prefix histogram cap (20k), truncation message includes total pattern count; **reflect-meta collapse** remediation; **top entities (filtered)** line; drop confusing `legacy ok=` markdown suffix; JSON adds `topEntitiesFiltered`.
- **Canonical embeddings on ingest**: auto-capture + reflection now call `factsDb.storeEmbedding` when embedding, aligning Lance with `fact_embeddings` / vectorless audit.
- **Procedure triage**: implied success when `last_validated` is set but `success_count` and version successes are still zero (fixes spurious `low_recall`).
- **SDK types**: optional `registerContextEngine` on `openclaw/plugin-sdk/core` shim.
- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.94** (lockfile aligned).

---

## [2026.5.81] - 2026-05-08

### Changed

- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.81** (lockfile aligned).

---

## [2026.5.80] - 2026-05-08

### Added

- **Cron exit ledger validation** ([#1203](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1203)): structured validation of maintenance step exit lines, `validate-cron-exit` CLI, bash harness guidance, and normalization of obsolete cron command references in managed job messages.

### Changed

- **Node.js**: Minimum version is now **22.16.0** so built-in `node:sqlite` includes **FTS5** (see [nodejs/node#57621](https://github.com/nodejs/node/pull/57621)); CI `.nvmrc` and `engines` updated accordingly.
- Bump plugin, `openclaw.plugin.json`, and `openclaw-hybrid-memory-install` package versions to **2026.5.80** (lockfile aligned).

---

## [2026.5.61] - 2026-05-07

### Added

- **Maintenance observability**: `hybrid-mem dream-cycle --verbose` (and parent `-v`) forwards through WAL pre-flush, reflection, reflect-rules, MEMORY_INDEX refresh, continuous verification (`onProgress`, throttled), extract-implicit, cross-agent learning, and tool effectiveness; `run-all --verbose` passes through to extract-procedures and self-correction-run.
- **Reflection progress logs** (always-on `info`): LLM completion line, dedupe embedding phase with success counts, new-candidate embedding phase, and a final summary (stored / duplicate skips / embed failures).
- **Embedding rate-limit context**: OpenAI embedding `withLLMRetry` calls include `llmContext` so 429 backoff lines identify `memory-hybrid: embeddings.create` vs chat completions.
- **Chat rate-limit detail**: `withLLMRetry` warns include operation label, model, and retry attempt index; optional provider **`x-ratelimit-*`** snapshot plus **60s / 180s** in-process attempt totals by operation/model (`recent-http-attempts`, read-only window counts).

### Changed

- **`ContinuousVerifierOptions`**: exported; optional `onProgress` for long verification cycles.
- **`runCrossAgentLearning` / CLI**: optional `verbose` with per-batch `info` logging when enabled.

### Fixed

- **Dream-cycle verbose steps**: runtime step ordinals so skipped optional phases do not leave gaps in `step N:` output.
- **Reflection**: single dedupe-phase log line for patterns/rules (accurate “batched embeds” wording).
- **Cross-agent learning**: per-batch `info` only when `verbose` is set (avoids noisy nightly logs).

### Notes

- Human-oriented upgrade narrative for the **2026.5.x** line: still start from [`release-notes/release-notes-2026.5.61.md`](release-notes/release-notes-2026.5.61.md) (supersedes **2026.5.60** for “current published” pointers).

---

## [2026.5.60] - 2026-05-06

**Previous baseline:** [2026.4.273] (2026-04-27) — last version published as a GitHub / npm release before this line of work.

### Release summary

**2026.5.60** is the **OpenClaw 2026.5.x readiness** release: it ships everything needed to run the hybrid-memory plugin on gateways that enforce compiled extension entries, tightened peers, HTTP route shape, **declared tool contracts**, and stricter CI—plus **SQLite compatibility** for older databases that used narrower `CHECK` constraints on outcomes. If you are on **2026.4.273** or earlier, upgrading to **2026.5.60** together with **OpenClaw `>=2026.5.0 <2027`** is the supported path. Human-oriented narrative: [`release-notes/release-notes-2026.5.60.md`](release-notes/release-notes-2026.5.60.md).

### Added

- **Build pipeline** (#1171): **`tsdown`** emits a multi-file ESM **`dist/`** tree; **`npm run build`** / **`npm run build:check`**; **`prepack`** builds then generates **`npm-shrinkwrap.json`**. Release and publish flows validate **`dist/index.js`** and types before publish.
- **`contracts.tools` in `openclaw.plugin.json`** (#1180): full list of agent tool names required by OpenClaw **2026.5+** before `registerTool` succeeds; canonical list in **`contracts/agent-tool-names.ts`** with **`tests/agent-tool-contracts.test.ts`** to prevent manifest drift.
- **`utils/plugin-root.ts`** (#1174): **`findPluginRoot`**, **`readPluginPackageJson`** (walk up to **`openclaw.plugin.json`**). Tests in **`tests/plugin-root.test.ts`**.
- **`tools/safe-register-http-route.ts`** (#1173): validates and normalizes HTTP paths before **`registerHttpRoute`**; tests in **`tests/safe-register-http-route.test.ts`**.
- **`utils/sqlite-outcome-compat.ts`** (#1178 / #1179): detects legacy SQLite DDL via **`sqlite_master`** and normalizes episode/audit **outcomes** at insert and read so older DBs do not hit **`CHECK` constraint failed`**. Tests in **`tests/sqlite-outcome-compat.test.ts`** (Node **22+** / **`node:sqlite`** in CI).
- **CI `install-smoke`** (#1172): packs tarball, installs with pinned **`openclaw@>=2026.5.0 <2027`**, asserts clean tree (no **`@duckflux/core`** **`ETARGET`**), **`dist/index.js`** present, smoke-load on Node **22** and **24**.
- **CI `publish-invariants`**: **`npm ci`** + **`npm run build`** before **`verify-publish.cjs`** so manifest checks always see a real **`dist/`**.
- **`verify-publish.cjs`**: asserts **`openclaw.plugin.json`** has non-empty **`contracts.tools`**; **`npm pack --dry-run --ignore-scripts`** plus explicit shrinkwrap **create/clean** so pack listing checks do not rely on **`prepack`** during verify.

### Changed

- **`openclaw.extensions`** / **`runtimeExtensions`** (#1171): point at **`./dist/index.js`**; **`dist`** listed under **`package.json#files`**.
- **`peerDependencies.openclaw`**: **`>=2026.5.0 <2027`** (#1172); **`MIN_OPENCLAW_VERSION`** **`2026.5.0`** and tests updated.
- **Dashboard / public API routes** (#1173): register through **`createSafeRegisterHttpRoute`**; dashboard root **without** trailing slash.
- **`versionInfo.ts`, `utils/prompt-loader.ts`, `setup/plugin-service.ts`, `cli/cmd-install.ts`, `cli/cmd-verify.ts`, `cli/cmd-config.ts`** (#1174): use **`findPluginRoot(import.meta.url)`** for plugin-root-relative paths when the runtime entry lives under **`dist/`**.
- **`utils/plugin-root.ts`**: path joins use **`node:path`** **`join`** (review feedback).
- **`extensions/memory-hybrid/package.json`**: Biome-friendly formatting for **`keywords`** and **`openclaw`** blocks.

### Fixed

- **#1171** — OpenClaw **2026.5.4+** rejected packages whose extension entry pointed at TypeScript without a matching build artifact.
- **#1172** — **`npm install`** could fail with **`ETARGET`** for **`@duckflux/core@^0.1.0`** when peers resolved to an incompatible **`openclaw`** line.
- **#1173** — Gateway **`http route registration missing path`** warnings from bad or empty route paths (especially dashboard root **`/`** handling).
- **#1174** — **`package.json`** / manifest reads resolved to **`dist/`** instead of the real package root under compiled entrypoints.
- **#1178** — **`recordEpisode`** / **`failure`** · **`unknown`** vs legacy **`episodes`** **`CHECK`** (**`failed`** only).
- **#1179** — **`AuditStore.append`** with **`skipped`** vs legacy **`audit_log`** **`CHECK`** (no **`skipped`**).
- **#1180** — Missing **`contracts.tools`** causing repeated **`plugin must declare contracts.tools before registering agent tools`** on OpenClaw **2026.5+**.

---

## [2026.4.273] - 2026-04-27

**Previous baseline:** [2026.4.272] (2026-04-27)

### Release summary

**2026.4.273** omits **`temperature`** / **`top_p`** on **chat.completions** and **Responses** requests for **gpt-5\*** models (in addition to **o-series** reasoning models), matching **Azure Foundry** / **APIM** behavior that returns HTTP 400 when non-default sampling is sent. **`shouldOmitSamplingParams`** centralizes detection; **`provider-router`**, **`chat`**, **`classification`**, and **`responses-adapter`** use it. Tests for classification and Responses bodies were updated accordingly. Version **2026.4.273** is published across **`extensions/memory-hybrid/package.json`**, **`openclaw.plugin.json`**, **`packages/openclaw-hybrid-memory-install/package.json`**, and **`package-lock.json`**. Human-oriented upgrade notes: [`release-notes/release-notes-2026.4.273.md`](release-notes/release-notes-2026.4.273.md).

### Fixed

- **LLM routing:** Avoid HTTP 400 from Azure chat deployments for **gpt-5\*** by stripping custom sampling params (same pattern as **o-series**).

---

## [2026.4.272] - 2026-04-27

**Previous baseline:** [2026.4.271] (2026-04-27)

### Release summary

**2026.4.272** stops the **passive observer** from scanning OpenClaw **`*.checkpoint.*.jsonl`** session sidecars (large single-line JSON), which removes noisy **“skipping oversized JSONL line”** warnings and avoids pointless I/O. **`.deleted*`** session tombstones are ignored for the same scan list. Version **2026.4.272** is published across **`extensions/memory-hybrid/package.json`**, **`openclaw.plugin.json`**, **`packages/openclaw-hybrid-memory-install/package.json`**, and **`package-lock.json`**. Human-oriented upgrade notes: [`release-notes/release-notes-2026.4.272.md`](release-notes/release-notes-2026.4.272.md).

### Fixed

- **Passive observer:** Exclude **checkpoint** and **deleted** session JSONL basenames from the sessions-dir scan; unit tests for `isPassiveObserverTranscriptCandidate`.

---

## [2026.4.271] - 2026-04-27

**Previous baseline:** [2026.4.270] (2026-04-27)

### Release summary

**2026.4.271** aligns **`hybrid-mem verify --test-llm`** with current **Azure Foundry Responses** and **chat** provider rules (token/output floors, temperature for chat probes, **`azure-foundry/o3-pro`** via Responses, shared routing for OAuth and API-key paths). **Dev dependencies** were refreshed via Dependabot (**#1169**). Version **2026.4.271** is published across **`extensions/memory-hybrid/package.json`**, **`openclaw.plugin.json`**, **`packages/openclaw-hybrid-memory-install/package.json`**, and **`package-lock.json`**. Human-oriented upgrade notes: [`release-notes/release-notes-2026.4.271.md`](release-notes/release-notes-2026.4.271.md).

### Changed

- **`hybrid-mem verify --test-llm`:** Probes use **Responses-appropriate** max output / caps and **chat-appropriate** temperature for Azure **`gpt-5.5`** SKUs; **`azure-foundry/o3-pro`** is exercised through **Responses**; OAuth and API-key paths share the same **Responses** routing where applicable.

### Maintenance

- **Dev dependencies:** Minor/patch group bump (**#1169**).

---

## [2026.4.270] - 2026-04-27

**Previous baseline:** [2026.4.260] (2026-04-26)

### Release summary

**2026.4.270** is a **correctness and robustness** release for the memory-hybrid plugin: **batch classification** and **JSON array parsing** tolerate more LLM output shapes; **chat** and **auto-classifier** paths harden **empty `choices`** and **transient provider errors**; **episode SQL** scope clauses avoid invalid `WHERE AND` fragments; **embeddings** gain **input truncation** and **context-length** error suppression; **vector DB** initialization reports **non-`Error` rejections** safely and reduces **hot-reload** noise; **lifecycle injection** avoids mis-attributing **edict** failures when the DB is not open. Version **2026.4.270** is published across **`extensions/memory-hybrid/package.json`**, **`openclaw.plugin.json`**, **`packages/openclaw-hybrid-memory-install/package.json`**, and **`package-lock.json`**. Human-oriented upgrade notes: [`release-notes/release-notes-2026.4.270.md`](release-notes/release-notes-2026.4.270.md). *(Issues #1151–#1167, PR #1168.)*

### Fixed

- **LLM JSON / classification:** More resilient **first-array** parsing, **batch classify** response handling, **`[Context:…]`** preamble stripping, and related **Vitest** coverage (#1151–#1154, #1155–#1160).
- **Chat / classifier HTTP:** Safer **`choices?.[0]`** access; **400** empty-body and **unsupported-operation** handling where appropriate (#1165 and related).
- **Facts / episodes SQL:** **Scope** fragments strip a leading **`AND`** so dynamic `WHERE` clauses stay valid (#1161).
- **Embeddings:** **Character cap** aligned with provider limits, **truncation** before request, and **context-length** classification for **suppressed** telemetry (#1162).
- **Vector DB:** **Init** failure path normalizes unknown rejections to **`Error`** for reporting; **hot-reload** race strings skip redundant **GlitchTip** capture (#1163, #1167).
- **Lifecycle:** **Stage injection** and **auto-classifier CLI** edge cases (edict DB state, **reporter** binding) (#1164, #1166).

---

## [2026.4.260] - 2026-04-26

**Previous baseline:** [2026.4.141] (2026-04-14)

### Release summary

**2026.4.260** ships **session observability**, **constrained-recall retrieval**, **security hardening** on public API and edicts, **productisation** documentation, and a **dependency refresh** (notably **OpenClaw** on the **2026.4** line). It also includes **correctness fixes** for typed-hook agent resolution and **tooling** alignment so CI format checks stay green. Version **2026.4.260** is published across **`extensions/memory-hybrid/package.json`**, **`openclaw.plugin.json`**, **`packages/openclaw-hybrid-memory-install/package.json`**, and **`package-lock.json`**. Human-oriented upgrade notes: [`release-notes/release-notes-2026.4.260.md`](release-notes/release-notes-2026.4.260.md).

### Security

- **Public memory HTTP API:** Responses are **scope-filtered** so callers only receive data appropriate to their session and configured visibility (#1137).
- **`memory_add_edict`:** Writes are **gated behind explicit configuration opt-in** so edicts cannot be applied unless you deliberately enable that capability (#1136).

### Added

- **Session observability (#1025):** A **session-level report** merges audit, capture, recall, injection, and suppression signals into a **timeline**—aimed at answering “what did memory do for this session?” without reading raw SQLite (#1148).
- **Constrained-recall (#1026):** Retrieval supports a **filter → rank → hydrate** path via **`retrievalMode: "constrained-recall"`** (and related tool/schema wiring) for bounded searches (#1141).
- **Productisation (#1029):** **[`docs/PRODUCTISATION-TRACK.md`](docs/PRODUCTISATION-TRACK.md)** and related README/docs links summarize **shipped** versus **planned** product work (#1134, #1147).
- **Presentation (#1139):** README and narrative updates to improve **onboarding** and **product storytelling** for Hybrid Memory.

### Changed

- **OpenClaw / toolchain:** **`openclaw`** and other dependencies were bumped (e.g. **2026.4.24** in the extension lockfile via #1145 / #1149; also **protobufjs** #1146, **basic-ftp** #1144). Prefer upgrading the **gateway** to a compatible **2026.4.x** OpenClaw build when you adopt this plugin version; see upstream OpenClaw release notes for full platform changes.
- **Docs:** README and docs home now surface the **productisation** tracker; changelog entry for **#1131** records automation validation for the release pipeline.

### Fixed

- **Recall isolation:** **Session isolation** for **timeline-style recall** so one session cannot read another session’s episode stream by mistake (#1135).
- **Lifecycle hooks:** Import **`resolveAgentIdFromHookEvent`** from **`resolve-agent-id`** (not **`hook-resolution-api`**) in capture, cleanup, injection, and recall stages; **`subagent_spawned`** skip audits now attach the correct **task label**.
- **Observability code:** Safer **injection summary** math when optional audit detail is missing; **tests** updated to match **`AuditEventInput`** / **`AuditStore.query`** typing.
- **Formatting:** **`memory-tools.ts`** formatted to satisfy **Biome `format:check`**.

---

## [2026.4.141] - 2026-04-14

### Security

- **npm overrides** for **`axios`**, **`follow-redirects`**, and **`tar`** so transitive dependencies (via **`openclaw`**) resolve to patched versions; **`npm audit --audit-level=moderate`** passes.

### Fixed

- **Auto-classifier / category discovery:** Parsing the LLM reply no longer uses a greedy **`[...]`** regex (which could join the first `[` with the last `]` across prose or multiple spans, causing **`JSON.parse`** errors such as *Expected ',' or ']' after array element*). The plugin now finds a **balanced** JSON array and, if needed, **retries** at later `[` positions until a valid JSON array parses.

- **Maintenance cron jobs (`~/.openclaw/cron/jobs.json`):** New and normalized **`hybrid-mem:*`** entries persist **`id`** (same stable string as **`pluginJobId`**) and **`sessionTarget: "isolated"`** so gateway **`cron.run`** and UIs that bind **`job.id`** stay aligned with on-disk records; **`verify --fix`** backfills these fields on existing jobs.

### Release summary

**2026.4.141** publishes version **2026.4.141** across **`package.json`**, **`openclaw.plugin.json`**, **`openclaw-hybrid-memory-install`**, and the lockfile, with **CHANGELOG** and **release notes** for this tag.

---

## [2026.4.140] - 2026-04-14

### Release summary

**2026.4.140** aligns published artifacts and documentation with version **2026.4.140**: **`package.json` / lockfile**, **`openclaw.plugin.json`**, and **`openclaw-hybrid-memory-install`**. **CHANGELOG** and **release notes** are updated for this tag. The **`skills/personal-assistant/`** bundle is **removed** from this package (only **`skills/hybrid-memory/`** remains bundled). **CI** expectations were validated locally (**TypeScript** `tsc --noEmit`, **Biome** lint/format, **Vitest** suite, **`verify-publish`** manifest checks) to match the **`main`** workflow.

### Removed

- **Bundled skill:** `skills/personal-assistant/` (README, SKILL, references, helper script) — not shipped with **openclaw-hybrid-memory** anymore.

---

## [2026.4.61] - 2026-04-06

### Release summary

**2026.4.61** rolls up **retrieval and recall** work: **two-phase FTS** (true phase split for large stores, bounded expansion when post-filters cull candidates, chunked SQL for SQLite limits), **recall pipeline** fixes (embed telemetry excludes HyDE/FTS wait, drain in-flight embed on FTS failure, vector-step hit logging, higher outer timeouts), **OAuth + Responses** (failover on `responses.create` only; inherit `embedding.apiKey` from merged `llm.providers`), and **lifecycle** (heartbeat task-hygiene gated on `goalStewardship.enabled`). **Active tasks:** **facts-backed projection** and operator docs for `ACTIVE-TASKS.md` / ledger. **Goal stewardship:** **heartbeat** verification vs `~/.openclaw/cron/jobs.json`, optional **`pr_merged`** verification (GitHub API, opt-in), **`lastMechanicalCheck`**, escalation nudges and CLI visibility. **Dependencies:** Vite patch bump. Also ships the **operator UX** and **skill bootstrap** items below.

### Changed

- **Config schema:** `activeTask.injectionBudget` is documented as **`integer`** with **`minimum: 1`** in `openclaw.plugin.json`, matching parse behavior (fractional values floored; non-positive values fall back to the default).

- **CLI:** `openclaw hybrid-mem goals status` with **no arguments** prints an **overview** (stewardship on/off, goals dir, active goals); `goals status <label-or-uuid>` still shows full detail for one goal.

- **Bundled Agent Skill:** On plugin startup, copy `skills/hybrid-memory/` into `{workspace}/skills/hybrid-memory/` **when `SKILL.md` is not already present**, so operators do not need a separate `hybrid-mem install` step just to populate the workspace skill tree. Existing files are left unchanged (use **`hybrid-mem install`** to overwrite from the bundle).

### Fixed

- **Workspace skill bootstrap:** Resolve which `openclaw.json` to read using **`OPENCLAW_CONFIG`**, then **`OPENCLAW_CONFIG_PATH`**, then **`$OPENCLAW_HOME/openclaw.json`**, then the default under `~/.openclaw/`. If `skills/hybrid-memory/` already exists but **`SKILL.md` is missing**, skip copying so a partial tree is not overwritten. Non-benign failures are **warned** and reported via the plugin error path instead of only **debug** logs.

---

## [2026.4.60] - 2026-04-06

### Release summary

**2026.4.60** adds **first-class OpenAI Responses API** support for plugin LLM calls (`responses.create`), including the **`azure-foundry-responses/`** model prefix, **`WireApi`** / **`resolveWireApi()`**, a **responses adapter**, **`chatComplete`** routing, and **multi-provider OpenAI proxy** handling for both `chat.completions` and `responses` (with **chat → Responses bridging** for direct `chat.completions.create` call sites such as classification). **Cost tracking** and **feature labeling** support Responses request shapes (`body.input` as well as `messages`); **`verify --test-llm`** exercises Responses-backed models. **Documentation** covers Azure Foundry Responses configuration. Also fixes a **procedures DB test** timing flake in CI.

### Added

- **LLM:** OpenAI **Responses API** wire for Azure Foundry Responses-only deployments; shared cost instrumentation and provider-router parity for chat vs responses surfaces.

### Fixed

- **Tests:** Deterministic **`lastOutcome`** assertion in **`procedures-db.test.ts`** (Unix-second timestamp ordering across Node versions).

---

## [2026.4.52] - 2026-04-05

### Release summary

**2026.4.52** improves **operator-facing config** for **goal stewardship** and **active tasks** (`hybrid-mem config`, `config-set goalStewardship`, `goals config`, `active-tasks config`), standardizes the default working-memory filename on **`ACTIVE-TASKS.md`** (with **legacy read** from `ACTIVE-TASK.md` when the new file is absent), and hardens **optimistic writes** and **`task-queue-status --with-active-tasks`** so resolved paths and mtimes stay consistent during migration.

### Added

- **CLI:** `openclaw hybrid-mem config-set goalStewardship enabled|disabled` (object-toggle style); `hybrid-mem config` shows goal stewardship, active-task ledger, and resolved `ACTIVE-TASKS.md` path; **`goals config`** and **`active-tasks config`** subcommands; **`active-tasks`** registered even when `activeTask.enabled` is false (config-only).

### Changed

- **Default active-task file:** `activeTask.filePath` defaults to **`ACTIVE-TASKS.md`** (docs, schema, parsers); singular **`active-task`** CLI alias removed in favor of **`active-tasks`**.

### Fixed

- **ACTIVE-TASKS migration:** `writeActiveTaskFileOptimistic` uses a single **`readActiveTaskFileWithMtime`** snapshot per retry so legacy vs canonical path and **mtime** do not drift; **`readActiveTaskFileWithResolvedPath`** gives **`task-queue-status`** a stable **`readFrom`** without separate resolve/read races.

---

## [2026.4.51] - 2026-04-05

### Release summary

**2026.4.51** delivers a **large stewardship and tasks/goals upgrade**: a full **goal stewardship** layer (registry, agent tools, heartbeat injection, watchdog health, CLI), **active task hygiene** that cooperates with heartbeats and can **draft goal payloads** from `ACTIVE-TASKS.md`, an optional **circuit breaker** so stuck goals **stop retrying** and **escalate to you** with a clear summary, and an optional **facts-backed active task ledger** with render-to-markdown. Reliability work includes **recall pipeline** timing (parallel FTS + vector, accurate wall-clock totals), **OpenAI Responses API** message sanitization (reasoning blocks, empty assistant placeholders), and **more robust batch classification** parsing. Configuration is easier thanks to **embedding inheritance** from OpenClaw defaults ([#1002](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1002)), and **cost tracking** survives plugin reload more cleanly ([#1021](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1021)). The epic and breakdown issues for stewardship are tracked under [#1051](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1051)–[#1061](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1061).

### Added

- **Goal stewardship:** JSON-backed goals under the workspace (default `state/goals/`), configurable via `goalStewardship.*`; agent tools `goal_register`, `goal_assess`, `goal_update`, `goal_complete`, `goal_abandon`; heartbeat-driven stewardship prepends when the last user message matches heartbeat patterns; optional multi-goal rotation with caps and attention weights; watchdog health checks (budgets, staleness, mechanical verification, escalation); CLI `openclaw hybrid-mem goals list|status|cancel|stewardship-run|audit`; subagent completion updates goals with improved session-key matching; documentation in `docs/GOAL-STEWARDSHIP-*.md` and skill updates.
- **Task hygiene:** On heartbeat turns, optional `<task-hygiene>` nudges for `ACTIVE-TASKS.md` (reconcile, `HEARTBEAT_OK`), optional “consider promoting to a goal” hints for long-running rows, and agent tool **`active_task_propose_goal`** to draft `goal_register` payloads from a task label. See [TASK-HYGIENE.md](docs/TASK-HYGIENE.md).
- **Circuit breaker (goal stewardship):** Optional `goalStewardship.circuitBreaker` — when assessments repeat with the **same blockers** (or without progress) beyond configured thresholds, the goal moves to **`blocked`**, records **`humanEscalationSummary`**, and can append to episodic memory; distinct from failure-count escalation. `goalStewardship.allowCommandVerification` gates risky `command_exit_zero` checks (default off).
- **Active tasks — facts ledger:** `activeTask.ledger` can be **`facts`** so active tasks live as structured facts in SQLite with **`active-tasks render`** to regenerate `ACTIVE-TASKS.md`; integrates with hygiene and lifecycle hooks.
- **Embedding config inheritance ([#1002](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1002)):** Before schema parse, merge OpenClaw `models.providers` into plugin `llm.providers`, then overlay `agents.defaults.memorySearch` onto `embedding` for omitted fields only; plugin values win.

### Changed

- **Recall pipeline:** FTS and vector phases run in parallel where appropriate; **`vector_step`** timing reflects vector work only; overall pipeline diagnostics use **wall-clock** elapsed time to avoid double-counting.
- **OpenAI Responses path:** `sanitizeMessagesForOpenAIResponses` strips internal **reasoning** blocks from message content arrays (any role), with a safe placeholder if an assistant message would otherwise be empty after sanitization.
- **Batch classification:** Lenient parsing accepts additional wrapper keys and noisy output, with guardrails (e.g. action coverage) to reduce false positives.

### Fixed

- **Cost tracker / `memory.db` ([#1021](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1021)):** `CostTracker` resolves the DB handle via `getRawDb()` per operation and skips writes when the DB is not open, avoiding stale-handle errors across plugin reload.
- **Goal health / escalation:** Safer optional command verification; escalation can apply to **`stalled`** goals where appropriate; assorted robustness fixes in registry and heartbeat matching (cached patterns, round-robin offset).

### Documentation

- Added and updated: [TASK-HYGIENE.md](docs/TASK-HYGIENE.md), [GOAL-STEWARDSHIP-OPERATOR.md](docs/GOAL-STEWARDSHIP-OPERATOR.md), [GOAL-STEWARDSHIP-DESIGN.md](docs/GOAL-STEWARDSHIP-DESIGN.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), hybrid-memory skill and workspace snippets.

---

## [2026.4.40] - 2026-04-04

### Release summary

Version bump to **2026.4.40** (npm package, `openclaw.plugin.json`, and standalone installer).

---

## [2026.4.38] - 2026-04-03

### Release summary

Version bump to **2026.4.38** (npm package, `openclaw.plugin.json`, and standalone installer).

---

## [2026.4.33] - 2026-04-03

### Release summary

Version **2026.4.33** ships **`scripts/task-queue.sh`** — a cron-friendly task-queue runner (`touch` / `status` via `openclaw hybrid-mem`, optional **`run`** with `flock`, PID in `current.json`, history under `state/task-queue/history/`, idle restore) — addressing **#1000**, with review hardening in **#1001** (unique history files, producer/PID guard before archive, busy semantics aligned with the watchdog). Bumps the npm package, `openclaw.plugin.json`, and the standalone installer.

### Added

- **`scripts/task-queue.sh`:** Task queue runner for cron/autonomous jobs — `touch` / `status` via `openclaw hybrid-mem`, optional **`run`** with `flock`, PID in `current.json`, history archive, idle restore ([#1000](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1000)).

### Fixed

- **`scripts/task-queue.sh`:** Hardening from PR review ([#1001](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1001)): unique history filenames with exclusive create; archive only when `current.json` still matches this run (`producer` + child PID); treat missing PID and `EPERM` on liveness like the watchdog; validate `--title` / `--issue`; do not let post-run `task-queue-touch` override the wrapped command’s exit code.

---

## [2026.4.32] - 2026-04-03

### Release summary

Version **2026.4.32** adds **ACTIVE-TASKS.md** session reconciliation when OpenClaw session transcripts are missing ([#978](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/978), [#981](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/981)), a **task-queue** idle `current.json` placeholder and CLI helpers ([#983](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/983)), and follow-up **CI / review** hardening (Biome `import type`, bootstrap FTS5 test spy, direct path checks before `readdir` for session lookup). Bumps the npm package, `openclaw.plugin.json`, and the standalone installer.

### Added

- **`openclaw hybrid-mem active-tasks reconcile`** (and `--dry-run`); plugin runs reconcile after the task-queue watchdog when active-task is enabled.
- **`openclaw hybrid-mem task-queue-status`** / **`task-queue-touch`**; watchdog writes an idle `state/task-queue/current.json` sentinel when missing (exclusive create).

### Changed

- **`ACTIVE-TASKS.md`:** Parse **`Session:`** into subagent when **`Subagent:`** is absent; complete orphan **In progress** rows when no session JSONL is found.

### Fixed

- **Lint:** `facts-db-layer2` uses `import type` for `DatabaseSync` (Biome `useImportType`).
- **Tests:** Bootstrap FTS5 test spies `verifyFts5Support` on `db-connection` (matches `FactsDB` constructor).

---

## [2026.4.31] - 2026-04-03

### Release summary

Version **2026.4.31** follows **2026.4.30** with structural refactors (**#954**–**#956**: split `init-databases`, manage CLI registration, `facts-db` barrel), **verify** fixes for **Azure OpenAI direct resource** URLs in `openclaw hybrid-mem verify --test-llm` (**#994**), **agent id** resolution from `event.context` session fields when OpenClaw omits top-level session keys, and small doc/comment corrections. Bumps the npm package, `openclaw.plugin.json`, and the standalone installer.

### Changed

- **Init / bootstrap:** `setup/init-databases.ts` split into `provider-router.ts`, `cost-instrumentation.ts`, `bootstrap-databases.ts` (same public API via thin re-exports).
- **Manage CLI:** `ManageContext` and `registerManageCommands` moved under `cli/` with corrected extension-root imports.
- **facts-db:** Public barrel `backends/facts-db/index.ts` re-exports `FactsDB`, types, and `ReinforcementEvent`.

### Fixed

- **Verify CLI — Azure direct resource ([#994](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/994)):** Direct `*.openai.azure.com` (and siblings) base URLs use `api-key` auth for the OpenAI SDK test client, not only APIM gateways; `AZURE_OPENAI_API_KEY` fallback extended to `azure-foundry-direct`.
- **Lifecycle:** `resolveSessionKeyFromHookEvent` reads `event.context` session id/key so `before_agent_start` agent detection works when the host puts identifiers only on payload context.

---

## [2026.4.30] - 2026-04-30

### Release summary

Version **2026.4.30** brings **entity-aware memory** (contacts, organizations, multilingual NER), **smoother embeddings and verification** (Azure Foundry compatibility, re-index throttling, clearer diagnostics), **context after compaction** so the assistant does not “forget” the last turn, **aligned cron vs main-agent model checks**, **consistent cost-tracking labels** for LLM calls, and **documentation** (plugin help, troubleshooting, hybrid-memory skill). Bumps the npm package, `openclaw.plugin.json`, and the standalone installer.

### Added

- **Contacts, organizations, and multilingual NER ([#985](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/985)–[#987](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/987)):** When `graph.enabled`, store-time **franc** + LLM extraction of **PERSON**/**ORG** spans into SQLite; **`memory_directory`** tool (`list_contacts`, `org_view`); CLI **`openclaw hybrid-mem enrich-entities`** for backfill; nightly/monthly cron steps updated. See [GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md), [MULTILINGUAL-SUPPORT.md](docs/MULTILINGUAL-SUPPORT.md).
- **`openclaw hybrid-mem re-index --delay-ms-between-batches`:** Optional spacing between embedding batches to reduce rate-limit pressure on large backfills.
- **Post-compaction recall ([#957](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/957)):** After compaction, re-run recall on the last user prompt and prepend `<recalled-context>` so recently relevant facts stay in context.
- **Plugin schema help:** `openclaw.plugin.json` entries for LLM tiers and `distill.extractionModelTier` to match the configuration surface.
- **Tests:** `config-set` JSON array handling (`tests/config-set-json.test.ts`).

### Changed

- **Embeddings / providers:** Azure embedding requests omit optional `dimensions` when not required; bootstrap validates embedding dimensions before opening **VectorDB**; shared **rate-limit header** parsing extracted for reuse.
- **Verify CLI — cron vs main agent ([#963](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/963)):** `readEffectiveAgentChatPrimaryFromOpenclawJsonRoot()` prefers `agents.list` entry **`id: "main"`** when resolving the primary chat model for verify/cron alignment warnings.
- **Cost attribution ([#961](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/961)):** Reflection, identity-reflection, cross-agent-learning, and related paths use **`CostFeature`** constants so proxy cost logs group calls predictably.

### Fixed

- **Agent id for cron / embedded hooks ([#990](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/990)):** When structured `agentId` fields are missing, derive the agent from OpenClaw session keys matching `agent:<id>:…` (e.g. `agent:ralph:cron:…`). Session resolution now considers `api.context.sessionKey` as well as `sessionId`. Clearer debug logs when detection still falls back to the orchestrator.

### Documentation

- **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md):** `[embedding-init]` / `[embedding-quota]`, re-index throttling, Azure HTTP 400 (empty body) and short-400 hints on **azure-foundry**; verify guidance cross-referenced.
- **`skills/hybrid-memory/SKILL.md`:** LLM tier guidance for operators.
- **Anthropic `/v1` normalization** already applied in verify and init paths (documented in troubleshooting flow where relevant).

---

## [2026.4.21] - 2026-04-21

### Release summary

Version **2026.4.21** — Anthropic-compliant tool registration (underscore-only `memory_*` tools; removed dotted `memory.*` aliases from the published tool list), documentation and issue templates for provider tool-name rules, hardened `verify-publish.cjs` shrinkwrap check (`npm pack --dry-run --json`), and README guidance for manual `.tgz` installs (`npm ci --omit=dev`). Bumps package, plugin manifest, standalone installer, and release metadata.

### Documentation

- Clarified that **agent tool names** use underscores only and must match provider rules (e.g. Anthropic `^[a-zA-Z0-9_-]{1,128}$`); documented in the plugin README, [CONFIGURATION.md](docs/CONFIGURATION.md), and [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Issue templates updated so examples do not suggest dotted tool names.

### Fixed

- **`verify-publish.cjs`:** Shrinkwrap check uses `npm pack --dry-run --json` (via `execFileSync` without `shell: true`; on Windows resolves `npm.cmd` next to `process.execPath`) and no longer depends on `tar` or a temp `.tgz`; catch blocks format unknown errors safely. README manual-install line documents **`npm ci --omit=dev`** for production installs.

---

## [2026.4.20] - 2026-04-02

### Release summary

Version bump to **2026.4.20** (package, plugin manifest, standalone installer, and release metadata).

---

## [2026.4.12] - 2026-04-01

### Release summary

Version bump to **2026.4.12** (package, plugin manifest, standalone installer, and release metadata).

---

## [2026.4.11] - 2026-04-01

### Release summary

Patch after **2026.4.10**: **interactive FTS fast path** on `FactsDB.search()` (auto-recall) — caps OR-term explosion and two-phase id fetch to reduce gateway stalls on large `facts.db`; **centralized agent id resolution** from hook events (`resolveAgentIdFromHookEvent`) for routed channels; **docs** [INTERACTIVE-RECALL-LATENCY.md](docs/INTERACTIVE-RECALL-LATENCY.md).

### Added

- **`FactsDB.search(..., { interactiveFtsFastPath: true })`** — used from interactive auto-recall; constant **`INTERACTIVE_FTS_MAX_OR_TERMS`**.
- **`lifecycle/resolve-agent-id.ts`** — `resolveAgentIdFromHookEvent()`; **`stage-setup`** uses it for `currentAgentIdRef`.

### Documentation

- **[INTERACTIVE-RECALL-LATENCY.md](docs/INTERACTIVE-RECALL-LATENCY.md)** — why interactive FTS can report very long wall times; `agentId` / OpenClaw context.

---

## [2026.4.10] - 2026-04-01

### Release summary

Follow-up to **2026.3.310** with **bounded interactive auto-recall**, a single **`autoRecall.interactiveEnrichment`** control, **OpenClaw hook alignment ([#966](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/966))**, **entity auto-lookup from facts ([#952](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/952))**, clearer **mode / Phase 1 documentation**, **operator guidance for recall timing logs**, and **CI** updates for current GitHub Actions runners.

### Added

- **`autoRecall.interactiveEnrichment`** (`"fast"` \| `"balanced"` \| `"full"`): one setting couples interactive-turn HyDE (when query expansion allows) and ambient multi-query behavior. **`fast`** turns both off for shorter, more predictable chat-turn recall; mode presets default to **`fast`** where auto-recall is on. Schema and labels in `openclaw.plugin.json`; see [CONFIGURATION.md](docs/CONFIGURATION.md).
- **Regression test** [`extensions/memory-hybrid/tests/config-presets-doc-sync.test.ts`](extensions/memory-hybrid/tests/config-presets-doc-sync.test.ts): asserts `PRESET_OVERRIDES` and post-parse Phase 1 behavior stay aligned with [CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md).
- **Entity lookup from the fact store when your list is empty** ([#952](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/952)):** `autoFromFacts` (default `true`) and `maxAutoEntities` (default 500, max 2000) resolve names via `FactsDb.getKnownEntities()` for merge and retrieval directives; deterministic sort before capping. Docs: [CONFIGURATION.md](docs/CONFIGURATION.md), [CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md), [EXAMPLES.md](docs/EXAMPLES.md). Tests: `entity-lookup-resolve.test.ts`.

### Changed

- **Interactive recall stage** (`lifecycle/stage-recall.ts`): **~32s** wall-clock cap via `AbortController` + race; inner `runRecall` respects **`AbortSignal`** at await boundaries so **`recallInFlightRef`** always decrements. Vector step budget remains **~26s** in policy ([`retrieval-mode-policy.ts`](extensions/memory-hybrid/services/retrieval-mode-policy.ts)); aligns with [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) timeout guidance.
- **Lifecycle hooks ([#966](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/966)):** Subagent lifecycle uses OpenClaw’s **`subagent_spawned`** / **`subagent_ended`** events with tolerant payload shapes; **`before_consolidation`** is **not** registered (not a core hook — avoids noisy no-ops). WAL flush before compaction stays on **`before_compaction`** only.
- **Mode presets** (`config/utils.ts`): presets that enable auto-recall set **`interactiveEnrichment: "fast"`** for consistent latency/cost behavior.
- **CI:** `actions/checkout@v6`, `dorny/paths-filter@v4`, and Node **24**-oriented JavaScript action defaults (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Fixed

- **Tests:** Stabilized reinforcement ranking case when **`diversityWeight`** is 0 (`facts-db` tests).
- **CI:** `plugin-service-startup` version-check test uses a mock **npm** version safely above the current release so the “published newer than local” branch still runs after each version bump.

### Documentation

- **[CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md):** Preset intent vs **Phase 1** overrides; feature matrix aligned with **`PRESET_OVERRIDES`**; link to preset sync test.
- **[TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md):** New section **“Interpreting recall pipeline timing logs (debug)”** — `OPENCLAW_LOG_LEVEL=debug`, FTS/ embed/vector/merge meanings, timeout vs FTS-heavy paths, **`recall degraded`**, fair A/B testing tips.
- **[CONFIGURATION.md](docs/CONFIGURATION.md):** `interactiveEnrichment` documented alongside auto-recall settings.

---

## [2026.3.310] - 2026-03-31

### Release summary

Reliability and upgrade-safety release after **2026.3.300**: improves recall responsiveness, hardens embedding and chat/network edge cases, auto-migrates older LanceDB tables missing the `why` column, documents safer RPC health-check timeouts, and refreshes CI/dependency tooling.

### Added

- **LanceDB compatibility migration:** Startup now detects legacy vector tables that predate provenance support and backfills a nullable `why` column automatically before reads/writes continue.

### Changed

- **Dependency and CI maintenance:** Updated GitHub Actions (`cache`, `stale`, `github-script`, `setup-node`, `labeler`) and refreshed dev dependency lock state (`extensions/memory-hybrid/package-lock.json`) to keep pipelines current.
- **Chat header parsing internals:** Deduplicated case-insensitive header lookup paths in retry-after handling for simpler, safer request metadata parsing.

### Fixed

- **Recall latency / responsiveness ([#931](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/931)):** Auto-recall now yields back to the event loop while processing memory candidates to avoid blocking under heavier recall workloads.
- **Embeddings and verification alignment ([#932](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/932), [#934](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/934), [#941](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/941)):** Dimension mismatch checks and fallback behavior were hardened across vector search, diagnostics, bootstrap, migration, and verify tooling so provider/model transitions fail less often and with clearer behavior.
- **Narratives / transient error handling ([#935](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/935), [#936](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/936)):** Daily narrative generation and chat retry paths better classify abort/timeout-family failures as transient, reducing noisy hard-failure reporting.
- **Store-embed error reporting noise ([#937](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/937)):** Expected embedding failures (including circuit-breaker scenarios) are filtered before plugin error reporting.
- **Type safety in retry-after parsing:** Resolved `TS2352` cast risk when handling `Headers` in `parseRetryAfterMs`.

### Documentation

- **Gateway health operations ([#938](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/938)):** Added operator guidance for default **10s** RPC probe timeout, warm-up false positives, and use of **`--timeout 45000`** (or 30s+) in scripts/dashboards.
- **Verify and dimension troubleshooting ([#941](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/941)):** [CLI-REFERENCE.md](docs/CLI-REFERENCE.md) now documents the verify embedding probe, alignment exit code, and link to troubleshooting; [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) adds sections on LanceDB dimension mismatch and Azure re-index throttling. Follow-ups: [#942](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/942)–[#946](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/946).

---

## [2026.3.301] - 2026-03-30

### Release summary

Embeddings and narratives hardening: **Azure / deployment** embedding paths and **verify** CLI align with runtime config ([#932](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/932), [#934](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/934)); **daily narrative** LLM calls use a longer timeout and **`chatCompleteWithRetry`** no longer reports wrapped abort/timeout causes to GlitchTip ([#935](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/935), [#936](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/936)); **store-embed** skips GlitchTip for Ollama circuit-breaker and other suppressed embedding errors ([#937](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/937)).

### Fixed

- **Embeddings:** Chain/fallback OpenAI model selection respects Azure deployment names; verify passes `deployment` / `models` / `endpoint` into embedding smoke tests.
- **Chat / narratives:** `isAbortOrTransientLlmError(finalError)` used for fallback-exhausted reporting so `LLMRetryError` wrapping `Request was aborted` is not treated as unexpected; narrative summary uses **120s** LLM timeout.
- **Embeddings (tools):** `shouldSuppressEmbeddingError` before `capturePluginError` on store-embed failures.

---

## [2026.3.300] - 2026-03-30

### Release summary

Stability and operator-experience release after **2026.3.293**: **CI** install smoke test no longer picks a stale local `.tgz`; **session narratives** treat gateway loss and `Request was aborted` as transient (info log, no GlitchTip) instead of a hard failure.

### Fixed

- **CI:** Install smoke test deletes prior `openclaw-hybrid-memory-*.tgz` and uses the tarball name from `npm pack` output so the wrong pack cannot fail the `benchmark/shadow-eval.ts` check.
- **Narratives:** `isAbortOrTransientLlmError()` classifies aborts, gateway-down messages, and connection errors; skipped narrative builds log at **info** instead of **warn** for those cases.

---

## [2026.3.293] - 2026-03-29

### Release summary

Follow-up release after **2026.3.292**: merges **[#922](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/922)** (security refactor — centralized `process.env` access and `child_process` via `utils/env-manager.ts` and `utils/process-runner.ts`) and **[#923](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/923)** (README revamp for onboarding). Version bump only; behavior matches the post-merge `main` branch.

### Changed

- **Security / hygiene:** Centralized environment and subprocess helpers to satisfy static scanners and reduce direct `process.env` / `child_process` usage across CLI, services, tests, and scripts.
- **Documentation:** README restructured for clearer engagement and setup.

---

## [2026.3.292] - 2026-03-29

### Release summary

CLI clarity release: **`hybrid-mem config`** and **`hybrid-mem stats`** now describe **effective (running) config** for Phase 1 core-only baseline features, so they no longer disagree with each other when `openclaw.json` still has `enabled: true` but the plugin forces options off (plugin ≥2026.3.140). Export **`PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS`** from the config parser so the migration list stays a single source of truth.

### Fixed

- **Config view:** Phase 1–affected optional features show effective on/off; when the file still has `enabled: true`, a short Phase 1 baseline note is shown. Added missing toggles for workflow tracking, verification, retrieval aliases, reranking, and contextual variants. Query expansion (Advanced) gets the same file-vs-effective note when applicable.
- **Rich stats:** Proposals and credentials lines avoid implying a feature is “broken” when it is off in effective config or the vault is disabled.

### Packaging / install

- **Private testing:** Publish to npm with a non-`latest` dist-tag (for example `npm publish --tag private --otp=…`) so you can install `openclaw-hybrid-memory@private` or pin `2026.3.292` without moving the default `latest` pointer until you are ready.

---

## [2026.3.291] - 2026-03-29

### Release summary

Packaging-only release: the npm tarball includes `benchmark/` (shadow-eval / `hybrid-mem benchmark`). **Feature list unchanged** from [2026.3.290](#20263290---2026-03-29).

### Fixed

- **npm package:** `benchmark/` listed in `package.json` `files` so installs include `benchmark/shadow-eval` and feature benchmarks required by `cli/benchmark.ts`.

---

## [2026.3.290] - 2026-03-29

### Release summary

This release is a large step forward for **structured memory**, **Azure / APIM deployments**, and **operational hardening**. It adds episodic memory, human-gated edicts, procedure outcome tracking, and frequency-based auto-capture; ships Mission Control dashboards (memory graph, agent health, cross-agent audit); improves embedding setup with APIM-aware routing and a new `model-info` CLI; and closes multiple critical-through-low severity issues across FTS5, WAL, LanceDB, credentials, SQLite lifecycle, and recall.

### Added

- **Episodic memory (#781):** First-class `category: "episode"` with `event`, `outcome` (`success` \| `failure` \| `partial` \| `unknown`), `timestamp`, `duration`, `context`, `relatedFactIds`, `procedureId`, scope, IDs, importance, tags, and decay. SQLite `episodes` table with indexed `outcome` and `timestamp`; vectors in LanceDB alongside facts (`category="episode"`). Failures auto-boost to `importance ≥ 0.8`.
- **Episode tools:** `memory_record_episode()`, `memory_search_episodes()` (outcome, time range, `procedureId`, FTS over `event + context`).
- **Session-end episode auto-capture (#781):** Compaction scans JSONL for outcome phrases (e.g. merged / failed / fixed / partial / ERROR) and creates episode records.
- **FactsDB episode API:** `storeEpisode`, `getEpisode`, `deleteEpisode`, `searchEpisodes`, `episodesCount`; `episodes_fts` FTS5 table; `episodes.test.ts` coverage.
- **Edict memory type (#791):** `category: "edict"` for verified ground truth in SQLite `edicts` with TTL (`never` \| `event` \| seconds). Tools: `memory_add_edict`, `memory_list_edicts`, `memory_get_edicts`, `memory_update_edict`, `memory_remove_edict`, `memory_edict_stats`. Injected before issue/narrative/hot blocks; **never trimmed** by token budget. Creation is **propose-only** (`[EDICT CANDIDATE]` on GitHub for human review).
- **Procedure feedback loop (#782):** `procedure_versions` and `procedure_failures` tables; `procedureFeedback()` on FactsDB; `memory_procedure_feedback()` tool; `memory_recall_procedures` enriched with `lastOutcome`, `successRate`, `avoidanceNotes`; CLI `memory procedure show` / `list`.
- **Frequency-based auto-save (#784):** `recent_mentions` table; auto-save entities after threshold; vault capture for credentials with hashed dedupe and `host+username+scope` supersession; `FrequencyCaptureConfig` (`mentionThreshold`, `lookbackSessions`, `ttlDays`, etc.).
- **Mission Control (#788–#790):** Memory graph visualization (#788), Agent Health Dashboard (#789), Cross-agent Audit Trail (#790).
- **Azure APIM for embeddings (#815):** Gateway auth, deployment override, endpoint auto-inheritance; plugin OpenAI client and `hybrid-mem --test-llm` probe updated (#822, #826).
- **`hybrid-mem model-info` CLI (#816):** Embedding dimension introspection for operators.
- **Shadow evaluation benchmark (#787).**
- **Repository automation:** `issue-verify-and-close` and `pr-merged-trigger` workflows for PR/issue verification.
- **Facts DB internals (#921):** Modular helpers — `cache-manager`, `db-connection`, `fact-queries`, `fts-text`; shared `utils/embed-call.ts` for embedding calls; expanded `credential-validation`; config schema additions in `openclaw.plugin.json` where applicable.

### Changed

- **`DEFAULT_MEMORY_CATEGORIES`:** Includes `"episode"` (and edict as a category where defined in types).
- **`EpisodeEntry` type** in `types/memory.ts` (discriminated `outcome`).
- **`ProcedureEntry`:** `version`, `lastOutcome`, `successRate`, `avoidanceNotes` from version tracking.
- **Token-budget trimming (#792):** Tiered trimming with `preserveUntil` / `preserveTags` for finer control over what survives under pressure.
- **Dependencies:** Audit and reduction (#777); `openclaw` peer/dev bumps (#780, #920); `path-to-regexp` bump (#809).
- **Imports:** Deprecated OpenClaw plugin-sdk barrel paths replaced with scoped subpaths (#779).
- **Lint / DX:** Biome rules tightened (off → warn), `organizeImports` disabled (#819); invalid `noUselessContinue` rule removed; retry/timeout constants centralized in `utils/constants.ts` (#910).

### Fixed

- **SQLite after gateway restart (#783):** Connection reopened correctly after `SIGUSR1` restart.
- **Migrations & data safety:** Duplicate `migrateEpisodesTable` removed (#801/#804); edict migration duplicate-check / data-loss risk (#808); stronger episodes migration (CHECK constraints, composite indexes, FTS trigger, #817).
- **Procedure feedback (#798):** `scopeTarget` null handling; double-counting in `procedureFeedback`.
- **Reliability wave (#909, #917, #918):** FTS5 hardening, WAL improvements, async/GitHub lease handling, safer tools, LanceDB and credential paths, task queue (incl. FD leak on lock, #813), embedding edge cases, security and SQLite hygiene, CLI verify behavior.
- **Priority-low sweep (#870–#902, #921):** Facts DB refactor and query paths; recall pipeline and memory/credential tools; WAL helpers; vector-db and FTS search; scope filtering; context engine and narratives; error reporter and verification store; Python bridge stdin; plugin API registration edge cases.
- **Register / task signals / Python stdin (#802, #810, #812, #823).**
- **CI:** Biome `--max-diagnostics=none` and unsafe write fixes (#805, #806).

---

## [2026.3.260] - 2026-03-26

### Release summary

A focused stability and usability release building on the large 2026.3.250 feature drop. Highlights: **Lineage Tracking** ("why" field on all memories and decisions), **flattened config schema** with backwards-compatible migration, **pinned-constraint auto-injection** before context compaction, and a comprehensive wave of LanceDB reliability fixes. All known LanceDB crash paths from 2026.3.250–251 are now resolved.

### Added

- **Lineage Tracking — "Why" field for files and decisions (#750, #752):** Every memory fact, file reference, and decision stored by the plugin now carries an optional `why` field capturing the reason it was created. The LanceDB schema and FTS5 index are both extended; `memory-tools` and CLI `vector store` commands support the new field. Enables provenance queries ("why was this fact stored?") and richer audit trails.
- **Auto-inject pinned constraints before context compaction (#758):** Constraints marked as `pinned` in the memory store are now automatically re-injected into the context window immediately before compaction runs. Previously, pinned constraints could be silently dropped during aggressive compaction; they are now guaranteed to survive.
- **Link timeline summaries to raw session logs (#766):** The session timeline UI now renders direct links from each summary entry to the underlying raw session log file, making it easy to jump from a high-level summary to the exact conversation that produced it.
- **preferredProviders in embedding schema (#743):** The `openclaw.plugin.json` embedding schema now accepts a `preferredProviders` array, letting operators declare a preferred embedding provider order per-deployment without touching code.

### Fixed

- **LanceDB re-index race condition and ENOTEMPTY on LanceDB 0.27.x (#771):** Concurrent re-index operations on LanceDB 0.27.x could leave a partial `_tmp` directory and throw `ENOTEMPTY`. The re-index path now uses atomic rename semantics and a lock guard to prevent interleaving.
- **LanceDB data file not found during vector-duplicate-check (#768, #774):** `hasDuplicate()` threw a file-not-found error on freshly initialised stores before the first write. The check now gracefully returns `false` when the underlying data file is absent.
- **Crystallization pipeline produces zero proposals (#742, #773):** A logic inversion in the candidate scoring step caused the crystallization pipeline to filter out all proposals instead of the weakest ones. Fixed; pipeline now consistently produces ranked proposals.
- **VectorDB schema error suppression tightened (#740, #753):** The `LANCE_NO_VECTOR_COL_MSG` error suppression was previously applied unconditionally, masking genuine schema errors. Guard now requires `!this.schemaValid` before suppressing, so real schema problems surface correctly.
- **Vector dimension mismatch in LanceDB fallback queries (#764):** When the active embedding model returns a different dimension than what the LanceDB table was created with, fallback queries no longer crash — they skip the vector leg and return FTS-only results.
- **SQLite FTS5 throws "unterminated string" on null bytes (#737, #738):** FTS5 queries containing null bytes (e.g. from binary clipboard content) caused an unhandled SQLite error. Input is now sanitized before FTS5 query construction.
- **LanceDB concurrent-close null guard (#771):** Concurrent close calls on the LanceDB connection could dereference a null handle. Added null guard in the close path.
- **`truncateForStorage` crashes on undefined/null input (#755, #756):** Two separate callers could pass `undefined` or `null` to `truncateForStorage`. Both paths now coerce to empty string before truncation.
- **selfCorrection and implicitFeedback JSON schema missing `enabled` field (#765, #767):** The `enabled` toggle was accepted at runtime but omitted from the JSON schema, causing validation warnings. Both schemas now declare `enabled` explicitly.
- **CLI config display: nightlyCycle enabled state always shown as false (#760):** The `hybrid-mem config` CLI output hardcoded `false` for the `nightlyCycle.enabled` field regardless of actual config. Now reads the live value correctly.
- **`stringEnum` removed — replaced with inline implementation (#762):** A utility that was removed in a dependency update was still being imported. Replaced with a minimal inline implementation to restore correct schema validation.
- **Suppress transient HTTP 500 errors from OpenAI to GlitchTip (#739, #759):** Transient 500 responses from OpenAI (server-side errors outside plugin control) are no longer reported as plugin errors in GlitchTip, reducing alert noise.
- **Distill description referenced removed GOOGLE_API_KEY (#776):** The distillation step description mentioned `GOOGLE_API_KEY` which was removed in favour of `llm.heavy` tier config. Updated to reflect current setup.
- **Google embedding model name (#743):** Default Google embedding updated from `text-embedding-005` (404) to `gemini-embedding-001` (current name).
- **Azure embedding label in verify output:** The verify `--test-llm` table now correctly labels the Azure embedding provider row.
- **CI: Biome format, lint error, and npm audit vulnerability (f240d914):** Three CI issues fixed on main: `vector-db.ts` Biome format (ternary line-length), `cmd-config.ts` unused `catch (e)` binding, `config-view-nightly-cycle.test.ts` missing `node:` import prefix, and `smol-toml` bumped to ≥1.6.1 (GHSA-v3rj-xjv7-4jmq, moderate DoS).

### Changed

- **Flattened config schema (#754, #776):** Three previously nested config keys are promoted to top-level:
  - `implicitFeedback.trajectoryLLMAnalysis` → `trajectoryLLMAnalysis`
  - `implicitFeedback.feedToSelfCorrection` → `feedToSelfCorrection`
  - `distill.extractReinforcement` → `extractReinforcement`

  Old nested keys continue to work during a migration period (deprecation warning logged when both are set). Top-level keys take precedence. Update your `openclaw.plugin.json` or agent config to use the new flat paths.

- **VectorDB error handler precision:** Schema-error suppression now conditioned on `!this.schemaValid`, making error handling more surgical and preventing silent masking of genuine issues.

### Dependencies

- `yaml` bumped from 2.8.2 → 2.8.3 in `extensions/memory-hybrid`
- `picomatch` bumped in both `extensions/memory-hybrid` and root workspace
- Root workspace dependencies updated to latest patch versions
- `smol-toml` bumped to ≥1.6.1 (security: GHSA-v3rj-xjv7-4jmq)

---

## [2026.3.250] - 2026-03-24

### Release summary

The largest feature release since the memory-manager 3.0 rewrite. This release ships **Production RAG principles**, **NarrativesDB** for temporal memory summaries, **identity reflection**, an **auto-generated memory mind-map**, a **task-queue watchdog**, and a comprehensive **database reliability overhaul** — alongside five crash-level bug fixes surfaced through real-world telemetry.

### Added

- **Production RAG principles (#656):** Full-featured Retrieval-Augmented Generation pipeline — reranking, semantic cache, document grading with configurable toggle, and best-match tiebreaking by `cachedAt` so higher-similarity results always win.
- **NarrativesDB — temporal + narrative summaries (#646):** New `NarrativesDB` backend stores per-session narrative snapshots synthesized from event-log events. Session summaries are generated at `agent_end` and surfaced during recall to give the agent temporal context ("what happened in the last session").
- **Identity reflection layer (#647):** A dedicated reflection pass builds and maintains a durable persona identity store from the agent's own outputs. Reflection outputs are promoted through a pipeline into `persona-state-store`, giving the agent long-term self-awareness across sessions.
- **Auto-generated memory mind-map / index (#645):** A background job synthesizes all stored facts into a human-readable memory index — a navigable mind-map of what the agent knows. Short entries now use their actual text as labels instead of generic category names.
- **Task-queue watchdog (#662):** A new watchdog service monitors the autonomous task queue for stale leases, clears expired entries, and emits alerts. Includes lease tracking with proper expiry management and Azure model documentation.
- **Retrieval modes — interactive vs. deep (#639):** First-class support for two distinct retrieval strategies: `interactive` (low-latency, FTS5-first) and `deep` (higher-recall, multi-strategy). Mode is selected per query based on context signals.
- **Hard FTS5 capability check (#727):** On startup the plugin verifies the SQLite FTS5 extension is available. If missing, it degrades gracefully with a clear alert rather than silent query failures.
- **Pre-consolidation flush & decay controls (#729):** New explicit controls for pre-consolidation memory flush and decay scheduling. Operators can now configure flush triggers and decay intervals directly rather than relying on implicit cron timing.
- **Provenance tagging to prevent cron contamination (#728):** Every fact written by a background cron job is tagged with its provenance source. Prevents cron-written facts from polluting feedback loops and corrupting the interactive memory signal.
- **Automated CI feedback loop (#664):** CI review comments are now automatically consumed and re-queued as follow-up tasks, closing the loop between review feedback and code changes without manual triage.
- **Architecture center (#637):** Formal definition of the core runtime boundary vs. adjacent subsystems. Enforced via lint rules to prevent coupling creep between plugin internals and external tooling layers.
- **`verify --test-llm`:** New `--test-llm` flag for `openclaw hybrid-mem verify` tests every configured LLM endpoint with a real API call, reporting which models are reachable and what dimensions/capabilities they expose.
- **ANTHROPIC_API_KEY env support in verify:** Verify now resolves the Anthropic key from `ANTHROPIC_API_KEY` env var (in addition to the existing config path), making it easier to run without a hardcoded key.
- **Agent + node tagging in error reports (#706):** GlitchTip / error reports now include which agent (Maeve, Doris, etc.) and which machine generated the error, enabling per-agent filtering in the telemetry dashboard.
- **Version-aware telemetry muting (#705):** Outdated plugin versions suppress telemetry noise by default. Configurable update nudges alert operators when a newer version is available.

### Fixed

- **EventLog closed after session dispose (#683, #712):** The `EventLog.liveDb` getter previously threw `"EventLog is closed"` permanently after `close()` was called. Changed from a permanent closed flag (better-sqlite3 pattern) to a reopen path using Node.js `DatabaseSync.open()`. Additionally added an `isOpen()` guard in `buildDailyNarrative` to skip narrative synthesis cleanly when the session is already torn down.
- **"database is not open" on hot-reload (#682, #711):** Defensive database connection initialization prevents `"database is not open"` errors during gateway hot-reload or SIGUSR1 restart cycles.
- **All embedding providers failed (#678, #680, #707, #710):** Fixed two separate causes: (1) incorrect provider chain fallback when the primary embedding provider is unreachable; (2) dimension mismatch when switching embedding models that caused the fallback chain to abort unnecessarily.
- **LanceDB "No vector column found" (#679, #708):** Query stream now handles the case where no vector column exists in the LanceDB table (e.g. on a freshly initialized or migrated store) without throwing.
- **Ollama connection failure noise (#681, #709):** Ollama `fetch failed` errors are no longer reported to the error tracker when Ollama is not configured; they are swallowed as expected unavailability.
- **Connection error circuit-breaker noise (#703, #713):** Generic "Connection error" and network errors are filtered from Sentry/GlitchTip SDK config to avoid alert fatigue when the network is temporarily unavailable.
- **Persona reflection — missing requirements (#647, #674, #675):** Fixed incomplete requirements resolution in the persona reflection pass that caused the pipeline to skip promotion steps silently.
- **Autonomous queue duplicate dispatch (#634):** Prevented the autonomous task queue from dispatching the same issue twice when a GitHub branch isn't yet visible during fast successive queue runs.
- **Gateway register parse failure (#661):** Isolated `hybridConfigSchema` to prevent the gateway registration parse from failing when the plugin config has extra top-level keys.
- **Upgrade missing @lancedb/lancedb (#636, #663):** Upgrade from 2026.3.181 no longer risks missing the native LanceDB bindings; postinstall script now checks for and rebuilds them when needed.
- **`fix(embedding)`: primary model/dimension alignment (#05b52d44):** Ensured the primary embedding model always resolves to consistent dimensions on backward-compatible stores to prevent re-indexing on restart.
- **Google embedding — gemini-embedding-001 (#8240914a):** Updated Google embedding to use `gemini-embedding-001` (the current model name after Google renamed `text-embedding-004`/`005`). Dimension chaining and verify output now reflect the corrected model.
- **CI actions failure on main branch (#733, #734):** Fixed concurrency and branch filter issues that caused CI to fail when running directly against `main`.

### Changed

- **FactsDB refactor (#638, #649):** `backends/facts-db.ts` split by responsibility boundary into focused sub-modules (retrieval, write, consolidation, decay), reducing module size and coupling.
- **Bootstrap slimmed (#640, #659):** Context-bag and service registration assembly streamlined — removed redundant tool registrations and tightened the wiring between plugin init and feature flags.
- **Google embedding — migrated to gemini-2.5-flash-lite (#e11c5ec1):** The Google embedding provider now defaults to the `gemini-2.5-flash-lite` model for classification/distill use cases (lower cost, same quality for short texts).
- **Error reporting filter (#704, #715):** Noisy network errors, auth failures, and circuit-breaker events are now filtered out of the Sentry SDK config. Only actionable plugin-internal errors reach the tracker.
- **Dependency updates:** `fast-xml-parser` bumped; minor/patch dependency group updated across `extensions/memory-hybrid`.

### Developer / Internal

- **Architecture lint rules (#637):** `lint-arch.sh` now enforces the boundary between the core runtime and adjacent subsystems. Violations fail CI.
- **PR template (#ae8d8fde):** Strict documentation requirements added to the pull request template — every PR must document user-facing impact and include test evidence.
- **Test improvements:** Fixed narrative-recall test timestamps (2025 → 2026), lease expiry bug in task-queue tests, and FTS5 degradation test coverage.

---

## [2026.3.181] - 2026-03-18

### Fixed

- **Release workflow:** Resolved concurrency deadlock when Release runs on tag push (caller and called CI workflow shared the same concurrency group). Release now uses a distinct group (`release-cd-${{ github.ref }}`) so the workflow completes and creates the GitHub Release and publishes to npm.

---

## [2026.3.180] - 2026-03-18

### Release summary (user-friendly)

This release includes a **security override** for the Hono node server dependency and documents **migration steps** for the retrieval pipeline API and Google embedding default change.

### Security

- **Override @hono/node-server to >=1.19.10 <2 (GHSA-wc8c-qw6v-h7f6):** Added npm `overrides` to force `@hono/node-server` to a patched version. The unbounded range is capped at `<2` to prevent accidental major-version upgrades.

### Migration notes

- **`runRetrievalPipeline` signature changed to options bag — breaking change (#501):** The function signature was refactored from many optional positional parameters to a single `RetrievalPipelineOptions` object. `runRetrievalPipeline` is re-exported from the package root (`extensions/memory-hybrid/index.ts`), so **any external consumer calling the old positional form must migrate**.

  Before:
  ```ts
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, config, budgetTokens, tagFilter, ...);
  ```
  After:
  ```ts
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, { config, budgetTokens, tagFilter, ... });
  ```
  The five required positional parameters (`query`, `queryVector`, `db`, `vectorDb`, `factsDb`) are unchanged; everything else moves into the `options` bag. Omitting any option preserves existing default behaviour.

- **Google embedding model default changed: `text-embedding-004` → `gemini-embedding-001` (#385):** If your deployment previously used `text-embedding-004` (explicitly or as the inferred default), switching to `gemini-embedding-001` produces different vector representations. **Existing LanceDB tables indexed with `text-embedding-004` will have degraded semantic retrieval quality until re-indexed.** Run `openclaw hybrid-mem re-index` after upgrading to rebuild the vector index with the new model. To keep using `text-embedding-004`, set `embedding.model: "text-embedding-004"` explicitly in your plugin config.

---

## [2026.3.152] - 2026-03-15

### Changed

- **config-set:** Simpler toggle syntax: use `openclaw hybrid-mem config-set <feature> enabled|disabled` (e.g. `config-set nightlyCycle enabled`) instead of `config-set nightlyCycle.enabled true`. Values validated; unknown values return a clear error. `costTracking` added to object toggles.
- **verify:** Clear summary and guidance after Embeddings/LLM tables. "Embeddings: OK" / "LLMs: OK" lines and a single "Summary: Ready" or "Summary: Fix the issue(s)…" so users know at a glance if setup is good. Source column no longer blank (shows "gateway" or "—" when key is not in plugin config). "In config" shows "No" instead of "—" for reference models. Legend explains Source and In config.

### Fixed

- **verify:** Empty Source column when API keys come from gateway/env; now shows "gateway" or "—". "In config" column now explicitly "No" when model is not in llm.nano/default/heavy.

---

## [2026.3.151] - 2026-03-15

### Fixed

- **Plugin config schema (OpenClaw validation):** `config.mode` enum in `openclaw.plugin.json` now includes `local`, `minimal`, `enhanced`, `complete` so configs using the new preset names pass OpenClaw validation. Legacy values (`essential`, `normal`, `expert`, `full`) remain accepted.

### Changed

- **Verify output:** Full embedding and LLM tables always visible (not suppressed in quiet). LLM table shows one row per model (from config + reference list), with Model, Provider, Auth, Source, In config, Enabled. Reference models (Opus, GPT-5.4, Codex, o3, etc.) always listed.

---

## [2026.3.150] - 2026-03-15

### Release summary (user-friendly)

This release adds **Phase 3 modularization** and **Phase 2.3 lifecycle staging**, plus **OAuth-first auth with smart failover** and clearer **configuration modes**.

- **OAuth preferred when both OAuth and API key exist** — The plugin now tries OAuth first when a provider has both. If OAuth fails (e.g. gateway down), it automatically falls back to your API key and uses **incremental backoff** (5 min → 30 min → 1 h → 2 h → 4 h) before retrying OAuth. You can clear backoff anytime with `openclaw hybrid-mem reset-auth-backoff`. See [LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md).
- **Configuration mode names updated** — Modes are now `local` | `minimal` | `enhanced` | `complete`. **Default when omitted is `local`** (backward compatible with previous “full” behavior). Deprecated names (`essential`, `normal`, `expert`, `full`) are reset to **`local`** and a one-time warning is logged; set the new mode explicitly to enable LLM or other features. See [CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md).
- **New CLI** — `openclaw hybrid-mem config` shows effective config and mode; `openclaw hybrid-mem reset-auth-backoff` clears OAuth failover state. `verify` gains `--test-llm` and richer Embeddings/LLM tables (credential source, OAuth vs API results, disabled providers).
- **Memory-to-skills removed** — The `skills-suggest` command, cron job, and related config/docs have been removed. Use workflow crystallization and tool proposals instead.
- **Stable internal API** — Optional modules can depend on `MemoryPluginAPI` (see `api/memory-plugin-api.ts`) for tool and lifecycle registration without circular dependencies.
- **Lifecycle pipeline** — Hooks are decomposed into staged pipeline (setup, recall, injection, capture, cleanup) with per-stage timeouts and toggles.

### Added

- **OAuth failover and backoff:** When OAuth fails for a provider that also has an API key, the plugin records the failure and uses the API key. Retries to OAuth use a configurable backoff schedule (default: 5 min, 30 min, 1 h, 2 h, 4 h). State is stored in `.auth-backoff.json` next to the SQLite DB. Config: `auth.preferOAuthWhenBoth` (default `true`), `auth.backoffScheduleMinutes`, `auth.resetBackoffAfterHours` (default 24). See [LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md).
- **CLI `reset-auth-backoff`:** Clears OAuth failover state so the next LLM call tries OAuth again for providers with both OAuth and API key.
- **CLI `config`:** New subcommand to print effective plugin config and detected mode (or “Custom” when presets are overridden).
- **`verify --test-llm`:** Runs minimal completions per provider and reports OAuth vs API result separately; shows credential source (env, file, plugin, gateway, local) and honors `llm.disabledProviders`.
- **Stable `MemoryPluginAPI`:** Type in `api/memory-plugin-api.ts` consumed by `registerTools` and `registerLifecycleHooks` so optional modules can depend on a single API surface.
- **Config:** `llm.disabledProviders` (array of provider IDs to exclude from all LLM use), `procedures.maxInjectionTokens` (default 500), mode presets for `local` / `minimal` / `enhanced` / `complete`.

### Changed

- **Default mode:** When `mode` is omitted, the plugin uses **`local`** (cost-safety: no external LLM, FTS-only). Set `"mode": "minimal"`, `"enhanced"`, or `"complete"` to enable LLM and other features.
- **Deprecated mode mapping:** All deprecated names (`essential`, `normal`, `expert`, `full`) are **reset to `local`**. A one-time warning is logged; set the new mode explicitly to restore higher tiers.
- **Lifecycle:** Single `pluginContext` (typed as `MemoryPluginAPI`) is passed into `registerLifecycleHooks` and `registerTools`. Hooks are implemented as staged pipeline (setup, recall, injection, capture, cleanup) with config toggles and timeouts.
- **Local / FTS-only:** When mode is `local`, retrieval uses FTS-only (no embeddings or vector DB). Capture and recall skip embedding/vector work when semantic retrieval is disabled.
- **Procedure injection:** Capped by `procedures.maxInjectionTokens`; blocks are trimmed to stay within the cap.

### Removed

- **Memory-to-skills feature:** `skills-suggest` CLI command, cron job, `memory-to-skills` service, prompts, and related config/types/docs. Maintenance cron set reduced from 9 to 8 jobs.

### Fixed

- **Credential source fallback:** `credentialSource` now returns empty string for missing keys so verify’s fallback logic correctly shows the actual source (e.g. `llm.providers` with `env:`).
- **Google LLM base URL:** Removed `/v1` appending in `buildDirectClient` so Google’s `v1beta/openai/` endpoint is used correctly in `verify --test-llm`.
- **Stale references:** Removed `skills-suggest` from CLI help and command list after feature removal.

### Migration notes

- If you used **deprecated mode names** (`essential`, `normal`, `expert`, `full`), the plugin resets them to **`local`**. Set `"mode": "minimal"`, `"enhanced"`, or `"complete"` explicitly to enable LLM and other features.
- If you relied on **memory-to-skills** or **skills-suggest**, remove those from cron/config; use workflow crystallization and tool proposals instead.
- **OAuth + API key** users: no change required; OAuth is preferred by default and API key is used on failure with backoff. Use `openclaw hybrid-mem reset-auth-backoff` to clear backoff if needed.

---

## [2026.3.140] - 2026-03-14

### Changed

- **Version 2026.3.140:** Bump for Phase 1 remodeling release.
- **Upgrade migration (core-only baseline):** When running plugin version **2026.3.140 or later**, config parsing applies a **Phase 1 core-only migration**. The plugin **overrides** every listed option to the disabled value, **including values the user had set**, so all installations get the same baseline. Affected areas: `queryExpansion`, `frustrationDetection`, `nightlyCycle`, `passiveObserver`, `workflowTracking`, `selfExtension`, `crystallization`, `verification`, `provenance`, `aliases`, `crossAgentLearning`, `reranking`, `contextualVariants`, `documents`, `personaProposals`, and `graph.strengthenOnRecall`. To re-enable any feature, set it explicitly in your plugin config after upgrading (e.g. `queryExpansion: { enabled: true }`).

---

## [2026.3.110] - 2026-03-11

### Fixed

- **GlitchTip false-positive for UnconfiguredProviderError in mixed fallback chains (#328):** In `chatCompleteWithRetry`, when the final fallback model threw `UnconfiguredProviderError` but an earlier model in the chain had failed for a different reason (e.g. ECONNREFUSED, rate limit), the `else if (unconfiguredCount > 0)` branch was incorrectly reporting the error to GlitchTip. `UnconfiguredProviderError` is always a config issue, not a code bug — GlitchTip reporting is now suppressed whenever the final error is an unconfigured-provider error, regardless of what earlier models failed with.
- **Qwen3 thinking mode empty responses (#314):** Qwen3 models running via Ollama default to `enable_thinking=true`, which places the actual model output in `message.reasoning_content` (current standard) or the legacy `message.reasoning` field while leaving `message.content` empty. `chatComplete()` now falls back to these fields when `content` is empty, so cron agents routing to `ollama/qwen3:*` receive the full response instead of timing out on a blank reply. Non-Qwen models are unaffected.

---

## [2026.3.100] - 2026-03-10

Major stability release: LanceDB OOM fix, provider hardening, 4-model council review, 13 bug fixes, cron guard system.

### Added

- **LanceDB auto-compaction (#292):** `VectorDB.optimize()` method with race-condition guard (`promiseRef` pattern). Auto-compacts after every 100 `store()` calls. New CLI command `openclaw hybrid-mem optimize` for manual compaction. Weekly cron job integration.
- **Cron job re-run guards (#304, #305):** `buildGuardPrefix()` generates `MIN_INTERVAL_MS` checks using `/tmp/hybrid-mem-guard-<job>.txt` timestamp files. Three tiers: daily (20h), weekly (5d), monthly (25d). Prevents jobs re-firing on every gateway restart.
- **Per-URL Ollama circuit breaker (#298):** Module-level circuit breaker tracks failures per endpoint URL instead of globally. Prevents one bad Ollama endpoint from disabling all local models.
- **Transient error retry logic (#301, #302):** LLM request timeouts and 5xx errors are now retried with configurable limits. Connection errors trigger graceful fallback to next provider.
- **`Retry-After` header parsing (#296):** 429 rate-limit responses now respect the server's `Retry-After` header with exponential backoff.
- **Provider fallback chain (#294, #300):** `UnconfiguredProviderError` now resolves fallback keys for OpenRouter, Anthropic, and generic API configurations. Embedding provider chain exhaustion handled gracefully — stores facts without embeddings when all providers fail.
- **`is404Like` detection (#303):** LLM 404 responses (model not found) now skip retry loops and move to next model immediately.
- **Try/finally scan locks:** `extract-directives`, `extract-reinforcement`, and `self-correction-run` now release concurrency locks in `finally` blocks, preventing lock leaks on errors.
- **Gateway token leak fix (#init-databases):** Removed `OPENCLAW_GATEWAY_TOKEN` from the OpenAI provider fallback chain — was sending internal gateway tokens to external endpoints.
- **Scan cursor fix:** `getScanCursor()` now returns `last_run_at` (not `last_session_ts`), fixing the 23-hour guard to check actual run time.
- **`$HOME` expansion fix (#299):** `.last-post-upgrade-version` path now expands `$HOME` explicitly in `plugin-service.ts`.
- **401 fast-fail (#295):** Authentication errors skip retry loops and fall back to next provider immediately.
- **Config validation (#289):** Placeholder API key detection for `embedding.apiKey`. Nano-tier defaults for all background features.

### Changed

- **LLM tier defaults:** Background features (autoClassify, HyDE, query expansion, summarize) default to nano tier. Self-correction spawn model changed to Sonnet. Distill model tier defaults to Flash.
- **Incremental processing for all scans (#288):** Watermark-based scan cursors. Full re-index only on explicit `--full` flag.

### Fixed

- 13 bugs identified from GlitchTip error reports (#294–#303) plus cron re-trigger (#304)
- LanceDB OOM crashes: 9036 uncompacted fragments → 1 after optimize (freed 2.6 GB)
- Race condition in `VectorDB.optimize()`: circular promise reference fixed with intermediate `promiseRef` variable
- All 76 review threads from 4-model council review (GPT, Opus, Gemini, Sonnet) resolved

### Security

- Gateway token no longer leaked to external OpenAI-compatible endpoints
- 401 errors no longer trigger infinite retry loops exposing invalid keys

---

## [2026.3.92] - 2026-03-10

Incremental extraction, startup guards, nano-tier defaults, and schema fix (#288/#289).

### Added

- **Incremental extraction (#288):** `extract-procedures`, `extract-directives`, `extract-reinforcement`, `distill`, and `self-correction-run` now maintain a watermark (`scan_cursors` table in SQLite). On each run they process only sessions created after the last successful scan, making nightly jobs fast regardless of session history size. `--full` forces a full re-scan and bypasses the watermark; `--dry-run` never writes the cursor.

- **Startup guards — 23-hour rate-limit (#289):** Each scan type checks the cursor's `lastRunAt` timestamp before acquiring the concurrency lock. If less than 23 hours have passed the job is skipped with a log message (`skipped: true`). Prevents runaway double-execution when OpenClaw retries a failed job.

- **`scan_cursors` schema (#288):** New SQLite table (`scan_type TEXT PRIMARY KEY, last_session_ts INTEGER, last_run_at INTEGER, sessions_processed INTEGER`) created during DB init. Seeded with a migration guard so existing databases upgrade automatically.

### Changed

- **`extractionModelTier` default changed to `"nano"`:** `extract-reinforcement` now defaults to the nano-tier model (e.g. `gpt-4.1-nano`) when `distill.extractionModelTier` is unset. Previously it defaulted to `"heavy"`. Expert and Full presets set `extractionModelTier: "default"` to opt into the standard-tier model. This significantly reduces cost for most users.

- **`weekly-extract-procedures` job model:** The cron job is now scheduled with `modelTier: "nano"` so the agent that orchestrates the extraction steps uses a cheap model. The LLM step inside `extract-reinforcement` is still controlled by `distill.extractionModelTier`.

### Fixed

- **Schema init order:** `scan_cursors` table is now created before any index is built, fixing a startup error on fresh installs.

---

## [2026.3.91] - 2026-03-09

Memory Dashboard: Lovable web UI, shared REST API, and multi-dashboard layout (placeholders for GPT/Gemini/Claude).

### Added

- **Memory Dashboard (Lovable):** Web UI in `dashboard/lovable/` for hybrid-memory inspection: overview stats (total facts, categories, links, issues, cost), facts-by-category/tier/decay and recent facts; interactive memory graph (force-directed, filters, node detail); facts explorer (paginated table with category/tier/search filters); issue tracker; knowledge clusters; cost & usage (daily/model/feature charts); feature configuration (read-only toggles from plugin config); workflow patterns. Built with React 18, TypeScript, Vite, Tailwind, shadcn/ui, Recharts, react-force-graph-2d. Uses mock data when no API is configured; set `VITE_API_BASE` to use the dashboard API for live data. Base path `/plugins/memory-dashboard/lovable/` for production hosting.

- **Dashboard REST API:** Standalone HTTP server in `extensions/memory-hybrid/scripts/dashboard-api.ts`. Run with `npm run dashboard-api` from the extension directory (listens on port 18790; `PORT` env to override). Reads OpenClaw config from `OPENCLAW_HOME` or `~/.openclaw` and serves live data from FactsDB, IssueStore, CostTracker, and WorkflowStore. Endpoints: `GET /api/stats`, `/api/facts`, `/api/facts/:id`, `/api/graph`, `/api/issues`, `/api/clusters`, `/api/cost`, `/api/config`, `/api/workflows`. CORS enabled for local dashboard use. No new runtime dependencies; uses `tsx` (devDependency) to run the TypeScript script.

- **Multi-dashboard layout:** `dashboard/` contains `lovable/` (full app), plus placeholders `gpt/`, `gemini/`, `claude/` with READMEs so you can add dashboards generated from the same brief by different tools and compare results. All dashboards use the same API contract; see `dashboard/README.md` for shared API instructions and how to add new dashboards.

### Documentation

- **dashboard/README.md:** Describes layout (lovable vs gpt/gemini/claude), shared API (run from `extensions/memory-hybrid`), how to run each dashboard (mock vs real data), and how to add GPT/Gemini/Claude dashboards.
- **dashboard/lovable/README.md:** Lovable-specific quick start (dev with mock, dev with API, production build), API endpoints table, tech stack, project structure.
- **README.md (root):** Memory Dashboard section updated: one shared API, multiple dashboards (lovable, gpt, gemini, claude) for comparing briefs; link to `dashboard/README.md`.

---

## [2026.3.90] - 2026-03-09

Milestone A+B: future-date decay, episodic event log, local embeddings (Ollama/ONNX), multi-model RRF, contextual variants, query expansion, re-ranking, verification store, provenance tracing, document ingestion; real-time frustration detection and cross-agent learning (#263/#265); dependency bumps.

### Added

- **Future-date decay protection (#144):** Facts containing future dates have their `decay_freeze_until` timestamp set to prevent them from expiring before they are relevant. Enabled by default. Config: `futureDateProtection.enabled` (default: `true`), `futureDateProtection.maxFreezeDays` (default: `365`; `0` = no limit). See [CONFIGURATION.md](docs/CONFIGURATION.md#future-date-decay-protection-144).

- **Episodic event log — Layer 1 passive capture (#150):** New `event-log.db` database alongside `memory.db` provides a high-fidelity, append-only session journal of all events (facts learned, decisions made, actions taken, entities mentioned, preferences expressed, corrections). Raw episodic events are cheap to write and serve as raw material for the Dream Cycle consolidation pipeline. API: `append()`, `appendBatch()`, `getBySession()`, `getByTimeRange()`, `getUnconsolidated()`, `getByEntity()`, `markConsolidated()`, `archiveConsolidated()`, `getStats()`. Config: `eventLog.archivalDays` (default: 90), `eventLog.archivePath`. See [extensions/memory-hybrid/docs/event-log.md](extensions/memory-hybrid/docs/event-log.md).

- **Local embedding switch — Ollama/ONNX providers (#153):** The embedding system now supports `provider: "ollama"` and `provider: "onnx"` in addition to `"openai"` and `"google"`. Local providers require no API key. Ollama connects to a running Ollama server (default `http://localhost:11434`); ONNX runs inference in-process via `@xenova/transformers`. Known model dimensions are auto-detected; unknown models require explicit `dimensions`. Config: `embedding.provider`, `embedding.model` / `embedding.ollamaModel` / `embedding.onnxModelPath`, `embedding.endpoint`, `embedding.autoMigrate`. See [CONFIGURATION.md](docs/CONFIGURATION.md#local-embedding-providers-153).

- **Multi-model embedding registry + RRF merge (#158):** Each fact can be embedded by multiple models simultaneously. Configure `embedding.multiModels` as an array of `{ name, provider, dimensions, role }` entries. At recall time, each model contributes a ranked list and Reciprocal Rank Fusion (RRF) merges them into a single result ranked by cross-model agreement. Supports mixing `openai`, `ollama`, and `onnx` providers. See [CONFIGURATION.md](docs/CONFIGURATION.md#multi-model-embedding-registry-158).

- **Contextual variants at index time (#159):** When enabled, a cheap LLM generates alternative phrasings of each stored fact. These variants are embedded and stored as additional LanceDB vectors linked to the parent fact, improving recall for paraphrased queries without requiring query expansion at retrieval time. Config: `contextualVariants.enabled`, `contextualVariants.model`, `contextualVariants.maxVariantsPerFact` (default: 2, max: 5), `contextualVariants.maxPerMinute` (default: 30), `contextualVariants.categories`. See [CONFIGURATION.md](docs/CONFIGURATION.md#contextual-variants-at-index-time-159).

- **Query expansion via LLM (#160):** Before embedding a retrieval query, a cheap LLM expands it into multiple variants (hypothetical answer style or paraphrase). All variants are embedded and their vector results are merged before RRF. Three modes: `"always"`, `"conditional"` (run only when initial score is below threshold), `"off"`. Includes an LRU cache to avoid redundant expansion calls. Replaces the deprecated `search.hydeEnabled` / `search.hydeModel`. Config: `queryExpansion.enabled`, `queryExpansion.mode`, `queryExpansion.threshold`, `queryExpansion.model`, `queryExpansion.maxVariants` (default: 4), `queryExpansion.cacheSize` (default: 100), `queryExpansion.timeoutMs` (default: 5000). See [CONFIGURATION.md](docs/CONFIGURATION.md#query-expansion-queryexpansion).

- **LLM re-ranking in retrieval pipeline (#161):** After RRF fusion, the top-N candidates are presented to an LLM for semantic re-ordering. On timeout or LLM failure, the original RRF order is used as a fallback. Config: `reranking.enabled`, `reranking.model`, `reranking.candidateCount` (default: 50), `reranking.outputCount` (default: 20), `reranking.timeoutMs` (default: 10000). See [CONFIGURATION.md](docs/CONFIGURATION.md#llm-re-ranking-161).

- **Verification store — integrity checking + auto-classify (#162):** Critical facts can be enrolled into a verification store that persists them to an append-only `verified-facts.json` backup and tracks them for scheduled re-verification. `autoClassify: true` (default) auto-enrolls facts tagged as `critical`. New agent tools: `memory_verify` (enroll a fact), `memory_verified_list` (list all verified facts), `memory_verification_status` (check a specific fact). Config: `verification.enabled`, `verification.backupPath`, `verification.reverificationDays` (default: 30), `verification.autoClassify` (default: true), `verification.continuousVerification`, `verification.cycleDays` (default: 30), `verification.verificationModel`. See [CONFIGURATION.md](docs/CONFIGURATION.md#verification-store-162).

- **Provenance tracing — DERIVED_FROM edges + memory_provenance tool (#163):** When enabled, the plugin records the full origin chain of every fact: which session it came from, which episodic events it was derived from, and which facts it was consolidated from. Provenance data is stored in `provenance.db` using `DERIVED_FROM` and `CONSOLIDATED_FROM` edges. New agent tool: `memory_provenance(factId)` returns the full chain up to 10 hops deep. Config: `provenance.enabled` (default: false), `provenance.retentionDays` (default: 365). See [CONFIGURATION.md](docs/CONFIGURATION.md#provenance-tracing-163).

- **Document ingestion — folder ingestion, progress callbacks, hash dedup, vision (#206):** New tools `memory_ingest_document` and `memory_ingest_folder` convert documents (PDF, DOCX, PPTX, XLSX, HTML, Markdown, CSV, EPUB, images, and more) to Markdown via the MarkItDown Python bridge, chunk the result, and store each chunk as a fact. Features: SHA-256 hash deduplication (skip duplicate documents), structured progress callbacks (`{ stage, pct, message }`), LLM vision for image files, optional path allowlist for security, configurable chunk size and overlap. Config: `documents.enabled` (default: false — opt-in), `documents.pythonPath` (default: `python3`), `documents.chunkSize` (default: 2000), `documents.chunkOverlap` (default: 200), `documents.maxDocumentSize` (default: 50 MB), `documents.autoTag` (default: true), `documents.visionEnabled` (default: false), `documents.visionModel`, `documents.allowedPaths`. Requires `pip install markitdown`. See [CONFIGURATION.md](docs/CONFIGURATION.md#document-ingestion-206).

- **Real-time frustration detection, cross-agent learning, tool effectiveness (#263, #265):** Frustration signals from user messages are detected in real time; cross-agent learning and tool effectiveness scoring improve recall and tool recommendations.

### Documentation

- **CONFIGURATION.md:** New sections for all 10 Milestone A+B features: future-date decay protection (#144), local embedding providers — Ollama/ONNX (#153), multi-model embedding registry (#158), contextual variants (#159), LLM re-ranking (#161), verification store (#162), provenance tracing (#163), and document ingestion (#206). Query expansion (#160) section was already present and has been retained.
- **FEATURES.md:** Feature table extended with entries for all 10 issues (#144-#206) with links to the relevant CONFIGURATION.md anchors.
- **CLI-REFERENCE.md:** Commands-by-category table; run-all, generate-proposals, scope list/stats/prune/promote, active-tasks; full 9 maintenance cron jobs table (nightly-memory-sweep, self-correction-analysis, nightly-memory-to-skills, nightly-dream-cycle, weekly-reflection, weekly-extract-procedures, weekly-deep-maintenance, weekly-persona-proposals, monthly-consolidation); verify --fix description updated.
- **cron-jobs.ts:** Aligned with handlers.ts: all 9 jobs with shell-command form; comment that canonical source is MAINTENANCE_CRON_JOBS in handlers.ts.

### Changed

- **Dependencies:** Minor and patch dependency bumps (minor-and-patch group, #266).

---

## [2026.3.72] - 2026-03-07

### Fixed

- **Release workflow:** "Set package version" step no longer fails when package.json already matches the tag (avoids `npm error Version not changed` on publish).

---

## [2026.3.71] - 2026-03-07

Documentation and UX: benefits-first messaging, multilingual, and analyze-feedback-phrases improvements.

### Added

- **README "Why you'll want this":** Plain-English benefits section (short- and long-term), bullets for remembers you, recalls the right stuff, learns from reactions, gets more personal, multilingual. Technical comparison table under "Why use this? (under the hood)". Documentation table links to new section.
- **Multilingual callout:** README and benefits now state that the plugin works in your language and adapts (build-languages, feedback-phrase learning).
- **analyze-feedback-phrases sentiment pre-filter:** Messages already matching reinforcement/correction regexes are skipped. Remaining messages are labeled by a nano-tier model (positive_feedback / negative_feedback / neutral); only positive/negative go to the heavy-tier phrase extractor. If none remain, heavy call is skipped. Model-agnostic (nano + heavy from config).
- **analyze-feedback-phrases 30/3-day window:** When `--days` is omitted, first run (or no `.user-feedback-phrases.json`) uses 30 days; subsequent runs use 3 days. `UserFeedbackPhrases.initialRunDone` persisted on `--learn`.

### Changed

- **QUICKSTART, FEATURES, HOW-IT-WORKS, FAQ:** Benefits-first intros and links to README "Why you'll want this".
- **CLI-REFERENCE, SELF-CORRECTION-PIPELINE:** analyze-feedback-phrases documented with nano pre-filter, auto 30/3 days, model-agnostic.

---

## [2026.3.70] - 2026-03-07

Major release: Hybrid Memory redesign, CI/CD automation with NPM Trusted Publishing, search/config improvements, and quality fixes.

### Added

- **Complete Hybrid Memory Redesign (#198):** Memory-first architecture with 18 features: dynamic memory tiering (hot/warm/cold) with configurable `memoryTiering.hotMaxTokens`, `compactionOnSessionEnd`, `inactivePreferenceDays`, and `hotMaxFacts`; multi-agent scoping with `multiAgent.orchestratorId` and `defaultStoreScope` (global/agent/auto); runtime agent detection for auto-scoped facts; retrieval and storage integrated with tiering and scope filters; preset alignment (normal/expert/full) for tiering and ingest; workflow integration hooks for session start/end and compaction.
- **Memory-first auto-recall features (#221):** Enhanced auto-recall with retrieval directives (`autoRecall.retrievalDirectives`): entity-mentioned recall, keyword triggers, task-type triggers, optional session-start recall; configurable `limit`, `maxPerPrompt`; entity lookup and directive recall merged into injection pipeline; agent-scoped memory and scope filtering in recall so specialists see only relevant scoped facts.
- **Workflow crystallization and self-extension (#208, #209, #210):** (1) **Workflow store & tool-sequence tracking:** Session tool sequences recorded and grouped into patterns with success rates. Tool `memory_workflows`: query patterns by goal (keyword-matched), filter by `minSuccessRate`, optional `limit`. (2) **Crystallization tools:** `memory_crystallize` analyses workflow patterns and generates pending AgentSkill SKILL.md proposals (human approval required); `memory_crystallize_list` / `memory_crystallize_approve` / `memory_crystallize_reject` list and approve/reject; approved proposals write skills to disk. (3) **Self-extension tools:** `memory_propose_tool` runs gap analysis on workflow traces to detect recurring workarounds and generates tool proposals; `memory_tool_proposals` / `memory_tool_approve` / `memory_tool_reject`; requires `selfExtension.enabled: true`; config supports `minFrequency`, `minToolSavings`.
- **Scope promote CLI (#134):** Subcommand `openclaw hybrid-mem scope promote` promotes high-importance session-scoped facts to global scope. Options: `--dry-run`, `--threshold-days <n>` (default 7), `--min-importance <n>` (default 0.7). Uses `findSessionFactsForPromotion` then `promoteScope(id, "global", null)`. Integrated into weekly-deep-maintenance cron (Saturday 04:00): compact then scope promote.
- **CI/CD:** CI workflow (typecheck Node 22/24, lint, test, coverage); PR checks; release workflow (tag `v*` or manual dispatch → CI, GitHub Release, then NPM publish for `openclaw-hybrid-memory` and `openclaw-hybrid-memory-install`). Version from tag; main package runs `verify:publish` before publish. **NPM Trusted Publishing:** OIDC only (no `NPM_TOKEN`); `id-token: write` per publish job; configure Trusted Publisher on npmjs.com for workflow `release.yml` for both packages; MFA can stay enabled.
- **Security & quality:** CodeQL workflow; Dependabot config; branch protection recommendations; labeler workflow for PRs (`.github/labeler.yml`).

### Changed

- **Search / query expansion (#228, #160):** Deprecated `search.hydeEnabled` and `search.hydeModel` in favor of `queryExpansion.enabled` and `queryExpansion.model`. Migration: if `search.hydeEnabled` is true and `queryExpansion.enabled` not set, queryExpansion is auto-enabled and model defaults to `search.hydeModel` or nano tier; `queryExpansion.enabled: false` overrides. Parser logs deprecation; timeout 25s when migrating from HyDE, 5s for direct queryExpansion. Preset `full` sets `queryExpansion.enabled: true` directly.
- **Error reporting:** Opt-out defaults: when `errorReporting` omitted, `enabled` and `consent` default to `true`; community mode uses hardcoded DSN. Opt out with `errorReporting.enabled: false` or `consent: false`.
- **Dependencies:** Actions setup-node/cache/checkout → v6; upload-artifact → v7; codeql-action → v4; minor-and-patch group (#173).
- **Repo quality:** ESLint + Prettier; Yarbo standards (#175); TypeScript strict mode errors resolved (#174).

### Fixed

- **Promotion:** Inconsistent `superseded_at` filter in `findSessionFactsForPromotion` corrected.
- **Verify:** `agents.defaults.pruning` correctly flagged as invalid (#105, #138).
- **Config:** `"env"` added to safe-config-write allowlist (#136).
- **CI:** Coverage provider; CodeQL matrix; label creation; pagination for label listing and listComments; workflow security/code quality; size label flapping.
- **Query expansion / HyDE:** HyDE timeout consistency; queryExpansion migration edge cases; model fallback and tests (#228).

---

## [2026.02.271] - 2026-02-27

Memory-to-skills disabled by default and boilerplate filter fix.

### Changed

- **Memory-to-skills:** Pipeline is **disabled by default**. Set `memoryToSkills.enabled: true` in config to run clustering/synthesis. Nightly job and `skills-suggest` exit cleanly when disabled.
- **Memory-to-skills boilerplate filter:** Skip clusters whose task pattern is the injected memory preamble (e.g. `<relevant-memories>` or "The following memories may be relevant") so snippet-derived clusters no longer produce misleading skills.

### Fixed

- Clusters with task text like "<relevant-memories> The following memories may be relevant: …" are now skipped instead of generating skills tied to injected context.

---

## [2026.02.270] - 2026-02-27

Feature and fix release: LanceDB dimension-mismatch graceful fallback and auto-repair (#128, #129), VectorDB reference-counted lifecycle and reconnection fixes (#106, #107), security and CodeQL fixes (#118–#127), credentials get/list CLI and config-set fix, proposal apply and workspace resolution fixes (#90), verify activeTask, npm package files (#71), and docs.

### Added

- **VectorDB dimension mismatch:** Graceful fallback when LanceDB table dimension does not match configured embedding model: search/count/hasDuplicate return empty/0/false and log a clear warning instead of crashing. Optional `vector.autoRepair: true` drops and recreates the table with the correct dimension and triggers re-embedding from SQLite (issue #128, #129).
- **Credentials CLI:** `openclaw hybrid-mem credentials get` and `credentials list --service <filter>` for vault inspection.
- **Verify:** Active-task (ACTIVE-TASKS.md) status shown in `openclaw hybrid-mem verify` output.
- **CI:** GitHub Actions labeler workflow for PRs; CodeQL suppressions where applicable.

### Fixed

- **VectorDB:** Reference-counted singleton prevents premature close when multiple sessions use the plugin (#106). Race condition in `VectorDB.open()` by deferring state cleanup to `ensureInitialized()`; clear `initPromise` in `open()` so reconnection is not blocked; try-catch in `_doClose()`; run `removeSession()` at end of `agent_end` (#107).
- **VectorDB auto-repair:** Re-embedding bugs fixed: track IDs instead of indices, check duplicates, handle delete errors; stale table handle on failed repair; incomplete re-embedding on hot reload; re-embedding loop leak on hot reload; skip auto-repair when dimension is unreadable.
- **Proposals:** ProposalsDB prune timer guard (#130). Restore `isGitRepo` guard for proposal apply to avoid applying outside a git repo (#90). Resolve proposal target files against workspace, not plugin data dir. Add `proposals show` subcommand to manage CLI.
- **Security (CodeQL/alert fixes):** Shell command built from env values (#119); password hash / scrypt handling (#120, #127); prototype-polluting deep merge (#121, #122, #118); ReDoS-safe regex in `resolveEnvVars` (js/polynomial-redos); HTML filtering regex (#125). Restore v1 KDF to scrypt to prevent data loss in existing vaults.
- **Config/CLI:** `config-set errorReporting true` now sets an object (enabled/consent) instead of a boolean. Claude provider support in cron model resolution; reset git staging on proposal commit rollback.
- **Credentials/stats:** Credential security and stats accuracy fixes.
- **Package:** Add missing `setup/`, `lifecycle/`, `tools/` to npm package files (#71).

### Changed

- **Docs:** Remove unsupported `agents.defaults.pruning` from setup and config (#105). Copilot review instructions. PR-133 merge analysis for memory-to-skills revert.
- **CI:** Labeler workflow uses `pull_request` (not `pull_request_target`); labeler action v5; fix label logic to use OR for glob patterns.
- **Version bump** — Release 2026.02.27 (npm `2026.02.270`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.02.240] - 2026-02-24

Feature and fix release: active-task working memory for multi-step tasks (#99, #104), VectorDB auto-reconnect after close (#103), credentials hardening and audit/prune/dedup CLI (#98), stats zero-hints clarification (#101), and related fixes.

### Added

- **Active-task working memory:** ACTIVE-TASKS.md doc, heartbeat stale warnings, duration parser, `staleThreshold` config, stashCommit preservation, injection budget checks, file path resolved against workspace root, original task start time in subagent_start; legacy `staleHours` rejects fractional values (closes #99, #104).
- **Credentials:** Hardened auto-capture validation; audit, prune, and dedup CLI (#98); duplicate normalized service detection; `storeIfNew` for auto-capture; lowercase URLs and empty-string fallback; list optimization; `runCredentialsList` in CLI context.

### Fixed

- **VectorDB:** Auto-reconnect after `close()` so concurrent ops no longer see "VectorDB is closed"; guard against concurrent `doInitialize()` during close (#103).
- **Stats:** Clarify zero procedures/proposals with hints when persona-proposals (or procedures) are disabled (#101).
- **Credentials:** Validation (minimum length, hostnames/URLs); dedup/validation bugs; N+1 in audit fixed via `listAll()`; P2 regression test (sk-key, assertion).
- **Cleanup:** Remove unreachable post-parse credential validation; remove dead code (`shouldSkipCredentialStore`, `CredentialsDbLike`); add `runCredentialsList` to `HybridMemCliContext`; address Copilot review threads.

### Changed

- **Docs:** Improved RRF search documentation and inline comments.
- **Version bump** — Release 2026.02.24 (npm `2026.02.240`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.02.230] - 2026-02-23

Feature and fix release: multi-provider LLM proxy (nano/default/heavy tiers), embeddings direct to OpenAI, error-reporting bot identity, config/model fallbacks, stats and distill improvements, and PR #93 review fixes (fixes #91, #92, #94, #95).

### Added

- **Multi-provider LLM proxy:** Configurable `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists and per-provider API keys. Chat/completion uses the gateway or direct provider APIs by tier; nano for cheap ops (autoClassify, HyDE, classifyBeforeWrite), default for reflection/language-keywords, heavy for distillation and persona proposals.
- **Error reporting bot identity:** Optional `errorReporting.botId` and `errorReporting.botName` for GlitchTip/Sentry tags; config-set and docs (ERROR-REPORTING.md) updated.
- **Stats:** Real queries for reflection, self-correction, language-keywords, and tier counts (no placeholder zeros).
- **Distill:** Chunking for oversized sessions (overlapping windows) instead of truncation when exceeding `--max-session-tokens`.

### Fixed

- **Embeddings:** Requests go direct to OpenAI; gateway is no longer used for `/v1/embeddings` (fixes GlitchTip #11 405 errors, #91).
- **HyDE and cron fallbacks:** HyDE uses `llm.default`; all runtime model fallbacks use `getDefaultCronModel()` — no hardcoded gpt-4o/gpt-4o-mini (#92).
- **Config:** `getDefaultCronModel()` fallbacks for all model fields; valid OpenAI model IDs when only embedding is configured (#94).
- **Error reporting:** Schema accepts `botId`/`botName`; no hostname leak when `botId` not set (#95).
- **Crashes:** Missing `pendingLLMWarnings` causing crash; gateway baseURL routing for chat OpenAI client restored.
- **Model/config:** Encryption key validation, timeout cleanup, model tier costs, HyDE fallback; UnconfiguredProviderError detection; model tier for auto-classify; OpenAI client cache key; credentials encryption validation.
- **Proposals:** Stronger proposal-generation prompt (template awareness, identity scoping, additive-first); improved error logging.
- **Deploy snippet:** Removed hardcoded models.

### Changed

- **Docs:** LLM-AND-PROVIDERS.md and related docs aligned with multi-provider proxy and three-tier architecture; ERROR-REPORTING.md for bot identity and config-set; TROUBLESHOOTING expanded.
- **Version bump** — Release 2026.02.23 (npm `2026.02.230`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.223] - 2026-02-22

Patch: align CLI-context `fallbackModels` with `cfg.llm` so gateway-routed model config is respected (fixes inconsistent model selection between CLI reflection and other code paths).

### Fixed

- **CLI-context fallbackModels:** When `cfg.llm` is set, `runReflection`, `runReflectionRules`, and `runReflectionMeta` now use no legacy fallbacks, matching `handlers.ts` and `utility-tools.ts`. Previously they always fell back to `cfg.distill?.fallbackModels`.

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.223`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.222] - 2026-02-22

Dependencies and tooling: better-sqlite3 ^12, direct Gemini REST API (drops @google/genai), `hybrid-mem version` command, cron/maintenance and Gemini fixes (fixes #72, #73, #80).

### Added

- **CLI `version` command:** `openclaw hybrid-mem version` shows installed version and latest on GitHub/npm with update hint (#80).
- **Dynamic cron and spawn from config:** Cron job definitions and spawn model configurable; docs and CLI updated.
- **Cron on install/upgrade:** Install and upgrade ensure cron jobs are present; disabled jobs honored.
- **MAINTENANCE_CRON_JOBS:** Nightly includes prune and extract-daily; weekly includes extract-directives, reinforcement, generate-auto-skills, persona-proposals; deep-maintenance simplified.

### Fixed

- **better-sqlite3:** Upgraded to ^12; README note for ^12 and prebuild-install (#72).
- **Gemini:** Removed @google/genai; direct Gemini REST API (#73). Multi-part response truncation and version display fixed.
- **Cron:** Canonical key mapping for weekly-persona-proposals job.
- **Model tier selection:** Provider-aware selection, async audit, duplicate commands, diff display.
- **PR 85:** Rollback proposal on apply fail, dedupe show, Gemini retry; Copilot/BugBot/Codex review feedback.
- **Misc:** Git commit non-fatal; JSON bracket extraction.

### Changed

- **Docs:** Gemini path per-request, retries for resilience. Comprehensive tests for new functionality.
- **Version bump** — Release 2026.02.22 revision (npm `2026.2.222`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.221] - 2026-02-22

Patch release: tool_use/tool_result sanitizer for Claude API, reflect --verbose, verify UX, LLM retry/fallback, Sentry false-positive fix (PR #78, closes #74–#77, #79).

### Added

- **Tool-use sanitizer:** `sanitizeMessagesForClaude()` and `llm_input` hook so every `tool_use` has a `tool_result` immediately after; prevents "LLM request rejected" when history is trimmed. Exported; doc TOOL-USE-TOOL-RESULT-ERROR.md.
- **Reflect CLI:** `--verbose` for `reflect`, `reflect-rules`, `reflect-meta` (#74).
- **Verify UX:** Cron job status and timing (last/next run, error preview); output grouped by section (#75, #77).
- **LLM retry/fallback:** `withLLMRetry`, `chatCompleteWithRetry` for distill/ingest, reflection, classification, consolidation, language-keywords, embeddings, summarization; optional fallback models (#76).

### Fixed

- **Sentry:** No longer report ENOENT on optional `credentials-pending.json` (#79).

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.221`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.220] - 2026-02-22

Refactor release: split monolithic `index.ts` into focused modules, plus security hardening (PR70 review), credential and CLI bug fixes, and improved error handling.

### Added

- **Security (PR70 review):** `trustToolScopeParams` config flag to prevent scope injection via tool parameters; health status tracking for init verification; credential validation and atomic migration flag; credential type in vault pointers; WAL circuit breaker; proposal validation.
- **CLI:** Error reporting and catch blocks for config, verify, install, and status paths; CLI reference and new commands documentation.
- **Refactor:** Plugin entry split into setup modules (database init, plugin service, lifecycle hooks, tool registration), dedicated `tools/` and `setup/` directories, extracted services (reflection, consolidation, find-duplicates, vector-search, credential-migration), and separate proposals CLI module.

### Fixed

- **Critical:** `currentAgentId` pass-by-value bug fixed so agent scoping is correct in lifecycle hooks.
- **Credentials:** Detection and `--days 0` parsing; BugBot credential store (split try-catch, pointer format, tests); rollback for credential DB writes on fact pointer failure; error handling and loop propagation; standardize vault pointers; duplicate scope declaration (ParseError).
- **Distill/ingest:** `distill --model` respects config; unified `.deleted` session file filter; orphaned facts bug in `runIngestFilesForCli` and `runDistillForCli`.
- **Self-correction:** Defaults and shared constants deduplication; directive store count; `--no-apply-tools` flag (Commander.js property and autoRewriteTools path).
- **CLI/lifecycle:** Weekly-reflection legacy job matcher (case-insensitive); async error handling and indentation in handlers; JSONL parse error flooding and missing schema validation; deepMerge array defaults, credential count tracking, directive deduplication; logger-after-close and String(null) check; agent detection in lifecycle hooks.
- **Consolidation/reflection:** Cosine similarity in consolidation; null handling in reflection.

### Changed

- **Version bump** — Release 2026.02.22 (npm `2026.2.220`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.201] - 2026-02-20

Bug-fix release: credentials encryption key handling and config mode reporting for verify.

### Fixed

- **Credentials:** When `credentials.enabled: true` and the user sets an `encryptionKey` that is invalid or unresolved (e.g. `env:MY_VAR` with `MY_VAR` unset, or a raw key &lt; 16 characters), the plugin now throws at config load with a clear error instead of silently falling back to memory-only (which would have stored credentials in plain SQLite). Memory-only mode is only used when credentials are enabled and no `encryptionKey` is set. Error messages direct users to set the env var or use a key of at least 16 characters and mention `openclaw hybrid-mem verify --fix`.
- **Config mode:** When a user specifies a configuration mode (e.g. `"normal"`) but overrides one or more preset values, the resolved config’s `mode` field is now set to `"custom"` so that `openclaw hybrid-mem verify` correctly shows **Mode: Custom**, matching CONFIGURATION-MODES.md.

### Changed

- **Version bump** — Release 2026.02.20 revision (npm `2026.2.201`). Version numbers updated in package.json, openclaw.plugin.json, and package-lock.

---

## [2026.2.210] - 2026-02-21

Consolidated release: verify reports all six optional cron jobs, scope/cold-tier and multi-agent fixes, error-reporting cleanup, cron job definitions, credentials/error-reporter/memory-forget fixes, config-set and open issues #53–#56.

### Added

- **Verify:** Optional/suggested jobs list now includes all six jobs: `nightly-memory-sweep`, `weekly-reflection`, `weekly-extract-procedures`, `self-correction-analysis`, `weekly-deep-maintenance`, `monthly-consolidation` (previously only four were shown).
- **Cron job definitions:** New `cli/cron-jobs.ts` module; nightly-distill cron includes `record-distill` step; cron commands add `generate-auto-skills` and drop no-op scope command (PR #66, issues #53–#56).
- **Config-set help:** Fix help parsing for `openclaw hybrid-mem config-set --help`; full preset includes ingest paths (PR #63).
- **Export CLI:** `openclaw hybrid-mem export` for vanilla OpenClaw–compatible MEMORY.md and memory/ directory layout (PR #57).
- **Error reporting schema:** Community/self-hosted mode and config-set support; `mode` passed to `initErrorReporter` (PR #58, #59).
- **Credentials:** `credentials.autoCapture` in plugin config schema; deploy snippet and vault-without-encryption option (PR #63).
- **Proposals/corrections:** List proposals, approve/reject, list corrections, approve-all from report; `listCorrections` uses `parseReportProposedSections` for both sections (issues #53–#56).
- **.gitignore:** `.claude/settings.json` added to ignore list.

### Fixed

- **Scope and cold-tier (from dev):** Scope computed early for classify-before-write so UPDATE path gets correct scope/scopeTarget; CLI search filters out cold-tier facts when tiering is enabled (`tieringEnabled` in CLI context), matching memory_recall and auto-recall.
- **Multi-agent (from feature/multi-agent-memory-scoping):** Stale cached agent ID no longer silences detection failure warnings; `buildToolScopeFilter` helper deduplicates scope filter logic; warning logs always emitted when agent detection fails; fallback uses `currentAgentId || orchestratorId` when detection fails.
- **Error reporting:** Remove duplicate `COMMUNITY_DSN` from config.ts (kept only in error-reporter.ts); breadcrumbs, Windows paths, async stop handler; credential CRUD and memory_forget error capture; rate limiter pruning and maxBreadcrumbs init; `flushErrorReporter` wired into shutdown (PR #60).
- **memory-forget:** Prefix matching UX, input validation, distinguish errors from not-found, tests; remove FTS text search for ID prefix resolution; show full UUIDs, report actual deletion failures (PR #61).
- **Credentials:** Critical plaintext vault bugs from council review fixed (PR #63).
- **Self-correction / procedures:** Verify --fix adds procedural and self-correction jobs; directive-extract 'remember' for URI+directive edge case; store rejection reason, config writes, correction parsers; TTY detection, feature gates, regex matching, macOS compatibility, scope issues (PR #57).

### Changed

- **Version bump** — Release 2026.02.21 (npm `2026.2.210`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.200] - 2026-02-20

Major feature release including procedural memory, directive extraction, reinforcement tracking, multi-agent scoping, auth-failure auto-recall, privacy-first error reporting, and credential auto-capture.

### Added

- **Directive extraction & reinforcement-as-metadata (PR #41, closes issues #39, #40):** Multi-language detection of user directives and reinforcement signals. Directive extraction detects directives in 10 categories (explicit memory requests, behavior changes, absolute rules, corrections, preferences, warnings, procedural, implicit corrections, emotional emphasis, conditional rules) with multi-language support and confidence scoring (0.5-1.0). Reinforcement-as-metadata annotates existing facts with `reinforced_count`, `last_reinforced_at`, `reinforced_quotes`. Reinforced facts rank higher in search results (configurable boost). 8 reinforcement signal categories with correlation logic. Procedure reinforcement: procedures table gets reinforcement columns with auto-promotion when procedures are reinforced ≥ threshold times (confidence boost to 0.8+). CLI: `openclaw hybrid-mem extract-directives`, `openclaw hybrid-mem extract-reinforcement`. Config: `distill.extractDirectives` (default: true), `distill.extractReinforcement` (default: true), `distill.reinforcementBoost` (default: 0.1), `distill.reinforcementProcedureBoost` (default: 0.1), `distill.reinforcementPromotionThreshold` (default: 2).

- **Code review security fixes (PR #42):** Critical security hardening from independent GPT and Gemini code reviews. Credential vault KDF replaced raw SHA-256 with scrypt (N=16384, r=8, p=1) + random salt; backward-compatible migration for existing vaults. VectorDB SQL injection hardening with tightened UUID validation and security boundary comments. God file extraction: moved CredentialsDB and ProposalsDB to dedicated backend files (~440 lines removed from index.ts). Fixed memory_recall limit default mismatch (schema said 5, code used 10). Expanded SENSITIVE_PATTERNS (AWS keys, private key headers, connection strings). Replaced non-null assertions with safe getTable() accessor in VectorDB. Hash-based embedding cache keys for memory efficiency.

- **Confidence-weighted procedural ranking (PR #44):** Multi-factor confidence-weighted ranking for procedure recommendations. New `searchProceduresRanked()` method with multi-factor scoring (confidence × recency × success_rate × penalties). Recency decay: linear decay over 30-day window with minimum 0.3 factor. Success rate boost: 50-100% weight based on successCount / (successCount + failureCount). Recent failure penalty: 0.5 multiplier for procedures that failed in last 7 days. Never-validated penalty: 30% reduction for procedures without lastValidated. Auto-recall injection now uses ranked results with relevance score filtering (>0.4 threshold). Emoji indicators: ✅ for high confidence (≥70%), ⚠️ for lower. Tool chain summaries: `tool1 → tool2 → tool3`.

- **Pre-release bug fixes (PR #45):** Four defensive improvements. Missing default for `reinforcementPromotionThreshold` (added `?? 2`). Race condition in `gatherBackfillFiles` recursive walk (wrapped in try-catch). Connection string regex improvement (exclude colon from username, require host segment). Test case for directive extraction URI+colon edge case (`mailto:user@... Remember:`).

- **Multi-agent memory scoping (PR #46, activates FR-006):** Enables specialist agents (Forge, Scholar, Hearth) to build domain expertise while maintaining shared global knowledge. Runtime agent detection: plugin detects current agent ID from `before_agent_start` event payload. New `multiAgent` config section with `orchestratorId` (default: "main") and `defaultStoreScope` (global/agent/auto). Smart auto-scoping: in `auto` mode, orchestrator stores globally, specialists store agent-scoped. Automatic scope filtering: specialists automatically filter to `global + agent-specific` memories; orchestrator sees all. Procedures scoping: added `scope` and `scope_target` columns to `procedures` table; all search methods now accept `scopeFilter`. Specialists see global knowledge + their own discoveries; orchestrator sees everything.

- **Auth-failure auto-recall (PR #48, closes issue #47):** Reactive memory trigger that auto-injects credentials when authentication failures are detected. Detection layer: SSH failures (Permission denied, Authentication failed), HTTP failures (401, 403), API failures (Invalid API key, token expired); target extraction (hostnames, IPs, URL domains, service names). Memory recall: searches both SQLite FTS5 and LanceDB vector backends; filters to technical/credential facts; respects FR-006 memory scoping (global + agent-specific); deduplication (max 1 recall per target per session, configurable). Context injection: formats credential hints for agent consumption via `prependContext` return from `before_agent_start` hook; non-intrusive (only triggers when auth failures detected). Security: no credential values logged (only target identifiers); scope-aware (respects FR-006); no auto-execution (only injects hints); `originalText` removed from errors to prevent credential leakage. Config: `autoRecall.authFailure.enabled` (default: true), `autoRecall.authFailure.patterns` (customizable regex patterns), `autoRecall.authFailure.maxRecallsPerTarget` (default: 1). Docs: [AUTH-FAILURE-AUTO-RECALL.md](../docs/AUTH-FAILURE-AUTO-RECALL.md) (348 lines) with configuration, security, troubleshooting.

- **Privacy-first error reporting (PR #49):** Optional, opt-in error reporting to GlitchTip (self-hosted Sentry alternative). Explicit consent required (default: disabled; requires both `enabled: true` and `consent: true` in config). Privacy guarantees: NO user prompts, memory text, API keys, or PII; all sensitive data scrubbed via strict allowlist-based sanitization; zero breadcrumbs, no default integrations. Optional dependency: works without @sentry/node installed. What's reported: exception type and sanitized message, sanitized stack trace (plugin paths only), plugin version and environment, operation context (subsystem, operation). What's NEVER reported: user prompts or memory text, API keys/tokens/passwords, home paths (replaced with $HOME), emails (replaced with [EMAIL]), IPs (replaced with [IP]), breadcrumbs, HTTP requests, console logs. Config: `errorReporting` section with `enabled`, `consent`, `dsn`, `environment`, `sampleRate`. Docs: [ERROR-REPORTING.md](../docs/ERROR-REPORTING.md) with setup guide, security audit checklist, FAQ.

- **Credential auto-capture from tool calls (PR #51):** Automatically stores credentials used in tool calls into encrypted vault. Detection patterns: 7 regex patterns covering `sshpass -p <pass> ssh`, `curl -H "Authorization: Bearer <token>"`, `curl -u user:pass`, connection strings (postgres://, mysql://, mongodb://, redis://, mssql://), `-H "X-API-Key: <key>"`, `export VAR_KEY/TOKEN/PASSWORD/SECRET=value`, `.env`-style `KEY=value` assignments. Extraction engine: `extractCredentialsFromToolCalls(text)` uses `matchAll()` to find all occurrences per pattern; handles multiple credentials in a single tool call; deduplicates by `(service, type)`. `agent_end` hook: scans `tool_calls[*].function.arguments` in assistant messages when `credentials.enabled && autoCapture.toolCalls`; stores via `credentialsDb.store()` (upsert) — never touches factsDB or vectorDB. Config: `credentials.autoCapture.toolCalls` (default: false, opt-in), `credentials.autoCapture.logCaptures` (default: true). Security: tool inputs only; vault-encrypted; no facts/vector DB exposure. Docs: [CREDENTIALS.md](../docs/CREDENTIALS.md) updated with "Auto-Capture from Tool Calls" section.

- **Self-correction analysis (issue #34, closes #34):** Nightly pipeline to detect user corrections in session logs and auto-remediate. Multi-language correction detection via `.language-keywords.json` (run `build-languages` first for non-English). CLI: `openclaw hybrid-mem self-correction-extract [--days N] [--output path]`, `openclaw hybrid-mem self-correction-run [--extract path] [--approve] [--no-apply-tools] [--model M]`. Phases: (1) extract incidents from session JSONL using correction signals, (2) LLM analyze (category, severity, remediation type), (3) remediate: MEMORY_STORE with semantic dedup, TOOLS.md rules under configurable section (default apply; opt-out with `applyToolsByDefault: false` or `--no-apply-tools`), AGENTS/SKILL as proposals. Optional: `autoRewriteTools: true` for LLM rewrite of TOOLS.md; `analyzeViaSpawn` for Phase 2 via `openclaw sessions spawn` (Gemini, large batches). Config: `selfCorrection.semanticDedup`, `semanticDedupThreshold`, `toolsSection`, `applyToolsByDefault`, `autoRewriteTools`, `analyzeViaSpawn`, `spawnThreshold`, `spawnModel`. Report: `memory/reports/self-correction-YYYY-MM-DD.md`. Docs: SELF-CORRECTION-PIPELINE.md, CONFIGURATION.md. Optional cron job `self-correction-analysis` in install script.

- **RRF and search improvements (issue #33, closes #33):** Reciprocal Rank Fusion (RRF): replaced naive score-based merge in `services/merge-results.ts` with RRF. BM25 (SQLite) and cosine (LanceDB) scores are on incompatible scales; RRF uses rank-based fusion `rrf_score = sum(1/(k+rank))` so items ranking well in both keyword and semantic search naturally float to the top. Default k=60. Optional `mergeResults(..., { k })`. `openclaw hybrid-mem ingest-files`: index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts via LLM extraction. Config `ingest.paths`, `ingest.chunkSize`, `ingest.overlap`. Facts stored with `category: technical`, `decayClass: stable`, tags include `ingest`. HyDE query expansion: opt-in `search.hydeEnabled: true` generates a hypothetical answer before embedding for vector search (memory_recall + auto-recall). Config `search.hydeModel` (default gpt-4o-mini). Adds latency/API cost per search.

- **Procedural memory (issue #23, closes #23):** Auto-generated skills from learned patterns. Three layers: (1) Procedure tagging: during session processing, multi-step tool-call sequences are extracted from session JSONL; successful runs are stored as positive procedures, failures as negative procedures. New `procedures` table and optional columns on `facts` (`procedure_type`, `success_count`, `last_validated`, `source_sessions`). CLI: `openclaw hybrid-mem extract-procedures [--dir path] [--days N] [--dry-run]` to scan session logs and upsert procedures. Secrets are never stored in recipes (redacted in procedure-extractor). (2) Procedure-aware recall: `memory_recall_procedures(taskDescription)` tool returns "Last time this worked" steps and "⚠️ Known issue" warnings. Auto-recall injects a `<relevant-procedures>` block when the prompt matches stored procedures (positive and negative). Config: `procedures.enabled` (default true), `procedures.sessionsDir`, `procedures.minSteps`, etc. (3) Skill generation: when a procedure is validated N times (default 3), auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`. CLI: `openclaw hybrid-mem generate-auto-skills [--dry-run]`. Skills are sandboxed under `procedures.skillsAutoPath` (default `skills/auto`). Stale procedures (past `skillTTLDays`) are available for revalidation. Config: `procedures.validationThreshold`, `procedures.skillTTLDays`, `procedures.requireApprovalForPromote`.

### Fixed

- **CLI:** Removed duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` (copy-paste had registered each command two extra times).

### Changed

- **Version bump** — Release 2026.02.20 (npm `2026.2.200`). Version numbers updated across package.json, openclaw.plugin.json, docs, and install scripts.

---

## [2026.2.181] - 2026-02-18

### Added

- **Self-correction analysis (issue #34, closes #34):** Nightly pipeline to detect user corrections in session logs and auto-remediate. Multi-language correction detection via `.language-keywords.json` (run `build-languages` first for non-English). CLI: `openclaw hybrid-mem self-correction-extract [--days N] [--output path]`, `openclaw hybrid-mem self-correction-run [--extract path] [--approve] [--no-apply-tools] [--model M]`. Phases: (1) extract incidents from session JSONL using correction signals, (2) LLM analyze (category, severity, remediation type), (3) remediate: MEMORY_STORE with semantic dedup, TOOLS.md rules under configurable section (default apply; opt-out with `applyToolsByDefault: false` or `--no-apply-tools`), AGENTS/SKILL as proposals. Optional: `autoRewriteTools: true` for LLM rewrite of TOOLS.md; `analyzeViaSpawn` for Phase 2 via `openclaw sessions spawn` (Gemini, large batches). Config: `selfCorrection.semanticDedup`, `semanticDedupThreshold`, `toolsSection`, `applyToolsByDefault`, `autoRewriteTools`, `analyzeViaSpawn`, `spawnThreshold`, `spawnModel`. Report: `memory/reports/self-correction-YYYY-MM-DD.md`. Docs: SELF-CORRECTION-PIPELINE.md, CONFIGURATION.md. Optional cron job `self-correction-analysis` in install script.

- **RRF and search improvements (issue #33, closes #33):**
  - **Reciprocal Rank Fusion (RRF)** — Replaced naive score-based merge in `services/merge-results.ts` with RRF. BM25 (SQLite) and cosine (LanceDB) scores are on incompatible scales; RRF uses rank-based fusion `rrf_score = sum(1/(k+rank))` so items ranking well in both keyword and semantic search naturally float to the top. Default k=60. Optional `mergeResults(..., { k })`.
  - **`openclaw hybrid-mem ingest-files`** — Index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts via LLM extraction. Config `ingest.paths`, `ingest.chunkSize`, `ingest.overlap`. Facts stored with `category: technical`, `decayClass: stable`, tags include `ingest`.
  - **HyDE query expansion** — Opt-in: `search.hydeEnabled: true` generates a hypothetical answer before embedding for vector search (memory_recall + auto-recall). Config `search.hydeModel` (default gpt-4o-mini). Adds latency/API cost per search.

- **Procedural memory (issue #23, closes #23):** Auto-generated skills from learned patterns. Three layers:
  - **Layer 1 — Procedure tagging:** During session processing, multi-step tool-call sequences are extracted from session JSONL; successful runs are stored as positive procedures, failures as negative procedures. New `procedures` table and optional columns on `facts` (`procedure_type`, `success_count`, `last_validated`, `source_sessions`). CLI: `openclaw hybrid-mem extract-procedures [--dir path] [--days N] [--dry-run]` to scan session logs and upsert procedures. Secrets are never stored in recipes (redacted in procedure-extractor).
  - **Layer 2 — Procedure-aware recall:** `memory_recall_procedures(taskDescription)` tool returns "Last time this worked" steps and "⚠️ Known issue" warnings. Auto-recall injects a `<relevant-procedures>` block when the prompt matches stored procedures (positive and negative). Config: `procedures.enabled` (default true), `procedures.sessionsDir`, `procedures.minSteps`, etc.
  - **Layer 3 — Skill generation:** When a procedure is validated N times (default 3), auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`. CLI: `openclaw hybrid-mem generate-auto-skills [--dry-run]`. Skills are sandboxed under `procedures.skillsAutoPath` (default `skills/auto`). Stale procedures (past `skillTTLDays`) are available for revalidation. Config: `procedures.validationThreshold`, `procedures.skillTTLDays`, `procedures.requireApprovalForPromote`.

### Fixed

- **CLI:** Removed duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` (copy-paste had registered each command two extra times).

---

## [Unreleased]

### Added

---

## [2026.2.176] - 2026-02-17

### Added

- **Gemini support for distill** — `openclaw hybrid-mem distill` can use Google Gemini (e.g. `gemini-2.0-flash`) via `--model` or config `distill.defaultModel`. Config `distill.apiKey` (raw or `env:VAR`); env fallback: `GOOGLE_API_KEY` / `GEMINI_API_KEY`. Gemini uses 500k-token batches (vs 80k for OpenAI). New `services/chat.ts` routes by model name; `distillBatchTokenLimit()` returns batch size. See CONFIGURATION.md, SESSION-DISTILLATION.md.
- **distill: chunk oversized sessions instead of truncating** — Sessions exceeding `--max-session-tokens` are now split into overlapping windows (10% overlap) rather than truncated. Each chunk is tagged as `SESSION: <file> (chunk N/M)`. Existing dedup (0.85 threshold) handles cross-chunk duplicates. New CLI flag: `--max-session-tokens <n>` (default: batch limit). See [issue #32](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/32).

### Changed

- **Documentation:** CONFIGURATION.md adds "Session distillation (Gemini)" section; SESSION-DISTILLATION documents `--model` and Gemini config; CLI-REFERENCE documents distill `--model` and batch sizes.
- **Tests:** `chat.test.ts` (isGeminiModel, distillBatchTokenLimit, chatComplete routing/errors); config.test.ts (distill parsing); `distill-chunk.test.ts`.

---

## [2026.2.175] - 2026-02-17

### Added

- **`openclaw hybrid-mem upgrade`** — One-command upgrade to latest from npm. Removes current install, fetches latest, rebuilds native deps. Restart gateway afterward. Simplifies the upgrade flow (no more fighting the bull).

### Fixed

- **Stability:** Plugin now closes LanceDB (VectorDB) on stop to avoid resource leaks; VectorDB has a `close()` method and closed guard.
- **Stability:** WAL writes are durable: fsync is performed after each write, remove, and pruneStale compact so power loss does not corrupt the log.
- **Stability:** LanceDB failures no longer crash the plugin: search/count/hasDuplicate return empty/0/false and log; store/delete log and rethrow; CLI and tool paths wrap vector calls in try/catch with logging.
- **Performance:** `refreshAccessedFacts` now uses bulk UPDATE with `WHERE id IN (...)` in batches of 500 instead of N+1 per-id updates.
- **Performance:** `find-duplicates` uses LanceDB vector search (indexed) instead of an O(n²) pairwise loop.
- **Performance:** Superseded-facts cache TTL increased from 60s to 5 minutes to reduce full table scans.

### Changed

- **Reopen guard:** At start of `register()`, any existing DB instances (factsDb, vectorDb, credentialsDb, proposalsDb) are closed and cleared before creating new ones, avoiding duplicate or leaked instances if the host calls `register()` again before `stop()` (e.g. SIGUSR1 or rapid reload).
- **Module split:** Tag/dedupe → `utils/tags.ts`; dates → `utils/dates.ts`; decay → `utils/decay.ts`. **FactsDB** → `backends/facts-db.ts` (SQLite+FTS5, all migrations, store/search/lookup/links/checkpoint/decay; exports `MEMORY_LINK_TYPES`, `MemoryLinkType`). Index imports FactsDB and link types from backends/facts-db.
- **WAL:** Append-only NDJSON format: write/remove append one line and fsync; pruneStale compacts by rewriting only valid entries. Legacy single-JSON-array files are still read correctly.
- **Utils:** Added `truncateText`, `truncateForStorage` for consistent truncation; store truncation uses `truncateForStorage`. Added `safeEmbed(embeddings, text, logWarn)` for centralized embedding error handling (used in find-duplicates).
- **Code quality:** Named constants for reflection/credential limits; empty catch blocks in vector delete paths now log with `api.logger.warn`.
- **Prompts:** Reflection, consolidation, category-discovery, and category-classify prompts moved to `prompts/*.txt`; index uses `loadPrompt`/`fillPrompt` for all (memory-classify was already external).
- **Dead imports:** Removed unused imports from index: `WALEntry`, `TTL_DEFAULTS`, `IDENTITY_FILE_TYPES`, `TAG_PATTERNS`.
- **CLI extraction (first batch):** `cli/register.ts` registers hybrid-mem subcommands stats, prune, checkpoint, backfill-decay via `registerHybridMemCli(mem, context)`. Index passes `{ factsDb, vectorDb, versionInfo }`; remaining commands stay in index for now.
- **Performance (redundant embeddings):** `Embeddings` now uses an in-memory LRU cache (max 500 entries) so repeated embedding of the same text returns the cached vector instead of calling the API again.
- **CLI (second batch):** search and lookup moved to `cli/register.ts`; context extended with embeddings, mergeResults, parseSourceDate.
- **CLI (third batch):** categories and find-duplicates moved to `cli/register.ts`; context extended with getMemoryCategories, runFindDuplicates.
- **CLI (fourth batch):** consolidate, reflect, reflect-rules, reflect-meta moved to `cli/register.ts`; context extended with runConsolidate, runReflection, runReflectionRules, runReflectionMeta, reflectionConfig.
- **CLI (fifth batch):** classify moved to `cli/register.ts`; added `runClassifyForCli` in index, context extended with runClassify, autoClassifyConfig.
- **CLI (sixth batch):** store moved to `cli/register.ts`; added `runStoreForCli` in index, `StoreCliOpts`/`StoreCliResult` and runStore in context.
- **CLI (seventh batch):** install moved to `cli/register.ts`; added `runInstallForCli` in index, `InstallCliResult` and runInstall in context.
- **CLI (eighth batch):** verify moved to `cli/register.ts`; added `runVerifyForCli` with VerifyCliSink, runVerify in context.
- **CLI (ninth batch):** distill-window and record-distill moved to `cli/register.ts`; added `runDistillWindowForCli`, `runRecordDistillForCli`, DistillWindowResult, RecordDistillResult, runDistillWindow, runRecordDistill in context.
- **CLI (final batch):** extract-daily, credentials (migrate-to-vault), uninstall moved to `cli/register.ts`. All CLI commands now registered via `registerHybridMemCli`. No CLI command blocks remain in index.ts.
- **Blocking I/O:** Hot-path sync I/O (agent_end, before_agent_start, auditProposal, discoverCategoriesFromOther) converted to async `fs/promises` (mkdir, readFile, writeFile, unlink, access).
- **Naming consistency:** Renamed `openaiClient` → `openai` (module-level), `db` → `factsDb` in classify/discovery functions.
- **Magic numbers:** 15+ named constants extracted to `utils/constants.ts` (importance levels, temperatures, thresholds, max chars, timeouts, SECONDS_PER_DAY).
- **WAL helpers:** `walWrite` and `walRemove` helpers eliminate 8–12 lines of boilerplate per call site (5 sites: memory_store UPDATE/ADD, auto-capture UPDATE/ADD, WAL recovery).
- **Documentation split:** `hybrid-memory-manager-v3.md` (927 lines) split into 8 focused docs: QUICKSTART, ARCHITECTURE, CONFIGURATION, FEATURES, CLI-REFERENCE, TROUBLESHOOTING, MAINTENANCE, MEMORY-PROTOCOL. Original moved to `docs/archive/`.

### Added

- **Graph-based spreading activation (FR-007):** Typed relationships between facts enable zero-LLM recall via graph traversal. The `memory_links` table stores five link types (`SUPERSEDES`, `CAUSED_BY`, `PART_OF`, `RELATED_TO`, `DEPENDS_ON`) with configurable strength (0.0-1.0). New tools: `memory_link` (create typed links), `memory_graph` (explore connections). Enhanced `memory_recall` automatically traverses graph when `graph.useInRecall` is enabled (default true). Optional auto-linking in `memory_store` creates `RELATED_TO` links to similar facts when `graph.autoLink` is enabled. Configuration: `graph.enabled`, `graph.autoLink`, `graph.autoLinkMinScore` (default 0.7), `graph.autoLinkLimit` (default 3), `graph.maxTraversalDepth` (default 2), `graph.useInRecall` (default true). See [docs/GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md) for architecture, usage, best practices, and competitive analysis (Zep/Graphiti, Mem0, MAGMA).
- **Write-Ahead Log (WAL) for crash resilience (FR-003):** Memory operations are now written to a durable WAL file before being committed to SQLite/LanceDB. If the agent crashes, times out, or is killed during generation, uncommitted operations are automatically recovered on startup. WAL is enabled by default. Configuration: `wal.enabled` (default true), `wal.walPath` (default `~/.openclaw/memory/memory.wal`), `wal.maxAge` (default 5 minutes). See [docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md) for architecture, recovery process, and troubleshooting.
- **Reflection Layer (FR-011)**: Analyze facts to extract behavioral patterns and meta-insights. New `pattern` and `rule` categories for storing synthesized patterns. CLI command `openclaw hybrid-mem reflect [--window N] [--dry-run] [--model MODEL]` and agent tool `memory_reflect` for on-demand pattern synthesis. Patterns are stored with high importance (0.9) and permanent decay class. Semantic deduplication at 85% similarity threshold. Config: `reflection.enabled`, `reflection.model` (default gpt-4o-mini), `reflection.defaultWindow` (default 14 days), `reflection.minObservations` (default 2). See [docs/REFLECTION.md](docs/REFLECTION.md) for full documentation. Inspired by Claude-Diary and Generative Agents paper.
- **Memory Operation Classification (FR-008)**: LLM-based pre-write classification of memory operations as `ADD`, `UPDATE`, `DELETE`, or `NOOP`. When enabled, the system analyzes new facts against existing memories to determine if they should be added as new facts, update/supersede existing facts, mark facts as deleted, or be skipped as duplicates. This prevents contradictory duplicates and maintains an audit trail of how facts evolve. **Similar-fact retrieval now uses embedding similarity** (top-N by vector search, then resolved via SQLite) as in Mem0-style pipelines; entity+key/FTS fallback is used when vector search returns no candidates. LanceDB stores the SQLite fact id when provided so classification can target the correct fact. New database fields `superseded_at` and `superseded_by` track supersession relationships. Deleted facts are soft-deleted (superseded with NULL) and excluded from recall. Config: `store.classifyBeforeWrite` (default false, opt-in), `store.classifyModel` (default gpt-4o-mini). Classification results are exposed in tool responses and nightly jobs. See [issue #8](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/8).
- **Progressive Disclosure for auto-recall (FR-009)**: Auto-recall can now inject a lightweight memory index instead of full memory texts, allowing the agent to decide what to fetch. When `autoRecall.injectionFormat` is set to `progressive`, the system injects a compact list showing available memories with their categories, titles, and token costs. The agent can then use `memory_recall` to fetch specific memories on demand. This reduces prompt bloat, prevents over-disclosure of marginal information, and gives agents more control over context usage. Access tracking (recall count and last accessed timestamp) is updated for all injected memories to support salience-based ranking.
- **Bi-temporal fact tracking (FR-010)**: Contradiction resolution and point-in-time queries. New columns: `valid_from`, `valid_until`, `supersedes_id`. When a fact is superseded (UPDATE/DELETE classification or manual `supersedes`), the old fact gets `valid_until = now` and the new fact gets `valid_from` and `supersedes_id`. Default recall returns only current facts (`superseded_at IS NULL`). Optional: `memory_recall(..., includeSuperseded: true)` or `asOf: "YYYY-MM-DD"` for point-in-time ("what did we know as of date X?"). `memory_store` accepts optional `supersedes` (fact id to replace). CLI: `hybrid-mem search "query" --as-of 2026-01-20`, `--include-superseded`. Session distillation (extract-daily) uses session/file date as `valid_from`. See [issue #10](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/10).

---

## [2026.2.172] - 2026-02-17

### Added

- **Category discovery (LLM-suggested):** When `autoClassify.suggestCategories` is true (default), the auto-classify job first asks the LLM to group "other" facts by free-form topic labels (e.g. food, travel). Any label that appears on at least `minFactsForNewCategory` facts (default 10) is created as a new category and those facts are reclassified. The threshold is not shown to the LLM. New categories are persisted to `~/.openclaw/memory/.discovered-categories.json` and loaded on next startup. Config: `autoClassify.suggestCategories` (default true), `autoClassify.minFactsForNewCategory` (default 10). See v3 guide §4.8 Stage 3 and §4.8.4.
- **Nightly job in deploy snippet and verify --fix:** The deploy snippet (`deploy/openclaw.memory-snippet.json`) now includes the `nightly-memory-sweep` job so users who merge only the snippet get session distillation by default. `openclaw hybrid-mem verify --fix` adds the nightly job to `openclaw.json` when it is missing, so upgrade or snippet-only users get it without running the full install.

### Changed

- **Session distillation docs:** SESSION-DISTILLATION.md "What the job should do" and the suggested nightly job message now state that extracted credentials are routed the same way as in real time (to the secure vault plus pointer when vault is enabled, or to memory when it is not).
- **Verify --fix:** Now applies the nightly-memory-sweep job when missing (same definition as install), in addition to embedding block and memory directory.

---

## [2026.2.17.1] - 2026-02-17

### Fixed

- **Credentials (vault enabled):** When the vault is enabled, credential-like content that could not be parsed as a structured credential was still being written to memory (facts). It is now skipped: `memory_store` returns a message and does not store; extract-daily and CLI `hybrid-mem store` skip the line; CLI store exits with code 1 and an error message. Ensures no raw credential-like text is stored in facts when vault is on.

---

## [2026.2.17.0] - 2026-02-17

### Added

- **Credential migration when vault is enabled**: When the credential vault is enabled, existing credentials that were stored in memory (facts with entity `Credentials`) are automatically moved into the vault and redacted from SQLite and LanceDB. Migration runs once on first plugin load (flag file `.credential-redaction-migrated`). New pointer facts are written so the agent still knows credentials exist and can use `credential_get`. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) § Migration.
- **CLI `credentials migrate-to-vault`**: `openclaw hybrid-mem credentials migrate-to-vault` runs the same migration on demand (idempotent; skips facts that are already pointers). Use after enabling the vault if you had credential facts stored in memory before.

### Changed

- **Model-agnostic analysis**: [docs/MODEL-AGNOSTIC-ANALYSIS.md](docs/MODEL-AGNOSTIC-ANALYSIS.md) documents the Option B exploration result (OpenClaw plugin SDK does not expose chat/embed APIs; Option B not available). Decision: keep hardcoded models (OpenAI embeddings/chat, Gemini in docs for distillation) for now; analysis and options retained for future reference.
- **CREDENTIALS.md**: New section “Migration: existing credentials into vault” describing automatic and manual migration when vault is enabled.

---

## [2026.2.16] - 2026-02-16

### Added

- **Session distillation pipeline (Phase 1)**: Batch fact-extraction pipeline for retrospective analysis of historical OpenClaw conversation transcripts. Located in `scripts/distill-sessions/` with components: `batch-sessions.sh` (organize sessions into batches), `extract-text.sh` (convert JSONL to readable text), `store-facts.sh` (generate memory_store commands), `gemini-prompt.md` (LLM extraction template), `run-stats.md` (metrics tracking). Two-phase approach: bulk historical distillation (one-time; typical yield ~20–30 net new facts per full sweep, cost on the order of a few dollars) + nightly incremental sweep (automated, 2–5 new facts per run). All facts tagged with original session date `[YYYY-MM-DD]` for temporal provenance. Recovers knowledge missed by live auto-capture. Documentation: [docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md), example run report: [docs/run-reports/example-distillation-report.md](docs/run-reports/example-distillation-report.md). Concept inspired by virtual-context's "memory archaeology" approach.
- **Nightly memory sweep**: Automated session distillation job (e.g. cron at 02:00 local time) processing last 3 days of sessions using isolated session + Gemini model. Expected yield: 2–5 new facts per run. Logs to `scripts/distill-sessions/nightly-logs/`. Setup via OpenClaw jobs config with `isolated: true` and `model: gemini`. Complements real-time auto-capture.
- **Auto-recall token cap (1.1)**: Configurable limit on how many tokens are injected when auto-recall runs. New config: `autoRecall` can be an object with `enabled`, `maxTokens` (default 800), and `maxPerMemoryChars` (default 0). When `maxTokens` is set, memories are added in score order until the cap is reached; when `maxPerMemoryChars` > 0, each memory text is truncated with "…". Legacy `autoRecall: true` remains valid and uses defaults. See v3 guide and README "What this repo adds" for options.
- **Honor captureMaxChars (1.3)**: `captureMaxChars` is now in config and schema (default 5000). Auto-capture filter (`shouldCapture`) rejects messages longer than `captureMaxChars`. When storing (tool or auto-capture), text longer than the cap is truncated and stored with " [truncated]". Plugin schema and UI hints updated.
- **Shorter injection format (1.2)**: Auto-recall injection format is configurable via `autoRecall.injectionFormat`: `full` (default, `[backend/category] text`), `short` (`category: text`), or `minimal` (text only). Saves tokens when set to short or minimal. Tool responses and logs still show backend/category.
- **Configurable recall limit and minScore (2.1)**: `autoRecall.limit` (default 5) sets the max number of memories considered for injection; `autoRecall.minScore` (default 0.3) sets the vector search minimum score (0–1). Replaces hardcoded values in the before_agent_start handler.
- **Decay-class–aware auto-recall (3.1)**: When `autoRecall.preferLongTerm` is true, scores are boosted for `permanent` (×1.2) and `stable` (×1.1) before re-sorting, so lasting facts are preferred when relevance is close. Default false.
- **Importance and recency in composite score (3.3)**: When `autoRecall.useImportanceRecency` is true, relevance score is combined with importance (0.7 + 0.3×importance) and recency (lastConfirmedAt over 90 days). More important or recently confirmed facts can rank higher. Lance results (lastConfirmedAt 0) get neutral recency. Default false.
- **Entity-centric recall (4.1)**: When `autoRecall.entityLookup.enabled` is true and `entities` is set (e.g. `["user", "owner"]`), if the prompt mentions an entity (case-insensitive), `factsDb.lookup(entity)` results are merged into auto-recall candidates (up to `maxFactsPerEntity` per entity, default 2). Deeper, entity-specific context without changing main search.
- **Chunked long facts / summary (4.3)**: Facts longer than `summaryThreshold` (default 300 chars) get a short summary stored (first `summaryMaxChars` chars + "…", default 80). At auto-recall, when `useSummaryInInjection` is true (default), the summary is injected instead of full text to save tokens; full text remains in DB and in `memory_recall`. New `summary` column in SQLite (migration added).
- **Consolidation job (2.4)**: `openclaw hybrid-mem consolidate [--threshold 0.92] [--include-structured] [--dry-run] [--limit 300] [--model gpt-4o-mini]` finds clusters of semantically similar facts (re-embed from SQLite, pairwise similarity), merges each cluster with a cheap LLM into one concise fact, stores the merged fact in SQLite + LanceDB, and deletes the cluster from SQLite. By default skips identifier-like facts (IP, email, phone, etc.); use `--include-structured` to include them. Dry-run reports clusters without writing.
- **Summarize when over budget (1.4)**: When `autoRecall.summarizeWhenOverBudget` is true and the token cap forces dropping memories, the plugin calls a cheap LLM (`autoRecall.summarizeModel`, default gpt-4o-mini) to summarize all candidate memories into 2–3 short sentences and injects that single block instead. On LLM failure it falls back to the truncated bullet list.
- **Find-duplicates CLI (2.2)**: `openclaw hybrid-mem find-duplicates [--threshold 0.92] [--include-structured] [--limit 300]` reports pairs of facts with embedding similarity ≥ threshold. Uses SQLite as source, re-embeds, pairwise comparison; by default skips identifier-like facts (IP, email, phone, UUID, etc.); `--include-structured` to include them. Report-only; no merge or store changes.
- **Fuzzy text deduplication in SQLite (2.3)**: When `store.fuzzyDedupe` is true, facts are normalized (trim, collapse whitespace, lowercase), hashed (SHA-256), and stored in `normalized_hash`. Before insert, exact match is checked; then duplicate is detected by normalized hash — store is skipped and existing fact is returned. Migration adds column and backfills. Default false.
- **Verify and uninstall CLI**: `openclaw hybrid-mem verify [--fix] [--log-file <path>]` checks config (embedding API key/model), SQLite, LanceDB, and embedding API; reports background jobs (prune 60min, auto-classify 24h); with `--fix` prints missing config suggestions and a minimal snippet; with `--log-file` scans for memory-hybrid/cron errors. Use with `openclaw doctor` when the host supports it. `openclaw hybrid-mem uninstall` **automatically restores the default memory manager** by updating `openclaw.json` (sets `plugins.slots.memory` to `memory-core` and disables memory-hybrid); `--leave-config` skips config change; `--clean-all` or `--force-cleanup` removes SQLite and LanceDB data (irreversible).

### Changed (2026.2.16)

- **First-install experience**: `openclaw hybrid-mem install` applies full defaults (config, compaction prompts, nightly-memory-sweep job); `verify --fix` applies safe fixes (embedding block, jobs, memory dir). Standalone `scripts/install-hybrid-config.mjs` for config before first gateway start. Credentials auto-enable when a valid encryption key is set. Clear error messages and load-blocking vs other issues in verify. Uninstall reverts to default memory without breaking OpenClaw.
- **Verify**: Optional/suggested jobs (nightly-memory-sweep defined/enabled), credentials vault check, session-distillation last run, record-distill CLI. Prerequisite checks at plugin init (embedding API, credentials vault).
- **npm install path**: Package name set to `openclaw-hybrid-memory` for `openclaw plugins install openclaw-hybrid-memory` (maintainer publish steps in internal docs).

---

## [2026.2.15] - 2026-02-15

### Added

- **Hybrid memory system**: Combines structured + vector memory (SQLite + FTS5 + LanceDB) from [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) with hierarchical file memory (MEMORY.md index + `memory/` drill-down) from [ucsandman’s OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System).
- **memory-hybrid plugin** (`extensions/memory-hybrid/`): Two-tier storage (SQLite+FTS5 for facts, LanceDB for semantic search), auto-capture, auto-recall, decay tiers with TTL, checkpoints, optional LLM auto-classification and custom categories.
- **Tools**: `memory_store`, `memory_recall`, `memory_forget`, `memory_checkpoint`, `memory_prune`.
- **CLI** (`openclaw hybrid-mem`): `stats`, `prune`, `checkpoint`, `backfill-decay`, `extract-daily`, `search`, `lookup`, `classify`, `categories`.
- **Full deployment reference**: See [docs/QUICKSTART.md](docs/QUICKSTART.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and other focused docs under `docs/`.
- **Autonomous setup**: [docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md) for AI-driven install, config, backfill, and verification.
- **Deploy snippet**: [deploy/openclaw.memory-snippet.json](deploy/openclaw.memory-snippet.json) (memory-hybrid + memorySearch, compaction, bootstrap limits) and [deploy/README.md](deploy/README.md).
- **Backfill script**: [scripts/backfill-memory.mjs](scripts/backfill-memory.mjs) — dynamic section handling, no hardcoded dates; safe on new systems.
- **Upgrade helpers**: [scripts/post-upgrade.sh](scripts/post-upgrade.sh), [scripts/upgrade.sh](scripts/upgrade.sh), [scripts/README.md](scripts/README.md) for post–OpenClaw-upgrade LanceDB reinstall and one-command upgrade flow.
- **Version metadata**: [extensions/memory-hybrid/versionInfo.ts](extensions/memory-hybrid/versionInfo.ts) — `pluginVersion` (from package.json), `memoryManagerVersion` (3.0), `schemaVersion`; exposed on plugin, in `openclaw.plugin.json`, and in `openclaw hybrid-mem stats` and gateway logs. Doc §3.3 describes versioning and upgrades.
- **CHANGELOG**: This file.

### Changed

- **Pre-compaction memory flush**: Customized `memoryFlush` prompts so the flush turn instructs the model to save to **both** `memory_store` (structured) and `memory/YYYY-MM-DD.md` (file-based), preserving hybrid memory across compaction.
- **Context window docs**: Removed hardcoded `contextTokens: 180000` from v3 guide and SETUP-AUTONOMOUS; OpenClaw auto-detects model context from the provider catalog. `contextTokens` is documented as an optional override only when users hit prompt-overflow (e.g. set to ~90% of model window).
- **v3 §4.4**: Clarified that `contextWindow` in the compaction flush formula comes from the **model catalog**, not from config.
- **v3 §12 (Troubleshooting)**: Updated “prompt too large for model” row to describe `contextTokens` as an optional override with examples (200k vs 1M models).

### Fixed

- **registerCli**: Corrected casing to match the actual OpenClaw API.
- **Stale closure and build**: Resolved closure bug and compile errors; repo hygiene (`.gitignore`, LICENSE, README, package.json).
- **Timestamp units**: SQLite and LanceDB now use **seconds** consistently for `created_at` and decay-related columns; added migration for DBs that previously stored milliseconds.
- **SQLite concurrency**: `busy_timeout` and WAL checkpointing for safer concurrent access.
- **Categories**: Documented default and custom categories in config and v3 guide.

### Credits

- **Clawdboss.ai** — [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): plugin design (SQLite+FTS5+LanceDB, decay, checkpoints).
- **ucsandman** — [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): hierarchical file layout (MEMORY.md + `memory/`), token discipline, directory structure.

---

[Unreleased]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.273...HEAD
[2026.4.273]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.272...v2026.4.273
[2026.4.272]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.271...v2026.4.272
[2026.4.271]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.270...v2026.4.271
[2026.4.270]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.260...v2026.4.270
[2026.4.260]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.141...v2026.4.260
[2026.4.141]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.140...v2026.4.141
[2026.4.140]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.61...v2026.4.140
[2026.4.61]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.60...v2026.4.61
[2026.4.60]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.52...v2026.4.60
[2026.4.52]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.51...v2026.4.52
[2026.4.51]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.40...v2026.4.51
[2026.4.40]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.38...v2026.4.40
[2026.4.38]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.36...v2026.4.38
[2026.4.33]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.32...v2026.4.33
[2026.4.32]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.31...v2026.4.32
[2026.4.31]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.30...v2026.4.31
[2026.4.30]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.21...v2026.4.30
[2026.4.21]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.20...v2026.4.21
[2026.4.20]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.12...v2026.4.20
[2026.4.12]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.11...v2026.4.12
[2026.4.11]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.4.10...v2026.4.11
[2026.4.10]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.310...v2026.4.10
[2026.3.310]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.301...v2026.3.310
[2026.3.301]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.300...v2026.3.301
[2026.3.300]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.293...v2026.3.300
[2026.3.250]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.181...v2026.3.250
[2026.3.181]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.181
[2026.3.180]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.180
[2026.3.152]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.152
[2026.3.151]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.151
[2026.3.150]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.150
[2026.3.140]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.140
[2026.3.110]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.110
[2026.3.100]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.100
[2026.3.92]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.92
[2026.3.91]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.91
[2026.3.90]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.90
[2026.02.271]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.271
[2026.02.270]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.270
[2026.02.240]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.240
[2026.02.230]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.230
[2026.2.223]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.223
[2026.2.222]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.222
[2026.2.221]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.221
[2026.2.220]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.220
[2026.2.210]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.210
[2026.2.201]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.201
[2026.2.200]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.200
[2026.2.181]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.181
[2026.2.172]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.172
[2026.2.17.1]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.1
[2026.2.17.0]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.0
[2026.2.16]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.16
[2026.2.15]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.15
