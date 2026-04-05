- **What `TOOLS.md` is:** Guidance for you only—it does **not** turn tools on or off. See OpenClaw [Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace).
- **Naming:** Memory-hybrid tools use **underscore** names (`memory_store`, `memory_recall`, `memory_forget`, …). Do not use dotted names (they break some providers).
- **Layers:** Plugin = structured facts (FTS) + vector recall (LanceDB). **memorySearch** searches `memory/**/*.md`. Keep **MEMORY.md** short; put detail in `memory/**`.
- **When to call tools:** Use `memory_store` when the user asks to remember something durable or when a fact must survive compaction. Use `memory_recall` when you need to search beyond auto-recall. Use `memory_directory` for **structured** contacts or org-centric views (people linked to an org, fact ids per org)—not a substitute for ad-hoc `memory_recall` search.
- **Verification:** If recall is empty or wrong, check embedding config and run `openclaw hybrid-mem verify` (after gateway restart if you changed config). After bulk imports or upgrades, **`openclaw hybrid-mem enrich-entities`** backfills PERSON/ORG extraction for facts missing rows.
- **Self-correction:** This plugin may add bullets under `## Self-correction rules` (or your configured section). Keep that section; do not strip it when editing `TOOLS.md` manually.
- **Goal stewardship (when `goalStewardship.enabled: true`):**

| Tool | When to call |
|------|-------------|
| `goal_register` | User assigns a multi-session, outcome-oriented goal |
| `goal_assess` | Every heartbeat stewardship turn — record observations and next action |
| `goal_update` | Goal description, criteria, or priority needs updating |
| `goal_complete` | ALL acceptance criteria are verifiably met |
| `goal_abandon` | Goal is no longer relevant (user decision) |
| `active_task_propose_goal` | Draft a `goal_register` payload from an `ACTIVE-TASKS.md` row |

**Subagent naming:** Use the goal label as a prefix for subagents that work toward it. Example: goal `deploy-api` -> subagents `deploy-api-run-tests`, `deploy-api-create-pr`. CLI: `openclaw hybrid-mem goals list|status|cancel|budget|reset-budget|stewardship-run|audit`. See [Goal stewardship design](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-DESIGN.md), [Operator guide](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-OPERATOR.md), and [Task hygiene](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TASK-HYGIENE.md).
- **More detail:** Workspace skill `skills/hybrid-memory/` (`SKILL.md` + `references/memory-optimization.md`, installed by `hybrid-mem install`) and repo docs: [Memory Protocol](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MEMORY-PROTOCOL.md).
