
### Dispatch authorization (fail-closed deployment)

Set `goalStewardship.dispatchAuthorization.enabled: true` to gate goal-linked `sessions_spawn` work; unrelated sessions remain unaffected. A goal-linked spawn needs a `goal_dispatch` declaration and that goal needs a version-1 `dispatch_policy`. The policy is generic: `classes` maps caller-defined class names to `{ allowedAgents, readOnly, canonical?, writeScope?, forbidNewPr?, forbidNewBranch? }`. No agent names, roles, or built-in class taxonomy are implied. The declared `requestedAgent` must exactly equal the host `agentId`, and the selected class must allow it. Read-only work must explicitly declare `readOnly: true` and select a read-only class. Write classes require a canonical PR/branch/remote SHA, non-empty allowed and requested scopes, and explicit `createsPr`/`createsBranch` declarations. Missing, malformed, or stale policies default-deny; every decision is recorded in `state/goals/dispatch-audit/<goal-id>.jsonl`. The gate does not create PRs, merge, or change product code.

## Core dispatch-authorization companion required

This plugin PR supplies the Hybrid Memory goal-policy adapter and the versioned
`contracts/core-dispatch-authorization.ts` ABI. It **does not itself provide
system-wide enforcement**: plugin `before_tool_call` hooks cannot be the
irreversible boundary for all native, ACP, cron-created, and direct gateway
child dispatch paths, nor can they persist grants or atomically reserve actual
usage.

A required upstream OpenClaw core companion must invoke registered providers at
that common pre-child-run boundary for `sessions_spawn` (native and ACP), cron
agent-turn child work, and direct gateway dispatch. With no provider configured
it must preserve today’s behavior. With enforcement enabled it must: build the
immutable ABI context from host state; atomically reserve goal, per-dispatch,
and per-agent/runtime budget before child allocation; persist the opaque,
short-lived grant on child metadata; verify it at launch; reconcile measured
usage and release reservations on completion/failure. Lifecycle events are
strictly audit/reconciliation signals, never the enforcement point.

`dispatchAuthorization.enabled` remains disabled in production configuration.
