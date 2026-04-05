# Task hygiene (ACTIVE-TASK.md)

This document describes **tactical** hygiene for rows in **`ACTIVE-TASK.md`** — separate from **goal stewardship** (`state/goals/`), which is the strategic layer. See [GOAL-STEWARDSHIP-OPERATOR.md](GOAL-STEWARDSHIP-OPERATOR.md) for goals.

## What it does

1. **Heartbeat escalation** — When `activeTask.taskHygiene.heartbeatEscalation` is not `false` and the **last user message** matches a **heartbeat pattern** (same sources as goal stewardship: built-in defaults and `goalStewardship.heartbeatPatterns`), the plugin prepends a short **`<task-hygiene>`** block after the usual active-task summary and optional stale warnings. The block reminds the agent to reconcile the file (complete work, update **Next**, verify subagents) before replying with **`HEARTBEAT_OK`** (or equivalent).

2. **Optional “consider a goal” hint** — Set **`activeTask.taskHygiene.suggestGoalAfterTaskAgeDays`** to a positive number. On heartbeat turns, tasks whose **`Updated`** timestamp is older than that many days are listed as long-running, with a pointer to **`active_task_propose_goal`** and then **`goal_register`**. Default is **`0`** (off). This does **not** create goals automatically.

3. **Size cap** — **`activeTask.taskHygiene.heartbeatNudgeMaxChars`** (default **2500**, minimum **200** in the config parser) limits the hygiene block length.

## Configuration (plugin memory config)

```json
"activeTask": {
  "enabled": true,
  "filePath": "ACTIVE-TASK.md",
  "taskHygiene": {
    "heartbeatEscalation": true,
    "suggestGoalAfterTaskAgeDays": 0,
    "heartbeatNudgeMaxChars": 2500
  }
}
```

Heartbeat **pattern** matching always uses **`goalStewardship`** heartbeat settings (patterns and compilation). If you customize patterns, both goal stewardship prepends and task hygiene use the same matchers.

## Agent tool: `active_task_propose_goal`

**Parameters:** `task_label` (string) — matches an active row label (exact match first, then case-insensitive).

**Behavior:** Reads **`ACTIVE-TASK.md`** at the configured path (resolved from `OPENCLAW_WORKSPACE`), finds the task, and returns a **draft** JSON payload suitable for **`goal_register`** (`label`, `description`, `acceptance_criteria`). Refine with the user and respect **`goal_register`** confirmation policy (`confirmed: true`) when configured.

Requires **`activeTask.enabled`**. The tool is registered with the plugin regardless of **`goalStewardship.enabled`**; registering a goal still requires goal stewardship to be on and within global limits.

## Operations

- **CLI:** `openclaw hybrid-mem active-tasks reconcile` — keeps subagent bookkeeping honest before you trust **`ACTIVE-TASK.md`** for heartbeats or audits.
- **Goals mirror:** When **`goalStewardship.heartbeatRefreshActiveTask`** is on, heartbeat also refreshes the **`## Active Goals`** mirror in **`ACTIVE-TASK.md`** (do not edit that section by hand).

## Related docs

- [GOAL-STEWARDSHIP-DESIGN.md](GOAL-STEWARDSHIP-DESIGN.md) — goals vs tactical tasks
- [GOAL-STEWARDSHIP-OPERATOR.md](GOAL-STEWARDSHIP-OPERATOR.md) — enabling goals and CLI
