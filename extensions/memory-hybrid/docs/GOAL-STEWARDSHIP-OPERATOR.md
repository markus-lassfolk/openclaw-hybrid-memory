
### Dispatch authorization (fail-closed deployment)

Set `goalStewardship.dispatchAuthorization.enabled: true` before allowing goal-linked `sessions_spawn` work. Once enabled, every such spawn must carry an explicit `goal_dispatch` declaration and the goal must contain a version-1 `dispatch_policy`. The gate records each decision in `state/goals/dispatch-audit/<goal-id>.jsonl` before allowing a spawn. Missing/legacy policies are denied; this is intentional compatibility behavior, so migrate active goals by registering an explicit policy or disable the gate to roll back. The policy pins task class, role, canonical PR/branch/remote SHA, write scope, and PR/branch creation prohibitions. It does not create PRs, merge, or change product code.
