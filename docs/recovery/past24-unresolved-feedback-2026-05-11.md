# Past-24h unresolved review feedback audit for PR #1333

- Repository: `markus-lassfolk/openclaw-hybrid-memory`
- Window: `2026-05-10T20:19:10Z` through `2026-05-11T20:19:10Z`
- Source: live GitHub GraphQL `reviewThreads` inventory
- Definition: unresolved means `isResolved == false`, regardless of `isOutdated`
- Total unresolved feedback items in window: **128**

## Classification policy

- **FIXED IN PR #1333**: the reviewed code is in PR #1333 and this branch implements the fix.
- **ADDRESSED BY MAIN / PRIOR REMEDIATION**: the item was from a merged/closed PR and is already covered by the merged #1332 recovery set now present on `main`; #1333 builds on that state or explicitly remediates #1332.
- **SOURCE PR ONLY — NOT IN PR #1333**: the item is on another still-open PR branch. The commented code is not part of `main`/PR #1333, so copying it into #1333 would import unrelated feature work. These items must be fixed in their own source PR before that PR merges.

## Summary by source PR

- PR #1308: **5** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — fix: resolve 15 critical bugs in stewardship and active-tasks subsystems
- PR #1311: **1** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — fix: cross-scope classification mutations and vector cleanup in memory pipelines
- PR #1316: **8** — SOURCE PR ONLY — NOT IN PR #1333 — feat: improve hybrid-memory onboarding, status visibility, and task UX
- PR #1317: **5** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — Add productization surfaces: doctor flow, session observability CLI, quality reporting, telemetry/sync tooling, and contributor/demo docs
- PR #1318: **35** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — Implement 10 strategic enhancements for ecosystem growth and enterprise adoption
- PR #1319: **11** — SOURCE PR ONLY — NOT IN PR #1333 — Implement cost optimization improvements: embedding cache, adaptive batching, smart VACUUM, CI/CD
- PR #1320: **25** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — feat: add user-friendly CLI commands and comprehensive quick-start guide
- PR #1322: **12** — SOURCE PR ONLY — NOT IN PR #1333 — fix: 10 cross-cutting issues across storage, services, CLI, tools, and utils
- PR #1323: **6** — ADDRESSED BY MAIN / PRIOR REMEDIATION (#1332 recovery) — Harden Active Tasks + Goal Stewardship state handling, signal trust, and heartbeat safety
- PR #1325: **2** — SOURCE PR ONLY — NOT IN PR #1333 — Add recall probe logging for hybrid-memory stalls
- PR #1331: **5** — SOURCE PR ONLY — NOT IN PR #1333 — fix(ci): block bot automerge until ci.yml succeeds for exact head sha
- PR #1332: **10** — FIXED IN PR #1333 (original remediation scope) — fix: address all unresolved feedback from recent merged PRs
- PR #1333: **3** — FIXED IN PR #1333 (this update) — fix: remediate unresolved feedback from PR #1332

## Items

### 1. PR #1333 — `extensions/memory-hybrid/utils/progress-indicators.ts:50`

- Status: **FIXED IN PR #1333**
- Evidence: `ProgressSpinner.success()` / `fail()` now use single-line template strings with explicit `\n`, avoiding indentation whitespace in output. Regression covered by `tests/pr1332-remediation.test.ts`.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T14:00:39Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1333#discussion_r3219488779
- Feedback: The `process.stdout.write(...)` calls use multiline template literals where the closing backtick is on the next line, which embeds a newline plus indentation whitespace into the output (e.g., a trailing `\n ` after the message). This produces inconsistent CLI output (extra spaces/blank lines). Prefer writing a single-line string with an explicit `\n` (or concatenating `+ "\n"`) so output is deterministic.

### 2. PR #1333 — `extensions/memory-hybrid/utils/progress-indicators.ts:155`

- Status: **FIXED IN PR #1333**
- Evidence: `utils/progress-indicators.ts` now writes single-line strings with explicit `\n`; no embedded template indentation/leading blank line remains. Regression covered by `tests/pr1332-remediation.test.ts`.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T14:00:39Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1333#discussion_r3219488846
- Feedback: `statusMessage()` and `showCompletionSummary()` also use multiline template literals with indentation, which injects unintended leading/trailing whitespace into the printed output (e.g., leading space before "✓" and trailing spaces after newlines). Use explicit `\n` in single-line strings (and avoid leading newline unless intended) to keep CLI output stable and easy to parse.

### 3. PR #1333 — `extensions/memory-hybrid/tests/pr1332-remediation.test.ts:169`

- Status: **FIXED IN PR #1333**
- Evidence: The `promptHidden` regression now simulates synchronous readline `close` by invoking the registered close callback inside the mock `close()` method.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T14:00:39Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1333#discussion_r3219488880
- Feedback: This test’s mocked readline emits the `close` event on a later tick (`setTimeout(cb, 0)`). Real `readline.Interface.close()` emits `close` synchronously, which is the ordering that can cause hidden prompts to resolve to "" if the implementation isn’t guarded. Add a regression case that fires `close` synchronously (during `close()`/`question()`), so the test will fail if typed input can be overwritten by the close fallback.

### 4. PR #1332 — `extensions/memory-hybrid/routes/graphql-server.ts:43`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T13:11:24Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143939
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Restore subscription argument filtering** The subscription resolvers now ignore all query arguments and subscribe every client to every event (`category`, `scope`, `factId`, etc. are no longer applied). This regresses behavior promised by the schema and can leak unrelated updates to subscribers that requested a narrower stream, especially in multi-tenant or multi-session usage. Re-introduce per-event predicate filtering in `subscribe` so payloads are scoped to the caller’s arguments. Useful? React with 👍 / 👎.

### 5. PR #1332 — `extensions/memory-hybrid/cli/cmd-setup.ts:43`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T13:11:24Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143943
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Avoid resolving hidden prompts to empty string** `promptHidden` registers an `rl.on("close")` handler that resolves `""`, but the question callback calls `rl.close()` before resolving the typed answer. That means normal interactive entry can resolve to the empty string first, so OpenAI/Google API keys are silently dropped during `setup --interactive`. Resolve only once from the question callback (and keep close handling for abort paths) to avoid losing user input. Useful? React with 👍 / 👎.

### 6. PR #1332 — `extensions/memory-hybrid/cli/cmd-doctor.ts:140`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T13:11:24Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143947
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Respect configured memory path in doctor disk check** The disk-space check now hardcodes `~/.openclaw/plugins/memory-hybrid` and no longer considers `cfg.paths?.memory`. Installations using a custom memory directory will be reported as missing/unhealthy even when storage is valid, which creates false warnings and misleading remediation advice. Use the configured path first and fall back to the default only when unset. Useful? React with 👍 / 👎.

### 7. PR #1332 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:348`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T13:11:24Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143950
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Fail supersede mutation when old fact is missing** This resolver validates only `newFactId` and ignores the boolean result of `factsDb.supersede(...)`. If `oldFactId` does not exist (or was already superseded), the mutation still returns success with the new fact, so clients get a false positive despite no lineage change. Check that the old fact exists or that `supersede` returns `true`, and throw when the operation did not apply. Useful? React with 👍 / 👎.

### 8. PR #1332 — `extensions/memory-hybrid/utils/provider-detection.ts:62`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T13:11:24Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219143956
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Stop treating OpenAI key as Google provider config** Google availability is computed with `googleApiKey ?? currentApiKey`, so any configured OpenAI key marks Google as available even when no Google key exists. This produces incorrect provider status/recommendations and can direct users into a non-working Google setup path. Google readiness should depend only on the Google key input. Useful? React with 👍 / 👎.

### 9. PR #1332 — `extensions/memory-hybrid/utils/progress-indicators.ts:47`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T13:12:26Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150271
- Feedback: ProgressSpinner.success()/fail() no longer emit any completion output (they only stop the spinner and compute unused elapsed variables). This makes setup/doctor flows lose their success/failure feedback, and in non-TTY mode there is now no output at all. Restore a minimal console log (or provide a logger callback) so callers get a completion line even when not in TTY.

### 10. PR #1332 — `extensions/memory-hybrid/utils/progress-indicators.ts:132`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T13:12:26Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150327
- Feedback: statusMessage() has become a no-op (it builds an icons map but never prints), which breaks cmd-demo's final success line and any other CLI status messaging that relies on it. Re-introduce the console output (or route through the project logger) so callers see the intended feedback.

### 11. PR #1332 — `extensions/memory-hybrid/services/collaboration.ts:102`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T13:12:26Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150363
- Feedback: CollaborationService constructor uses `require(...)` in an ESM module, but `require` is not defined in ESM and will throw at runtime. Use `createRequire(import.meta.url)` (as done elsewhere) or switch to a static import from `node:sqlite` so this service can be constructed without crashing.

### 12. PR #1332 — `extensions/memory-hybrid/routes/graphql-server.ts:61`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T13:12:26Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150403
- Feedback: GraphQL subscription resolvers no longer apply the schema-defined filters (e.g. factCreated(category, scope), factUpdated(factId, category), linkCreated(sourceId, targetId)). The current subscribe() implementations ignore args, so clients requesting filtered subscriptions will receive all events. Reintroduce payload filtering based on the subscription arguments (as before) to match the schema and avoid noisy/unexpected updates.

### 13. PR #1332 — `extensions/memory-hybrid/utils/provider-detection.ts:63`

- Status: **FIXED IN PR #1333**
- Evidence: Covered by `docs/recovery/pr1332-unresolved-feedback-remediation.md` and the PR #1333 code/test changes for #1332 remediation.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T13:12:26Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1332#discussion_r3219150439
- Feedback: googleConfigured is computed from `hasConfiguredApiKey(googleApiKey ?? currentApiKey)`, which will mark the Google provider as available whenever an OpenAI apiKey is present (even if no Google/Gemini key is configured). That can mislead setup/providers output and cause recommendProvider() to pick google incorrectly. Compute googleConfigured from googleApiKey only (or an explicit google-specific config source).

### 14. PR #1331 — `.github/workflows/copilot-automerge.yml:141`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T09:07:34Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1331#discussion_r3217583854
- Feedback: The workflow-run gate currently allows merging if *any* completed CI run for this head SHA succeeded, even if the most recent completed run was a failure/cancelled (e.g., after a rerun). This conflicts with the PR description’s “latest CI for that SHA” requirement; consider selecting the latest completed run and requiring its conclusion to be `success` (or update the description if “any success” is intended).

### 15. PR #1331 — `.github/workflows/copilot-automerge.yml:112`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T09:07:34Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1331#discussion_r3217583919
- Feedback: `listWorkflowRuns` here doesn’t restrict the run’s triggering event, so a successful `push` run for the same SHA could satisfy this gate and allow merge before the `pull_request` CI run completes (CI has event-specific conditions). To ensure the gate reflects PR CI, filter runs to `event === 'pull_request'` (or pass the API’s `event: 'pull_request'` param if supported) and also defensively filter by `r.head_sha === pr.head.sha` before evaluating success.

### 16. PR #1331 — `.github/workflows/copilot-automerge.yml:119`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T09:07:34Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1331#discussion_r3217583952
- Feedback: `successfulCiRun` is computed but never used. Consider removing the variable (inline the `find` in the `if`), or using it for logging (e.g., run id/url) to keep this section consistent and avoid dead code.

### 17. PR #1331 — `.github/workflows/copilot-automerge.yml:106`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T09:07:49Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1331#discussion_r3217585679
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Add Actions API permission before listing workflow runs** This change introduces `github.rest.actions.listWorkflowRuns`, but the workflow token permissions only grant `contents`, `pull-requests`, and `issues`; with explicit `permissions`, all other scopes are `none`. The Actions REST endpoint requires Actions read access, so this call will 403 at runtime and prevent the automerge job from evaluating PRs at all. Add `actions: read` at workflow or job scope before calling this API. Useful? React with 👍 / 👎.

### 18. PR #1331 — `.github/workflows/copilot-automerge.yml:121`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T09:07:49Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1331#discussion_r3217585681
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Require latest completed CI run to be successful** Using `completedCiRuns.find(...)` accepts any historical successful run for the SHA, so a newer rerun with conclusion `failure`/`cancelled` still passes this gate as long as an older attempt succeeded. That contradicts the intended “latest CI state” guard and can allow merge attempts under stale success. Check the newest completed run’s conclusion (or filter by run attempt/event) instead of any-match success. Useful? React with 👍 / 👎.

### 19. PR #1325 — `extensions/memory-hybrid/services/recall-pipeline.ts:153`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T08:13:52Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1325#discussion_r3217273528
- Feedback: `probeId` is declared optional, but the pipeline unconditionally generates a probeId, emits probe debug lines, and arms a watchdog timer even when the caller doesn’t provide one. This makes “probe logging” effectively always-on and can increase log volume / warning noise unexpectedly for call sites that don’t want probe output. Consider gating probe logs + watchdog behind `opts?.probeId` (or a dedicated flag/config), or make `probeId` required if the intent is always-on tracing so API expectations match behavior.

### 20. PR #1325 — `extensions/memory-hybrid/lifecycle/stage-recall.ts:107`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T08:13:52Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1325#discussion_r3217273580
- Feedback: The recall watchdog is scheduled once at the start, but `scheduleRecallProbeWatchdog` is never called again when phases change. As a result, the “still-running” warning can fire during normal long recalls (without indicating a stall), and it won’t emit anything if the recall later stalls after the first 5s window. Consider either re-arming the watchdog whenever `setRecallProbePhase(...)` is called (so it measures time since last progress), or switching to a repeating interval until the stage completes; otherwise simplify by removing the unused reschedule helper.

### 21. PR #1323 — `extensions/memory-hybrid/services/goal-registry.ts:180`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T04:49:21Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216414656
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Prevent corrupt goal file from aborting all goal processing** Throwing on any non-ENOENT read error here makes higher-level scans fail hard because `listGoals()` calls `readGoal()` without a per-file guard, and `runGoalHealthCheck()` calls `listGoals()` before entering its per-goal `try/catch`. As a result, a single malformed `*.json` goal file can stop the entire watchdog pass (no other goals get checked), which regresses the new per-goal failure isolation behavior. Useful? React with 👍 / 👎.

### 22. PR #1323 — `extensions/memory-hybrid/services/active-task.ts:480`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T04:49:21Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216414659
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Preserve file permissions during atomic ACTIVE-TASKS writes** Replacing the file via temp-write + `rename()` changes the inode, so existing mode/ownership/ACL on `ACTIVE-TASKS.md` are not preserved and are replaced by defaults from the temp file creation umask. If operators intentionally set restrictive permissions (for task content confidentiality), a normal write can silently broaden access after this change. Useful? React with 👍 / 👎.

### 23. PR #1323 — `extensions/memory-hybrid/services/goal-registry.ts:181`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `True`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:49:51Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415837
- Feedback: `readGoal` now throws on corrupt/unreadable JSON (good), but `listGoals` calls `readGoal` without a per-file try/catch. A single corrupt goal file will now cause `listGoals()` (and callers like `runGoalHealthCheck` and `stage-active-task` injection) to throw and abort processing entirely, which undermines the intended “per-goal isolation”. Consider catching errors inside `listGoals` (skip/record corrupt files) or adding a separate safe listing API used by watchdog/injection paths.

### 24. PR #1323 — `extensions/memory-hybrid/services/goal-health.ts:249`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:49:51Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415854
- Feedback: `isBlockedVerificationHost` returns `true` immediately for any `::ffff:` IPv4-mapped IPv6 address, so the subsequent `mappedIpv4` extraction and private-range check is unreachable. Either remove the dead code or move the private-range parsing before the unconditional return (depending on the intended policy).

### 25. PR #1323 — `extensions/memory-hybrid/services/goal-health.ts:240`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:49:51Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415861
- Feedback: The `http_ok` host blocking only checks IP literals (`isIP(hostname)`), and returns `false` for any DNS hostname (other than `.local`/`.localhost`). That still allows SSRF to private/loopback/link-local networks via hostnames that resolve to private IPs (including DNS rebinding). If the goal is to block private/local targets, consider resolving the hostname (e.g., `dns.lookup`/`dns.resolve`) and rejecting any private/local results before calling `fetch`.

### 26. PR #1323 — `extensions/memory-hybrid/services/goal-active-task-mirror.ts:83`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:49:51Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1323#discussion_r3216415870
- Feedback: `refreshActiveTaskMirrorWithGoals` writes `ACTIVE-TASKS.md` via a direct `writeFile`, which can still leave partial-file corruption if interrupted (the PR aims to make ACTIVE-TASKS.md writes atomic). Consider using the same temp-file+rename atomic write pattern as `writeActiveTaskFile`, or delegating the final write to that helper so all writers share the same safety guarantees.

### 27. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:84`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T04:48:25Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216412218
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Avoid forced exit immediately after JSON writes** Calling `process.exit(0)` right after `console.log(...)` can terminate the process before stdout is fully flushed when output is piped or under backpressure, which can yield truncated JSON while still returning success. This affects automation consumers of `goals --json`; prefer setting `process.exitCode = 0` and returning so Node can drain I/O naturally. Useful? React with 👍 / 👎.

### 28. PR #1322 — `extensions/memory-hybrid/tools/memory-tools.ts:101`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T04:48:25Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216412220
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Reject oversized scope IDs instead of truncating** Silently slicing `userId`/`agentId`/`sessionId` to 256 chars can collapse distinct tenant identifiers that share the same prefix, so scoped recall may return another tenant's data when `trustToolScopeParams` is enabled. This is a security/correctness regression introduced by truncation; oversized scope values should be rejected rather than rewritten. Useful? React with 👍 / 👎.

### 29. PR #1322 — `extensions/memory-hybrid/backends/vector-db.ts:991`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T04:48:25Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216412221
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Skip reinit after a failed swap rollback** The `finally` block always calls `ensureInitialized()` even when shadow swap failed and rollback threw. In that failure path, reinitialization can create a new empty main table if `mainTableDir` is absent, mutating disk state before propagating the error and complicating/manual recovery from the preserved backup directory. Reconnect should be skipped when rollback fails. Useful? React with 👍 / 👎.

### 30. PR #1322 — `extensions/memory-hybrid/utils/auth.ts:21`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418836
- Feedback: `apiOnlyPatternsLower` is compared against `p.toLowerCase()`, but the patterns are built from the raw `provider` string without lowercasing. If a caller passes `provider` with any uppercase (or whitespace), API-only profiles can be misclassified as OAuth profiles. Consider normalizing `provider` (e.g., `const providerLower = provider.toLowerCase().trim()`) before building the patterns.

### 31. PR #1322 — `extensions/memory-hybrid/utils/auth.ts:29`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418851
- Feedback: New case-insensitive behavior and the `onOAuthProfile` diagnostic callback aren’t covered by the existing auth-order tests. Adding unit tests for inputs like `openai:Api`/`openai:DEFAULT` (and asserting the callback fires only when an OAuth profile is detected) would prevent regressions in routing decisions.

### 32. PR #1322 — `extensions/memory-hybrid/tools/memory-tools.ts:101`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418867
- Feedback: `sanitizeScopeParam()` silently truncates overlong scope IDs. Because these values can affect authorization/scoping when `multiAgent.trustToolScopeParams=true`, truncation can change the effective identity (and potentially collide with a different real ID). Safer options are to reject/throw on >256 chars (or return an error to the tool caller) rather than slice.

### 33. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:67`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `True`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418875
- Feedback: Calling `process.exit(0)` inside the command action bypasses Commander’s normal completion flow (including the `postAction` teardown hook installed by `registerHybridMemCliWithApi`). This can skip DB/timer cleanup and will also hard-exit when the CLI is invoked in-process (e.g. tests). Prefer returning normally (and ensuring teardown runs), or gating any forced exit behind a standalone-CLI check in the shared CLI context rather than in this command.

### 34. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:86`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `True`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418880
- Feedback: Calling `process.exit(0)` inside the command action bypasses Commander’s `postAction` teardown hook and will hard-exit when the CLI is invoked in-process (e.g. tests). Prefer returning normally and letting the shared CLI teardown/exit handling run.

### 35. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:123`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418885
- Feedback: Calling `process.exit(0)` here bypasses Commander’s `postAction` teardown hook (used to close DBs/clear timers) and will hard-exit in embedded invocations. Prefer returning normally and relying on the shared CLI context to handle exit/teardown.

### 36. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:154`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `True`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418895
- Feedback: Calling `process.exit(0)` inside the action will hard-exit the process even when running under `registerHybridMemCliWithApi` (tests/in-process CLI) and can bypass teardown hooks. Prefer returning normally and letting the CLI context drive any forced exit for standalone mode.

### 37. PR #1322 — `extensions/memory-hybrid/cli/goals.ts:256`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418904
- Feedback: This `process.exit(0)` bypasses Commander’s completion/teardown path (the `postAction` hook that disposes timers / closes DB handles). It can also terminate the process when the CLI is executed in-process (e.g. tests). Prefer returning normally and relying on the shared CLI context to manage exit behavior in standalone mode.

### 38. PR #1322 — `extensions/memory-hybrid/backends/vector-db.ts:1004`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T04:51:06Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1322#discussion_r3216418915
- Feedback: `swapSucceeded` only tracks that the filesystem rename completed. If LanceDB fails to reopen the swapped-in table (degraded mode / schema repair failure), removing `oldTableDir` here discards the last known-good backup and makes manual recovery harder. Consider only deleting the old table directory after verifying the reopened DB/table is healthy (e.g. `await ensureInitialized(); if (!this.isLanceAvailable()) keep oldTableDir`).

### 39. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:127`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:46:38Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216253962
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Persist setup selections to plugin configuration** The setup wizard reports that it is "applying configuration", but this block only prints key/value pairs and never calls any config writer or `config-set` handler; the inline note explicitly says real persistence is missing. In practice, `openclaw hybrid-mem setup --interactive` can end with a success message while leaving provider/model/API key unchanged, so users still fail later commands expecting the new setup to be active. Useful? React with 👍 / 👎.

### 40. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:43`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:46:38Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216253967
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Make --interactive actually optional** With Commander, defining `.option("--interactive", ..., true)` makes `interactive` true even when the flag is omitted and does not provide `--no-interactive`, so the non-interactive branch below is unreachable. This means setup always prompts on stdin, which breaks scripted/CI usage and contradicts the presence of explicit non-interactive logic in the command. Useful? React with 👍 / 👎.

### 41. PR #1320 — `extensions/memory-hybrid/utils/provider-detection.ts:41`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257864
- Feedback: `checkOnnxAvailable()` uses `require.resolve(...)` inside an ES module. At runtime `require` is not defined (unless created via `createRequire`), so this will throw and incorrectly report ONNX as unavailable. Use `createRequire(import.meta.url).resolve(...)`, or make this check async and `await import("onnxruntime-node")` in a try/catch to detect availability.

### 42. PR #1320 — `extensions/memory-hybrid/utils/provider-detection.ts:7`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257887
- Feedback: `execSync` and `existsSync` are imported but never used in this module. Please remove them to avoid dead code and keep the provider detection logic focused.

### 43. PR #1320 — `extensions/memory-hybrid/utils/provider-detection.ts:15`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257903
- Feedback: The embedding config supports provider `"google"` (see EmbeddingConfig), but provider detection/status only handles openai/ollama/onnx. If a user is configured for google, `providers/doctor/health` will misreport it as “not configured/unavailable”. Consider adding google to `ProviderStatus.provider` and implementing a `checkGoogleConfigured(...)` similar to OpenAI (or at least treat it as configured when an API key is present).

### 44. PR #1320 — `extensions/memory-hybrid/utils/progress-indicators.ts:86`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257918
- Feedback: `ProgressBar.update()` in non-TTY mode logs whenever `percent % 10 === 0`, which can print the same percentage many times if `update()` is called frequently. The codebase already uses milestone logging with a `lastPct` guard (e.g. 25/50/75/100) to avoid log spam. Track the last logged percentage (and consider milestone steps + a `total <= 0` guard) to prevent duplicate logs and division-by-zero when `total` is 0.

### 45. PR #1320 — `extensions/memory-hybrid/utils/error-codes.ts:153`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257935
- Feedback: `wrapCommonError()` treats timeouts as provider-unavailable (HM_E003) because it matches `lowerMsg.includes("timeout")`, but the catalog defines HM_E008 specifically for operation timeouts. This will surface the wrong title/solution for genuine timeouts. Prefer mapping timeout-ish messages to HM_E008 (and keep HM_E003 for connection/refused/notfound cases).

### 46. PR #1320 — `extensions/memory-hybrid/utils/error-codes.ts:35`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257948
- Feedback: Several `docsLink` URLs point at README anchors that don’t exist (e.g. `#embedding-providers`). This makes the “More info” link in `UserFriendlyError.format()` misleading. Please update these links to stable docs that exist in this repo (e.g. `docs/LLM-AND-PROVIDERS.md`, `docs/TROUBLESHOOTING.md`, etc.).

### 47. PR #1320 — `extensions/memory-hybrid/docs/QUICK-START.md:253`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257962
- Feedback: These “Learn More” references point to `docs/CLI-REFERENCE.md`, `docs/CONFIGURATION.md`, and `docs/ARCHITECTURE.md` relative to `extensions/memory-hybrid/docs/`, but those files don’t exist in this folder (they live under the repo root `docs/`). Use correct relative links (e.g. `../../docs/CLI-REFERENCE.md`) or absolute repo links so GitHub navigation works.

### 48. PR #1320 — `extensions/memory-hybrid/docs/QUICK-START.md:53`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257966
- Feedback: ONNX setup here suggests `npm install onnxruntime-node` without the `--prefix ~/.openclaw/extensions ...` guidance used elsewhere in the repo. As documented in `extensions/memory-hybrid/README.md`, installing into the OpenClaw extensions folder is important so the dependency survives `openclaw hybrid-mem upgrade`. Please align these instructions with the README’s recommended installation method.

### 49. PR #1320 — `extensions/memory-hybrid/cli/register.ts:463`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257973
- Feedback: `registerUserFriendlyCommands(mem as any, ...)` is needed because the user-friendly command modules are typed against Commander `Command`, while the rest of the CLI uses the local `Chainable` abstraction. To avoid `any` and keep type safety consistent, update `cmd-user-friendly.ts` (and the new command modules) to accept `Chainable` from `cli/shared.ts` (only using the subset of Commander APIs the CLI supports).

### 50. PR #1320 — `extensions/memory-hybrid/cli/register.ts:470`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257978
- Feedback: New CLI surface area is being registered here, but there are no accompanying tests verifying that these commands are registered and don’t hang the CLI (the repo already has CLI registration tests like `active-task.test.ts`). Add tests that assert `setup/demo/providers/health/doctor/examples` are present on the command tree and that help-only registration still avoids DB/bootstrap side effects.

### 51. PR #1320 — `extensions/memory-hybrid/cli/cmd-user-friendly.ts:35`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257988
- Feedback: This module types `mem` as Commander `Command`, but `registerHybridMemCli` passes a `Chainable` (and currently must cast with `as any`). To match the rest of the CLI modules, consider switching these registrations to accept `Chainable` from `cli/shared.ts`. This removes the need for unsafe casts and ensures the command modules stay compatible with the CLI’s abstraction layer.

### 52. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:15`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216257998
- Feedback: Several Node imports here (`readFileSync`, `writeFileSync`, `homedir`, `join`) are unused in the current implementation. Please remove them to avoid dead code and reduce confusion about whether the wizard persists anything to disk.

### 53. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:128`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258011
- Feedback: The wizard claims to be “Applying configuration”, but it never actually writes anything (it only logs key/value pairs and even notes “In real implementation…”). This is a functional gap vs the command description/PR description. Please wire this to the existing config machinery (e.g. call the `config-set` handler / `runConfigSet`, or persist updates via the config service) so `setup --interactive` genuinely updates the plugin config.

### 54. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:100`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258018
- Feedback: The OpenAI API key prompt uses `readline.question`, which echoes the secret as the user types. For a setup wizard, this is risky in shared terminals/screen recordings. Use a masked/hidden input method for secrets (or instruct users to set `embedding.apiKey` via `config-set`/env vars instead of typing it interactively).

### 55. PR #1320 — `extensions/memory-hybrid/cli/cmd-setup.ts:87`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258040
- Feedback: `configUpdates` is declared as `Record<string, any>`, losing type safety for config keys/values. Since this code is user-facing config, it’s worth keeping types tight. Prefer `Record<string, string>` (all values are printed as strings here) or a typed map of known keys to avoid accidentally emitting non-serializable values.

### 56. PR #1320 — `extensions/memory-hybrid/cli/cmd-providers.ts:24`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258053
- Feedback: This command runs an async `.action(...)` without using the repo’s `withExit(...)` helper. Many existing CLI modules rely on `withExit` for consistent error capture and to ensure the process exits/tears down cleanly. Consider wrapping the action with `withExit` (from `cli/shared.ts`) and letting errors throw so teardown/error reporting stays consistent.

### 57. PR #1320 — `extensions/memory-hybrid/cli/cmd-health.ts:116`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258066
- Feedback: `health` recomputes `factsDb.countFacts()` and calls `vectorDb.getAllIds()` multiple times. `getAllIds()` can be expensive on large vector stores; doing it twice per invocation is unnecessary. Fetch `factCount`/`vectorCount` once and reuse for Memory Size + Sync checks (or add a cheaper `countVectors()` API if available).

### 58. PR #1320 — `extensions/memory-hybrid/cli/cmd-examples.ts:149`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258076
- Feedback: Using `category in EXAMPLE_CATEGORIES` checks the prototype chain too. Inputs like `examples toString` will pass the check and then `EXAMPLE_CATEGORIES["toString"]` is not a valid category object, which can crash or print nonsense. Use an own-property check (e.g. `Object.hasOwn(...)` / `hasOwnProperty.call(...)`) before indexing.

### 59. PR #1320 — `extensions/memory-hybrid/cli/cmd-doctor.ts:5`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258084
- Feedback: `statSync` is imported but never used in this file. Please remove it to avoid dead code.

### 60. PR #1320 — `extensions/memory-hybrid/cli/cmd-doctor.ts:31`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258093
- Feedback: The command defines a `--fix` option, but `opts.fix` is never used. This makes the CLI misleading (users expect some remediation behavior). Either implement `--fix` (e.g. run the suggested fix commands / call existing verify/reconcile flows) or remove the option until it’s supported.

### 61. PR #1320 — `extensions/memory-hybrid/cli/cmd-doctor.ts:148`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258098
- Feedback: This “Disk Space” check uses `require("node:path")` / `require("node:os")` inside an ES module. At runtime `require` will be undefined, causing the diagnostics command to crash. Use top-level ESM imports (`import { homedir } from "node:os"; import { join } from "node:path";`) or `createRequire(import.meta.url)` if you truly need `require`.

### 62. PR #1320 — `extensions/memory-hybrid/cli/cmd-doctor.ts:161`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258110
- Feedback: The check is labeled “Disk Space”, but it only verifies that the memory directory exists/access is possible. This doesn’t actually validate free space, which the PR description mentions. Either rename the check to reflect what it does (directory accessibility) or implement a real free-space check (e.g. via `statvfs`-style approach or a platform-appropriate utility) and warn/fail below a threshold.

### 63. PR #1320 — `extensions/memory-hybrid/cli/cmd-demo.ts:37`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:56Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1320#discussion_r3216258120
- Feedback: `EmbeddingProvider` doesn’t have a `provider` property (it exposes `activeProvider`, `modelName`, etc.). This line will fail TypeScript checking and/or always print the wrong value. Use `embeddings.activeProvider` (or `cfg.embedding.provider` if you want configured provider) when displaying provider status.

### 64. PR #1319 — `extensions/memory-hybrid/services/dream-cycle.ts:827`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:38Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216246796
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Wire enableReflectionRules through runtime config** This branch assumes `enableReflectionRules` can be supplied by config, but the commit only adds the type field and never threads it through the parser/CLI runtime path, so in normal execution this value stays `undefined` and `config.enableReflectionRules !== false` always evaluates true. That means operators cannot actually disable reflect-rules via `nightlyCycle.enableReflectionRules`, despite the new setting and docs claiming they can. Useful? React with 👍 / 👎.

### 65. PR #1319 — `extensions/memory-hybrid/services/dream-cycle.ts:934`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:38Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216246797
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Preserve WAL checkpoint when skipping VACUUM** The new threshold skips the full `factsDb.vacuumAndCheckpoint()` call when free space is under 10MB, but that helper performs both `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)`. As a result, most cycles now skip checkpoint/truncate entirely, which is a behavioral regression from prior `vacuumOnCycle=true` semantics and can leave WAL growth unchecked even when only VACUUM was intended to be deferred. Useful? React with 👍 / 👎.

### 66. PR #1319 — `extensions/memory-hybrid/services/dream-cycle.ts:924`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256361
- Feedback: `pageCountResult`/`pageCount` are computed but never used. With `noUnusedLocals` enabled (tsconfig.strict.json), this will fail strict typecheck. Either remove these locals (only freelist_count + page_size are needed for the reclaimed-MB heuristic) or incorporate them into logging/decision logic.

### 67. PR #1319 — `extensions/memory-hybrid/services/dream-cycle.ts:936`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256373
- Feedback: This changes the meaning of `vacuumRan`: when `vacuumOnCycle=true` but `freelist_count` indicates <10MB freed, `vacuumRan` remains false and the digest won’t include “VACUUM ran”. Existing tests currently assert `vacuumRan===true` whenever `vacuumOnCycle===true` (extensions/memory-hybrid/tests/dream-cycle.test.ts around the maintenance integration tests), so CI will fail unless the tests (and/or result fields) are updated to reflect the new “skipped VACUUM” behavior.

### 68. PR #1319 — `extensions/memory-hybrid/config/types/maintenance.ts:88`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256393
- Feedback: `nightlyCycle.enableReflectionRules` is added to the type, but the runtime config parser does not currently read/propagate this field (parseNightlyCycleConfig in config/parsers/maintenance.ts only returns known keys). As-is, setting `nightlyCycle.enableReflectionRules: false` in user config will be ignored and reflection rules will still run. Thread this option through the config parser into the DreamCycleConfig passed to runDreamCycle (and add/adjust config parsing tests accordingly).

### 69. PR #1319 — `extensions/memory-hybrid/services/adaptive-model-limits.ts:83`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256409
- Feedback: This change makes the default limits for a model with no adaptive state start at 50% of catalog. The existing unit test currently asserts the *full* catalog limits are returned when no state exists (extensions/memory-hybrid/tests/adaptive-model-limits.test.ts). Update the tests (and any callers that rely on the previous behavior) to match the new conservative-default semantics.

### 70. PR #1319 — `extensions/memory-hybrid/backends/facts-db/housekeeping.ts:56`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256418
- Feedback: The new comment claims this uses `optimize(0x02)` / “incremental analysis mode”, but the implementation still executes the plain FTS5 `optimize` command (`INSERT INTO facts_fts(facts_fts) VALUES('optimize')`). Also, the note about a “rank command” is misleading in this context (ranking is configured via queries, not an FTS5 maintenance command). Please align the docstring/comments with what the code actually does (or implement the documented behavior if there is a supported SQLite/FTS5 mode flag you intend to use).

### 71. PR #1319 — `extensions/memory-hybrid/services/embeddings/openai-provider.ts:80`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256425
- Feedback: `batchSize` here is used as a chunk size for the *number of input strings* sent per embeddings request (see embedBatch slicing), not a token budget. The new comment/documentation referencing “8000 tokens / 8191 max” is therefore inaccurate, and changing the constructor default to 8000 does not implement token-based batching. Also note that the config parser always supplies `cfg.embedding.batchSize` (default 40), so this constructor default is typically unused in production paths; if the intent is to change real default behavior, adjust the config default and/or implement token-aware batching.

### 72. PR #1319 — `extensions/memory-hybrid/docs/COST-OPTIMIZATION-IMPLEMENTATION.md:26`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256432
- Feedback: This section describes the embedding “batch size” change as “2048 → 8000 tokens” tied to the OpenAI 8191 token limit, but in code `batchSize` is the number of input strings per embeddings request (not a token budget). Consider rewording this to avoid implying token-based batching, and document the actual constraint(s) you’re optimizing for (e.g., request payload size / max inputs per request / observed throughput).

### 73. PR #1319 — `extensions/memory-hybrid/docs/COST-OPTIMIZATION-IMPLEMENTATION.md:113`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256442
- Feedback: The doc claims/assumes an `optimize(0x02)` mode, but the code currently runs the plain FTS5 `optimize` command without a mode flag. Unless you’re certain the target SQLite/FTS5 build supports an argumented optimize variant, this should be corrected to avoid propagating an unsupported/incorrect maintenance recommendation.

### 74. PR #1319 — `extensions/memory-hybrid/docs/COST-OPTIMIZATION-IMPLEMENTATION.md:50`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:47:19Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1319#discussion_r3216256450
- Feedback: This doc states a new `nightlyCycle.enableReflectionRules` config flag was added. However, the runtime config parsing currently doesn’t read/emit this field (parseNightlyCycleConfig only returns known keys), so setting it in user config will have no effect unless the parser is updated. Please either update the parser/tests or adjust the documentation to match current behavior.

### 75. PR #1318 — `extensions/memory-hybrid/routes/dashboard-server.ts:2032`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:30Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246289
- Feedback: **<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)</sub></sub> Make dashboard request handler async before using await** This branch introduces `await` expressions inside the `createServer((req, res) => { ... })` callback, which is not marked `async`, so the package no longer builds (`tsdown` reports parse errors at these lines). As written, any CI or local build that includes this file will fail before runtime, blocking release of the plugin. Useful? React with 👍 / 👎.

### 76. PR #1318 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:9`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:30Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246290
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Replace unresolved search-hybrid import with existing module** The resolver imports `../services/search-hybrid.js`, but that module is not present in the repository, so module resolution will fail when this file is bundled or loaded. This breaks GraphQL query handling (`search`/`semanticSearch`) once parsing reaches this file. Useful? React with 👍 / 👎.

### 77. PR #1318 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:264`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:30Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246293
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Implement schema-declared mutations in resolver map** The `Mutation` resolver map only defines fact CRUD/import/prune handlers, while the schema in this same commit declares additional non-null mutations (`createLink`, `deleteLink`, `consolidateFacts`, `recomputeEmbeddings`). Calling those operations will hit GraphQL's default resolver and return `null` for non-null fields, producing runtime errors instead of usable API responses. Useful? React with 👍 / 👎.

### 78. PR #1318 — `extensions/memory-hybrid/api/plugin-system.ts:357`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:30Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216246298
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Preserve other plugins' hooks when unloading one plugin** Unloading a single plugin currently clears every listener list in `eventListeners`, so hooks from unrelated still-loaded plugins stop firing after any unload. This causes cross-plugin behavior loss in long-running processes where plugins are dynamically reloaded. Useful? React with 👍 / 👎.

### 79. PR #1318 — `extensions/memory-hybrid/api/plugin-system.ts:9`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:28Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216263977
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that module exports `MemoryPluginAPI` (and does not define/export `MemoryPluginContext`). This will fail TypeScript builds; either import the correct type (e.g. `MemoryPluginAPI`) or define/export the intended context type from a dedicated module and update all imports accordingly.

### 80. PR #1318 — `extensions/memory-hybrid/api/plugin-system.ts:358`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:28Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216263990
- Feedback: `unregisterHooks()` currently clears *all* event listeners for *all* events, so unloading one plugin will disable event delivery for every other loaded plugin. Track listeners per plugin (e.g., store listener fns in a Map keyed by pluginId) and only remove the listeners belonging to the plugin being unloaded.

### 81. PR #1318 — `extensions/memory-hybrid/api/plugin-system.ts:144`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:28Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264002
- Feedback: This runtime module uses `console.*` for logging (`PluginManager`'s context logger). The repo’s logger guidance explicitly requires using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (see `utils/logger.ts`). Using `console.*` here will likely violate linting and bypass verbosity/log routing; please switch these to `pluginLogger` (or inject the host logger).

### 82. PR #1318 — `extensions/memory-hybrid/services/plugin-loader.ts:10`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:28Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264008
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that type isn’t exported there. This will not compile; use the correct exported type (e.g. `MemoryPluginAPI`) or introduce an explicit context type/module for the plugin loader and update imports accordingly.

### 83. PR #1318 — `extensions/memory-hybrid/services/plugin-loader.ts:74`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264013
- Feedback: `import(pluginPath)` is called with a filesystem path built via `join(...)`. In Node ESM, dynamic import is most reliable with a `file://` URL (via `pathToFileURL(pluginPath).href`), and passing arbitrary paths can fail across platforms. Convert the path to a file URL before importing.

### 84. PR #1318 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:14`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264023
- Feedback: `MemoryPluginContext` is imported from `../api/memory-plugin-api.js`, but that module does not export it. This will break compilation; switch to the correct exported type or define/export the intended GraphQL context type from the right module.

### 85. PR #1318 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:47`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264026
- Feedback: These resolvers call `factsDb.getFactById()` / `getAllFacts()` / `deleteFact()`, but the actual FactsDB API is `getById()` / query helpers / `delete()` (and `store()` expects `StoreFactInput` without `id`/`createdAt`). As written, this GraphQL layer won’t compile or work against the existing backend; update resolvers to use the real FactsDB methods and data shapes (e.g. `factsDb.getById(id)`, `factsDb.searchFacts(...)`/`listForDashboard(...)`, and `factsDb.store({ text, category, ... })` letting the DB assign ids/timestamps).

### 86. PR #1318 — `extensions/memory-hybrid/routes/graphql-resolvers.ts:431`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264033
- Feedback: `supersedes` / `supersededByFact` appear swapped: `supersedes` returns the fact referenced by `parent.supersededBy`, which is the fact that supersedes the parent (i.e. "superseded by"), while `supersededByFact` searches for a fact whose `supersededBy === parent.id`, which is the fact that the parent supersedes. Swap these resolver implementations (or rename fields) to match their semantics.

### 87. PR #1318 — `extensions/memory-hybrid/routes/graphql-schema.ts:235`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264041
- Feedback: The schema declares non-null root fields (`episode`, `episodes`, `link`, many `Mutation`s like `createLink`, `deleteLink`, `consolidateFacts`, `recomputeEmbeddings`) that do not have resolvers implemented in `graphql-resolvers.ts`. Querying any of these will resolve to `null/undefined` and can trigger runtime GraphQL errors (especially for `...!` fields). Either implement the missing resolvers or remove/mark nullable the fields until supported.

### 88. PR #1318 — `extensions/memory-hybrid/routes/graphql-server.ts:193`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264047
- Feedback: CORS is configured with `origin: "*"` while `credentials: true`. Browsers will reject `Access-Control-Allow-Origin: *` when credentials are allowed, and it’s also unsafe for authenticated endpoints. Restrict `origin` to a concrete allow-list (or echo validated origins) and only enable credentials when needed.

### 89. PR #1318 — `extensions/memory-hybrid/routes/graphql-server.ts:202`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264052
- Feedback: This runtime route module logs via `console.*` in the Yoga `logging` hooks. The repo’s logger guidance requires using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (`utils/logger.ts`). Switch these to `pluginLogger.{debug,info,warn,error}` so verbosity/log routing behaves consistently and lint rules pass.

### 90. PR #1318 — `extensions/memory-hybrid/routes/dashboard-server.ts:2065`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264062
- Feedback: The `/graphql` handler reads the request body with an unbounded string concatenation loop. This bypasses the existing `readJsonBody(..., MAX_DASHBOARD_JSON_BODY_BYTES)` protections used elsewhere and allows a large body to consume memory (DoS risk). Reuse `readJsonBody` with the existing size limit (or stream with backpressure) and return `413` on oversize payloads.

### 91. PR #1318 — `extensions/memory-hybrid/routes/dashboard-server.ts:2047`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264068
- Feedback: `createGraphQLServer(...)` is instantiated on every `/graphql` request. Creating Yoga (schema + plugins + PubSub) per request is unnecessary overhead and can become a scalability bottleneck. Create the Yoga server once when the dashboard server starts (and reuse the same instance) instead of rebuilding it on each request.

### 92. PR #1318 — `extensions/memory-hybrid/routes/dashboard-server.ts:2047`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264075
- Feedback: This block uses `as any` to coerce the object passed as `pluginContext`. In strict TypeScript this hides mismatches (and `MemoryPluginContext` isn’t actually defined/exported in the referenced module). Define a correct context type (or use an existing exported API type) and build an object that actually satisfies it so GraphQL resolvers can safely rely on typed fields without `any` casts.

### 93. PR #1318 — `extensions/memory-hybrid/routes/dashboard-server.ts:2066`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264085
- Feedback: `createDashboardServer` has an existing test suite, but the newly added `/graph` and `/graphql` routes aren’t covered. Add tests that (1) GET `/graph` returns HTML and (2) POST `/graphql` returns a valid GraphQL response (and enforces the same body-size limits/error handling as other endpoints).

### 94. PR #1318 — `extensions/memory-hybrid/services/memory-compression.ts:75`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264098
- Feedback: This service uses `console.log(...)` in a runtime module. The repo logger guidelines require using `pluginLogger` instead of `console.*` outside CLI allow-listed paths (`utils/logger.ts`). Replace these with `pluginLogger.*` to avoid lint failures and to respect verbosity/log routing.

### 95. PR #1318 — `extensions/memory-hybrid/services/memory-compression.ts:88`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264107
- Feedback: `FactsDB` does not expose `getAllFacts()` (or `getFactById()`), and `FactsDB.store()` expects a `StoreFactInput` shape without `id`/`createdAt` (those are assigned by the DB). As written, this service won’t compile/work with the existing backend; refactor to use supported FactsDB query APIs (e.g. `searchFacts`/`listForDashboard`/`getFactsForConsolidation`) and store summaries via `factsDb.store({ text, category, ... })` without pre-assigning ids/timestamps.

### 96. PR #1318 — `extensions/memory-hybrid/services/memory-compression.ts:243`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264119
- Feedback: This uses placeholder/random embeddings (`generateRandomEmbedding`) instead of reading real vectors from `VectorDB`. That makes clustering non-deterministic and effectively meaningless, and it will produce different clusters on every run. Either wire this to the actual embedding storage/search APIs (preferred) or remove the vector-based path and only expose the category/time-window fallback until embeddings are implemented.

### 97. PR #1318 — `extensions/memory-hybrid/services/benchmark-suite.ts:61`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264131
- Feedback: This runtime module uses `console.log(...)` for progress output. Per `utils/logger.ts`, non-CLI runtime code should use `pluginLogger` rather than `console.*` so logs respect verbosity and lint rules. Replace these with `pluginLogger.info/debug` (or accept an injected logger).

### 98. PR #1318 — `extensions/memory-hybrid/services/benchmark-suite.ts:130`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264137
- Feedback: `FactsDB` does not provide `getAllFacts()` / `getFactById()`. The benchmark implementation currently depends on those methods (and uses placeholder `setTimeout` calls for vector/hybrid search), so it won’t compile or measure real system performance. Update it to use the actual FactsDB APIs (e.g. `searchFacts`, `lookupFacts`, `getById`, etc.) and real vector/hybrid search entrypoints so the benchmark reflects real behavior.

### 99. PR #1318 — `extensions/memory-hybrid/services/collaboration.ts:7`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264154
- Feedback: This service imports/uses `better-sqlite3`, but the codebase has migrated to `node:sqlite` (and tests explicitly assert postinstall does not reference `better-sqlite3`). `better-sqlite3` is not a dependency of this package, so this will fail to build/run. Use `node:sqlite`’s `DatabaseSync` (consistent with the rest of the repo) or add a separate optional package with clear build steps.

### 100. PR #1318 — `extensions/memory-hybrid/services/collaboration.ts:6`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264166
- Feedback: `FactsDB` is imported but never used in this file. With typical TS/biome settings this will fail lint/typecheck; remove the unused import or use it as intended.

### 101. PR #1318 — `extensions/memory-hybrid/cli/plugin-commands.ts:43`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264180
- Feedback: `listPlugins` uses `import(manifestPath, { assert: { type: "json" } })` with a filesystem path. Node’s import-attributes support uses `with: { type: "json" }` (and dynamic import of absolute paths is brittle), so this is likely to throw at runtime. Prefer reading `package.json` via `fs.readFile` + `JSON.parse`, or convert `manifestPath` to a `file://` URL and use the correct import-attributes syntax.

### 102. PR #1318 — `extensions/memory-hybrid/cli/plugin-commands.ts:81`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264193
- Feedback: `installPlugin(..., { npm: true })` runs `npm install ... --prefix <pluginsDir>`, which installs into `<pluginsDir>/node_modules/<pkg>`. However, `PluginLoader` scans `<pluginsDir>/*/index.js`, so npm-installed plugins will not be discoverable/enableable with the current directory layout. Align the installer and loader (e.g., install into a per-plugin directory or have the loader scan `node_modules`), otherwise `plugin install --npm` will appear to succeed but nothing will load.

### 103. PR #1318 — `extensions/memory-hybrid/cli/plugin-commands.ts:79`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264206
- Feedback: `installPlugin` dynamically imports `execa`, but `execa` is not listed in `extensions/memory-hybrid/package.json` dependencies/devDependencies. This will fail at runtime in a clean install. Either add `execa` as a dependency or replace it with `node:child_process` (`spawn`/`execFile`) to avoid the extra dep.

### 104. PR #1318 — `sdk/openclaw-memory-js/package.json:53`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264213
- Feedback: `graphql-request` is declared as a dependency but the SDK implementation uses `fetch` directly and never imports/uses `graphql-request`. Either remove the unused dependency to keep the package lean, or refactor the SDK to use `graphql-request` consistently.

### 105. PR #1318 — `sdk/openclaw-memory-js/src/index.ts:137`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264221
- Feedback: `restPath` is stored on the client (`private restPath` and constructor assignment) but never used by any method. With common TS settings (`noUnusedLocals`/`noUnusedParameters`) this can fail builds and it’s confusing API surface. Either implement REST-based methods that use `restPath` or remove it until needed.

### 106. PR #1318 — `sdk/openclaw-memory-js/README.md:91`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264226
- Feedback: The `getFacts` example includes `minImportance`, but `MemoryClient.getFacts()` options (and the underlying GraphQL `facts` query) do not support `minImportance`. This makes the README example incorrect/misleading; remove `minImportance` from the example or add support for it end-to-end.

### 107. PR #1318 — `docs/tutorials/HYBRID-MEMORY-101.md:320`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264234
- Feedback: This tutorial uses `client.getFacts({ ..., minImportance: 0.7 })`, but the SDK’s `getFacts` method does not accept `minImportance` (and the GraphQL `facts` query doesn’t define it). Update the tutorial to match the actual API, or add `minImportance` support across GraphQL schema/resolvers + SDK.

### 108. PR #1318 — `docs/IMPLEMENTATION-SUMMARY.md:529`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264244
- Feedback: This doc claims the GraphQL layer is "fully implemented and operational" (and elsewhere calls it "complete"), but the code currently contains multiple TODOs/placeholders (e.g. random embeddings in compression, benchmark stubs) and the GraphQL schema includes many fields without resolvers. Please adjust the claims to reflect current implementation status, or complete the missing pieces before describing them as operational.

### 109. PR #1318 — `docs/PLUGIN-DEVELOPMENT.md:46`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:50:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1318#discussion_r3216264251
- Feedback: The link `See the [Plugin Development Guide](../docs/PLUGIN-DEVELOPMENT.md)` points to `docs/docs/PLUGIN-DEVELOPMENT.md` from within `docs/PLUGIN-DEVELOPMENT.md`, which is incorrect/broken. Link to `./PLUGIN-DEVELOPMENT.md` (self) or to the intended separate guide file.

### 110. PR #1317 — `extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2697`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:10Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216245142
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Bind the export handler before invoking sync-export** `sync-export` calls `runExport(...)`, but `runExport` is never pulled from `ManageBindings` in this module scope, so this path fails immediately (TypeScript reports `TS2304: Cannot find name 'runExport'`, and runtime would throw `ReferenceError`). As written, users cannot generate any sync bundle at all. Useful? React with 👍 / 👎.

### 111. PR #1317 — `extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2698`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:44:10Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216245144
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Encrypt actual export content instead of export directory path** Even after wiring `runExport`, this code reads `exportResult.outputPath` as a UTF-8 file, but the export API returns an output directory root (the same contract used by `hybrid-mem export --output <dir>`). Reading that path with `readFileSync(..., "utf-8")` will hit `EISDIR`, so `sync-export` still fails before encryption for valid inputs. Useful? React with 👍 / 👎.

### 112. PR #1317 — `extensions/memory-hybrid/cli/verify.ts:225`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:45:13Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248411
- Feedback: `doctor` currently runs `runInstall({ dryRun: dryRunInstall })` with `dryRunInstall` defaulting to false when neither `--fix` nor `--dry-run` are provided, which means `doctor` will write/apply install defaults by default. That’s surprising given the `--fix` option text (“Apply recommended install defaults…”) and can cause unintended config changes. Consider making the default behavior non-mutating (run install in dry-run/check mode unless `--fix` is set), or rename/reword the option(s) to clearly communicate that install defaults are applied on every run unless `--dry-run` is used.

### 113. PR #1317 — `extensions/memory-hybrid/cli/commands/manage/register-storage-and-stats.ts:2796`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:45:13Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248456
- Feedback: `sync-import` uses `envelope.iterations` directly in `pbkdf2Sync` and decodes `salt`/`iv`/`tag`/`ciphertext` without validating types or lengths. A malformed or hostile bundle could set an extremely large iterations value (DoS) or invalid base64/lengths (crash/unclear errors). Add strict runtime validation (schemaVersion/type/kdf, iterations finite and within a sane min/max, iv length 12 bytes, tag length 16 bytes, salt length expected) and fail with a clear error message before attempting PBKDF2/decryption.

### 114. PR #1317 — `extensions/memory-hybrid/cli/benchmark.ts:144`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:45:13Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1317#discussion_r3216248479
- Feedback: `buildBenchmarkQualityReport` clamps negative latency values to 0 via `Math.max(0, r.latency.p50)` etc. If *all* benchmark features fail (latency pXX = -1, samples=0), the summary averages will misleadingly report 0ms latency instead of indicating “n/a”/failure. Consider computing summary latency only over successful rows and emitting `null` (or a sentinel + explicit flag) when there are no successful measurements, and update markdown rendering accordingly.

### 115. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1569`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:45:44Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216250909
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Do not treat AZURE_OPENAI_API_KEY as OpenAI embedding key** Auto-detecting `AZURE_OPENAI_API_KEY` as an `openai` embedding credential writes `embedding.apiKey=env:AZURE_OPENAI_API_KEY`, but the embedding parser prioritizes `embedding.apiKey` before the Azure Foundry fallback path, so it never applies Azure base-URL wiring and instead uses the default OpenAI endpoint; this breaks embeddings for users who only have Azure credentials configured (a common setup when `llm.providers["azure-foundry"]` is used). Useful? React with 👍 / 👎.

### 116. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1833`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T03:45:44Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216250911
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Make workspace bootstrap failures non-fatal during install** Calling `ensureWorkspaceBootstrap` directly in the main install path can throw on permission-restricted or read-only workspace roots (for example, `OPENCLAW_WORKSPACE` pointing to an unwritable mount), which causes the whole install to return failure even though config writing already succeeded; this leaves users with partial side effects and a misleading "Could not write config" outcome instead of the warning-style behavior already used for skill/tools updates and cron setup. Useful? React with 👍 / 👎.

### 117. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1496`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:46:07Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216252106
- Feedback: `isPlaceholderSecret()` doesn't treat the UI placeholder value `sk-proj-...` (used in openclaw.plugin.json) as a placeholder. That means `hasUsableSecret()` can incorrectly treat `sk-proj-...` as a real key, which will skew embedding auto-detection and the install done/left checklist. Consider expanding the placeholder detection (e.g., match `sk-proj-...` / any `...`-style sentinel) so placeholders are never treated as usable secrets.

### 118. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1517`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:46:07Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216252153
- Feedback: `inspectExistingEmbeddingSetup()` only considers `embedding.apiKey` and `llm.providers.google.apiKey` when deciding whether a usable embedding key exists. The plugin config parser also supports sourcing OpenAI-compatible embedding auth from `llm.providers["openai"].apiKey` / `llm.providers["azure-foundry"].apiKey` when `embedding.apiKey` is unset, so this inspection can incorrectly conclude "no usable key" and drive misleading recommendations. Consider checking those provider keys as well to avoid false negatives.

### 119. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1641`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:46:07Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216252165
- Feedback: When `detection.provider === "openai"`, this always writes `embedding.apiKey` (env ref or the "YOUR_OPENAI_API_KEY" placeholder) whenever the current `embedding.apiKey` isn't usable. This can accidentally break previously-working configs that rely on `llm.providers["openai"|"azure-foundry"].apiKey` fallback: once a placeholder string is written into `embedding.apiKey`, the config parser will treat it as an explicit (invalid) key and throw instead of falling back. Consider: (1) treating a usable `llm.providers.*.apiKey` as satisfying the OpenAI auth requirement, and/or (2) clearing placeholder `embedding.apiKey` instead of setting it when you intend to rely on provider fallback.

### 120. PR #1316 — `extensions/memory-hybrid/cli/cmd-status.ts:23`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-11T03:46:07Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216252181
- Feedback: New CLI surface area (`status`/`dashboard`) is introduced here, but there are no tests covering the text vs JSON output shape or basic behavior (e.g., rendering "needs attention" when cron jobs have errors). The repo has CLI-focused tests for other commands; adding a unit test for `runStatusForCli()` (with a stubbed status payload) would help prevent output regressions and ensure the JSON contract stays stable.

### 121. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1636`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T05:30:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216532493
- Feedback: **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub> Preserve SecretRef API keys during install auto-fill** This branch rewrites `embedding.apiKey` whenever `hasUsableSecret` returns false, but `hasUsableSecret` only accepts strings. Users who configured `embedding.apiKey` as an OpenClaw SecretRef object (supported by the parser) will have that object replaced with `env:...` or `YOUR_OPENAI_API_KEY` during `install`, which silently destroys valid secret wiring and can break deployments that rely on non-env secret sources. Useful? React with 👍 / 👎.

### 122. PR #1316 — `extensions/memory-hybrid/cli/cmd-install.ts:1629`

- Status: **SOURCE PR ONLY — NOT IN PR #1333**
- Evidence: The item belongs to a still-open source PR branch and the reviewed change is not part of `main`/PR #1333. It must be fixed in that source PR before merge; porting it into #1333 would import unrelated unmerged feature work.
- Source PR state: `OPEN`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-11T05:30:29Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1316#discussion_r3216532495
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Keep provider and model updates consistent when model is missing** If a config already has `embedding.provider` set but `embedding.model` missing, detection falls back to environment/runtime heuristics; then this logic updates only the model while leaving the pre-set provider unchanged. That can produce mismatched pairs like `provider: "google"` with an ONNX/Ollama/OpenAI model, causing invalid embedding requests after install. Useful? React with 👍 / 👎.

### 123. PR #1311 — `extensions/memory-hybrid/services/vector-search.ts:27`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `MERGED`
- Thread outdated: `False`
- Author: `chatgpt-codex-connector`
- Comment updated: `2026-05-10T22:17:17Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1311#discussion_r3215609558
- Feedback: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Keep embedding similarity unscoped when no scope is provided** Defaulting `scope` to `"global"` here silently changes the behavior of existing `FindSimilarByEmbeddingFn` callers that still use the old 4/5-argument form (the new `options` arg is optional in `api/memory-plugin-api.ts`), so those callers now stop seeing `user`/`agent`/`session` memories without any type error. In multi-scope deployments this regresses dedupe/classification quality for non-global flows unless every caller is updated to pass explicit scope options. Useful? React with 👍 / 👎.

### 124. PR #1308 — `extensions/memory-hybrid/services/task-ledger-facts.ts:657`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `CLOSED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-10T22:03:08Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215593998
- Feedback: `Promise.race([checkPromise, timeoutPromise])` creates a `setTimeout` that is never cleared when `checkSessionPresent()` resolves quickly. Those pending timers can keep the Node.js event loop alive for up to 5s per sessionRef, which is an operational regression during shutdown/CLI runs. Consider using a `const t = setTimeout(...)` and `clearTimeout(t)` in a `finally`, or `AbortSignal.timeout()`/`timers/promises.setTimeout` with cancellation so the timer is cleaned up once the check completes.

### 125. PR #1308 — `extensions/memory-hybrid/services/task-ledger-facts.ts:803`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `CLOSED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-10T22:03:08Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594004
- Feedback: The null-byte escaping in `taskEntityKey()` is not injective: an input containing the literal sequence `\\x00` becomes indistinguishable from an input that contained an actual `\^@` (both end up with `\\x00` in the serialized key). That means collisions (and incorrect supersede/lookup behavior) are still possible. Use an encoding that guarantees round-tripping (e.g., length-prefix each part, base64/URL-encode each part, or escape `\\` first and then escape `\^@`).

### 126. PR #1308 — `extensions/memory-hybrid/services/active-task-checkpoint.ts:411`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `CLOSED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-10T22:03:08Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594009
- Feedback: In `safeJson()`, the fallback `String(value)` can itself throw if `value` is an object with a throwing `toString`/`Symbol.toPrimitive`. That would cause `safeJson` to unexpectedly throw in the very scenario it is meant to harden. Wrap the preview generation in its own try/catch (and fall back to something like `Object.prototype.toString.call(value)` or a constant string) so `safeJson` is guaranteed not to throw.

### 127. PR #1308 — `extensions/memory-hybrid/services/active-task.ts:1067`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `CLOSED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-10T22:03:08Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594013
- Feedback: `writeActiveTaskFileOptimistic` now throws after exhausting retries, but there is no test covering the new failure mode (previously it performed a last-write-wins fallback). Add a test that forces repeated mtime changes until `maxRetries` is exceeded and asserts the function throws with a helpful message, so this concurrency behavior doesn’t regress silently.

### 128. PR #1308 — `extensions/memory-hybrid/services/goal-stewardship-heartbeat.ts:56`

- Status: **ADDRESSED BY MAIN / PRIOR REMEDIATION**
- Evidence: This item is part of the earlier merged/closed PR recovery inventory in `docs/recovery/unresolved-feedback-2026-05-11.md`; the underlying remediation was merged to `main` through PR #1332 before PR #1333 was opened.
- Source PR state: `CLOSED`
- Thread outdated: `False`
- Author: `copilot-pull-request-reviewer`
- Comment updated: `2026-05-10T22:03:08Z`
- URL: https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1308#discussion_r3215594020
- Feedback: The comment says "Use immutable cache with Map for thread safety", but the cache isn’t immutable (the Map is mutated, and callers receive the cached array by reference). This is misleading documentation; consider rewording to describe the actual behavior (memoization keyed by pattern list) and/or freezing/cloning the returned array if immutability is intended.
