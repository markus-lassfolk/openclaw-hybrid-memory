# PR #1332 unresolved feedback remediation

Source PR: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332
Merged: 2026-05-11T13:06:22Z via `5067cd82a943ca48326f2235efb1ed358cbcc89c`
Unresolved threads at extraction: 10

This remediation PR must implement every item below. Do not mark complete until each item has code/test evidence.

## 1. `extensions/memory-hybrid/routes/graphql-server.ts` line 43 — **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Restore subscription argument filtering**

- Thread: `PRRT_kwDORQuyQM6BF08k`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143939
- Author: `chatgpt-codex-connector` at 2026-05-11T13:11:24Z
- Outdated: `False`
- Status: FIXED — `routes/graphql-server.ts` reintroduces subscription predicates; regression: `tests/pr1332-remediation.test.ts` validates fact/link filters.

```text
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Restore subscription argument filtering**

The subscription resolvers now ignore all query arguments and subscribe every client to every event (`category`, `scope`, `factId`, etc. are no longer applied). This regresses behavior promised by the schema and can leak unrelated updates to subscribers that requested a narrower stream, especially in multi-tenant or multi-session usage. Re-introduce per-event predicate filtering in `subscribe` so payloads are scoped to the caller’s arguments.

Useful? React with 👍 / 👎.
```

## 2. `extensions/memory-hybrid/cli/cmd-setup.ts` line 43 — **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Avoid resolving hidden prompts to empty string**

- Thread: `PRRT_kwDORQuyQM6BF08o`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143943
- Author: `chatgpt-codex-connector` at 2026-05-11T13:11:24Z
- Outdated: `False`
- Status: FIXED — `promptHidden` now resolves once through `finish()`; regression validates typed answer wins over close fallback.

```text
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Avoid resolving hidden prompts to empty string**

`promptHidden` registers an `rl.on("close")` handler that resolves `""`, but the question callback calls `rl.close()` before resolving the typed answer. That means normal interactive entry can resolve to the empty string first, so OpenAI/Google API keys are silently dropped during `setup --interactive`. Resolve only once from the question callback (and keep close handling for abort paths) to avoid losing user input.

Useful? React with 👍 / 👎.
```

## 3. `extensions/memory-hybrid/cli/cmd-doctor.ts` line 140 — **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Respect configured memory path in doctor disk check**

- Thread: `PRRT_kwDORQuyQM6BF08r`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143947
- Author: `chatgpt-codex-connector` at 2026-05-11T13:11:24Z
- Outdated: `False`
- Status: FIXED — doctor disk check uses `dirname(cfg.sqlitePath)` when configured; regression validates custom path is reported.

```text
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Respect configured memory path in doctor disk check**

The disk-space check now hardcodes `~/.openclaw/plugins/memory-hybrid` and no longer considers `cfg.paths?.memory`. Installations using a custom memory directory will be reported as missing/unhealthy even when storage is valid, which creates false warnings and misleading remediation advice. Use the configured path first and fall back to the default only when unset.

Useful? React with 👍 / 👎.
```

## 4. `extensions/memory-hybrid/routes/graphql-resolvers.ts` line 348 — **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Fail supersede mutation when old fact is missing**

- Thread: `PRRT_kwDORQuyQM6BF08t`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143950
- Author: `chatgpt-codex-connector` at 2026-05-11T13:11:24Z
- Outdated: `False`
- Status: FIXED — `supersedeFact` validates old/new facts and throws when `factsDb.supersede()` returns false; regression covers missing/already-superseded old fact.

```text
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Fail supersede mutation when old fact is missing**

This resolver validates only `newFactId` and ignores the boolean result of `factsDb.supersede(...)`. If `oldFactId` does not exist (or was already superseded), the mutation still returns success with the new fact, so clients get a false positive despite no lineage change. Check that the old fact exists or that `supersede` returns `true`, and throw when the operation did not apply.

Useful? React with 👍 / 👎.
```

## 5. `extensions/memory-hybrid/utils/provider-detection.ts` line 62 — **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Stop treating OpenAI key as Google provider config**

- Thread: `PRRT_kwDORQuyQM6BF08x`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143956
- Author: `chatgpt-codex-connector` at 2026-05-11T13:11:24Z
- Outdated: `False`
- Status: FIXED — Google provider readiness now depends only on `googleApiKey`; regression validates OpenAI key does not mark Google available.

```text
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Stop treating OpenAI key as Google provider config**

Google availability is computed with `googleApiKey ?? currentApiKey`, so any configured OpenAI key marks Google as available even when no Google key exists. This produces incorrect provider status/recommendations and can direct users into a non-working Google setup path. Google readiness should depend only on the Google key input.

Useful? React with 👍 / 👎.
```

## 6. `extensions/memory-hybrid/utils/progress-indicators.ts` line 47 — ProgressSpinner.success()/fail() no longer emit any completion output (they only stop the spinner and compute unused elapsed variables). This makes setup/doctor flows lose their success/failure feedback, and in non-TTY mode there is now no output at all. Restore a minimal console log (or provide a logger callback) so callers get a completion line even when not in TTY.

- Thread: `PRRT_kwDORQuyQM6BF2Ho`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150271
- Author: `copilot-pull-request-reviewer` at 2026-05-11T13:12:24Z
- Outdated: `False`
- Status: FIXED — `ProgressSpinner.success/fail` emit completion lines via stdout; regression covers non-TTY output.

```text
ProgressSpinner.success()/fail() no longer emit any completion output (they only stop the spinner and compute unused elapsed variables). This makes setup/doctor flows lose their success/failure feedback, and in non-TTY mode there is now no output at all. Restore a minimal console log (or provide a logger callback) so callers get a completion line even when not in TTY.
```

## 7. `extensions/memory-hybrid/utils/progress-indicators.ts` line 132 — statusMessage() has become a no-op (it builds an icons map but never prints), which breaks cmd-demo's final success line and any other CLI status messaging that relies on it. Re-introduce the console output (or route through the project logger) so callers see the intended feedback.

- Thread: `PRRT_kwDORQuyQM6BF2IW`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150327
- Author: `copilot-pull-request-reviewer` at 2026-05-11T13:12:25Z
- Outdated: `False`
- Status: FIXED — `statusMessage` emits icon + message; regression covers CLI status output.

```text
statusMessage() has become a no-op (it builds an icons map but never prints), which breaks cmd-demo's final success line and any other CLI status messaging that relies on it. Re-introduce the console output (or route through the project logger) so callers see the intended feedback.
```

## 8. `extensions/memory-hybrid/services/collaboration.ts` line 102 — CollaborationService constructor uses `require(...)` in an ESM module, but `require` is not defined in ESM and will throw at runtime. Use `createRequire(import.meta.url)` (as done elsewhere) or switch to a static import from `node:sqlite` so this service can be constructed without crashing.

- Thread: `PRRT_kwDORQuyQM6BF2Iy`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150363
- Author: `copilot-pull-request-reviewer` at 2026-05-11T13:12:25Z
- Outdated: `False`
- Status: FIXED — `CollaborationService` uses module-scope `createRequire(import.meta.url)` instead of global `require`; regression constructs service in ESM.

```text
CollaborationService constructor uses `require(...)` in an ESM module, but `require` is not defined in ESM and will throw at runtime. Use `createRequire(import.meta.url)` (as done elsewhere) or switch to a static import from `node:sqlite` so this service can be constructed without crashing.
```

## 9. `extensions/memory-hybrid/routes/graphql-server.ts` line 61 — GraphQL subscription resolvers no longer apply the schema-defined filters (e.g. factCreated(category, scope), factUpdated(factId, category), linkCreated(sourceId, targetId)). The current subscribe() implementations ignore args, so clients requesting filtered subscriptions will receive all events. Reintroduce payload filtering based on the subscription arguments (as before) to match the schema and avoid noisy/unexpected updates.

- Thread: `PRRT_kwDORQuyQM6BF2JQ`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150403
- Author: `copilot-pull-request-reviewer` at 2026-05-11T13:12:25Z
- Outdated: `False`
- Status: FIXED — duplicate of item 1; subscription argument filtering restored and tested.

```text
GraphQL subscription resolvers no longer apply the schema-defined filters (e.g. factCreated(category, scope), factUpdated(factId, category), linkCreated(sourceId, targetId)). The current subscribe() implementations ignore args, so clients requesting filtered subscriptions will receive all events. Reintroduce payload filtering based on the subscription arguments (as before) to match the schema and avoid noisy/unexpected updates.
```

## 10. `extensions/memory-hybrid/utils/provider-detection.ts` line 63 — googleConfigured is computed from `hasConfiguredApiKey(googleApiKey ?? currentApiKey)`, which will mark the Google provider as available whenever an OpenAI apiKey is present (even if no Google/Gemini key is configured). That can mislead setup/providers output and cause recommendProvider() to pick google incorrectly. Compute googleConfigured from googleApiKey only (or an explicit google-specific config source).

- Thread: `PRRT_kwDORQuyQM6BF2Jq`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150439
- Author: `copilot-pull-request-reviewer` at 2026-05-11T13:12:26Z
- Outdated: `False`
- Status: FIXED — duplicate of item 5; Google readiness no longer falls back to OpenAI key and is tested.

```text
googleConfigured is computed from `hasConfiguredApiKey(googleApiKey ?? currentApiKey)`, which will mark the Google provider as available whenever an OpenAI apiKey is present (even if no Google/Gemini key is configured). That can mislead setup/providers output and cause recommendProvider() to pick google incorrectly. Compute googleConfigured from googleApiKey only (or an explicit google-specific config source).
```


## Verification

Local verification on this branch:

```text
npm run format:check
npm run lint
npm run build:check
npx tsc --noEmit
npx vitest run tests/pr1332-remediation.test.ts tests/user-friendly-cli.test.ts tests/progress-bar.test.ts tests/facts-db.test.ts --coverage.enabled=false
```

Result: all commands passed locally on 2026-05-11.
