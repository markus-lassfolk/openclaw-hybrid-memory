# Goal stewardship — audit playbook

Use this when you need to **explain what happened** to a goal, or **why** stewardship behaved a certain way.

## Sources of truth

1. **Goal JSON** — `OPENCLAW_WORKSPACE` + `goalStewardship.goalsDir` (default `state/goals/<uuid>.json`). Each file has `history[]` with timestamps, actors, and actions.
2. **CLI**
   - `openclaw hybrid-mem goals list` / `status <id>` — current state.
   - `openclaw hybrid-mem goals audit` — JSON snapshot (add `--jsonl` for one line per goal).
   - `openclaw hybrid-mem goals stewardship-run` — one deterministic health pass (watchdog logic).
3. **ACTIVE-TASKS.md** — If `heartbeatRefreshActiveTask` is on, the **## Active Goals** section is a **mirror** refreshed on heartbeat; do not edit by hand.
4. **Plugin logs** — Look for `memory-hybrid: goal stewardship` and `ACTIVE-TASKS.md mirror refreshed`.
5. **Event log** (when configured) — May contain `goal.*` events from tools and watchdog.

## Typical questions

| Question | Where to look |
| --- | --- |
| Why was a goal blocked? | `status` + `currentBlockers` + `history` in goal JSON; health check actions from `stewardship-run`. |
| Why no stewardship this heartbeat? | Last user message must match a **heartbeat pattern** (defaults include “heartbeat”, “scheduled ping”). Check `goalStewardship.heartbeatPatterns`. |
| Why only some goals in the prepend? | **Multi-goal cap** (`multiGoalMaxChars`, `multiGoalMaxGoals`), **cooldown** per goal, **weights** (`attentionWeights`), **round-robin** cursor file `_stewardship_rr.json` in goals dir. |
| Why confirm on register? | `confirmationPolicy.requireRegisterAckForPriorities` — use `confirmed: true` on `goal_register` after user approval. |

## Automation

Pipe `goals audit --jsonl` into your log stack or CI artifact store for long-term correlation with gateway logs.
