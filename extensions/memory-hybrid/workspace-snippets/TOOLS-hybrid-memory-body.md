- **What `TOOLS.md` is:** Guidance for you only—it does **not** turn tools on or off. See OpenClaw [Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace).
- **Naming:** Memory-hybrid tools use **underscore** names (`memory_store`, `memory_recall`, `memory_forget`, …). Do not use dotted names (they break some providers).
- **Layers:** Plugin = structured facts (FTS) + vector recall (LanceDB). **memorySearch** searches `memory/**/*.md`. Keep **MEMORY.md** short; put detail in `memory/**`.
- **When to call tools:** Use `memory_store` when the user asks to remember something durable or when a fact must survive compaction. Use `memory_recall` when you need to search beyond auto-recall. Use `memory_directory` for **structured** contacts or org-centric views (people linked to an org, fact ids per org)—not a substitute for ad-hoc `memory_recall` search.
- **Verification:** If recall is empty or wrong, check embedding config and run `openclaw hybrid-mem verify` (after gateway restart if you changed config). After bulk imports or upgrades, **`openclaw hybrid-mem enrich-entities`** backfills PERSON/ORG extraction for facts missing rows.
- **Maintenance:** Default schedule uses the **orchestrator** — gateway tick (`maintenance cycle`) + one nightly cron (`maintenance nightly`). Inspect with **`openclaw hybrid-mem maintenance steps`**; full catch-up: **`maintenance full`** or **`run-all`**. See workspace skill `references/memory-optimization.md`.
- **Credentials vault (when enabled):** Secrets live in the vault only; memory holds pointers. Use **`credential_get`** / **`credential_store`** — not `memory_store` for secrets. **`type`** is the secret kind (`token`, `password`, `api_key`, `ssh`, `bearer`, `other`) — put endpoint URLs in the optional **`url`** parameter, not `type=url`. CLI: `credentials list`, `credentials get --service <name>`, `credentials vault-status`.
- **Self-correction:** This plugin may add bullets under `## Self-correction rules` (or your configured section). Keep that section; do not strip it when editing `TOOLS.md` manually.
- **Goal stewardship (when `goalStewardship.enabled: true`):**

| Tool | When to call |
|------|-------------|
| `goal_list` / `goal_get` | Discover goals — **not** via `memory_recall` |
| `goal_register` | Multi-session outcome (measurable criteria; retry with `confirmed: true` after clarity prompts) |
| `goal_assess` | Every heartbeat stewardship turn — record observations and next action |
| `goal_update` | Goal description, criteria, or priority needs updating |
| `goal_complete` | ALL acceptance criteria are verifiably met |
| `goal_abandon` | Goal is no longer relevant (user decision) |
| `active_task_checkpoint` | Before ending turns with pending work; set `relatedGoal`, checkpoint facts + optional wake; auto-refreshes projection when ledger=facts |
| `active_task_list` / `active_task_get` | List or fetch tasks from facts ledger or ACTIVE-TASKS.md |
| `active_task_propose_goal` | Draft a `goal_register` payload from a task row (facts-aware) |

Every turn shows `<active-goals-summary>` when enabled. On heartbeat pulses, run `goal_assess` before `HEARTBEAT_OK`. If tools return `wrapper_args_dropped`, retry top-level or restart session.

**Subagent naming:** Use the goal label as a prefix for subagents that work toward it. Example: goal `deploy-api` -> subagents `deploy-api-run-tests`, `deploy-api-create-pr`. CLI: `openclaw hybrid-mem goals list|status|cancel|budget|reset-budget|stewardship-run|audit`. See [Goal stewardship design](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-DESIGN.md), [Operator guide](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-OPERATOR.md), and [Task hygiene](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TASK-HYGIENE.md).
- **More detail:** Workspace skill `skills/hybrid-memory/` (`SKILL.md` + `references/memory-optimization.md` — copied on first gateway start if missing; refreshed via **`openclaw hybrid-mem install`**) and repo docs: [Memory Protocol](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MEMORY-PROTOCOL.md), [Maintenance matrix](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md).
