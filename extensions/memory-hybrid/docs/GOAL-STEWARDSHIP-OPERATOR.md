
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

### Core dispatch authorization bridge (ABI v1)

`goalStewardship.dispatchAuthorization.enabled` defaults to `false`. Installing this plugin never enables core dispatch enforcement. When enabled, the plugin registers three authenticated, operator-admin gateway methods: `memory-hybrid.core-dispatch.v1.authorize`, `.reconcile`, and `.health`. Core must make the authorization call with its closed, host-derived context (`trustedByCore: true`), persist and validate the returned opaque grant before launch, and call reconcile with `completed`, `failed`, or `cancelled` to release reservations.

This bridge is a provider-side prerequisite, not enforcement by itself: a **separate authorized local OpenClaw core patch** must discover/invoke these methods at every native, ACP, cron, and direct-dispatch lifecycle boundary. The provider rejects goal/task labels and arbitrary tool metadata as authority. Grant accounting is atomic only among processes sharing a local POSIX filesystem (`mkdir` lock plus atomic rename); NFS/distributed/weakly-consistent stores are unsupported and must not be represented as cross-host guarantees. The ledger records only grant ids, goal ids, budgets, timestamps, and terminal outcomes—no prompt/tool payloads.
