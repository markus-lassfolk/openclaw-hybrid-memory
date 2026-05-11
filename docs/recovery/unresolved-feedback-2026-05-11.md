# Recovery checklist: unresolved feedback from recent merged PRs

Inventory item count: **77** unresolved review threads.

Generated from GitHub review threads during the 2026-05-11 red-CI/unresolved-feedback recovery incident.

## Merge gate

This PR must not merge until all three gates are satisfied:

- [ ] All substantive latest-head CI checks are green.
- [ ] No unresolved review feedback/items remain.
- [ ] No merge conflicts remain.

Admin merge is only a mechanical last resort after those gates are already satisfied; never to bypass red CI, feedback, or conflicts.

## Status labels

Each inventory item must end as exactly one of:

- `FIXED` — changed in this PR with file/commit evidence.
- `ALREADY FIXED` — already fixed on current main with file/line evidence.
- `OBSOLETE` — no longer applicable with evidence.

`TODO` is allowed only while this PR is draft. Applicable items must not be deferred before merge.

# Unresolved review feedback inventory — incident window

Repo: markus-lassfolk/openclaw-hybrid-memory
Scope: merged/closed PRs updated/closed/merged since 2026-05-10T20:00Z plus #1308.
Generated from GitHub reviewThreads; only unresolved threads listed.

## PR #1308: fix: resolve 15 critical bugs in stewardship and active-tasks subsystems
- State: CLOSED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308
- Unresolved threads: 5 / 5

### 1308.1 — extensions/memory-hybrid/services/task-ledger-facts.ts:657

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A7yo6`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215593998
- Feedback: `Promise.race([checkPromise, timeoutPromise])` creates a `setTimeout` that is never cleared when `checkSessionPresent()` resolves quickly. Those pending timers can keep the Node.js event loop alive for up to 5s per sessionRef, which is an operational regression during shutdown/CLI runs. Consider using a `const t = setTimeout(...)` and `clearTimeout(t)` in a `finally`, or `AbortSignal.timeout()`/`timers/promises.setTimeout` with cancellation so the timer is cleaned up once the check completes.

### 1308.2 — extensions/memory-hybrid/services/task-ledger-facts.ts:803

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A7yo-`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594004
- Feedback: The null-byte escaping in `taskEntityKey()` is not injective: an input containing the literal sequence `\\x00` becomes indistinguishable from an input that contained an actual `\^@` (both end up with `\\x00` in the serialized key). That means collisions (and incorrect supersede/lookup behavior) are still possible. Use an encoding that guarantees round-tripping (e.g., length-prefix each part, base64/URL-encode each part, or escape `\\` first and then escape `\^@`).

### 1308.3 — extensions/memory-hybrid/services/active-task-checkpoint.ts:411

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A7ypC`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594009
- Feedback: In `safeJson()`, the fallback `String(value)` can itself throw if `value` is an object with a throwing `toString`/`Symbol.toPrimitive`. That would cause `safeJson` to unexpectedly throw in the very scenario it is meant to harden. Wrap the preview generation in its own try/catch (and fall back to something like `Object.prototype.toString.call(value)` or a constant string) so `safeJson` is guaranteed not to throw.

### 1308.4 — extensions/memory-hybrid/services/active-task.ts:1067

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A7ypG`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594013
- Feedback: `writeActiveTaskFileOptimistic` now throws after exhausting retries, but there is no test covering the new failure mode (previously it performed a last-write-wins fallback). Add a test that forces repeated mtime changes until `maxRetries` is exceeded and asserts the function throws with a helpful message, so this concurrency behavior doesn’t regress silently.

### 1308.5 — extensions/memory-hybrid/services/goal-stewardship-heartbeat.ts:56

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A7ypN`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594020
- Feedback: The comment says "Use immutable cache with Map for thread safety", but the cache isn’t immutable (the Map is mutated, and callers receive the cached array by reference). This is misleading documentation; consider rewording to describe the actual behavior (memoization keyed by pattern list) and/or freezing/cloning the returned array if immutability is intended.

## PR #1311: fix: cross-scope classification mutations and vector cleanup in memory pipelines
- State: MERGED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1311
- Unresolved threads: 1 / 8

### 1311.1 — extensions/memory-hybrid/services/vector-search.ts:27

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A71pB`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1311#discussion_r3215609558
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Keep embedding similarity unscoped when no scope is provided** Defaulting `scope` to `"global"` here silently changes the behavior of existing `FindSimilarByEmbeddingFn` callers that still use the old 4/5-argument form (the new `options` arg is optional in `api/memory-plugin-api.ts`), so those callers now stop seeing `user`/`agent`/`session` memories without any type error. In multi-scope deployments this regresses dedupe/classification quality for non-global flows unless every caller is updated to pass explicit scope options. Useful? React with 👍 / 👎.

## PR #1317: Add productization surfaces: doctor flow, session observability CLI, quality reporting, telemetry/sync tooling, and contributor/demo docs
- State: MERGED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317
- Unresolved threads: 5 / 5

### 1317.1 — extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2697

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9o1E`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216245142
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Bind the export handler before invoking sync-export** `sync-export` calls `runExport(...)`, but `runExport` is never pulled from `ManageBindings` in this module scope, so this path fails immediately (TypeScript reports `TS2304: Cannot find name 'runExport'`, and runtime would throw `ReferenceError`). As written, users cannot generate any sync bundle at all. Useful? React with 👍 / 👎.

### 1317.2 — extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2698

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9o1F`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216245144
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Encrypt actual export content instead of export directory path** Even after wiring `runExport`, this code reads `exportResult.outputPath` as a UTF-8 file, but the export API returns an output directory root (the same contract used by `hybrid-mem export --output <dir>`). Reading that path with `readFileSync(..., "utf-8")` will hit `EISDIR`, so `sync-export` still fails before encryption for valid inputs. Useful? React with 👍 / 👎.

### 1317.3 — extensions/memory-hybrid/cli/verify.ts:225

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pXu`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248411
- Feedback: `doctor` currently runs `runInstall({ dryRun: dryRunInstall })` with `dryRunInstall` defaulting to false when neither `--fix` nor `--dry-run` are provided, which means `doctor` will write/apply install defaults by default. That’s surprising given the `--fix` option text (“Apply recommended install defaults…”) and can cause unintended config changes. Consider making the default behavior non-mutating (run install in dry-run/check mode unless `--fix` is set), or rename/reword the option(s) to clearly communicate that install defaults are applied on every run unless `--dry-run` is used.

### 1317.4 — extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2796

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pYI`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248456
- Feedback: `sync-import` uses `envelope.iterations` directly in `pbkdf2Sync` and decodes `salt`/`iv`/`tag`/`ciphertext` without validating types or lengths. A malformed or hostile bundle could set an extremely large iterations value (DoS) or invalid base64/lengths (crash/unclear errors). Add strict runtime validation (schemaVersion/type/kdf, iterations finite and within a sane min/max, iv length 12 bytes, tag length 16 bytes, salt length expected) and fail with a clear error message before attempting PBKDF2/decryption.

### 1317.5 — extensions/memory-hybrid/cli/benchmark.ts:144

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pYa`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248479
- Feedback: `buildBenchmarkQualityReport` clamps negative latency values to 0 via `Math.max(0, r.latency.p50)` etc. If *all* benchmark features fail (latency pXX = -1, samples=0), the summary averages will misleadingly report 0ms latency instead of indicating “n/a”/failure. Consider computing summary latency only over successful rows and emitting `null` (or a sentinel + explicit flag) when there are no successful measurements, and update markdown rendering accordingly.

## PR #1318: Implement 10 strategic enhancements for ecosystem growth and enterprise adoption
- State: MERGED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318
- Unresolved threads: 35 / 35

### 1318.1 — extensions/memory-hybrid/routes/dashboard-server.ts:2032

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pAs`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246289
- Feedback: **<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)</sub></sub> Make dashboard request handler async before using await** This branch introduces `await` expressions inside the `createServer((req, res) => { ... })` callback, which is not marked `async`, so the package no longer builds (`tsdown` reports parse errors at these lines). As written, any CI or local build that includes this file will fail before runtime, blocking release of the plugin. Useful? React with 👍 / 👎.

### 1318.2 — extensions/memory-hybrid/routes/graphql-resolvers.ts:9

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pAt`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246290
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Replace unresolved search-hybrid import with existing module** The resolver imports `../services/search-hybrid.js`, but that module is not present in the repository, so module resolution will fail when this file is bundled or loaded. This breaks GraphQL query handling (`search`/`semanticSearch`) once parsing reaches this file. Useful? React with 👍 / 👎.

### 1318.3 — extensions/memory-hybrid/routes/graphql-resolvers.ts:264

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pAu`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246293
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Implement schema-declared mutations in resolver map** The `Mutation` resolver map only defines fact CRUD/import/prune handlers, while the schema in this same commit declares additional non-null mutations (`createLink`, `deleteLink`, `consolidateFacts`, `recomputeEmbeddings`). Calling those operations will hit GraphQL's default resolver and return `null` for non-null fields, producing runtime errors instead of usable API responses. Useful? React with 👍 / 👎.

### 1318.4 — extensions/memory-hybrid/api/plugin-system.ts:357

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9pAw`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246298
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Preserve other plugins' hooks when unloading one plugin** Unloading a single plugin currently clears every listener list in `eventListeners`, so hooks from unrelated still-loaded plugins stop firing after any unload. This causes cross-plugin behavior loss in long-running processes where plugins are dynamically reloaded. Useful? React with 👍 / 👎.

### 1318.5 — extensions/memory-hybrid/api/plugin-system.ts:9

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r5S`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216263977
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that module exports `MemoryPluginAPI` (and does not define/export `MemoryPluginContext`). This will fail TypeScript builds; either import the correct type (e.g. `MemoryPluginAPI`) or define/export the intended context type from a dedicated module and update all imports accordingly.

### 1318.6 — extensions/memory-hybrid/api/plugin-system.ts:358

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r5e`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216263990
- Feedback: `unregisterHooks()` currently clears *all* event listeners for *all* events, so unloading one plugin will disable event delivery for every other loaded plugin. Track listeners per plugin (e.g., store listener fns in a Map keyed by pluginId) and only remove the listeners belonging to the plugin being unloaded.

### 1318.7 — extensions/memory-hybrid/api/plugin-system.ts:144

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r5p`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264002
- Feedback: This runtime module uses `console.*` for logging (`PluginManager`'s context logger). The repo’s logger guidance explicitly requires using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (see `utils/logger.ts`). Using `console.*` here will likely violate linting and bypass verbosity/log routing; please switch these to `pluginLogger` (or inject the host logger).

### 1318.8 — extensions/memory-hybrid/services/plugin-loader.ts:10

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r5v`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264008
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that type isn’t exported there. This will not compile; use the correct exported type (e.g. `MemoryPluginAPI`) or introduce an explicit context type/module for the plugin loader and update imports accordingly.

### 1318.9 — extensions/memory-hybrid/services/plugin-loader.ts:74

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r5z`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264013
- Feedback: `import(pluginPath)` is called with a filesystem path built via `join(...)`. In Node ESM, dynamic import is most reliable with a `file://` URL (via `pathToFileURL(pluginPath).href`), and passing arbitrary paths can fail across platforms. Convert the path to a file URL before importing.

### 1318.10 — extensions/memory-hybrid/routes/graphql-resolvers.ts:14

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r55`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264023
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that module does not export it. This will break compilation; switch to the correct exported type or define/export the intended GraphQL context type from the right module.

### 1318.11 — extensions/memory-hybrid/routes/graphql-resolvers.ts:47

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r58`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264026
- Feedback: These resolvers call `factsDb.getFactById()` / `getAllFacts()` / `deleteFact()`, but the actual FactsDB API is `getById()` / query helpers / `delete()` (and `store()` expects `StoreFactInput` without `id`/`createdAt`). As written, this GraphQL layer won’t compile or work against the existing backend; update resolvers to use the real FactsDB methods and data shapes (e.g. `factsDb.getById(id)`, `factsDb.searchFacts(...)`/`listForDashboard(...)`, and `factsDb.store({ text, category, ... })` letting the DB assign ids/timestamps).

### 1318.12 — extensions/memory-hybrid/routes/graphql-resolvers.ts:431

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6C`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264033
- Feedback: `supersedes` / `supersededByFact` appear swapped: `supersedes` returns the fact referenced by `parent.supersededBy`, which is the fact that supersedes the parent (i.e. "superseded by"), while `supersededByFact` searches for a fact whose `supersededBy === parent.id`, which is the fact that the parent supersedes. Swap these resolver implementations (or rename fields) to match their semantics.

### 1318.13 — extensions/memory-hybrid/routes/graphql-schema.ts:235

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6I`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264041
- Feedback: The schema declares non-null root fields (`episode`, `episodes`, `link`, many `Mutation`s like `createLink`, `deleteLink`, `consolidateFacts`, `recomputeEmbeddings`) that do not have resolvers implemented in `graphql-resolvers.ts`. Querying any of these will resolve to `null/undefined` and can trigger runtime GraphQL errors (especially for `...!` fields). Either implement the missing resolvers or remove/mark nullable the fields until supported.

### 1318.14 — extensions/memory-hybrid/routes/graphql-server.ts:193

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6L`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264047
- Feedback: CORS is configured with `origin: "*"` while `credentials: true`. Browsers will reject `Access-Control-Allow-Origin: *` when credentials are allowed, and it’s also unsafe for authenticated endpoints. Restrict `origin` to a concrete allow-list (or echo validated origins) and only enable credentials when needed.

### 1318.15 — extensions/memory-hybrid/routes/graphql-server.ts:202

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6O`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264052
- Feedback: This runtime route module logs via `console.*` in the Yoga `logging` hooks. The repo’s logger guidance requires using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (`utils/logger.ts`). Switch these to `pluginLogger.{debug,info,warn,error}` so verbosity/log routing behaves consistently and lint rules pass.

### 1318.16 — extensions/memory-hybrid/routes/dashboard-server.ts:2065

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6U`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264062
- Feedback: The `/graphql` handler reads the request body with an unbounded string concatenation loop. This bypasses the existing `readJsonBody(..., MAX_DASHBOARD_JSON_BODY_BYTES)` protections used elsewhere and allows a large body to consume memory (DoS risk). Reuse `readJsonBody` with the existing size limit (or stream with backpressure) and return `413` on oversize payloads.

### 1318.17 — extensions/memory-hybrid/routes/dashboard-server.ts:2047

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6a`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264068
- Feedback: `createGraphQLServer(...)` is instantiated on every `/graphql` request. Creating Yoga (schema + plugins + PubSub) per request is unnecessary overhead and can become a scalability bottleneck. Create the Yoga server once when the dashboard server starts (and reuse the same instance) instead of rebuilding it on each request.

### 1318.18 — extensions/memory-hybrid/routes/dashboard-server.ts:2047

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6f`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264075
- Feedback: This block uses `as any` to coerce the object passed as `pluginContext`. In strict TypeScript this hides mismatches (and `MemoryPluginContext` isn’t actually defined/exported in the referenced module). Define a correct context type (or use an existing exported API type) and build an object that actually satisfies it so GraphQL resolvers can safely rely on typed fields without `any` casts.

### 1318.19 — extensions/memory-hybrid/routes/dashboard-server.ts:2066

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r6o`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264085
- Feedback: `createDashboardServer` has an existing test suite, but the newly added `/graph` and `/graphql` routes aren’t covered. Add tests that (1) GET `/graph` returns HTML and (2) POST `/graphql` returns a valid GraphQL response (and enforces the same body-size limits/error handling as other endpoints).

### 1318.20 — extensions/memory-hybrid/services/memory-compression.ts:75

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r60`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264098
- Feedback: This service uses `console.log(...)` in a runtime module. The repo logger guidelines require using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (`utils/logger.ts`). Replace these with `pluginLogger.*` to avoid lint failures and to respect verbosity/log routing.

### 1318.21 — extensions/memory-hybrid/services/memory-compression.ts:88

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r68`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264107
- Feedback: `FactsDB` does not expose `getAllFacts()` (or `getFactById()`), and `FactsDB.store()` expects a `StoreFactInput` shape without `id`/`createdAt` (those are assigned by the DB). As written, this service won’t compile/work with the existing backend; refactor to use supported FactsDB query APIs (e.g. `searchFacts`/`listForDashboard`/`getFactsForConsolidation`) and store summaries via `factsDb.store({ text, category, ... })` without pre-assigning ids/timestamps.

### 1318.22 — extensions/memory-hybrid/services/memory-compression.ts:243

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r7F`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264119
- Feedback: This uses placeholder/random embeddings (`generateRandomEmbedding`) instead of reading real vectors from `VectorDB`. That makes clustering non-deterministic and effectively meaningless, and it will produce different clusters on every run. Either wire this to the actual embedding storage/search APIs (preferred) or remove the vector-based path and only expose the category/time-window fallback until embeddings are implemented.

### 1318.23 — extensions/memory-hybrid/services/benchmark-suite.ts:61

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r7R`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264131
- Feedback: This runtime module uses `console.log(...)` for progress output. Per `utils/logger.ts`, non-CLI runtime code should use `pluginLogger` rather than `console.*` so logs respect verbosity and lint rules. Replace these with `pluginLogger.info/debug` (or accept an injected logger).

### 1318.24 — extensions/memory-hybrid/services/benchmark-suite.ts:130

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r7X`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264137
- Feedback: `FactsDB` does not provide `getAllFacts()` / `getFactById()`. The benchmark implementation currently depends on those methods (and uses placeholder `setTimeout` calls for vector/hybrid search), so it won’t compile or measure real system performance. Update it to use the actual FactsDB APIs (e.g. `searchFacts`, `lookupFacts`, `getById`, etc.) and real vector/hybrid search entrypoints so the benchmark reflects real behavior.

### 1318.25 — extensions/memory-hybrid/services/collaboration.ts:7

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r7l`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264154
- Feedback: This service imports/uses `better-sqlite3`, but the codebase has migrated to `node:sqlite` (and tests explicitly assert postinstall does not reference `better-sqlite3`). `better-sqlite3` is not a dependency of this package, so this will fail to build/run. Use `node:sqlite`’s `DatabaseSync` (consistent with the rest of the repo) or add a separate optional package with clear build steps.

### 1318.26 — extensions/memory-hybrid/services/collaboration.ts:6

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r7v`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264166
- Feedback: `FactsDB` is imported but never used in this file. With typical TS/biome settings this will fail lint/typecheck; remove the unused import or use it as intended.

### 1318.27 — extensions/memory-hybrid/cli/plugin-commands.ts:43

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r77`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264180
- Feedback: `listPlugins` uses `import(manifestPath, { assert: { type: "json" } })` with a filesystem path. Node’s import-attributes support uses `with: { type: "json" }` (and dynamic import of absolute paths is brittle), so this is likely to throw at runtime. Prefer reading `package.json` via `fs.readFile` + `JSON.parse`, or convert `manifestPath` to a `file://` URL and use the correct import-attributes syntax.

### 1318.28 — extensions/memory-hybrid/cli/plugin-commands.ts:81

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8G`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264193
- Feedback: `installPlugin(..., { npm: true })` runs `npm install ... --prefix <pluginsDir>`, which installs into `<pluginsDir>/node_modules/<pkg>`. However, `PluginLoader` scans `<pluginsDir>/*/index.js`, so npm-installed plugins will not be discoverable/enableable with the current directory layout. Align the installer and loader (e.g., install into a per-plugin directory or have the loader scan `node_modules`), otherwise `plugin install --npm` will appear to succeed but nothing will load.

### 1318.29 — extensions/memory-hybrid/cli/plugin-commands.ts:79

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8T`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264206
- Feedback: `installPlugin` dynamically imports `execa`, but `execa` is not listed in `extensions/memory-hybrid/package.json` dependencies/devDependencies. This will fail at runtime in a clean install. Either add `execa` as a dependency or replace it with `node:child_process` (`spawn`/`execFile`) to avoid the extra dep.

### 1318.30 — sdk/openclaw-memory-js/package.json:53

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8X`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264213
- Feedback: `graphql-request` is declared as a dependency but the SDK implementation uses `fetch` directly and never imports/uses `graphql-request`. Either remove the unused dependency to keep the package lean, or refactor the SDK to use `graphql-request` consistently.

### 1318.31 — sdk/openclaw-memory-js/src/index.ts:137

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8c`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264221
- Feedback: `restPath` is stored on the client (`private restPath` and constructor assignment) but never used by any method. With common TS settings (`noUnusedLocals`/`noUnusedParameters`) this can fail builds and it’s confusing API surface. Either implement REST-based methods that use `restPath` or remove it until needed.

### 1318.32 — sdk/openclaw-memory-js/README.md:91

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8g`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264226
- Feedback: The `getFacts` example includes `minImportance`, but `MemoryClient.getFacts()` options (and the underlying GraphQL `facts` query) do not support `minImportance`. This makes the README example incorrect/misleading; remove `minImportance` from the example or add support for it end-to-end.

### 1318.33 — docs/tutorials/HYBRID-MEMORY-101.md:320

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8k`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264234
- Feedback: This tutorial uses `client.getFacts({ ..., minImportance: 0.7 })`, but the SDK’s `getFacts` method does not accept `minImportance` (and the GraphQL `facts` query doesn’t define it). Update the tutorial to match the actual API, or add `minImportance` support across GraphQL schema/resolvers + SDK.

### 1318.34 — docs/IMPLEMENTATION-SUMMARY.md:529

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8r`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264244
- Feedback: This doc claims the GraphQL layer is "fully implemented and operational" (and elsewhere calls it "complete"), but the code currently contains multiple TODOs/placeholders (e.g. random embeddings in compression, benchmark stubs) and the GraphQL schema includes many fields without resolvers. Please adjust the claims to reflect current implementation status, or complete the missing pieces before describing them as operational.

### 1318.35 — docs/PLUGIN-DEVELOPMENT.md:46

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9r8w`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264251
- Feedback: The link `See the [Plugin Development Guide](../docs/PLUGIN-DEVELOPMENT.md)` points to `docs/docs/PLUGIN-DEVELOPMENT.md` from within `docs/PLUGIN-DEVELOPMENT.md`, which is incorrect/broken. Link to `./PLUGIN-DEVELOPMENT.md` (self) or to the intended separate guide file.

## PR #1320: feat: add user-friendly CLI commands and comprehensive quick-start guide
- State: MERGED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320
- Unresolved threads: 25 / 25

### 1320.1 — extensions/memory-hybrid/cli/cmd-setup.ts:127

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9qM_`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216253962
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Persist setup selections to plugin configuration** The setup wizard reports that it is "applying configuration", but this block only prints key/value pairs and never calls any config writer or `config-set` handler; the inline note explicitly says real persistence is missing. In practice, `openclaw hybrid-mem setup --interactive` can end with a success message while leaving provider/model/API key unchanged, so users still fail later commands expecting the new setup to be active. Useful? React with 👍 / 👎.

### 1320.2 — extensions/memory-hybrid/cli/cmd-setup.ts:43

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9qND`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216253967
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Make --interactive actually optional** With Commander, defining `.option("--interactive", ..., true)` makes `interactive` true even when the flag is omitted and does not provide `--no-interactive`, so the non-interactive branch below is unreachable. This means setup always prompts on stdin, which breaks scripted/CI usage and contradicts the presence of explicit non-interactive logic in the command. Useful? React with 👍 / 👎.

### 1320.3 — extensions/memory-hybrid/utils/provider-detection.ts:41

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9qzh`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257864
- Feedback: `checkOnnxAvailable()` uses `require.resolve(...)` inside an ES module. At runtime `require` is not defined (unless created via `createRequire`), so this will throw and incorrectly report ONNX as unavailable. Use `createRequire(import.meta.url).resolve(...)`, or make this check async and `await import("onnxruntime-node")` in a try/catch to detect availability.

### 1320.4 — extensions/memory-hybrid/utils/provider-detection.ts:7

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9qzy`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257887
- Feedback: `execSync` and `existsSync` are imported but never used in this module. Please remove them to avoid dead code and keep the provider detection logic focused.

### 1320.5 — extensions/memory-hybrid/utils/provider-detection.ts:15

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9qz8`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257903
- Feedback: The embedding config supports provider `"google"` (see EmbeddingConfig), but provider detection/status only handles openai/ollama/onnx. If a user is configured for google, `providers/doctor/health` will misreport it as “not configured/unavailable”. Consider adding google to `ProviderStatus.provider` and implementing a `checkGoogleConfigured(...)` similar to OpenAI (or at least treat it as configured when an API key is present).

### 1320.6 — extensions/memory-hybrid/utils/progress-indicators.ts:86

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0J`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257918
- Feedback: `ProgressBar.update()` in non-TTY mode logs whenever `percent % 10 === 0`, which can print the same percentage many times if `update()` is called frequently. The codebase already uses milestone logging with a `lastPct` guard (e.g. 25/50/75/100) to avoid log spam. Track the last logged percentage (and consider milestone steps + a `total <= 0` guard) to prevent duplicate logs and division-by-zero when `total` is 0.

### 1320.7 — extensions/memory-hybrid/utils/error-codes.ts:153

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0U`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257935
- Feedback: `wrapCommonError()` treats timeouts as provider-unavailable (HM_E003) because it matches `lowerMsg.includes("timeout")`, but the catalog defines HM_E008 specifically for operation timeouts. This will surface the wrong title/solution for genuine timeouts. Prefer mapping timeout-ish messages to HM_E008 (and keep HM_E003 for connection/refused/notfound cases).

### 1320.8 — extensions/memory-hybrid/utils/error-codes.ts:35

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0g`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257948
- Feedback: Several `docsLink` URLs point at README anchors that don’t exist (e.g. `#embedding-providers`). This makes the “More info” link in `UserFriendlyError.format()` misleading. Please update these links to stable docs that exist in this repo (e.g. `docs/LLM-AND-PROVIDERS.md`, `docs/TROUBLESHOOTING.md`, etc.).

### 1320.9 — extensions/memory-hybrid/docs/QUICK-START.md:253

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0p`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257962
- Feedback: These “Learn More” references point to `docs/CLI-REFERENCE.md`, `docs/CONFIGURATION.md`, and `docs/ARCHITECTURE.md` relative to `extensions/memory-hybrid/docs/`, but those files don’t exist in this folder (they live under the repo root `docs/`). Use correct relative links (e.g. `../../docs/CLI-REFERENCE.md`) or absolute repo links so GitHub navigation works.

### 1320.10 — extensions/memory-hybrid/docs/QUICK-START.md:53

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0r`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257966
- Feedback: ONNX setup here suggests `npm install onnxruntime-node` without the `--prefix ~/.openclaw/extensions ...` guidance used elsewhere in the repo. As documented in `extensions/memory-hybrid/README.md`, installing into the OpenClaw extensions folder is important so the dependency survives `openclaw hybrid-mem upgrade`. Please align these instructions with the README’s recommended installation method.

### 1320.11 — extensions/memory-hybrid/cli/register.ts:463

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0v`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257973
- Feedback: `registerUserFriendlyCommands(mem as any, ...)` is needed because the user-friendly command modules are typed against Commander `Command`, while the rest of the CLI uses the local `Chainable` abstraction. To avoid `any` and keep type safety consistent, update `cmd-user-friendly.ts` (and the new command modules) to accept `Chainable` from `cli/shared.ts` (only using the subset of Commander APIs the CLI supports).

### 1320.12 — extensions/memory-hybrid/cli/register.ts:470

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q0y`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257978
- Feedback: New CLI surface area is being registered here, but there are no accompanying tests verifying that these commands are registered and don’t hang the CLI (the repo already has CLI registration tests like `active-task.test.ts`). Add tests that assert `setup/demo/providers/health/doctor/examples` are present on the command tree and that help-only registration still avoids DB/bootstrap side effects.

### 1320.13 — extensions/memory-hybrid/cli/cmd-user-friendly.ts:35

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q04`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257988
- Feedback: This module types `mem` as Commander `Command`, but `registerHybridMemCli` passes a `Chainable` (and currently must cast with `as any`). To match the rest of the CLI modules, consider switching these registrations to accept `Chainable` from `cli/shared.ts`. This removes the need for unsafe casts and ensures the command modules stay compatible with the CLI’s abstraction layer.

### 1320.14 — extensions/memory-hybrid/cli/cmd-setup.ts:15

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1A`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257998
- Feedback: Several Node imports here (`readFileSync`, `writeFileSync`, `homedir`, `join`) are unused in the current implementation. Please remove them to avoid dead code and reduce confusion about whether the wizard persists anything to disk.

### 1320.15 — extensions/memory-hybrid/cli/cmd-setup.ts:128

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1K`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258011
- Feedback: The wizard claims to be “Applying configuration”, but it never actually writes anything (it only logs key/value pairs and even notes “In real implementation…”). This is a functional gap vs the command description/PR description. Please wire this to the existing config machinery (e.g. call the `config-set` handler / `runConfigSet`, or persist updates via the config service) so `setup --interactive` genuinely updates the plugin config.

### 1320.16 — extensions/memory-hybrid/cli/cmd-setup.ts:100

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1R`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258018
- Feedback: The OpenAI API key prompt uses `readline.question`, which echoes the secret as the user types. For a setup wizard, this is risky in shared terminals/screen recordings. Use a masked/hidden input method for secrets (or instruct users to set `embedding.apiKey` via `config-set`/env vars instead of typing it interactively).

### 1320.17 — extensions/memory-hybrid/cli/cmd-setup.ts:87

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1g`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258040
- Feedback: `configUpdates` is declared as `Record<string, any>`, losing type safety for config keys/values. Since this code is user-facing config, it’s worth keeping types tight. Prefer `Record<string, string>` (all values are printed as strings here) or a typed map of known keys to avoid accidentally emitting non-serializable values.

### 1320.18 — extensions/memory-hybrid/cli/cmd-providers.ts:24

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1p`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258053
- Feedback: This command runs an async `.action(...)` without using the repo’s `withExit(...)` helper. Many existing CLI modules rely on `withExit` for consistent error capture and to ensure the process exits/tears down cleanly. Consider wrapping the action with `withExit` (from `cli/shared.ts`) and letting errors throw so teardown/error reporting stays consistent.

### 1320.19 — extensions/memory-hybrid/cli/cmd-health.ts:116

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1r`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258066
- Feedback: `health` recomputes `factsDb.countFacts()` and calls `vectorDb.getAllIds()` multiple times. `getAllIds()` can be expensive on large vector stores; doing it twice per invocation is unnecessary. Fetch `factCount`/`vectorCount` once and reuse for Memory Size + Sync checks (or add a cheaper `countVectors()` API if available).

### 1320.20 — extensions/memory-hybrid/cli/cmd-examples.ts:149

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q1y`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258076
- Feedback: Using `category in EXAMPLE_CATEGORIES` checks the prototype chain too. Inputs like `examples toString` will pass the check and then `EXAMPLE_CATEGORIES["toString"]` is not a valid category object, which can crash or print nonsense. Use an own-property check (e.g. `Object.hasOwn(...)` / `hasOwnProperty.call(...)`) before indexing.

### 1320.21 — extensions/memory-hybrid/cli/cmd-doctor.ts:5

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q13`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258084
- Feedback: `statSync` is imported but never used in this file. Please remove it to avoid dead code.

### 1320.22 — extensions/memory-hybrid/cli/cmd-doctor.ts:31

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q18`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258093
- Feedback: The command defines a `--fix` option, but `opts.fix` is never used. This makes the CLI misleading (users expect some remediation behavior). Either implement `--fix` (e.g. run the suggested fix commands / call existing verify/reconcile flows) or remove the option until it’s supported.

### 1320.23 — extensions/memory-hybrid/cli/cmd-doctor.ts:148

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q2A`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258098
- Feedback: This “Disk Space” check uses `require("node:path")` / `require("node:os")` inside an ES module. At runtime `require` will be undefined, causing the diagnostics command to crash. Use top-level ESM imports (`import { homedir } from "node:os"; import { join } from "node:path";`) or `createRequire(import.meta.url)` if you truly need `require`.

### 1320.24 — extensions/memory-hybrid/cli/cmd-doctor.ts:161

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q2H`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258110
- Feedback: The check is labeled “Disk Space”, but it only verifies that the memory directory exists/access is possible. This doesn’t actually validate free space, which the PR description mentions. Either rename the check to reflect what it does (directory accessibility) or implement a real free-space check (e.g. via `statvfs`-style approach or a platform-appropriate utility) and warn/fail below a threshold.

### 1320.25 — extensions/memory-hybrid/cli/cmd-demo.ts:37

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A9q2M`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258120
- Feedback: `EmbeddingProvider` doesn’t have a `provider` property (it exposes `activeProvider`, `modelName`, etc.). This line will fail TypeScript checking and/or always print the wrong value. Use `embeddings.activeProvider` (or `cfg.embedding.provider` if you want configured provider) when displaying provider status.

## PR #1323: Harden Active Tasks + Goal Stewardship state handling, signal trust, and heartbeat safety
- State: MERGED
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323
- Unresolved threads: 6 / 6

### 1323.1 — extensions/memory-hybrid/services/goal-registry.ts:180

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-HhK`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216414656
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Prevent corrupt goal file from aborting all goal processing** Throwing on any non-ENOENT read error here makes higher-level scans fail hard because `listGoals()` calls `readGoal()` without a per-file guard, and `runGoalHealthCheck()` calls `listGoals()` before entering its per-goal `try/catch`. As a result, a single malformed `*.json` goal file can stop the entire watchdog pass (no other goals get checked), which regresses the new per-goal failure isolation behavior. Useful? React with 👍 / 👎.

### 1323.2 — extensions/memory-hybrid/services/active-task.ts:480

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-HhN`
- Outdated: False
- Author: chatgpt-codex-connector
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216414659
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Preserve file permissions during atomic ACTIVE-TASKS writes** Replacing the file via temp-write + `rename()` changes the inode, so existing mode/ownership/ACL on `ACTIVE-TASKS.md` are not preserved and are replaced by defaults from the temp file creation umask. If operators intentionally set restrictive permissions (for task content confidentiality), a normal write can silently broaden access after this change. Useful? React with 👍 / 👎.

### 1323.3 — extensions/memory-hybrid/services/goal-registry.ts:181

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-Hux`
- Outdated: True
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415837
- Feedback: `readGoal` now throws on corrupt/unreadable JSON (good), but `listGoals` calls `readGoal` without a per-file try/catch. A single corrupt goal file will now cause `listGoals()` (and callers like `runGoalHealthCheck` and `stage-active-task` injection) to throw and abort processing entirely, which undermines the intended “per-goal isolation”. Consider catching errors inside `listGoals` (skip/record corrupt files) or adding a separate safe listing API used by watchdog/injection paths.

### 1323.4 — extensions/memory-hybrid/services/goal-health.ts:249

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-HvA`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415854
- Feedback: `isBlockedVerificationHost` returns `true` immediately for any `::ffff:` IPv4-mapped IPv6 address, so the subsequent `mappedIpv4` extraction and private-range check is unreachable. Either remove the dead code or move the private-range parsing before the unconditional return (depending on the intended policy).

### 1323.5 — extensions/memory-hybrid/services/goal-health.ts:240

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-HvG`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415861
- Feedback: The `http_ok` host blocking only checks IP literals (`isIP(hostname)`), and returns `false` for any DNS hostname (other than `.local`/`.localhost`). That still allows SSRF to private/loopback/link-local networks via hostnames that resolve to private IPs (including DNS rebinding). If the goal is to block private/local targets, consider resolving the hostname (e.g., `dns.lookup`/`dns.resolve`) and rejecting any private/local results before calling `fetch`.

### 1323.6 — extensions/memory-hybrid/services/goal-active-task-mirror.ts:83

- [ ] Status: TODO
- Evidence: _pending_
- Thread id: `PRRT_kwDORQuyQM6A-HvO`
- Outdated: False
- Author: copilot-pull-request-reviewer
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415870
- Feedback: `refreshActiveTaskMirrorWithGoals` writes `ACTIVE-TASKS.md` via a direct `writeFile`, which can still leave partial-file corruption if interrupted (the PR aims to make ACTIVE-TASKS.md writes atomic). Consider using the same temp-file+rename atomic write pattern as `writeActiveTaskFile`, or delegating the final write to that helper so all writers share the same safety guarantees.


Total unresolved threads in scope: 77
