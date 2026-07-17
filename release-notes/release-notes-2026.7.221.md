# Release v2026.7.221

Closes three open issues filed from live Maeve host telemetry (#2141, #2142, #2143).

## Fixed — Maintenance orchestrator hangs with no terminal exit ledger

- **`maintenance-nightly` could stall forever inside a single hung step (e.g. `enrich-entities`), past its 420s heartbeat, with no terminal exit ledger or summary** (#2141) — `runMaintenanceOrchestrator` awaited each step's runner with no timeout of its own; the orchestrator's `maxRuntimeMs` time budget was only checked *between* steps, so a step that never settled (a stuck network/LLM call with no internal timeout) blocked the loop indefinitely. Because the consolidated `maintenance-nightly` cron job wraps the entire orchestrator run in a single `hm_step`, a hung step meant the cron harness process itself never exited — `HM_EXIT` / `validate-cron-exit` never ran, and the run was left stale with no diagnosable terminal state.

  `runStepWithHeartbeat` now races each step against a hard watchdog timeout (default **30 minutes** — kept below the 45-minute threshold `maintenance-log-analyzer` uses to flag a run as stale, so the orchestrator self-terminates before the external analyzer would otherwise fire on an empty ledger). On timeout the step is recorded as a `failed` result with a clear `"exceeded max runtime of Ns (aborted by watchdog)"` summary, its step lock is released so a later run can retry it, and the orchestrator continues to the remaining steps before returning a real non-zero exit code — so the cron harness always reaches its terminal ledger/validation state instead of hanging. Node has no true cancellation for an arbitrary in-flight promise, so an abandoned call is left to settle on its own; its eventual outcome is swallowed so it can never surface as an unhandled rejection and crash the process.

  New config: `maintenance.orchestrator.stepTimeoutMinutes` (optional override; default 30).

## Documentation — Ops guidance for cron/gateway version drift and health-check scripts

- **Health-check cron scripts must probe the gateway, not `systemctl`** (#2142) — reported symptom: a custom `hybrid-memory-health.cron`-style monitoring script reported `gateway_active=inactive` on every tick while `gateway-ensure` and direct gateway probes showed the gateway healthy. Root cause: deriving liveness from `systemctl --user is-active openclaw-gateway.service` — unreliable both because WSL2/containers commonly have no systemd user session at all (the gateway runs in the foreground or under a cron watchdog instead), and because even a real systemd unit's tracked state can diverge from the process's actual RPC-reachable health. `docs/OPERATIONS.md` gains a new "Writing a health-check cron job" section spelling out the correct pattern — `openclaw gateway probe` (or `openclaw gateway status --json --timeout 45000`) as the *only* liveness signal, matching what `scripts/gateway-watchdog-cron.sh` already does — with `systemctl` state, if wanted at all, logged only as separate diagnostic metadata that never overrides the probe result.

- **Version source of truth: cron vs. gateway can load different plugin copies** (#2143) — reported symptom: cron/CLI resolved a different `openclaw-hybrid-memory` version than the one the live gateway had loaded, with no error. `docs/OPERATIONS.md` gains a new "Version source of truth" section documenting:
  - the two canonical install trees inside `~/.openclaw` (`extensions/` vs. the OpenClaw-managed `npm/projects/` copy) and how `openclaw hybrid-mem doctor --fix` / `verify --fix` reconcile a stale copy of either (see `UPGRADE-PLUGIN.md § Extensions-canonical hosts`);
  - the three additional accidental-location paths those same commands already detect and quarantine;
  - a fourth path they do **not** cover: a separately `npm install -g openclaw-hybrid-memory`'d copy living entirely outside `~/.openclaw`, which a cron job's `PATH` can resolve ahead of whatever the gateway actually loaded — this is the gap that produces silent version skew;
  - the read-only commands to check both sides (`openclaw hybrid-mem --version` for the current shell/cron context, `openclaw hybrid-mem doctor` for what the gateway loaded) and the manual alignment command for the uncovered global-install case.

- Also de-duplicates `docs/UPGRADE-PLUGIN.md`, whose entire body had been accidentally repeated twice (pre-existing, unrelated to any of the three issues above — fixed in passing since it sits directly in the section being documented).

## Notes

- No `schemaVersion` bump — no storage-schema changes.
- No agent-tool contract changes.
- #2142 and #2143 describe host-side operator scripts (`hybrid-memory-health.cron`, `gateway-ensure`) that are not part of this package and cannot be edited from here; the fix gives them the correct pattern to adopt and documents the failure mode precisely, using only mechanisms this repo already ships (`openclaw gateway probe`, `openclaw hybrid-mem doctor`).
