# Release notes — 2026.7.227

## Fixed

- The nightly maintenance orchestrator CLI now initializes the error reporter before running steps, so a failing `reflect-rules` stage reports its real diagnostics (parse failure reason, which model/fallback answered) to GlitchTip instead of only a generic "stage failed" summary.
- The semantic query cache's table-rebuild self-repair no longer races an in-flight cache read/write, which could surface as a LanceDB "stream not found" error; that specific transient message is also no longer reported as an exception, since it was already handled as a safe cache miss.
- The generated cron harness now runs the supported `maintenance validate-exit` command instead of the deprecated `validate-cron-exit` alias, and writes its guard file mechanically — gated on the wrapped step, the validator's own exit code, its parsed status, and an independent recheck of every required step in the exit ledger — instead of trusting the executing agent to write it correctly.
- `VectorDB` no longer resolves a helper via a runtime `import()` that could fail under OpenClaw's custom plugin loader; it's now a static import.
- Compaction no longer crashes with a "database connection is not open" error if it runs while the store is mid-teardown; it now no-ops safely.
- `memory_loop_list` and five sibling stores (learnings, beliefs, serendipity findings, issues, drift) no longer crash when an array-typed filter field is passed a bare string instead of an array — a pattern reachable from ordinary LLM tool use.
- Nightly maintenance telemetry now tags LLM-call failures with a coarse failure class, and includes distill batch-failure counts and analyzer finding titles directly in GlitchTip issue data instead of only summary counts.

## Changed

- Nightly maintenance telemetry no longer fires redundant GlitchTip issues for the same underlying failure — a generic "step exited non-zero" issue is dropped when a more specific issue already explains it, and the top-level "job exited non-zero" issue is dropped when other issues from the same run already explain what happened.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.7.227`.
