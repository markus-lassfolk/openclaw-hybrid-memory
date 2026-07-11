---
layout: default
title: Proactive Research
parent: Features
nav_order: 6
---
# Proactive Research — your agent notices, decides, and researches overnight

The proactive research loop turns the living-memory observation layer into initiative: the agent
notices a recurring pattern about *you* (from what, when, and how you interact), concludes it
deserves attention, researches it on the web overnight, and presents a briefing next morning —
with every step auditable back to the memories that triggered it.

```
 living-memory signals            nightly (maintenance)                overnight (cron agent)        next session
┌──────────────────────┐   ┌───────────────┐  ┌────────────────┐   ┌──────────────────────────┐   ┌─────────────┐
│ valence-stamped facts│ → │ insight-      │→ │ research-      │ → │ research-overnight job:   │ → │ 🔎 briefing │
│ routines, patterns,  │   │ synthesis     │  │ trigger        │   │ pick → web research →     │   │ block (once │
│ frustration signals  │   │ (LLM, ≤2/run) │  │ (no LLM, ≤1/n) │   │ research store (briefing) │   │ per session)│
└──────────────────────┘   └───────────────┘  └────────────────┘   └──────────────────────────┘   └─────────────┘
```

## The four steps

1. **Insight synthesis** (`insight-synthesis`, nightly LLM step): reads the last 7 days of
   person-signals — negative-valence memories, mined routines, frustration signals, behavioral
   patterns — and writes at most 2 evidence-linked `insight` facts ("User repeatedly works past
   midnight and expresses fatigue — sleep procrastination may be hurting focus"). The model can
   only cite numbered evidence references that map back to real memory ids; an insight citing
   unknown references is dropped, so hallucinated evidence chains are structurally impossible.
   Insights are ordinary decayable memories tagged `needs-review`.
2. **Trigger policy** (`research-trigger`, nightly, deterministic — no LLM): at most one insight
   per night graduates to research. Gates: importance ≥ 0.74 (salience ≥ 0.6), evidence count,
   topic blocklist plus a sensitive-text regex (credentials never leave the machine), and a
   14-day per-topic cooldown. The pick is recorded as a `research:<slug>` queue fact whose
   provenance points at the insight — which points at the raw evidence.
3. **Research executor** (`research-overnight` OpenClaw cron job, default 03:30, isolated
   heavy-model agent session): runs `openclaw hybrid-mem research pick --json`, researches the
   topic with the session's web tools, and stores ≤400 words via
   `openclaw hybrid-mem research store` — the **single writer** for briefings, which validates
   topic state, length, and http(s) sources, and records the full provenance chain including
   every source URL. Most nights it replies `SKIPPED: no research topic` and exits. No web tools
   configured ⇒ `TOOLING_BLOCKED` and **no** briefing from prior knowledge — a briefing without
   checkable sources is worse than none.
4. **Morning delivery**: the next session start injects a one-time "🔎 Overnight research
   briefing" block (headline + `memory_recall` hint; index-only exposure, so surfacing it never
   counts as a recall). Optionally, setting `research.delivery { mode: "announce", channel, to }`
   also pushes the agent's summary to that channel when the overnight run finishes.

## Why you can trust it

- **Explainable by construction.** Christoffer's "I can't describe exactly why it decided to
  research this" is answered here by walking provenance: briefing → queue fact → insight →
  evidence facts/signals. `openclaw hybrid-mem research status` shows the queue, briefings, and
  evidence counts.
- **Single-writer storage.** The overnight agent cannot write memories directly; only the
  validating `research store` CLI can, and web content is handled as untrusted data (the job
  message forbids following instructions found in fetched pages; briefing headlines are
  injection-sanitized again at delivery).
- **Bounded cost.** One heavy-model agent turn per night at most, one topic per night, 14-day
  topic cooldown, 20h re-run guard, and the whole loop off with one flag.

## Configuration (`research.*`, all default-on except announce delivery)

| Key | Default | Effect |
|-----|---------|--------|
| `research.enabled` | `true` | Master gate: synthesis, trigger, cron job, and delivery. |
| `research.schedule` | `"30 3 * * *"` | Cron expression for the overnight agent. |
| `research.insights.maxPerRun` / `windowDays` / `minEvidence` | `2` / `7` / `2` | Synthesis caps. `insights.model` overrides the maintenance-tier model. |
| `research.trigger.minImportance` | `0.74` | Insight importance floor (importance = 0.5 + 0.4 × salience). |
| `research.trigger.cooldownDays` / `maxPerNight` | `14` / `1` | Re-research cooldown per topic; nightly budget. |
| `research.trigger.topicBlocklist` | `["credential","secret","security"]` | Topics never researched (a sensitive-text regex also always applies). |
| `research.executor.maxBriefingChars` / `maxSources` | `4000` / `8` | Briefing storage caps. |
| `research.delivery.injectDays` / `maxBriefings` | `3` / `2` | Session-start injection window and per-session cap (0 disables injection). |
| `research.delivery.mode` + `channel` + `to` | `"none"` | Set all three for an announce push (e.g. Telegram) when the overnight run completes; partial config safely maps to none. |

## Operations

- `openclaw hybrid-mem verify --fix` (or install/upgrade) installs the `research-overnight` cron
  job alongside the maintenance jobs; `research.enabled: false` gate-disables it (and re-enables
  when flipped back).
- The nightly steps run inside the standard maintenance orchestrator (`openclaw hybrid-mem
  maintenance nightly`); summaries appear in the maintenance logs
  (`stored=… candidates=… evidence=…`, `picked=… cooldown=… blocklist=…`).
- Everything the loop produces is visible in the Memory Graph (insights, queue facts, briefings,
  and their provenance edges) and manageable like any other memory.

## Related docs

- [LIVING-MEMORY.md](LIVING-MEMORY.md) — the observation layer this loop builds on
- [OPERATIONS.md](OPERATIONS.md) — cron jobs and maintenance tiers
- [CONFIGURATION.md](CONFIGURATION.md) — full config reference
