---
layout: default
title: "Goal Stewardship: Design & Gap Analysis"
parent: Architecture & Internals
nav_order: 10
---
# Goal Stewardship — Autonomous Goal Pursuit for Hybrid Memory

Design document for durable, closed-loop goal pursuit. Tracks the gap between
what users expect from heartbeat + active-task and what the system actually
delivers, then proposes a concrete architecture that closes that gap within the
plugin boundary.

Related issues: #1046, #1047, #1048.

---

## 1. The Problem

When a user assigns OpenClaw a goal — "deploy the new API", "fix CI and get the
PR merged", "sync GlitchTip and keep it healthy" — they expect the system to:

1. **Remember** the goal durably (across restarts, compaction, idle periods).
2. **Keep working** toward it on every heartbeat or idle cycle.
3. **Assess** progress, diagnose blockers, and recover from errors.
4. **Dispatch** follow-up work (subagents, tool calls) until the goal is met.
5. **Only then** mark it done — not when a single turn "feels done."

In short: the user wants to sleep and trust that OpenClaw does everything in its
power to reach the agreed-upon goal autonomously.

Today the system does not deliver this. The building blocks exist (heartbeat,
ACTIVE-TASK.md, subagent lifecycle, task signals) but they are not wired into a
closed loop. The result is that goals are forgotten, heartbeat says
`HEARTBEAT_OK` even when work remains, and subagent completion is treated as
goal completion without any verification.

---

## 2. Why the Current System Falls Short

### 2.1 Heartbeat is a prompt, not an orchestrator

OpenClaw's heartbeat delivers a periodic user message. What happens next is one
LLM turn, constrained by token limits, tool allowlists, and model compliance.
The model frequently replies `HEARTBEAT_OK` early, especially when the default
`HEARTBEAT.md` guidance says not to repeat old tasks from prior chats.

There is no hard state machine that forces the pattern: observe goal state,
decide what to do, dispatch work, verify progress. "Check the goal every
heartbeat" is prompt engineering, not an enforced pipeline.

### 2.2 ACTIVE-TASK.md is working memory, not execution

`stage-active-task.ts` injects a summary of `ACTIVE-TASK.md` into agent context
at `before_agent_start`. `stage-cleanup.ts` checkpoints on `subagent_spawned`
and `subagent_ended`. This provides **context** — the agent knows tasks exist —
but not **continuation**:

- Nothing in the plugin **schedules** work when the user is away.
- Nothing **proves** progress toward a goal; it **displays** status and
  staleness.
- Completion is inferred from subagent exit status, not from whether the user's
  goal was actually achieved.

### 2.3 The default heartbeat prompt conflicts with goal carry-over

Stock heartbeat guidance often includes "do not infer or repeat tasks from prior
chats." This directly fights "keep pursuing the goal I gave you until it's done."
There is no first-class "active goal" channel that overrides this default
behavior.

### 2.4 Extraction pipelines skip heartbeat

`directive-extract.ts`, `session-pre-filter.ts`, `reinforcement-extract.ts`, and
`self-correction-extract.ts` all contain `SKIP_PATTERNS` matching `/heartbeat/i`.
This is correct for memory hygiene — heartbeat traffic is low-signal for fact
extraction — but it reinforces that heartbeat content is not treated as
first-class user intent. Stewardship observations made during heartbeat turns
are silently discarded.

### 2.5 Task-queue watchdog solves a different problem

`task-queue-watchdog.ts` maintains PID / branch / runtime health for the
autonomous queue (`state/task-queue/current.json`). It self-heals stuck factory
runs. It does not connect to conversational user goals or ACTIVE-TASK.md
semantics.

### 2.6 Facts are passive

In deployments that generate `ACTIVE-TASK.md` from `category:project` facts,
the facts are stored but nothing acts on them. Unless an agent on each heartbeat
explicitly recalls, evaluates, and dispatches, the fact ledger goes stale. There
is no daemon enforcing that loop.

---

## 3. Gap Summary

| Capability | Today | Needed |
|---|---|---|
| **Goal contract** | Project facts + optional ACTIVE-TASK.md rows | Explicit fields: acceptance criteria, verification hooks, priority, budget, last assessment |
| **Stewardship loop** | Optional LLM behavior on heartbeat (often skipped) | Deterministic or policy-driven step: select candidate goals, evaluate, enqueue actions |
| **Dispatch bridge** | Manual subagent spawning during an LLM turn | Structured stewardship injection that directs the LLM to assess and dispatch on heartbeat |
| **Completion semantics** | Status set when subagent exits | Verification against acceptance criteria, configurable per goal |
| **Budget and safety** | None for goal pursuit | Per-goal and global limits on dispatches, assessments, and cost |
| **Audit trail** | Episodes and logs (ad hoc) | Structured history per goal: every assessment, dispatch, and status change |

---

## 4. Proposed Architecture

Two coordinated loops running within the existing plugin infrastructure, plus a
persistent goal registry and agent-facing tools.

### 4.1 High-level flow

```
                        ┌─────────────────────────────────────┐
                        │         Goal Registry               │
                        │  (state/goals/<id>.json per goal)   │
                        └──────┬────────────────┬─────────────┘
                               │                │
               reads/writes    │                │    reads/writes
                               ▼                ▼
          ┌────────────────────────┐  ┌──────────────────────────┐
          │  Deterministic Watchdog │  │  LLM Stewardship Engine  │
          │  (5-min plugin timer)   │  │  (heartbeat → before_    │
          │                         │  │   agent_start hook)      │
          │  • Staleness detection  │  │                          │
          │  • Subagent PID checks  │  │  • Detect heartbeat msg  │
          │  • Mechanical verify    │  │  • Select priority goal  │
          │  • Budget enforcement   │  │  • Inject stewardship    │
          │  • Escalation policy    │  │    prompt into LLM turn  │
          └────────┬───────────────┘  │  • LLM assesses, plans,  │
                   │                   │    dispatches subagents   │
                   │ updates status    │  • Records via goal_      │
                   │                   │    assess tool            │
                   ▼                   └────────────┬─────────────┘
          ┌────────────────────────┐                │
          │  ACTIVE-TASK.md        │   dispatches   │
          │  (tactical layer —     │◀───────────────┘
          │   subagent bookkeeping)│
          └────────┬───────────────┘
                   │ subagent_spawned / subagent_ended
                   ▼
          ┌────────────────────────┐
          │  Feedback to Goal      │
          │  Registry              │
          │  • Link subagent → goal│
          │  • Update progress     │
          │  • Trigger next cycle  │
          └────────────────────────┘
```

### 4.2 Why two loops?

Many checks require no LLM at all: is the subagent PID still alive? Did the
process runtime exceed the maximum? Does the target file exist? Has the budget
been exhausted? Running these deterministically on the existing 5-minute timer
(alongside the task-queue watchdog) is cheap, fast, and reliable.

The LLM stewardship loop handles what deterministic code cannot: interpreting
error output, deciding what to try next, authoring subagent prompts, and
reasoning about whether acceptance criteria are met. This runs only on heartbeat
turns when there are goals needing attention.

Separating the two loops ensures that goals are monitored even if heartbeat is
delayed or the LLM is unreliable, while keeping LLM costs proportional to
actual work needed.

---

## 5. Component Design

### 5.1 Goal Registry (data layer)

**Location:** `~/.openclaw/workspace/state/goals/`

One JSON file per goal (`<goal-id>.json`). Individual files avoid the merge and
optimistic-locking issues that ACTIVE-TASK.md suffers from. A lightweight index
(`_index.json`) is regenerated on reads for fast listing.

**Goal schema:**

```
Goal
├── id: string                       (UUID)
├── label: string                    (short human name, e.g. "deploy-api")
├── description: string              (full goal statement)
├── acceptanceCriteria: string[]     (numbered list of what "done" means)
├── verification                     (optional mechanical check)
│   ├── type: manual | file_exists | command_exit_zero | pr_merged | http_ok
│   └── target: string              (file path, URL, command, etc.)
├── status: active | blocked | stalled | verifying | completed | failed | abandoned
├── priority: critical | high | normal | low
│
├── createdAt: ISO timestamp
├── lastAssessedAt: ISO timestamp | null
├── lastDispatchedAt: ISO timestamp | null
├── assessmentCount: number
├── dispatchCount: number
├── currentBlockers: string[]
├── lastOutcome: string | null
│
├── maxDispatches: number            (per-goal cap, default 20)
├── maxAssessments: number           (per-goal cap, default 50)
├── cooldownMinutes: number          (min time between dispatches, default 10)
├── escalateAfterFailures: number   (consecutive failures before escalation, default 3)
│
├── linkedTasks[]                    (connection to ACTIVE-TASK.md)
│   ├── label: string
│   ├── sessionKey: string | null
│   └── status: string
│
└── history[]                        (audit trail)
    ├── timestamp: ISO
    ├── action: string
    ├── detail: string
    └── actor: watchdog | steward | agent | user
```

**Relationship to ACTIVE-TASK.md:** Goals are the strategic layer (what we want
to achieve). ACTIVE-TASK.md remains the tactical layer (which subagent is doing
what right now). Each ACTIVE-TASK.md row can optionally carry a `goalId` field
linking it back to its parent goal. When subagents complete, both systems update.

### 5.2 Deterministic Health Watchdog

**Integration point:** `setup/plugin-service.ts`, added to the existing
`watchdogRun` function (line ~598) that already runs `runTaskQueueWatchdog` and
`reconcileActiveTaskInProgressSessions` on a 5-minute interval.

New function: `runGoalHealthCheck(goalsDir, opts, logger)`

**What it checks for each non-terminal goal:**

| Check | Condition | Action |
|---|---|---|
| Staleness | No assessment in `2 × cooldownMinutes` | Set status `stalled`, log warning |
| Subagent liveness | Linked task has PID that is no longer alive | Update linked task status, log |
| Mechanical verification | `verification.type` is not `manual` and check passes | Set status `verifying`, write assessment |
| Budget exhaustion | `dispatchCount >= maxDispatches` or `assessmentCount >= maxAssessments` | Set status `blocked`, reason "budget exhausted" |
| Escalation threshold | `escalateAfterFailures` consecutive failed dispatches | Set status `blocked`, write high-priority signal for next stewardship turn |
| Orphaned goals | Goal is `active` but has no linked tasks and last dispatch was long ago | Set status `stalled` with reason |

Every action writes to `goal.history[]` with `actor: "watchdog"`.

### 5.3 LLM Stewardship Engine (heartbeat integration)

**New lifecycle stage:** `lifecycle/stage-goal-stewardship.ts`

**Registration:** In `lifecycle/hooks.ts`, registered as a `before_agent_start`
handler after `registerActiveTaskInjection`:

```
registerGoalStewardshipInjection(api, ctx, goalsDir);
```

**Heartbeat detection:** The existing `SKIP_PATTERNS` in
`services/directive-extract.ts` identify heartbeat messages via `/heartbeat/i`.
The stewardship stage reuses the same detection logic, but inverted: when a
heartbeat IS detected AND there are active goals, activate stewardship mode
instead of remaining passive.

**Stewardship injection flow:**

1. Extract user message from the `before_agent_start` event.
2. Test against heartbeat patterns. If not a heartbeat, return `undefined`
   (no injection — normal session, lightweight goal status only via existing
   active-task injection).
3. Load all non-terminal goals from the registry.
4. If none, return `undefined` (no goals, heartbeat proceeds normally).
5. Select the highest-priority goal needing attention, respecting cooldown:
   - `critical` > `high` > `normal` > `low`
   - Within same priority: longest time since last assessment
   - Skip goals still within their cooldown window
6. Build a structured stewardship prompt and return as `{ prependContext }`.

**Stewardship prompt structure:**

```xml
<goal-stewardship>
## Active Goal: {label} (priority: {priority})

**Description:** {description}

**Acceptance Criteria:**
1. {criterion_1} [{status}]
2. {criterion_2} [{status}]
...

**Stewardship State:**
- Status: {status} | Assessments: {count}/{max} | Dispatches: {count}/{max}
- Last assessment: {time_ago} — {lastOutcome}
- Current blockers: {blockers or "none"}
- Linked tasks: {task_label} ({task_status}, session {key})

**Stewardship Directive:**
Assess the current state of this goal. {context-specific instructions based on
current state — e.g., "Check if the linked subagent completed successfully",
"The previous dispatch failed with error X — diagnose and retry", "All criteria
appear met — verify and complete."}

Record your assessment using the goal_assess tool. If work is needed, dispatch
a subagent. If the goal is complete, call goal_complete.
</goal-stewardship>
```

**During normal (non-heartbeat) conversation:** Goals are surfaced as part of the
existing active-task injection with a lightweight one-line summary per goal.
The full stewardship directive is heartbeat-only.

### 5.4 Agent Tools

**New file:** `tools/goal-tools.ts`, registered in `setup/register-tools.ts`
alongside memory tools.

| Tool | Purpose | Key parameters |
|---|---|---|
| `goal_register` | Create a tracked goal from conversation | label, description, acceptance_criteria[], priority, verification?, budget overrides |
| `goal_assess` | Record a stewardship assessment | goal_id, assessment, criteria_updates[], next_action, blockers[] |
| `goal_update` | Update goal metadata | goal_id, + any mutable fields (description, criteria, priority, blockers) |
| `goal_complete` | Mark goal as completed with verification | goal_id, reason, verified_criteria[] |
| `goal_abandon` | Mark goal as abandoned | goal_id, reason |

**`goal_register` flow:** When the user states a goal during normal conversation,
the LLM calls `goal_register`. The tool:

1. Validates the input (label uniqueness, criteria present).
2. Writes `state/goals/<id>.json` with defaults from config.
3. Optionally creates a linked ACTIVE-TASK.md row.
4. Returns confirmation with goal ID and summary.

**When does the LLM know to register a goal?** Via skill documentation and
workspace instructions (TOOLS.md / AGENTS.md). The guidance: "When the user
assigns a long-running objective with clear outcomes, register it as a goal
using `goal_register` so the system tracks and pursues it across sessions."

Auto-detection of goal-worthy messages is explicitly out of scope for the
initial implementation. The LLM must make an explicit tool call.

### 5.5 Subagent Integration

**Modified file:** `lifecycle/stage-cleanup.ts`

**`subagent_spawned`:** When the spawned subagent references a goal (via label
convention or explicit metadata), add it to `goal.linkedTasks[]`. The link is
established by:
- Checking if the subagent label matches a known goal label prefix.
- Checking if the spawning context (tool call args) includes a `goalId`.

**`subagent_ended`:** When a subagent linked to a goal ends:
1. Update the linked task status in the goal registry.
2. If the subagent succeeded, check whether all acceptance criteria are now met.
3. If all criteria met and verification type is `manual`, set goal status to
   `verifying` (the next stewardship turn will ask the LLM to confirm).
4. If all criteria met and verification is mechanical, the watchdog will run the
   check on its next cycle.
5. Write to `goal.history[]` with `actor: "agent"`.

**OCTAVE task signals:** `consumePendingTaskSignals` in `stage-cleanup.ts` is
extended to also look up the parent goal for each signal and update goal state
accordingly.

### 5.6 Configuration

**Added to config types and `openclaw.plugin.json`:**

```
goalStewardship:
  enabled: false                    # opt-in, off by default
  goalsDir: "state/goals"           # relative to workspace root
  model: null                       # LLM for stewardship (default: cron "default" tier)
  heartbeatStewardship: true        # inject on heartbeat when enabled
  watchdogHealthCheck: true         # run health checks on 5-min timer
  defaults:
    maxDispatches: 20               # per-goal dispatch cap
    maxAssessments: 50              # per-goal assessment cap
    cooldownMinutes: 10             # min time between dispatches
    escalateAfterFailures: 3        # consecutive failures before escalation
    priority: "normal"
  globalLimits:
    maxDispatchesPerHour: 6         # across all goals
    maxActiveGoals: 5
```

### 5.7 CLI

**New CLI group:** `openclaw hybrid-mem goals <subcommand>`

| Command | Purpose |
|---|---|
| `goals list` | Show all goals with status, progress, budget usage |
| `goals status <id-or-label>` | Detailed goal view with full history |
| `goals cancel <id-or-label>` | Abandon a goal with reason |
| `goals budget` | Show budget usage across all goals |
| `goals reset-budget <id-or-label>` | Reset dispatch/assessment counters |
| `goals stewardship-run` | Manually trigger one stewardship cycle (for cron/testing) |

The `stewardship-run` command is designed to be called from an external cron job
or script for operators who want stewardship on a different schedule than
heartbeat, or who want to run it alongside heartbeat for extra reliability.

### 5.8 Audit and Observability

- **Goal history:** Every assessment, dispatch, status change, and error is
  logged in `goal.history[]` with timestamp, actor, action, and detail.
- **Event log:** Structured events emitted to `backends/event-log.ts` (if
  enabled) for dashboard visibility: `goal.created`, `goal.assessed`,
  `goal.dispatched`, `goal.completed`, `goal.failed`, `goal.escalated`.
- **Episodic memory:** On goal completion or failure, auto-capture an episode
  to the facts database (reusing the pattern from `stage-capture.ts`), so the
  system remembers what it achieved and how.
- **Dashboard:** Future extension — expose goal status via the existing
  dashboard HTTP server. Not in initial implementation.

---

## 6. Safety and Cost Control

Autonomous goal pursuit is high-risk without guardrails. The following
mechanisms are mandatory in the implementation, not optional:

### 6.1 Budget enforcement (deterministic, not prompt-based)

- **Per-goal dispatch cap** (`maxDispatches`): Hard limit on how many subagents
  a single goal can spawn. Enforced by the watchdog, not by the LLM.
- **Per-goal assessment cap** (`maxAssessments`): Hard limit on stewardship
  LLM turns per goal.
- **Global dispatch rate** (`maxDispatchesPerHour`): Across all goals, no more
  than N dispatches per hour. Prevents cost spikes from multiple active goals.
- **Active goal cap** (`maxActiveGoals`): Maximum concurrent tracked goals.
- **Cooldown** (`cooldownMinutes`): Minimum interval between dispatches for a
  single goal. Prevents tight retry loops.

When any budget is exhausted, the goal transitions to `blocked` with a clear
reason. It does not silently retry. The user (or CLI) must explicitly
`reset-budget` to continue.

### 6.2 Escalation policy

After `escalateAfterFailures` consecutive failed dispatches, the stewardship
engine stops auto-dispatching and instead injects a prompt asking the LLM to
**notify the user** of the situation rather than retry. This prevents the system
from burning budget on a fundamentally broken task.

### 6.3 Opt-in activation

Goal stewardship is **disabled by default** (`goalStewardship.enabled: false`).
Users must explicitly enable it. This is critical because the feature
fundamentally changes heartbeat behavior from "quiet check-in" to "active
autonomous work."

### 6.4 Kill switch

`openclaw hybrid-mem goals cancel <id>` immediately sets a goal to `abandoned`
and stops all stewardship for it. `goalStewardship.enabled: false` in config
disables the entire system. Both are instantaneous and do not depend on the
LLM cooperating.

### 6.5 Subagent containment

Subagents spawned by stewardship inherit the workspace's tool allowlists and
model constraints. The stewardship engine does not escalate privileges. Existing
OpenClaw session policy (tool limits, token caps, rate limits) applies to all
dispatched work.

---

## 7. What This Design Does NOT Do

These are explicit non-goals for the initial implementation:

- **Build a scheduler daemon.** OpenClaw core owns session scheduling and
  heartbeat timing. The plugin hooks into existing infrastructure (5-min timer,
  `before_agent_start`), it does not run its own cron runtime.
- **Auto-detect goals from conversation.** Phase 1 requires the LLM to
  explicitly call `goal_register`. Auto-detection (intent classification on
  user messages) is a future enhancement.
- **Replace ACTIVE-TASK.md.** The tactical subagent tracking layer remains.
  Goals add a strategic layer on top.
- **Require OpenClaw core changes.** The design works within the current plugin
  API. Dedicated heartbeat hooks (`before_heartbeat_llm`, programmatic wake
  API) would improve reliability but are not prerequisites.
- **SQLite-backed goal store.** At the expected scale (1-10 concurrent goals),
  JSON files are sufficient and simpler to debug/inspect.
- **YAML task definition DSL.** Over-engineered for this use case. Goals are
  created via tool calls or CLI, not static config files.
- **Distributed execution.** Single-machine, single-OpenClaw-instance scope.

---

## 8. Files Changed or Created

### New files

| Path | Purpose |
|---|---|
| `services/goal-stewardship.ts` | Goal registry types, read/write, health watchdog logic, stewardship decision engine |
| `lifecycle/stage-goal-stewardship.ts` | Lifecycle stage: heartbeat detection, goal selection, prompt building |
| `tools/goal-tools.ts` | Agent tools: goal_register, goal_assess, goal_update, goal_complete, goal_abandon |
| `cli/goals.ts` | CLI commands: goals list/status/cancel/budget/reset-budget/stewardship-run |

All paths relative to `extensions/memory-hybrid/`.

### Modified files

| Path | Change |
|---|---|
| `setup/plugin-service.ts` | Add `runGoalHealthCheck` to existing 5-min watchdog timer |
| `lifecycle/hooks.ts` | Register `registerGoalStewardshipInjection` after active-task injection |
| `lifecycle/stage-cleanup.ts` | Connect `subagent_spawned`/`subagent_ended` to goal registry |
| `config.ts` + `config/types/` | Add `goalStewardship` config section |
| `setup/register-tools.ts` | Register goal tools |
| `cli/register.ts` | Register goal CLI group |
| `index.ts` | Wire goal tools and pass goals directory to lifecycle context |

### Documentation

| Path | Change |
|---|---|
| `skills/hybrid-memory/SKILL.md` | Add goal tools guidance |
| `workspace-snippets/TOOLS-hybrid-memory-body.md` | Add goal tools to tool listing |
| `docs/GOAL-STEWARDSHIP-DESIGN.md` | This document |

---

## 9. Worked Example

A concrete walkthrough of the system in action:

**T=0 (user conversation):**
User says: "I want you to deploy the new API to production. Run all tests,
fix any failures, create a PR, get it merged, then deploy."

The LLM calls `goal_register`:
```json
{
  "label": "deploy-api",
  "description": "Deploy the new API to production",
  "acceptanceCriteria": [
    "All tests pass",
    "Any test failures are fixed",
    "Pull request created",
    "Pull request merged",
    "Deployed to production"
  ],
  "priority": "high"
}
```

Goal saved to `state/goals/a1b2c3.json`, status `active`.

**T=5min (heartbeat fires):**
`before_agent_start` triggers. Stewardship stage detects heartbeat, loads goal
registry, finds `deploy-api` (active, never assessed). Injects stewardship
prompt directing the LLM to begin with criterion 1.

LLM spawns a subagent to run the test suite. `subagent_spawned` links it to the
goal. LLM calls `goal_assess`: "Dispatched test-runner subagent."

**T=12min (subagent ends):**
`subagent_ended` fires — tests passed. Goal's linked task updated to
"completed." Goal history records: "test-runner succeeded."

**T=15min (next heartbeat):**
Stewardship sees: criterion 1 met, criterion 2 can be skipped (no failures).
Injects prompt to proceed with criterion 3. LLM spawns PR creation subagent.

**T=25min (subagent ends):**
PR created, linked task updated.

**T=30min (heartbeat):**
Stewardship sees PR exists but not merged. Injects: "Wait for review or
check if auto-merge is configured." LLM calls `goal_assess`: "PR #42 open,
awaiting review. No action needed this cycle."

**T=35min (watchdog runs):**
Deterministic check: goal active, last assessed 5 min ago (within cooldown),
PR not merged. No action needed. Logs "ok."

**T=60min (heartbeat):**
Stewardship checks PR status — merged. Criterion 4 met. Injects: "Proceed
with deployment." LLM spawns deploy subagent.

**T=70min (subagent ends):**
Deploy succeeded. All criteria now met. `subagent_ended` sets goal status to
`verifying`.

**T=75min (heartbeat):**
Stewardship sees status `verifying`, all criteria met. LLM calls
`goal_complete` with verification summary. Goal status becomes `completed`.
Episode captured to memory: "Successfully deployed API — tests, PR, deploy
all completed."

**User wakes up:** Sees the completed goal in `openclaw hybrid-mem goals list`.

---

## 10. Open Questions

These should be resolved before or during implementation:

1. **Should heartbeat detection be pattern-based or flag-based?** Pattern
   matching on `/heartbeat/i` works but is fragile. A better approach would be
   a dedicated flag in the `before_agent_start` event from OpenClaw core, but
   that requires a core change. Pattern matching is acceptable for Phase 1.

2. **Goal-to-ACTIVE-TASK linkage format?** Options: (a) add a `goalId` field to
   ACTIVE-TASK.md rows, (b) use label conventions (goal label as prefix), or
   (c) maintain the link only in the goal registry. Option (a) is cleanest.

3. **Stewardship model selection.** Should stewardship assessment use the same
   model as the heartbeat session, or a dedicated model from config? A
   dedicated model (defaulting to the cron `"default"` tier) allows cost
   optimization, but the stewardship injection happens within the heartbeat
   LLM turn — the plugin cannot change the model mid-turn. This may require
   core support or a different architecture (stewardship as a separate session
   rather than injection).

4. **Multi-goal stewardship.** When multiple goals need attention in the same
   heartbeat, should we inject context for all of them (risking token overflow)
   or select only the highest-priority one? The initial design proposes
   selecting one per heartbeat to keep token usage bounded.

5. **User confirmation before first dispatch.** Should `goal_register` require
   explicit user confirmation ("I've registered goal X with these criteria —
   shall I proceed?") before the stewardship loop begins auto-dispatching?
   This adds safety but reduces autonomy.

---

## 11. Implementation Sequence

Recommended build order, each step independently testable:

1. **Goal store** — types, read/write, tests (no external integration)
2. **Configuration** — config schema, defaults, validation
3. **Agent tools** — goal_register, goal_assess, goal_update, goal_complete,
   goal_abandon (functional without stewardship loop)
4. **CLI** — goals list/status/cancel (observability before automation)
5. **Deterministic watchdog** — health checks on 5-min timer
6. **Stewardship injection** — heartbeat detection, prompt building
7. **Subagent integration** — connect spawned/ended to goals
8. **Audit and observability** — event log, episodic memory, history
9. **Documentation** — skill, tools snippet, operator guide
10. **End-to-end testing** — simulated heartbeat + goal lifecycle
