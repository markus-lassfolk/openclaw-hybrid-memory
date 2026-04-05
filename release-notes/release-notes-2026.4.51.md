# Release Notes — OpenClaw Hybrid Memory 2026.4.51

**Date:** 2026-04-05  
**Previous baseline:** 2026.4.40

## Summary

**2026.4.51** is a **feature-heavy release** centered on **how the agent tracks long-running work**. If you use **`ACTIVE-TASK.md`**, heartbeats, or cron-style check-ins, you get **clearer nudges** and a path to **promote work into formal goals**. If you turn on **goal stewardship**, OpenClaw gains a **structured goal registry**, **agent tools**, **heartbeat-aware prepends**, a **watchdog**, and optional **circuit breaking** so the system does not spin forever on the same blockers. Alongside that, this build improves **memory recall diagnostics**, **LLM input hygiene** for the OpenAI Responses API, and **batch classification** robustness, plus **embedding defaults** inherited from OpenClaw and a **cost tracker** fix after reload.

---

## Who should care

| You… | Then… |
| --- | --- |
| Run scheduled “heartbeat” or ping messages | New **task hygiene** blocks can remind the agent to reconcile **`ACTIVE-TASK.md`** before answering, and optionally hint when a row has been open “too long” without a registered goal. |
| Want multi-step work that survives sessions | Enable **goal stewardship** and use **`goal_register`** / **`goal_assess`** / **`goal_update`** / completion or abandon tools — goals live under **`state/goals/`** (configurable). |
| Worry about endless retries | Turn on **`goalStewardship.circuitBreaker`** so repeated assessments with the **same blockers** can **block the goal** and surface a **human-readable escalation** (and optional append to **`memory/`**). |
| Prefer SQLite over hand-edited markdown for tasks | Set **`activeTask.ledger`** to **`facts`** and use **`openclaw hybrid-mem active-tasks render`** to regenerate **`ACTIVE-TASK.md`** when you want a file view. |
| Tune embeddings once in OpenClaw config | **Embedding inheritance** ([#1002](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1002)) fills in missing plugin embedding fields from **`agents.defaults.memorySearch`** / providers so you do not duplicate model IDs. |
| Saw noisy cost logs after gateway reload | **Cost tracker** now follows the same DB lifecycle as the rest of the store ([#1021](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1021)). |

---

## Goal stewardship (high level)

**Goals** are **long-running commitments** with a label, description, acceptance-style criteria, blockers, and history — stored as JSON, not just a line in **`ACTIVE-TASK.md`**.

- **Enable:** `goalStewardship.enabled: true` in the hybrid-memory plugin config.
- **Agent tools:** `goal_register`, `goal_assess`, `goal_update`, `goal_complete`, `goal_abandon` (underscore names in tool APIs).
- **Heartbeats:** When the **last user message** matches a **heartbeat pattern** (defaults include phrases like “heartbeat”, “scheduled ping”), the plugin can **prepend** stewardship context (single- or multi-goal, with caps).
- **Watchdog:** On a timer, deterministic checks run: budgets, staleness, linked subagents, optional **mechanical** checks (`file_exists`, `http_ok`, and **`command_exit_zero`** only if **`allowCommandVerification`** is enabled — default **off** for safety).
- **CLI:** `openclaw hybrid-mem goals list`, `goals status`, `goals cancel`, `goals stewardship-run`, `goals audit` for inspection and one-off health passes.

**Design and operations:** [GOAL-STEWARDSHIP-DESIGN.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-DESIGN.md), [GOAL-STEWARDSHIP-OPERATOR.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-OPERATOR.md), [GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md).

**Tracking:** Epic and sub-issues [#1051](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1051)–[#1061](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1061).

---

## Task hygiene (ACTIVE-TASK.md)

**Task hygiene** is the **tactical** layer: it improves how **`ACTIVE-TASK.md`** behaves on **heartbeat** turns without forcing every row to become a goal.

1. **Heartbeat escalation** — Optional **`<task-hygiene>`** content reminds the agent to reconcile the file (finish work, update **Next**, verify subagents) before replying with something like **`HEARTBEAT_OK`**.
2. **“Consider a goal” hints** — If **`activeTask.taskHygiene.suggestGoalAfterTaskAgeDays`** is set, tasks older than that many days can be called out on heartbeat with pointers to **`active_task_propose_goal`** and **`goal_register`**. This **does not auto-create** goals.
3. **`active_task_propose_goal`** — Given a **task label**, returns a **draft** JSON payload for **`goal_register`** so the agent (and you) can refine and confirm per policy.

Full detail: [TASK-HYGIENE.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/TASK-HYGIENE.md).

---

## Circuit breaker (stuck goals)

If **`goalStewardship.circuitBreaker.enabled`** is **true**, the plugin tracks whether **`goal_assess`** keeps seeing the **same blockers** (fingerprinted) or too many assessments **without progress**. When thresholds trip, the goal becomes **`blocked`**, **`humanEscalationSummary`** explains what failed and what was tried, and optional memory append records it for you. This is **separate** from **`escalateAfterFailures`** (subagent / process failures), which the watchdog still handles.

Configure thresholds under **`goalStewardship.circuitBreaker`** in plugin config; see the operator guide for defaults and semantics.

---

## Active tasks: markdown vs facts ledger

- **`activeTask.ledger: markdown`** (typical): **`ACTIVE-TASK.md`** is the source of truth.
- **`activeTask.ledger: facts`**: Active tasks are stored as structured **`category:project`** facts in SQLite; use **`openclaw hybrid-mem active-tasks render`** to regenerate **`ACTIVE-TASK.md`** when you want a readable file. Hygiene and hooks work with either source.

---

## Recall, LLM input, and classification

- **Recall:** Full-text and vector search are orchestrated so **timings** better match what actually ran; total pipeline time uses **wall-clock** duration.
- **Responses API:** Messages sent through the sanitizer strip internal **reasoning** traces from **content arrays** (any role) so replays do not trigger API errors; empty assistant content after stripping gets a small placeholder.
- **Batch classify:** Parsing tolerates more wrapper shapes and noisy output, with checks so lenient mode does not accept completely bogus rows.

---

## Other fixes and docs

- **Embedding inheritance** ([#1002](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1002)): merges provider and memory-search defaults into embedding config when you omit fields in the plugin.
- **Cost tracker** ([#1021](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1021)): avoids stale DB handles across reload.
- **Documentation** updates across architecture, stewardship design/operator docs, and the bundled hybrid-memory skill.

---

## Upgrade

```bash
npm install -g openclaw-hybrid-memory@2026.4.51
```

Restart the gateway after upgrading. If you use the standalone installer package, align its version with **2026.4.51** as well.

---

## Links

- [CHANGELOG (full)](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md) — search for **`2026.4.51`** for this release’s section.
