# Goal stewardship — operator guide

This document is for **humans** operating the OpenClaw hybrid-memory plugin with long-running goals. For design rationale and edge cases, see [GOAL-STEWARDSHIP-DESIGN.md](GOAL-STEWARDSHIP-DESIGN.md).

## Enable and locate data

1. Set **`goalStewardship.enabled: true`** in the plugin memory config (same file as other hybrid-memory settings).
2. Goals are stored as JSON under the workspace, by default **`state/goals/`** (relative to `OPENCLAW_WORKSPACE`, usually `~/.openclaw/workspace`). Override with **`goalStewardship.goalsDir`** if needed.
3. **Tactical tasks** live in **`ACTIVE-TASKS.md`** (see **`activeTask.*`** in config). Optional **task hygiene** on heartbeat — stale nudges, optional long-running hints, and tool **`active_task_propose_goal`** — is documented in **[TASK-HYGIENE.md](TASK-HYGIENE.md)**.
4. Optional toggles:
   - **`heartbeatStewardship`** — inject stewardship when the last user message matches a **heartbeat pattern** (built-in defaults include “heartbeat”, “scheduled ping”, “cron heartbeat”; override with **`goalStewardship.heartbeatPatterns`**).
   - **`watchdogHealthCheck`** — run deterministic checks (budget, staleness, mechanical verification) on the plugin’s five-minute timer (default: on).
   - **`heartbeatRefreshActiveTask`** — on each heartbeat match, rewrite **`ACTIVE-TASKS.md`** with an **## Active Goals** mirror section (requires **`activeTask.enabled`**). Do not edit that section by hand.
   - **`multiGoalMaxChars` / `multiGoalMaxGoals` / `attentionWeights`** — cap and prioritize multi-goal stewardship prepends (defaults: weights critical 4×, high 2×, medium 1×, low 0.5×).
   - **`confirmationPolicy`** — priorities that require **`confirmed: true`** on **`goal_register`** after user approval (default: critical and high).
   - **`llmTriageOnHeartbeat`** — optional nano LLM triage for “needs heavy” hints (default: off; enable only when API keys and cost are acceptable).
   - **`circuitBreaker`** — optional automatic **stop and escalate** when **`goal_assess`** is called repeatedly with the **same blockers** (or when too many assessments occur without the blocker fingerprint changing). Default **`enabled: false`**. When enabled, set at least one of **`sameBlockerRepeatLimit`** (≥1) or **`maxAssessmentsWithoutProgress`** (≥1); **`0`** means off for that threshold. On trip: goal becomes **`blocked`**, **`humanEscalationSummary`** holds a human-readable brief (blockers, criteria, linked tasks, recent history), **`appendMemoryEscalation`** (default on) appends the same to **`memory/YYYY-MM-DD.md`**, and the event log may record **`goal.circuit_breaker`**. This is separate from **`escalateAfterFailures`** (subagent / PID failures), which the watchdog already enforces.

## CLI (observability)

All commands are under **`openclaw hybrid-mem goals`**:

| Command | Purpose |
| --- | --- |
| `list` | Active goals (use `--all` to include completed / failed / abandoned). |
| `status <idOrLabel>` | Full JSON for one goal (UUID or case-insensitive label). |
| `cancel <idOrLabel> --reason "<text>"` | Mark goal **abandoned** with a reason. |
| `stewardship-run` | Run one deterministic health pass (requires `goalStewardship.enabled`; forces the same checks as the watchdog for that run). |
| `audit` | JSON snapshot of goals + config subset; add **`--jsonl`** for NDJSON (one object per goal). |

## Agent tools

Agents use underscore names: **`goal_register`**, **`goal_assess`**, **`goal_update`**, **`goal_complete`**, **`goal_abandon`**. Stewardship is disabled until `goalStewardship.enabled` is true; tools then respond with a clear error if disabled.

For promoting work from **`ACTIVE-TASKS.md`** into a registered goal, use **`active_task_propose_goal`** (draft fields for **`goal_register`**; requires **`activeTask.enabled`**). Details: **[TASK-HYGIENE.md](TASK-HYGIENE.md)**.

## What the watchdog does (no LLM)

On the timer (when enabled), the plugin checks each non-terminal goal for: dispatch/assessment budgets, escalation after repeated failures, dead subagent PIDs linked to tasks, staleness (idle vs cooldown), and optional **mechanical** verification (`file_exists`, `command_exit_zero`, `http_ok`) when configured on the goal.

## Episodic memory and audit

Successful completions can append a short summary under **`memory/`** (date-stamped files) when the tool path is configured. Goal history is stored **on the goal JSON** (`history` array). Event-log entries may be written for budget and staleness when an event log is available.

**Audit playbook:** [GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md](GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md) — how to trace failures and correlate CLI, files, and logs.

## Automated tests (developers)

Plugin CI runs stewardship tests without OpenClaw core: a **mock plugin API** (`extensions/memory-hybrid/tests/harness/mock-plugin-api.ts`) registers the same lifecycle handlers and emits synthetic `before_agent_start` / subagent events. See `tests/goal-stewardship-integration.test.ts` for the heartbeat + subagent flow.

## Troubleshooting

- **No goals in CLI:** Confirm workspace path (`OPENCLAW_WORKSPACE`), `goalsDir`, and that JSON files exist under that directory.
- **No stewardship on heartbeat:** Confirm `heartbeatStewardship` is not `false` and that the user message matches a configured or default **heartbeat pattern** (not only the literal word “heartbeat”).
- **Goals blocked:** Check `currentBlockers` via `goals status`; budget and escalation are enforced by the watchdog and tools. If **`escalationKind`** is **`circuit_breaker`**, read **`humanEscalationSummary`** on the goal JSON (or the **`memory/`** append) for what failed and what was already tried.
