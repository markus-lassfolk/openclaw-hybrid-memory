# CLI Observability Contract (issue #2106)

This document defines the house convention for **long-running, mutating, or
provider-dependent** `hybrid-mem` CLI commands — those that touch SQLite,
LanceDB, wiki mirrors, task/goal stores, credentials, or call an
embedding/LLM provider, and can run for more than a few seconds.

It exists because a silent, slow, mutating command is operationally
ambiguous: an operator (or an agent supervising a cron job) cannot tell
whether it's actively working, waiting on a provider, blocked on a lock, or
hung. See [issue #2105](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2105)
for a concrete case (`verify --fix --reconcile` going silent for minutes)
and its fix.

## 1. Progress heartbeat — the canonical primitive

Use `runMaintenanceHeartbeat(label, verbose, fn, opts)` from
`cli/commands/manage/maintenance-heartbeat.ts` for any command-layer loop
that can take more than a few seconds:

```ts
await runMaintenanceHeartbeat(
  "verify-reconcile:rebuild-sqlite-orphans",
  verbose,
  async (heartbeat) => {
    for (const item of items) {
      // ...do work...
      processed++;
      heartbeat.heartbeat(); // cheap: internally debounced by heartbeatIntervalMs
    }
  },
  {
    heartbeatIntervalMs: 20_000, // default 60_000; shorten for interactive commands
    progressSupplier: () => `stage=rebuild; processed=${processed}/${items.length}; failed=${failed}`,
  },
);
```

This emits `"<label> — start"` and `"<label> — complete in <N>s"` unconditionally
when `verbose` is true (regardless of elapsed time — cheap to assert in
tests), plus a periodic `"<label> — still running after <N>s; <progress>"`
line while the interval has elapsed. `jsonMode: true` reroutes these lines to
stderr so `--json` callers keep stdout clean for the final structured result
(see §5 — this is **not** a structured JSON progress event).

Two sibling implementations exist for callers with different shapes — use
whichever matches your call site, don't invent a third:
- **`runStepWithHeartbeat`** (`services/maintenance-orchestrator.ts`) — same
  start/heartbeat/complete shape, but logs via a `{ info, warn }` logger
  instead of `console.*`, with defensive try/catch so a broken logger
  transport can't crash the gateway. Use this for orchestrator-tier steps.
- **`startDistillProgress`** (`cli/cmd-distill.ts`) — a bespoke variant with
  the same shape, predating the two generic helpers above. New distill-family
  work should still use it for consistency with existing distill output.

## 2. Phase logging

For commands with distinct stages (not just one loop), log phase
transitions as plain lines — `scan`, `plan`, `execute`/`embed`/`upsert`,
`verify`, `summarize`. This is additive to §1, not a replacement: each phase
can be its own `runMaintenanceHeartbeat` call (own label, own progress
supplier), or one shared `heartbeat()` controller threaded through phases if
they share a single logical operation. There is no dedicated "phase machine"
helper — phases are just heartbeat labels chosen to say what's happening
right now.

## 3. Mutating repair summaries

Commands using `--fix`, `--repair`, `--reconcile`, `--prune`, `--migrate`, or
similar should report, in the final summary:
- what was planned (candidates found),
- what was changed (counts, by outcome),
- what was skipped and why (budget, policy, guard),
- what failed (counts; don't silently swallow),
- whether a post-check/verification ran and passed.

This is already the norm for most maintenance/repair commands in this
codebase (`storage reembed`, `doctor --fix`, `verify --fix --reconcile`,
`credentials prune`, `scope prune` all print planned/changed/skipped/failed
breakdowns) — the gap is almost always the *heartbeat* during the work, not
the summary after it.

## 4. Interruption / deadline awareness

Loops inside orchestrator-tier steps should consult
`maintenanceRunDeadlineReached()` (`utils/maintenance-run-deadline.ts`) and
stop early — logging how far they got — rather than run past the
orchestrator's own run-length budget. Interactive commands (run directly by
an operator, not the orchestrator) generally don't have a deadline set and
this check is a no-op for them; it costs nothing to add defensively.

## 5. JSON mode: no streaming progress events (deliberate, for now)

None of the three heartbeat implementations emit structured JSON progress
events today — `jsonMode` only reroutes the human-readable heartbeat lines
to stderr so stdout stays a clean, single final JSON object. This is a
**deliberate decision for this pass, not an oversight**: building a
streamable progress-event protocol (`{"type":"progress",...}` lines) is a
larger, cross-cutting change with no consumer yet. Revisit if/when a
dashboard or watchdog needs to consume progress programmatically rather than
just confirming liveness.

## Current-state audit (as of the #2105/#2106 pass)

| Command family | Verdict | Notes |
|---|---|---|
| `verify --fix --reconcile` | **Compliant** (fixed by #2105) | Heartbeat-wrapped vector-orphan delete and SQLite-orphan rebuild loops; `--verbose` now actually threads through; deadline-checked. |
| `doctor --fix` | Partial | Each repair area has a hard timeout (`withTimeout`) and a final structured summary, but no periodic tick while running. |
| `maintenance nightly` / orchestrator steps | Compliant | Reference implementation — every step runs through `runStepWithHeartbeat`. |
| `storage reembed` / `re-index` | Mostly compliant | `reembed-vectorless` is heartbeat-wrapped; `re-index` gets volume-based progress (every 100 facts) from the underlying migration helper, not time-based. |
| `storage repair` | **Gap** | The repair pipeline itself has no logging; only the command handler's final report. Candidate for the next follow-up. |
| distill / reflect / extract / self-correction | Compliant | Distill has its own dedicated heartbeat; reflection-pipeline and self-correction commands use `runMaintenanceHeartbeat` directly. |
| `credentials rekey-vault` / `encrypt-vault` / `migrate-to-vault` | **Gap** | Fully silent per-row loops over the whole vault; only a final `{migrated/rekeyed/verified/errors}` summary. Candidate for the next follow-up, especially for large vaults. |
| `scope prune` / `credentials prune` | Partial | Single bulk-delete with one final summary line; acceptable today since these are fast bulk SQL ops, not iterative per-row work. |
| `wiki export` / mirror rebuilds | Partial | One final summary; no progress during the file/fact iteration. |

**Not fixed in this pass** (flagged for follow-up, in priority order): the
`storage repair` pipeline's silence, and the credential vault
migration/rekey/encrypt commands' silence on large vaults. Both are lower
urgency than `verify --fix --reconcile` (#2105) since they're less
frequently run interactively and don't currently have a reported "looks
hung" complaint — but they're the next candidates once one is reported.
