---
layout: default
title: Autonomous Dreaming
parent: Architecture
nav_order: 25
---

# Autonomous Dreaming

Epic [#2169](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2169). Candidate/shadow store + machine promote/rollback: [#2170](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2170). Unified Dream: [#2171](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2171).

## Product intent

The **candidate store is for autonomous safety**, not a human review inbox.

Anthropic-style dreaming architecture (out-of-band curation, candidate memory state, provenance) is useful. Hybrid Memory’s product preference is different: the operator does **not** click Approve/Reject on curriculum changes. The machine must gate, promote, and roll back.

Persona/skill proposal queues remain escape hatches elsewhere. They are **not** the happy path for dream curriculum.

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
   Dream run (#2171)
        ↓
 candidate entries (#2170)
        ↓
 machine gates (#2172 prevalence / evidence)
        ↓
 auto-promote | quarantine  (+ OCC #2175)
        ↓
 outcome window (#2173) → auto-rollback if regression
        ↓
 ROI report (#2179)
```

Existing Dream Cycle, distill, reflection, consolidate, Loom, and Event Bus producers are **composed under Dream**, not deleted. When `dreaming.enabled` and `skipNightlyOverlap` are true, overlapping nightly steps are skipped so Dream owns them.

## What lands with #2170 / #2171

| Piece | Role |
|-------|------|
| `dream_runs` + `memory_candidate_entries` | Durable proposed-diff + reverse plan in the **facts** SQLite DB |
| `runDream` / `hybrid-mem dream run` | Unified compose facade → always ≥1 candidate |
| Status lifecycle | `pending → running → gated → promoted \| quarantined \| failed`; `promoted → rolled_back` |
| Machine gates | Provenance, contradiction stub, prevalence/blast-radius (#2172) |
| Promote / rollback | Transactional SQLite apply; reverse plan + `post_hash` drift refuse |
| OCC | `input_store_revision` / `expectedHash` (#2175) |

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
    steering: { profile: "personal", promote: [...], ignore: [...] }
  }
}
```

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
openclaw hybrid-mem dream rollback <id>
```

## Non-goals (sibling issues)

- Blast-radius / prevalence policy depth (#2172)
- Outcome self-heal metrics (#2173)
- Permission-scoped transcript attachment (#2174)
- Steering policy profiles (#2176)
- Autopilot-first defaults (#2177)
- Dream ROI report (#2179)
