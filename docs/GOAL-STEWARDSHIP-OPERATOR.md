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
   - **`escalationPolicy.taskHygieneOnBlockedGoals`** — when **task hygiene** runs on a heartbeat match, also prepend a **`<goal-escalation>`** snippet if any goal is **`blocked`** or **`stalled`** (default: **true**). Set to **false** to disable the cross-layer nudge.

## Heartbeat scheduling checklist

Goal stewardship **injection** runs on **`before_agent_start`** only when the **last user message** matches **`goalStewardship.heartbeatPatterns`** (or the built-in defaults: “heartbeat”, “scheduled ping”, “cron heartbeat”, case-insensitive). The plugin’s **watchdog** does **not** start LLM turns; it only updates deterministic goal state on a timer.

1. **Confirm patterns:** List effective patterns with `openclaw hybrid-mem goals config` (or your config file). `openclaw hybrid-mem verify` prints how many matchers compiled and warns if `~/.openclaw/cron/jobs.json` has no job message matching those patterns.
2. **Cron / job message:** Ensure the string OpenClaw delivers as the **user** message for your scheduled job matches a pattern. Examples that match defaults:
   - `heartbeat`
   - `scheduled ping`
   - `cron heartbeat`
3. **Troubleshooting — no stewardship prepend:** Check gateway logs for `goal stewardship`; confirm the **actual** last user text (not only the job title). Adjust **`heartbeatPatterns`** or the job **`message` / `payload.message`** so they align.

### Host boundary (synthetic turns)

This plugin **reacts** to agent turns; it does **not** enqueue scheduled LLM runs. To get recurring stewardship prepends, **OpenClaw** (or your host) must deliver messages that match your heartbeat patterns — e.g. via **`jobs`** / cron in `~/.openclaw/cron/jobs.json`. Upstream scheduling features belong in **OpenClaw core**; the hybrid-memory plugin stays local-first and does not replace the host scheduler.

---

## User guide: scheduled stewardship, agents, and “how often?”

This section is for **everyday operators** who want recurring goal check-ins without reading plugin source code.

### Two different things (do not confuse them)

| What | What it does | Uses the LLM? |
| --- | --- | --- |
| **Watchdog** (`watchdogHealthCheck`, ~every 5 minutes) | Updates goal JSON: budgets, stalled / blocked, mechanical checks, PID links, etc. | **No** |
| **Heartbeat stewardship** (`heartbeatStewardship`) | When a **new turn starts**, if the **last user message** matches your heartbeat patterns, the plugin **prepends** goal context so the model can call `goal_assess` and related tools. | **Yes** (this turn) |

So: **the watchdog can run while nothing “talks” to the model.** If you want the **agent to actively work goals on a schedule**, you need **scheduled agent turns** (OpenClaw jobs) whose **message text** matches your heartbeat patterns — not a second timer inside the plugin.

### How often should a “goal heartbeat” job run?

There is no single correct answer; it is a trade-off between **responsiveness**, **cost**, and **noise**.

| Cadence | Typical use |
| --- | --- |
| **1–2× per day** | Long-running goals; light-touch reminders. |
| **Every 4–6 hours** | You want regular `goal_assess` / progress without spamming. |
| **Every 30–60 minutes** | Active goals where same-day follow-up matters. |
| **Every 5–15 minutes** | Rare; usually overkill unless goals are truly time-critical — high token cost and channel noise. |

Start **conservative** (few times per day or every 4–6 hours). Increase only if goals stall between other automation.

### Can I use an agent other than `main` for goal heartbeats?

**Yes.** That is a normal pattern: keep **interactive chat** on `main`, and use a **dedicated** `agentId` (e.g. `hearth`, `ops-goals`, or another profile) for short scheduled “pulse” turns.

**Requirements for that agent to see the same goals:**

1. **Same workspace** — The agent’s process must resolve the same **`OPENCLAW_WORKSPACE`** (and thus the same `state/goals/` tree) as the goals you care about.
2. **Goal stewardship enabled** — Hybrid-memory must load with **`goalStewardship.enabled: true`** for that agent’s plugin config (same as for `main` if you use one global plugin config).
3. **Same `goalsDir`** — If you override `goalStewardship.goalsDir`, it must point to the **same** directory for every agent that should share those goals.

**“Can every agent read goals via hybrid-memory?”** — **Recall** of memories (`memory_recall`, etc.) is **not** the same as **registered goals**. Goals are **`goal_*` tools** and JSON under `state/goals/`. Any agent that should **drive** stewardship needs goal stewardship **enabled** and the **goal tools** available — not only generic memory recall.

### Minimal OpenClaw job shape (another agent + heartbeat text)

OpenClaw stores scheduled work in **`~/.openclaw/cron/jobs.json`** (exact path may match your install). A **minimal** pattern is:

- **`agentId`**: the agent that should run the pulse (not necessarily `main`).
- **`schedule`**: your cron expression and timezone.
- **`sessionTarget`**: often **`isolated`** so the pulse does not hijack your interactive session.
- **`payload.kind`**: **`agentTurn`**
- **`payload.message`**: must **match** a heartbeat pattern (see below).

**Example (illustrative — adjust fields to your OpenClaw version):**

```json
{
  "name": "goal-stewardship-pulse",
  "agentId": "hearth",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 */6 * * *", "tz": "Europe/Stockholm" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "cron heartbeat\n\nYou are running a scheduled goal-stewardship pulse. List active goals (via tools / workspace), call goal_assess where appropriate, and report only concise status and next actions.",
    "timeoutSeconds": 600
  },
  "delivery": { "mode": "none" }
}
```

**First line matters for matching:** put a known trigger on **line 1**, e.g. `cron heartbeat`, then a blank line, then instructions. Default patterns match substrings like **`heartbeat`**, **`scheduled ping`**, and **`cron heartbeat`** (case-insensitive).

**Avoid accidental matches:** Long job prompts that mention unrelated paths (e.g. `heartbeat-state.json`) can contain the word **`heartbeat`** and make **`openclaw hybrid-mem verify`** think a job “matches” even when that job is **not** your goal pulse. Prefer a **dedicated** short job for stewardship, or a **custom** `goalStewardship.heartbeatPatterns` (e.g. a unique tag like `GOAL_PULSE_V1`) that only your pulse job uses.

### Suggested minimal job text (copy-paste)

**Option A — default pattern on first line:**

```text
cron heartbeat

Goal stewardship pulse: review active goals, run goal_assess for each that needs an update, keep the reply short.
```

**Option B — custom pattern (after you add the same string to `goalStewardship.heartbeatPatterns`):**

```text
GOAL_PULSE_V1

Review registered goals and assess progress; do not run unrelated maintenance.
```

---

## Verification: confirm heartbeat delivery is plausible

Run:

```bash
openclaw hybrid-mem verify
```

When **`goalStewardship.enabled`** is true, the **Goal stewardship (heartbeat)** section reports:

- Whether **`heartbeatStewardship`** is on.
- How many **heartbeat pattern matchers** compiled.
- A **warning** (non-fatal) if `~/.openclaw/cron/jobs.json` is missing, unreadable, has no job text, or **no** job message matches your patterns.

This does **not** prove a specific agent ran — it only checks that **some** job message **could** trigger a heartbeat. Combine with logs below.

Also useful:

```bash
openclaw hybrid-mem goals config
openclaw hybrid-mem goals status
```

---

## Logging: how to see if stewardship ran

When the gateway runs the plugin with sufficient log level, look for these **plugin log lines** (exact wording may evolve slightly):

| Log substring | Meaning |
| --- | --- |
| `memory-hybrid: goal stewardship bundle` | Heartbeat matched and stewardship prepend was built for at least one goal (includes goal count). |
| `memory-hybrid: goal stewardship skipped — global dispatch rate limit` | Heartbeat matched but **global** hourly dispatch cap blocked prepend. |
| `memory-hybrid: goal stewardship injection error` | Exception during injection — inspect the stack / message. |
| `memory-hybrid: task hygiene block appended (heartbeat match)` | Task hygiene block was added on the same heartbeat (if `activeTask` + task hygiene are enabled). |

**Practical checks:**

1. **After a scheduled job is supposed to run**, search gateway / plugin logs for `goal stewardship bundle` for that time window.
2. If you never see it, confirm the **job’s `payload.message`** as seen by the agent actually contains your heartbeat trigger (not only the job **title** in `jobs.json`).
3. Run **`goal_assess`** from the agent in that turn if you expect progress — the prepend is **context**; the model must still **use** the tools.

**Deterministic health without LLM** (watchdog / manual):

```bash
openclaw hybrid-mem goals stewardship-run
```

This runs the same **non-LLM** checks as the periodic watchdog (budgets, staleness, mechanical verification, etc.). It does **not** replace a heartbeat turn.

## CLI (observability)

All commands are under **`openclaw hybrid-mem goals`**:

| Command | Purpose |
| --- | --- |
| `list` | Active goals (use `--all` to include completed / failed / abandoned). |
| `status` | Overview: stewardship on/off, goals directory, active goals table (same rows as `list`). |
| `status <idOrLabel>` | Full detail for one goal (UUID or case-insensitive label). Add **`--json`** for raw JSON. |
| `cancel <idOrLabel> --reason "<text>"` | Mark goal **abandoned** with a reason. |
| `stewardship-run` | Run one deterministic health pass (requires `goalStewardship.enabled`; forces the same checks as the watchdog for that run). |
| `audit` | JSON snapshot of goals + config subset; add **`--jsonl`** for NDJSON (one object per goal). |

## Agent tools

Agents use underscore names: **`goal_register`**, **`goal_assess`**, **`goal_update`**, **`goal_complete`**, **`goal_abandon`**. Stewardship is disabled until `goalStewardship.enabled` is true; tools then respond with a clear error if disabled.

For promoting work from **`ACTIVE-TASKS.md`** into a registered goal, use **`active_task_propose_goal`** (draft fields for **`goal_register`**; requires **`activeTask.enabled`**). Details: **[TASK-HYGIENE.md](TASK-HYGIENE.md)**.

## What the watchdog does (no LLM)

On the timer (when enabled), the plugin checks each non-terminal goal for: dispatch/assessment budgets, escalation after repeated failures, dead subagent PIDs linked to tasks, staleness (idle vs cooldown), and optional **mechanical** verification when configured on the goal.

| Verifier | Behavior | Opt-in |
| --- | --- | --- |
| `file_exists` | Path relative to workspace (or absolute) must exist | Always on when set |
| `http_ok` | HTTP GET must return a successful status | Always on when set |
| `command_exit_zero` | Run argv split with `execFile` (no shell); exit 0 | **`goalStewardship.allowCommandVerification: true`** |
| `pr_merged` | GitHub REST API: PR must be merged | **`goalStewardship.allowPrVerification: true`** and **`GITHUB_TOKEN`** or **`GH_TOKEN`** set. Target: `owner/repo#N` or `https://github.com/owner/repo/pull/N` |

Each run records **`lastMechanicalCheck`** on the goal JSON (`at`, `ok`, `detail`). On success, non-terminal **`active`** / **`stalled`** goals move to **`verifying`** (same as before); **`goal_complete`** is still for the agent when policy allows.

## Escalation ladder (watchdog vs tools vs circuit breaker)

Order of enforcement (first match wins as the goal is processed each watchdog pass):

1. **Terminal goals** — skipped.
2. **Dispatch / assessment budgets** — goal becomes **`blocked`** with a budget reason (`watchdog`, `budget-enforced`).
3. **`escalateAfterFailures`** — consecutive failure counter (e.g. dead subagent PID) reaches threshold → **`blocked`** (`watchdog`, `escalated`).
4. **Linked subagent tasks** — stale PID may increment failures (`subagent-died`).
5. **Staleness** — idle beyond `cooldownMinutes * 2` while **`active`** → **`stalled`**; activity resumes → **`active`** again.
6. **Mechanical verification** — see table above; outcomes in **`lastMechanicalCheck`** and history (`verification-passed` / `mechanical-fail`).
7. **Circuit breaker** (during **`goal_assess`**, not the timer) — repeated same blockers / no progress → **`blocked`**, **`escalationKind: circuit_breaker`**, **`humanEscalationSummary`**, optional memory append.

**`stalled`** means “no recent activity”; **`blocked`** means “do not proceed without human or policy change.” **`failed`** is for explicit failure/abandon flows from tools, not the watchdog budget path.

## Episodic memory and audit

Successful completions can append a short summary under **`memory/`** (date-stamped files) when the tool path is configured. Goal history is stored **on the goal JSON** (`history` array). Event-log entries may be written for budget and staleness when an event log is available.

**Audit playbook:** [GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md](GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md) — how to trace failures and correlate CLI, files, and logs.

## Automated tests (developers)

Plugin CI runs stewardship tests without OpenClaw core: a **mock plugin API** (`extensions/memory-hybrid/tests/harness/mock-plugin-api.ts`) registers the same lifecycle handlers and emits synthetic `before_agent_start` / subagent events. See `tests/goal-stewardship-integration.test.ts` for the heartbeat + subagent flow.

## Troubleshooting

- **No goals in CLI:** Confirm workspace path (`OPENCLAW_WORKSPACE`), `goalsDir`, and that JSON files exist under that directory.
- **No stewardship on heartbeat:** Confirm `heartbeatStewardship` is not `false` and that the user message matches a configured or default **heartbeat pattern** (not only the literal word “heartbeat”). Run `openclaw hybrid-mem verify` — it warns when stewardship is enabled but no cron job message matches your patterns.
- **Goals blocked:** Check `currentBlockers` via `goals status`; budget and escalation are enforced by the watchdog and tools. If **`escalationKind`** is **`circuit_breaker`**, read **`humanEscalationSummary`** on the goal JSON (or the **`memory/`** append) for what failed and what was already tried.
