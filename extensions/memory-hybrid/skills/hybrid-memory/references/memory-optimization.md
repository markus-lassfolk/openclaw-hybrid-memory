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
| D | Inspect `~/.openclaw/cron/jobs.json` | Which **hybrid-mem:*** jobs exist (disabled jobs stay disabled; verify does not re-enable them) |

If **embedding vs LanceDB dimensions** mismatch, fix config and run `openclaw hybrid-mem re-index` if the docs say so—semantic recall will be wrong until aligned.

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
| **`nightlyCycle` / `dream-cycle`** | Prune → consolidate event log → reflect chain | Layer-1 episodic consolidation depends on this being on |
| **`consolidate` / `compact` / `scope promote`** | Merge duplicates, tier DB, promote scoped facts | Drift, bloat, session facts stuck in session scope |
| **`ingest.paths`** + **`ingest-files`** | Indexes `skills/**`, `TOOLS.md`, `AGENTS.md` as facts | Lower recall of workspace “how we work” docs |
| **`graph.enabled`** (NER + contacts) | Store-time PERSON/ORG extraction (**franc** + LLM); **`memory_directory`** for org/people views | No structured contact/org lists without it; use **`enrich-entities`** to backfill old facts |

For deep detail, see the repo: [CONFIGURATION.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION.md), [GRAPH-MEMORY.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/GRAPH-MEMORY.md), [MAINTENANCE-TASKS-MATRIX.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md).

---

## 3. One command: broad “catch-up”

**`openclaw hybrid-mem run-all`** runs a long, ordered pipeline (prune, compact, distill, extracts, reflection, self-correction, languages, etc.—**respecting feature flags**). It is the best **single** entry for “run everything that makes sense with my current config.”

**Not covered by `run-all`:** e.g. **`consolidate`**, **`scope promote`**, **`sensor-sweep`**—those are mainly **weekly/monthly cron** or manual. See matrix below.

---

## 4. Manual order (when running steps one-by-one)

If the user prefers **explicit** steps or `run-all` is too heavy, use this **canonical** ordering (aligned with scheduled jobs in the plugin docs).

### A. Nightly-style sweep (session + daily files + contradictions)

1. `openclaw hybrid-mem prune`
2. `openclaw hybrid-mem distill --days 3` (adjust window as needed; `--all` for big backfill)
3. `openclaw hybrid-mem extract-daily` (as configured)
4. `openclaw hybrid-mem resolve-contradictions`
5. `openclaw hybrid-mem enrich-entities --limit 200` (backfill PERSON/ORG rows for facts still missing them; uses LLM when graph is on)

### B. Self-correction (after distill if you want fresh incidents)

6. `openclaw hybrid-mem self-correction-run` (when `selfCorrection` is enabled)

### C. Dream cycle (optional; requires `nightlyCycle.enabled`)

7. `openclaw hybrid-mem dream-cycle`

### D. Weekly-style (procedures, directives, reinforcement, auto-skills)

8. `openclaw hybrid-mem extract-procedures --days 7`
9. `openclaw hybrid-mem extract-directives --days 7`
10. `openclaw hybrid-mem extract-reinforcement --days 7`
11. `openclaw hybrid-mem generate-auto-skills`

### E. Reflection + proposals (weekly cron mirrors)

12. `openclaw hybrid-mem reflect --verbose`
13. `openclaw hybrid-mem reflect-rules --verbose`
14. `openclaw hybrid-mem reflect-meta --verbose`
15. `openclaw hybrid-mem generate-proposals` (if persona proposals matter)

### F. Deep storage maintenance (weekly cron mirror)

16. `openclaw hybrid-mem compact`
17. `openclaw hybrid-mem vectordb-optimize` (when you use vector DB maintenance)
18. `openclaw hybrid-mem scope promote` (promote important session-scoped facts)

### G. Monthly-style consolidation

19. `openclaw hybrid-mem consolidate --threshold 0.92`
20. `openclaw hybrid-mem build-languages`
21. `openclaw hybrid-mem backfill-decay`
22. `openclaw hybrid-mem enrich-entities --limit 500` (larger backfill pass; optional if nightly already ran)

### H. Workspace corpus (optional but high value for recall of docs)

23. `openclaw hybrid-mem ingest-files` (uses `ingest.paths`—default includes `skills/**/*.md`, `TOOLS.md`, `AGENTS.md`)

**Always end with:** `openclaw hybrid-mem verify` if anything failed or config changed.

---

## 5. Cron schedule (what runs automatically)

If **`openclaw hybrid-mem install`** / **`verify --fix`** has been run, jobs in `~/.openclaw/cron/jobs.json` mirror roughly:

| When | Bundle |
| --- | --- |
| Daily 02:00 | prune → distill → extract-daily → resolve-contradictions → enrich-entities |
| Daily 02:30 | self-correction-run |
| Daily 02:45 | dream-cycle (gated) |
| Weekly | reflection, procedure pipeline, compact/scope, proposals |
| Monthly | consolidate, languages, backfill-decay, enrich-entities |

Exact names/schedules: [CLI-REFERENCE.md — Maintenance cron jobs](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CLI-REFERENCE.md#maintenance-cron-jobs).

---

## 6. File quality (cheap wins)

- Keep **`MEMORY.md`** short; put detail in **`memory/**`**.
- Use clear headings and consistent paths in markdown so **memorySearch** chunks well.
- See [MAINTENANCE.md — Writing Effective Memory Files](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE.md#writing-effective-memory-files).
