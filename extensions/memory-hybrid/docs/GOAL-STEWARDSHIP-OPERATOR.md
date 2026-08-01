# Goal stewardship operator notes

## Managed dispatch broker

`goal_dispatch` is a supported plugin integration, disabled unless goal stewardship is enabled. It requires the **canonical goal UUID**: labels and task text never establish authority. The goal policy must contain a `managed` class with an explicit `allowedAgents` list. The broker creates an opaque, expiring grant and atomically reserves the requested budget before work is started.

The broker uses a JSON ledger protected by `mkdir` locking and atomic rename. Its guarantees are limited to processes sharing a strongly consistent local POSIX filesystem. It is neither a distributed transaction nor a safe guarantee on NFS/other weakly consistent filesystems. The ledger records identifiers, target/runtime, budget, lifecycle state and redacted reasons—not prompts or grant secrets.

For **native** work, `goal_dispatch` launches through the public `api.runtime.subagent.run` SDK. A launch failure releases the reservation. The public `subagent_ended` hook settles native launches where a run id is provided; expiry releases abandoned reservations. The currently public plugin runtime exposes no ACP launcher. ACP requests are reserved but returned as a redacted `dispatch_request` for a trusted host launcher to validate, launch and reconcile. The plugin does not claim a tool-only ACP launch.

## Direct-spawn migration and enforcement

`goalStewardship.dispatchAuthorization.mode` is `disabled` by default, preserving existing behavior.

* `disabled`: no model-tool interception.
* `audit`: permits model-visible `sessions_spawn` (native and ACP) and records direct attempts/would-be denials in `state/goals/dispatch-audit/` for inventory and migration.
* `enforce`: blocks direct model-visible `sessions_spawn` (native and ACP). The public hook has no trusted provenance channel to attach a broker grant to a subsequent model tool call, so there is deliberately **no model-supplied grant exception**.

Migrate managed cron work by having a trusted host launcher call/consume a `goal_dispatch` request, retain the returned dispatch id externally, then reconcile it after the child ends. Administrative/direct Gateway, cron control-plane and other runtime routes outside model-visible `sessions_spawn` do not traverse this hook. Treat them as break-glass/unmanaged until moved to the launcher and write a redacted event shaped as `{route, actor, goalId:null, reason, timestamp}`. This operational boundary is intentional; plugin hooks are not system-wide control-plane enforcement.
