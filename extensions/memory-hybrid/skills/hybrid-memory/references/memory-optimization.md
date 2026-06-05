# Memory optimization — inspection, settings, and task order

Use this when the user wants **best-practice tuning**, a **full maintenance pass**, or to understand **what is on** vs **what to enable next**.

---

## 1. See what is enabled (before changing anything)

Run these in a shell (host where OpenClaw + the plugin run):

| Step | Command | What you learn |
| --- | --- | --- |
| A | `openclaw hybrid-mem verify` | Embedding, SQLite, LanceDB, embedding↔vector dimensions, cron jobs registered, feature toggles printed as **true/false** |
| B | `openclaw hybrid-mem config` | Full effective-style view of plugin keys (or use `openclaw hybrid-mem config-set <key>` **without a value** to read one key) |
| C | `openclaw hybrid-mem stats` (optional: `--efficiency`) | Fact counts, decay breakdown, store health |
| D | `openclaw hybrid-mem maintenance steps` | **48-step orchestrator** — guard intervals, last run, what is due tonight vs on the gateway tick |
| E | Inspect `~/.openclaw/cron/jobs.json` | Look for **`hybrid-mem:maintenance-nightly`** (consolidated mode). Legacy per-task jobs may show `superseded: true` after upgrade |

If **embedding vs LanceDB dimensions** mismatch, fix config and run `openclaw hybrid-mem re-index` if the docs say so—semantic recall will be wrong until aligned.

**Full command tree:** `openclaw hybrid-mem help` (grouped namespaces) or repo [MAINTENANCE-TASKS-MATRIX.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md).

---

## 2. Highest-impact settings (typical priorities)

These are **general** priorities; exact benefit depends on workload.

| Area | Why it matters | If disabled / wrong |
| --- | --- | --- |
| **Embedding provider + model + dimensions** | Everything vector-related depends on it | Plugin may not load, or recall silently degrades |
| **`autoCapture` / `autoRecall`** | Live conversation → memory without manual `memory_store` | Missing facts unless user distills often |
| **`distill` (session distillation)** | Backfills facts from **session JSONL** history | Old chats never contribute to memory |
| **`memorySearch`** (OpenClaw) + good **`memory/**/*.md`** | File corpus search separate from LanceDB | “Where did I write X?” suffers |
| **`extraction.preFilter`** (Ollama) | Cheap triage before cloud LLM on distill/extract pipelines | Higher API cost on noisy sessions |
| **`reflection` + `reflect-*`** | Meta-patterns, rules, proposals | Less self-improvement over time |
| **`procedures` + extract/generate-auto-skills** | Reusable tool sequences → skills | No procedural layer |
| **`selfCorrection`** | Learns from user corrections → memory + TOOLS.md | Repeated mistakes |
| **`nightlyCycle` / dream-cycle** | Prune → consolidate event log → reflect chain | Layer-1 episodic consolidation depends on this being on |
| **`consolidate` / `compact` / `scope promote`** | Merge duplicates, tier DB, promote scoped facts | Drift, bloat, session facts stuck in session scope |
| **`ingest.paths`** + **`ingest-files`** | Indexes `skills/**`, `TOOLS.md`, `AGENTS.md` as facts | Lower recall of workspace “how we work” docs |
| **`graph.enabled`** (NER + contacts) | Store-time PERSON/ORG extraction (**franc** + LLM); **`memory_directory`** for org/people views | No structured contact/org lists without it; use **`enrich-entities`** to backfill old facts |
| **`maintenance.orchestrator`** (default on) | Gateway tick + one nightly cron instead of 18 separate jobs | Set `consolidatedCronJobs: false` only if you need legacy per-task crons |

For deep detail, see the repo: [CONFIGURATION.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION.md), [GRAPH-MEMORY.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GRAPH-MEMORY.md), [MAINTENANCE-TASKS-MATRIX.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md).

---

## 3. Maintenance orchestrator (preferred)

Since 2026.6, maintenance runs through a **48-step hybrid orchestrator** with **staggered guards** (20h / 44h / 68h / 5d / 25d). Weekly/monthly work is **not** separate cron jobs — guards decide when each step is due.

| Layer | Trigger | Command | Typical steps |
| --- | --- | --- | --- |
| **Gateway tick** | ~every 60 min (+ startup) | `maintenance cycle` | prune, compact, sensor-sweep, auto-classify, proposals-prune, build-languages (when due) |
| **Nightly cron** | Daily 02:00 `hybrid-mem:maintenance-nightly` | `maintenance nightly --verbose` | distill, extract-daily, dream-cycle, reflect chain, self-correction, LLM-heavy quality steps (only when guards say due) |
| **Manual catch-up** | Operator | `maintenance full` or `run-all` | cycle + nightly tiers (respects guards unless `--force`) |
| **Inspect** | Anytime | `maintenance steps` | Full registry: guard interval, last run, eligible now |

**Start here for “run everything”:**

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem maintenance steps          # see what's due
openclaw hybrid-mem maintenance full --verbose # or: run-all
```

After long downtime: `openclaw hybrid-mem maintenance full --force --verbose` bypasses guard files under `~/.openclaw/memory/step--*.ms`.

**Install / verify --fix** adds the single consolidated cron job and marks legacy hybrid-mem crons `superseded: true` (when consolidated mode is on). Restart the gateway so the 60-minute tick runs.

---

## 4. Individual steps (manual override)

Use these when the user wants **one** step, a **targeted backfill**, or to debug a failing orchestrator step. The orchestrator runs the same underlying commands with guards and scan cursors.

### Quick local / storage (often on gateway tick)

| Step | Command | Notes |
| --- | --- | --- |
| Prune | `openclaw hybrid-mem prune [--verbose]` | Also at gateway startup |
| Compact | `openclaw hybrid-mem compact` | Or `storage compact` |
| Vector maintenance | `openclaw hybrid-mem vectordb-optimize` | Or `storage optimize` |
| Scope promote | `openclaw hybrid-mem scope promote` | Promote important session-scoped facts |
| Sensor sweep | `openclaw hybrid-mem sensor-sweep` | When sensor features enabled |

### Session + daily extraction (nightly tier)

| Step | Command | Notes |
| --- | --- | --- |
| Distill | `openclaw hybrid-mem distill --days 3` | Cron/orchestrator uses scan cursors; `--all` for big backfill |
| Daily logs | `openclaw hybrid-mem extract-daily` | Orchestrator passes `--days 7` |
| Contradictions | `openclaw hybrid-mem resolve-contradictions --auto` | Or `quality contradictions` |
| Enrich entities | `openclaw hybrid-mem enrich-entities --limit 200` | Backfill PERSON/ORG; `--verbose` in cron |

### Learning + reflection (guarded 44h–5d)

| Step | Command | Notes |
| --- | --- | --- |
| Self-correction | `openclaw hybrid-mem self-correction-run` | When `selfCorrection` enabled |
| Dream cycle | `openclaw hybrid-mem dream-cycle` | Requires `nightlyCycle.enabled` |
| Procedures | `openclaw hybrid-mem extract-procedures --days 7` | Or `distill extract-procedures` |
| Directives / reinforcement | `extract-directives`, `extract-reinforcement` | Weekly-frequency guards |
| Auto-skills | `openclaw hybrid-mem generate-auto-skills` | Procedure → skill drafts |
| Reflect chain | `reflect`, `reflect-rules`, `reflect-meta` | Or `reflect patterns`, etc. |
| Proposals | `openclaw hybrid-mem generate-proposals` | Persona proposals |

### Deep / monthly-style (5d–25d guards)

| Step | Command | Notes |
| --- | --- | --- |
| Consolidate | `openclaw hybrid-mem consolidate --threshold 0.92` | Or `quality consolidate` |
| Languages | `openclaw hybrid-mem build-languages` | Multilingual NER keywords |
| Decay backfill | `openclaw hybrid-mem backfill-decay` | Once per install (marker) |
| Workspace ingest | `openclaw hybrid-mem ingest-files` | Uses `ingest.paths` |

**Always end with:** `openclaw hybrid-mem verify` if anything failed or config changed.

**Grouped CLI (preferred):** `distill`, `reflect`, `storage`, `quality`, `learn`, `maintenance` — each accepts `--help`. Flat names (`run-all`, `stats`, `extract-daily`, …) still work with a deprecation hint on stderr.

---

## 5. Cron schedule (what runs automatically)

### Consolidated mode (default)

| When | Job / trigger | What runs |
| --- | --- | --- |
| **Every ~60 min** | Gateway maintenance tick | `maintenance cycle` — local steps (prune, compact, sensor-sweep, …) |
| **Daily 02:00** | `hybrid-mem:maintenance-nightly` in `~/.openclaw/cron/jobs.json` | `openclaw hybrid-mem maintenance nightly --verbose` — LLM steps only when guards are due (~5–7 steps on a typical night, not all 48) |
| **After plugin upgrade** | Gateway startup (once) | Post-upgrade pipeline (~20s delay) |

Logs: `~/.openclaw/logs/cron-hybrid-mem/` (created on install). Per-step harness lines include `HM_EXIT` exit codes when using the bundled cron message.

**Disable consolidated mode:** `maintenance.orchestrator.consolidatedCronJobs: false` — restores legacy per-task cron layout (see repo docs).

### Legacy multi-job layout (opt-in only)

If consolidated mode is off, install/verify may register separate daily/weekly jobs (prune→distill chain, self-correction, dream-cycle, etc.). Prefer upgrading to consolidated mode unless you rely on custom per-job schedules.

Canonical reference: [MAINTENANCE-TASKS-MATRIX.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md).

---

## 6. File quality (cheap wins)

- Keep **`MEMORY.md`** short; put detail in **`memory/**`**.
- Use clear headings and consistent paths in markdown so **memorySearch** chunks well.
- See [MAINTENANCE.md — Writing Effective Memory Files](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE.md#writing-effective-memory-files).

---

## 7. Refresh this skill in your workspace

- **First gateway start:** copies bundled skill if `{workspace}/skills/hybrid-memory/SKILL.md` is missing.
- **After plugin upgrade:** run **`openclaw hybrid-mem install`** to overwrite the workspace skill + `references/` and refresh the managed block in `TOOLS.md`.
- Custom edits in the workspace skill are **not** overwritten on every restart — only `install` replaces them.
