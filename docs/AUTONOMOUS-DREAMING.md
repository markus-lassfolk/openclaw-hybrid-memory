---
layout: default
title: Autonomous Dreaming
parent: Architecture
nav_order: 25
---

# Autonomous Dreaming

Epic [#2169](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2169). Child issues: [#2170](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2170)–[#2179](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2179), reload fix [#2181](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2181).

## Product intent

**Autonomous machine review is the design center.** Human proposal/approve/deny UX is an escape hatch — not the happy path for continual learning ([#2177](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2177)).

The **candidate store is for autonomous safety**, not a human review inbox. The machine gates, promotes, observes outcomes, and rolls back.

## Task path vs Dream path

```text
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│ In-band (task / session)    │     │ Out-of-band Dream (#2171)         │
│                             │     │                                  │
│ short-loop capture          │     │ snapshot store_revision          │
│ memory_store / auto-capture │     │ attach permission-scoped sessions│
│ immediate FactsDB write     │     │ compose distill→…→consolidate    │
│                             │     │ emit candidates (#2170)          │
│                             │     │ machine gates → promote/rollback │
└─────────────────────────────┘     └──────────────────────────────────┘
```

Task path learns for *this* session. Dream path spends dedicated maintenance budget (`CostFeature.dream`) to improve curriculum for *future* sessions.

## Control plane

```
sessions + store snapshot
        ↓
   Dream run (#2171) + steering (#2176)
        ↓
 candidate entries (#2170)
        ↓
 machine gates (#2172 prevalence / evidence / permission #2174)
        ↓
 auto-promote | quarantine  (+ OCC #2175)
        ↓
 outcome window (#2173) → auto-rollback if regression  ← self-heal = “deny”
        ↓
 ROI report (#2179)
```

Existing Dream Cycle, distill, reflection, consolidate, Loom, and Event Bus producers are **composed under Dream**, not deleted. When `dreaming.enabled` and `skipNightlyOverlap` are true, overlapping nightly steps are skipped so Dream owns them.

There is **no separate Rumination Engine** process ([#2178](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2178)): Event Bus status lifecycle is advanced by distributed consumers (maintenance + Dream).

## Self-heal (outcome feedback) — autonomy substitute for deny

After promote ([#2173](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2173)):

1. Capture a **pre-promote baseline** (session-scoped feedback signals).
2. Tag applied facts `dream-run:<id>` for attribution. While `autoRollback` is enabled, recall mildly **prefers** those tagged facts (canary boost) so post-promote curriculum is exercised.
3. Observe for `autoRollback.observeWindowHours`.
4. Nightly `dream-outcome-probe` (when autoRollback enabled) collects after-window metrics **scoped to the dream’s sessions**, compares effect score, and **auto-rollbacks** via reverse plan on regression.
5. Decisions (`keep` / `rollback` / `insufficient_data`) are journaled on `dream_runs.metrics_summary_json`. Insufficient data never false-rollbacks.

## How to read Dream ROI

`hybrid-mem dream report --since-days 30 --json` ([#2179](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2179)):

| Field | Meaning |
|-------|---------|
| `totals.cost.tokens` / `usdProxy` | LLM spend attributed to `feature=dream` during compose |
| `totals.promoted` / `rolledBack` / `quarantined` | Lifecycle outcomes |
| `totals.candidatePromoteRatio` | Candidates that cleared gates vs proposed |
| `perRun[].metricsSummary` | Per-run cost/hygiene + optional outcome decision |
| `howToRead` | Inline guidance string |

Shadow mode first: compare ROI and rollback rate before turning `autoPromote` on.

## Steering (set-and-forget)

`dreaming.steering` ([#2176](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2176)) — default **personal** profile for single-operator autonomy:

- **promote:** preference, routine, insight
- **ignore:** one_off_debug, transient_path, secret_like
- **notes:** freeform LLM guidance injected into distill/reflect prompts

No nightly UI confirmation. Profile id is stored on each `dream_run`.

## Config (defaults conservative)

```json5
{
  dreaming: {
    enabled: false,
    mode: "autonomous",          // #2177 — machine gates are happy path
    compose: ["distill", "contradictions", "reflect", "consolidate"],
    maxSessions: 20,
    maxRuntimeMinutes: 30,
    skipNightlyOverlap: true,
    promoteAfterRun: false,
    candidateStore: {
      enabled: false,
      shadow: true
    },
    autoPromote: { enabled: false, requireProvenance: true, blockOnContradictionWorsening: true },
    autoRollback: { enabled: false, observeWindowHours: 24, regressionThreshold: 0.15 },
    prevalence: { /* session/agent/user/global bars — #2172 */ },
    permissionBoundary: {
      targetScope: "session",    // raise for global curriculum (#2174)
      enforce: true,
      personalMode: false
    },
    steering: {
      profile: "personal",
      promote: ["preference", "routine", "insight"],
      ignore: ["one_off_debug", "transient_path", "secret_like"]
    }
  }
}
```

When `mode: "autonomous"` and Dream is enabled, nightly `pending-digest` is skipped so human triage is not implied for correctness. Set `mode: "supervised"` to restore digest-first workflows.

Compose under candidate/shadow mode runs maintenance stages with **`dryRun: true`** so the live store is unchanged until machine promote.

**Shadow matrix**

| candidateStore | shadow | autoPromote | Behavior |
|----------------|--------|-------------|----------|
| off | — | — | Today’s live mutate paths unchanged |
| on | true | off | Candidates + gates + would-promote; no live apply |
| on | false | on | Real promote when gates pass |
| + autoRollback on | — | — | Observe → reverse plan on regression (#2173) |

## CLI

```bash
openclaw hybrid-mem dream run --json --dry-shadow
openclaw hybrid-mem dream run --sessions s1,s2 --compose distill,reflect --json
openclaw hybrid-mem dream status
openclaw hybrid-mem dream status <id>
openclaw hybrid-mem dream promote <id>        # machine path; --force under shadow
openclaw hybrid-mem dream rollback <id>       # escape hatch
openclaw hybrid-mem dream observe <id>        # auto-collect metrics; --apply to rollback
openclaw hybrid-mem dream observe --all       # probe elapsed windows
openclaw hybrid-mem dream report --since-days 30 --json
```

## Escape hatches (keep)

- Inspect / promote / rollback / observe / report via CLI above
- `dreaming.mode: "supervised"` for operators who want digest-first workflows
- Manual `--force` promote under shadow for debugging
