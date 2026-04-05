---
name: openclaw_hybrid_memory
description: OpenClaw hybrid memory (memory-hybrid plugin)—SQLite+FTS5 facts, LanceDB semantic recall, auto-capture/recall, decay, contacts/org layer (memory_directory), multilingual NER when graph is on, memorySearch, and memory/ files. Use whenever the user asks about saving or recalling information, memory_store or memory_recall, people or companies in memory, hybrid-mem CLI, MEMORY.md, pruning, distillation, embeddings, tuning recall, which memory settings are enabled, how to optimize or run maintenance (run-all, verify, config, enrich-entities, digest pipelines, cron order), or debugging missing recall—even if they do not say "hybrid memory" by name.
---

# OpenClaw Hybrid Memory

You have **two database-backed layers** plus **file-backed** memory; they are designed to work together.

| Layer | Role | Agent action |
| --- | --- | --- |
| **Structured facts** | Fast exact-ish lookup (FTS5), entities, categories | Often automatic; use tools when the user asks to save or look up something durable |
| **Vector recall** | Fuzzy "what was that thing?" semantic matches | Often automatic; use `memory_recall` when you need to search explicitly |
| **Contacts & orgs** | Structured people/orgs derived from facts (NER + SQLite) | Use `memory_directory` (`list_contacts`, `org_view`) for lists tied to an org or name prefix—not a substitute for `memory_recall` ranking |
| **Files** | Long-form truth, project state, narrative | Read/write `memory/**/*.md`; keep **MEMORY.md** lean (index), details in subfiles |
| **memorySearch** | Search over markdown files the agent wrote | Usually automatic; do not confuse with LanceDB recall |

**Token discipline:** Bootstrap files load every turn—keep **MEMORY.md** short. Put bulk reference in `memory/**` and pull it in with search or explicit reads.

## Tool names (critical)

All memory-hybrid tools use **underscore** names: `memory_store`, `memory_recall`, `memory_directory`, `memory_forget`, etc. **Do not** use dotted aliases (`memory.store`); some providers reject them.

## When to call tools explicitly

- **Save something that must survive a new session or compaction:** use `memory_store` (and update `memory/` if the user wants a human-readable log).
- **Search or verify what is stored:** use `memory_recall` with a clear query; narrow with category/tags if the config supports it.
- **List people, or everything tied to a company/org:** use `memory_directory` (`list_contacts` or `org_view` with `org_name`) for **structured** results; use `memory_recall` when you need semantic search ranking.
- **User asks to forget or correct a bad fact:** use the appropriate forget/update flow (e.g. `memory_forget` or supersede via store) per plugin behavior.

If **auto-capture** and **auto-recall** are on, many turns need no tool call—but still **store** when the user explicitly asks to remember, or when the information is important and might not be captured automatically.

## Goal Stewardship (when `goalStewardship.enabled: true`)

When goal stewardship is enabled, use these tools for long-running, multi-session objectives:

**When to use:** When the user assigns an outcome-oriented goal ("deploy X", "fix Y and get it merged", "keep Z healthy") that will take multiple sessions, subagents, or heartbeat cycles to complete.

**Tools:**

| Tool | When to call |
|------|-------------|
| `goal_register` | User assigns a multi-session, outcome-oriented goal. Provide a short `label` (alphanumeric/hyphens/underscores, e.g. `deploy-api`), a `description`, and explicit `acceptance_criteria`. Use `confirmed: true` when confirmation policy requires it. |
| `goal_assess` | Every heartbeat stewardship turn — record observations, what was tried, and next action |
| `goal_update` | Goal description, criteria, or priority needs updating as context evolves |
| `goal_complete` | ALL acceptance criteria are verifiably met — include a clear verification summary |
| `goal_abandon` | Goal is no longer relevant (user changed their mind) |
| `active_task_propose_goal` | Draft a `goal_register` payload from an `ACTIVE-TASKS.md` row (task hygiene) |

**Subagent naming convention for automatic goal linkage:**
When spawning a subagent to work on a goal, name the subagent with the goal's label as a prefix.
For example, for goal `deploy-api`, name subagents `deploy-api-run-tests`, `deploy-api-create-pr`,
`deploy-api-deploy`. This creates an automatic link between the subagent and the goal.

**CLI (for inspection):**
- `openclaw hybrid-mem goals list [--all] [--json]` — see all goals and their status
- `openclaw hybrid-mem goals status <label> [--json]` — full detail with history
- `openclaw hybrid-mem goals cancel <label> --reason "..."` — abandon a goal
- `openclaw hybrid-mem goals budget` — check dispatch/assessment budget usage
- `openclaw hybrid-mem goals reset-budget <label>` — reset counters after budget exhaustion
- `openclaw hybrid-mem goals stewardship-run` — manually trigger one watchdog cycle
- `openclaw hybrid-mem goals audit [--jsonl]` — structured audit snapshot

**Docs:** `docs/GOAL-STEWARDSHIP-OPERATOR.md`, `docs/GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md`, `docs/GOAL-STEWARDSHIP-DESIGN.md`, `docs/TASK-HYGIENE.md`

## CLI and health checks

- **`openclaw hybrid-mem verify [--fix]`** — Confirms SQLite, LanceDB, embedding config, and related jobs. Use when memory seems broken after config or gateway changes.
- **`openclaw hybrid-mem stats`** — Quick view of store state.
- **`openclaw hybrid-mem enrich-entities`** — Backfill PERSON/ORG extraction for facts missing mention rows (after upgrades or bulk imports; uses LLM when graph features are on).
- **`openclaw hybrid-mem active-tasks reconcile`** — Run before strategic or heartbeat jobs that trust `ACTIVE-TASKS.md`: moves **In progress** rows to **Completed** when the OpenClaw session transcript no longer exists (fixes stale subagent bookkeeping; issues #978, #981).
- **`openclaw hybrid-mem task-queue-status`** — Prints `state/task-queue/current.json` as JSON for cron (no bare `cat`); use after **`task-queue-touch`** if the gateway has not yet created the idle placeholder (issues #981, #983). For shell-only hosts, use repo **`scripts/task-queue.sh`** (`touch`, `status`, `run`) so the file and PID lifecycle stay consistent ([#1000](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1000)).
- Prefer plugin docs for full command lists (prune, distill, ingest-files, etc.).

## Configuration mindset

- **Embedding provider** must be valid or the plugin fails to load—fix provider, model, and dimensions before debugging "no memories."
- **LLM tiers** (`llm.nano` → `llm.default` → `llm.heavy`): put **cheapest** models first in each list. Nano is for HyDE/classify/summarize; default covers maintenance and dream cycle (unless `nightlyCycle.model` is set); heavy is for distill and hard quality steps. Run `openclaw hybrid-mem config` to see effective first choices.
- **Scopes** (global / user / agent / session) matter for who sees a fact; match the user's intent.
- **Decay / tiering** affect how long items stay hot—do not assume everything is permanent unless configured.

## Progressive disclosure

- For deep behavior (HyDE, RRF, procedures, crystallization, cron jobs), rely on **this skill for basics**, then read project docs or the plugin README when a task requires a specific subsystem.

## Optimizing memory (inspection, settings, task order)

When the user wants **maximum memory quality**, **which toggles are on**, **what to enable next**, or a **step-by-step maintenance / digest / optimization run**:

1. Tell them to run **`openclaw hybrid-mem verify`** and **`openclaw hybrid-mem config`** first (ground truth for health + flags).
2. For a **single bundled catch-up**, use **`openclaw hybrid-mem run-all`** (respects feature flags; see repo docs for what it includes vs cron-only tasks).
3. For **manual ordering** (nightly → weekly → monthly mirrors) and **high-impact settings**, read the bundled reference:

**`references/memory-optimization.md`** (same folder as this `SKILL.md` under `{workspace}/skills/hybrid-memory/` — copied there on first gateway start if missing, or by `openclaw hybrid-mem install`)

That file covers: inspection commands, benefit-ranked settings, `run-all` vs one-by-one chains, and how cron maps to CLI—without duplicating the full repo manuals.

## Reference

- **Optimization guide (bundled):** `references/memory-optimization.md`
- Upstream docs: [openclaw-hybrid-memory repository](https://github.com/markus-lassfolk/openclaw-hybrid-memory) (`docs/QUICKSTART.md`, `docs/CONFIGURATION.md`, `docs/GRAPH-MEMORY.md`, `docs/MULTILINGUAL-SUPPORT.md`, `docs/MAINTENANCE-TASKS-MATRIX.md`).
- OpenClaw skills layout: [Creating skills](https://docs.openclaw.ai/tools/creating-skills).
