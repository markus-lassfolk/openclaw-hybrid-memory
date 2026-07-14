# Serendipity Protocol

Bounded proactive noticing, recording, triage, and resolution of adjacent improvements while an agent does requested work. The goal is to make agents more useful — noticing a packaging defect, a stale assumption, a recurring friction — **without** autonomous wandering, scope creep, or creating a new dashboard to babysit.

Tracking issue: [#2119](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2119).

> **Not to be confused with** the recall-time `autoRecall.serendipity` slot (see `services/serendipity.ts`), which surfaces an interesting-but-unrecalled fact during retrieval. That is a *daydreaming* recall feature. The **Serendipity Protocol** described here is a proactive-findings *workflow*. They are independent and separately configured (`serendipityProtocol` vs `autoRecall.serendipity`).

## Engagement levels

A configurable level (0–4, default **2.5**) governs how proactive the agent is. Higher levels do more; every level keeps the guardrails.

| Level | Name | Behavior |
| ----- | ---- | -------- |
| 0 | requested-only | Do exactly what was asked. Mention only blockers and serious safety issues. |
| 1 | safety | Also act on immediate safety / security / data-loss / reliability / trust issues. |
| 2 | adjacent cleanup | Also fix low-risk, reversible issues **directly adjacent** to the task. |
| 2.5 | (default) | Fix low-risk direct improvements; file or remember larger findings; don't wander. |
| 3 | improvement scout | Actively look for leverage (wrappers, missing tests, brittle docs); propose skills/issues. |
| 4 | steward | Proactive backlog sweeps and broader maintenance (requires explicit opt-in). |

Levels are stored per scope with precedence **session > agent > user > channel > repo > global-pref > config default**. An explicitly *disabled* pref at the winning scope means "serendipity off" (level 0) for that scope.

```bash
openclaw hybrid-mem serendipity level set 2.5 --scope user --target markus
openclaw hybrid-mem serendipity level get
```

## Data model

Findings are stored in a dedicated SQLite store (`serendipity.db`), one row per `SerendipityFinding`:

- **classification** — `findingType` (stale_assumption, repeated_friction, low_risk_cleanup, missing_validation, packaging_defect, documentation_mismatch, unsafe_default, duplicate_state, load_reduction_opportunity, other)
- **triage inputs** — `riskLevel`, `reversibility`, `adjacency`, `estimatedHumanLoadReduction`, `confidence`, and the guardrail flags `external` / `destructive` / `privacySensitive`
- **lifecycle** — `status` (`observed → fixed | filed | remembered | proposed | dismissed | deferred`) with a validated transition map
- **evidence + links** — `evidence[]`, `relatedFacts[]`, `relatedIssues[]`, `relatedProcedures[]`, `relatedSkills[]`
- **backlog** — `expiresAt` (TTL) and `lastSurfacedAt` (resurfacing cooldown)

New findings are **deduplicated** against recent findings by `repo + entity + findingType + normalized-title` (within `dedupWindowDays`); a duplicate merges its evidence into the existing record instead of creating a new row.

## Agent tools

- **`serendipity_record`** — record a finding with evidence + suggested action (dedup-aware).
- **`serendipity_list`** — list/filter findings; `backlog: true` returns the ranked actionable deferred backlog.
- **`serendipity_decide`** — recommend an action for the current level. **Recommends only — never executes.**
- **`serendipity_resolve`** — record the outcome (fixed/filed/remembered/proposed/dismissed/deferred). `status: filed` creates a linked local issue (real GitHub filing stays an approval-gated agent action).
- **`serendipity_promote`** — hand a finding off to durable work: a **goal** (goal stewardship then drives it), an **active task**, or a **Skill Workshop proposal**. Links back and marks the finding `proposed`; the target system enforces its own guardrails.
- **`serendipity_digest`** — a compact, low-noise digest of findings + backlog.
- **`serendipity_set_level`** — set the engagement level for a scope (also available via CLI).

## Decision policy

`serendipity_decide` runs a deterministic policy (no LLM):

1. **Guardrail override (any level):** destructive / external / privacy-sensitive / irreversible → **`ask_user`**.
2. **Level 0:** safety findings → `remember`; everything else → `ignore`.
3. **Safety (level ≥ 1):** low-risk + easily reversible + directly adjacent → `fix_now`; otherwise `file_issue`.
4. **Level ≥ 2:** direct + low-risk + reversible → `fix_now`; near/medium → `file_issue`/`remember`; broad → `remember`.
5. **Level ≥ 3:** recurring friction / load-reduction → `propose_skill`; large leverage → `create_task`.
6. **Level 4:** broad findings are `file_issue`, not silent scope expansion.

Low confidence downgrades a would-be `fix_now` to `remember`.

## Deferred backlog: revisit & TTL

Findings left in `observed`/`deferred` form a **TTL-bounded backlog** (`deferredTtlDays`, default 30; expired findings are pruned by `archiveExpired()`). Two revisit drivers surface backlog items — **neither edits code; the agent acts under approval:**

- **Heartbeat resurfacing** (`resurface`, level-gated ≥ `minLevel`, default 3): on heartbeat / low-activity turns, the single top actionable deferred finding is injected as a bounded, cooldown-gated one-liner.
- **Opt-in Level-4 cron sweep** (`sweep.enabled`, off by default): a scheduled job prunes expired findings and reports the backlog. It is **surface-only** unless `sweep.dispatch` is enabled; when dispatch is on it **promotes** the top in-bounds findings (up to `sweep.maxDispatch`) into goals or active tasks (`sweep.target`, default `goal`) so their existing dispatch/approval loops drive the work. The sweep never edits code itself.

The **pending-review digest** (`openclaw hybrid-mem digest`) also gains a "Serendipity backlog" section when the protocol is enabled, so the actionable backlog shows up in the regular weekly review.

```bash
openclaw hybrid-mem serendipity backlog        # ranked actionable backlog
openclaw hybrid-mem serendipity sweep --json   # run the sweep on demand
```

## Context injection

When `injectPolicy` is on, a compact one-line policy summary is injected once per session:

```
[serendipity] Level 2.5 (adjacent-cleanup). Also fix low-risk, reversible, directly adjacent issues; file or remember larger ones. Ask before risky/destructive/external/privacy-sensitive actions. Optimize for reducing future human load, not creating a new garden to maintain.
```

## Guardrails

- Destructive / external / privacy-sensitive / irreversible actions **always require approval**.
- The plugin **resurfaces**; it never edits code — the agent acts under normal approval rules.
- No auto-scheduled digest/sweep unless the operator explicitly enables it. The Level-4 sweep is off by default and surface-only by default.
- The whole subsystem is gated behind `serendipityProtocol.enabled: false` by default.

## Configuration

```jsonc
{
  "serendipityProtocol": {
    "enabled": false,          // gates the store, tools, CLI, and injection
    "defaultLevel": 2.5,       // 0–4 fallback when no scoped pref applies
    "injectPolicy": true,
    "injectionMaxChars": 400,
    "dedupWindowDays": 30,
    "deferredTtlDays": 30,     // 0 = never expire
    "digest": { "enabled": true },
    "resurface": { "enabled": true, "minLevel": 3, "cooldownPrompts": 10, "maxChars": 200 },
    "sweep": { "enabled": false, "minLevel": 4, "dispatch": false, "target": "goal", "maxDispatch": 3 }
  }
}
```

## CLI reference

```
openclaw hybrid-mem serendipity list [--status s] [--type t] [--risk r] [--repo r] [--backlog] [--limit n] [--json]
openclaw hybrid-mem serendipity show <id> [--json]
openclaw hybrid-mem serendipity record <title> --type <t> [--description d] [--risk r] [--repo r] [--evidence e...]
openclaw hybrid-mem serendipity resolve <id> --status <s> [--action text]
openclaw hybrid-mem serendipity backlog [--limit n] [--json]
openclaw hybrid-mem serendipity promote <id> --target goal|task|skill   (agent tool: serendipity_promote)
openclaw hybrid-mem serendipity digest [--since 7d] [--format md|json] [--out path|-]
openclaw hybrid-mem serendipity sweep [--json]
openclaw hybrid-mem serendipity level get [--json]
openclaw hybrid-mem serendipity level set <level> --scope <s> [--target t] [--disabled]
```
