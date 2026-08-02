# Configurable target stewardship guardrails
Canonical targets are caller-supplied `goal.dispatchPolicy` data: the plugin has no production default repository, PR, branch, head, or model. Write dispatches fail closed unless requests exactly match configured PR, branch, remote head, agent, scope, and no-new-PR/no-new-branch rules. The existing locked dispatch ledger stores target metadata, owner/run/session leases, expiry recovery, and receipts. Receipts require requested/resolved model, `modelApplied`, start/end head, outcome, and evidence. Progress requires a source `TASKS` reference plus direct implementation and verification evidence; diff scope is configurable.

The following verified mappings are examples only, not defaults. Existing PR only; no new PR.

| Work item | Repository | PR / branch / head | Required model |
| --- | --- | --- | --- |
| M-CCA | `markus-lassfolk/ts-sh-armor-mvp` | #909 `feat/m-cca-minimax-m3-authority` `42e6c31bff52e85c37577bd766e480fd203e92d3` | Furnace-M3 exact MiniMax M3 |
| M-IAT | `markus-lassfolk/ts-sh-armor-mvp` | #940 `feat/m-iat-investigation-atlas-v2` `527d5bfc74e4398c3340e77171e53063cd0b062d` | Furnace exact MiniMax M2.7 |
