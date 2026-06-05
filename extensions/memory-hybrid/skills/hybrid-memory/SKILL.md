---
name: openclaw_hybrid_memory
description: OpenClaw hybrid memory (memory-hybrid plugin)—SQLite+FTS5 facts, LanceDB semantic recall, auto-capture/recall, decay, contacts/org layer (memory_directory), multilingual NER when graph is on, memorySearch, and memory/ files. Goal stewardship (goal_* tools, heartbeat scheduling, OpenClaw cron jobs, verify/troubleshooting). Maintenance orchestrator (maintenance nightly/cycle/full/steps, consolidated cron, run-all). Credentials vault (credential_* tools, credentials get --value-only). Generated skills (skills queue/telemetry/doctor). Workboard integration (bidirectional task/goal sync to Kanban UI). Wiki integration and Dreaming UI (memory-wiki bridge, corpus supplement, bidirectional fact editing, dream findings ingestion). Use whenever the user asks about saving or recalling information, memory_store or memory_recall, people or companies in memory, hybrid-mem CLI, MEMORY.md, goals, goal_assess, scheduled heartbeat pulses, pruning, distillation, embeddings, tuning recall, which memory settings are enabled, how to optimize or run maintenance, credential vault, crystallization, Workboard, wiki, Dreaming UI, or debugging missing recall—even if they do not say "hybrid memory" by name.
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

**Two layers (do not confuse them):**

| Layer | What it does |
| --- | --- |
| **Watchdog** (~every 5 min, no LLM) | Updates goal JSON: budgets, stalled/blocked, mechanical verification, PID links. Does **not** start a chat turn. |
| **Heartbeat stewardship** | On **`before_agent_start`**, if the **last user message** matches **heartbeat patterns** (defaults include `heartbeat`, `scheduled ping`, `cron heartbeat`), prepends goal context so you can run `goal_assess` etc. **Requires a real agent turn** — the plugin does not schedule LLM runs by itself. |

**Recall ≠ goals:** `memory_recall` does not replace **`goal_*` tools**. Shared goals require the same **`OPENCLAW_WORKSPACE`** / `goalsDir` and stewardship enabled for whichever agent runs the pulse.

**Tools:**

| Tool | When to call |
|------|-------------|
| `goal_register` | User assigns a multi-session, outcome-oriented goal. Provide a short `label` (alphanumeric/hyphens/underscores, e.g. `deploy-api`), a `description`, and explicit `acceptance_criteria`. Use `confirmed: true` when confirmation policy requires it. |
| `goal_assess` | Every heartbeat stewardship turn — record observations, what was tried, and next action |
| `goal_update` | Goal description, criteria, or priority needs updating as context evolves |
| `goal_complete` | ALL acceptance criteria are verifiably met — include a clear verification summary |
| `goal_abandon` | Goal is no longer relevant (user changed their mind) |
| `active_task_checkpoint` | Atomically checkpoint active work (project facts + episode audit + optional wake schedule + optional ACTIVE-TASKS projection refresh) |
| `active_task_propose_goal` | Draft a `goal_register` payload from an `ACTIVE-TASKS.md` row (task hygiene) |

**Subagent naming convention for automatic goal linkage:**
When spawning a subagent to work on a goal, name the subagent with the goal's label as a prefix.
For example, for goal `deploy-api`, name subagents `deploy-api-run-tests`, `deploy-api-create-pr`,
`deploy-api-deploy`. This creates an automatic link between the subagent and the goal.

**Scheduled “pulse” (OpenClaw cron):** To get recurring **LLM** stewardship, add a job in `~/.openclaw/cron/jobs.json` with `payload.kind: agentTurn` and a **short first line** that matches patterns, e.g. `cron heartbeat` then instructions. You may set **`agentId`** to a dedicated agent (not `main`) and **`sessionTarget: isolated`** so chat stays free. Cadence: often **a few times per day** or **every 4–6 hours** to start; avoid 5-minute pulses unless goals are truly urgent (cost/noise). Full examples and pitfalls: **`docs/GOAL-STEWARDSHIP-OPERATOR.md`** (User guide + verification + logging).

**CLI (for inspection):**
- `openclaw hybrid-mem goals list [--all] [--json]` — see all goals and their status
- `openclaw hybrid-mem goals status <label> [--json]` — full detail with history
- `openclaw hybrid-mem goals cancel <label> --reason "..."` — abandon a goal
- `openclaw hybrid-mem goals budget` — check dispatch/assessment budget usage
- `openclaw hybrid-mem goals reset-budget <label>` — reset counters after budget exhaustion
- `openclaw hybrid-mem goals stewardship-run` — **watchdog only** (same deterministic pass as the timer — not a heartbeat turn)
- `openclaw hybrid-mem goals audit [--jsonl]` — structured audit snapshot
- `openclaw hybrid-mem goals config` — effective stewardship flags and paths

**Verify & troubleshoot (operator + you helping them):**

1. **`openclaw hybrid-mem verify`** — With stewardship enabled, read the **Goal stewardship (heartbeat)** block: matcher count + warnings if no cron job message matches patterns (or file missing). This is **best-effort**; unrelated long prompts that contain the substring `heartbeat` (e.g. a filename) can give misleading “match” — prefer a **dedicated short pulse job** or custom `heartbeatPatterns`.
2. **`openclaw hybrid-mem goals status`** — Blockers, escalation, `lastMechanicalCheck`, etc.
3. **Gateway logs** — Search for `memory-hybrid: goal stewardship bundle` (prepend ran), `goal stewardship skipped — global dispatch rate limit`, `goal stewardship injection error`.
4. If **nothing happens for hours:** often no **scheduled turn** with a matching message, or the pulse runs on an agent/workspace without shared goals. Confirm the job’s **`payload.message`** is what the agent sees as the user message, not only the job name.

**Docs:** `docs/GOAL-STEWARDSHIP-OPERATOR.md` (start here — user guide, cron examples, verify, logging), `docs/GOAL-STEWARDSHIP-AUDIT-PLAYBOOK.md`, `docs/GOAL-STEWARDSHIP-DESIGN.md`, `docs/TASK-HYGIENE.md`

## Maintenance orchestrator (2026)

Maintenance is driven by a **48-step hybrid orchestrator** — not a pile of separate daily/weekly cron jobs. **Guards** (20h / 44h / 68h / 5d / 25d) decide when each step runs.

| What you want | Command |
| --- | --- |
| See what's due / last run | `openclaw hybrid-mem maintenance steps` |
| Normal nightly work (cron uses this) | `openclaw hybrid-mem maintenance nightly --verbose` |
| Local lightweight steps (~hourly via gateway) | `openclaw hybrid-mem maintenance cycle` |
| Full catch-up (cycle + nightly) | `openclaw hybrid-mem maintenance full --verbose` or **`run-all`** |
| Force everything after long downtime | `... maintenance full --force --verbose` |

**Automatic schedule (consolidated mode, default):**

- **Gateway tick (~60 min):** `maintenance cycle` — prune, compact, sensor-sweep, etc.
- **Daily 02:00 cron:** one job `hybrid-mem:maintenance-nightly` → `maintenance nightly --verbose`
- **`verify --fix` / `install`:** ensures that cron job exists; legacy hybrid-mem crons are marked superseded

Deep detail: bundled **`references/memory-optimization.md`** §3–5 and repo **`docs/MAINTENANCE-TASKS-MATRIX.md`**.

## CLI quick reference

**Discovery:** `openclaw hybrid-mem help` · `openclaw hybrid-mem examples maintenance` · `<group> --help`

**Health & config (start here):**

- **`verify [--fix]`** — SQLite, LanceDB, embeddings, maintenance cron, goal-stewardship heartbeat check
- **`config`** / **`config-set <key> [value]`** — effective toggles and LLM tier choices
- **`stats`** · **`health`** · **`doctor`** — store snapshot vs full diagnostics
- **`maintenance steps`** — orchestrator registry (see above)

**Grouped namespaces (preferred over flat aliases):**

| Group | Examples |
| --- | --- |
| **`maintenance`** | `nightly`, `cycle`, `full`, `steps`, `run-all`, `cron-health` |
| **`distill`** | `run`, `window`, `extract-daily`, `extract-procedures`, … |
| **`reflect`** | `patterns`, `rules`, `meta`, `dream`, `identity` |
| **`storage`** | `stats`, `compact`, `optimize`, `reembed`, `re-index` |
| **`quality`** | `duplicates`, `consolidate`, `contradictions`, `classify`, `enrich-entities` |
| **`learn`** | `self-correction`, `feedback`, `implicit` |

Flat names (`run-all`, `extract-daily`, `stats`, …) still work; stderr may suggest the grouped form.

**Daily use:** `search`, `lookup`, `store`, `ingest-files`, `enrich-entities`, `active-tasks reconcile`, `task-queue-status`, `goals …`, `skills …`, `credentials …`

**Operator shortcuts:**

- **`enrich-entities`** — backfill PERSON/ORG rows after upgrades or bulk imports
- **`active-tasks reconcile`** — before heartbeat/strategic jobs: complete stale **In progress** rows when session transcripts are gone
- **`task-queue-status`** / **`task-queue-touch`** — cron-safe task-queue JSON (prefer over bare `cat`); shell-only hosts: repo **`scripts/task-queue.sh`**

**Workspace skill refresh:** Bundled files copy on first gateway start if missing. After upgrades, run **`openclaw hybrid-mem install`** to overwrite `{workspace}/skills/hybrid-memory/` and refresh the managed block in `TOOLS.md`.

## Agent tools (by category)

All tools use **underscore** names. Below is a compact index — not every deployment registers every tool (feature flags apply).

| Category | Tools |
| --- | --- |
| **Core memory** | `memory_store`, `memory_recall`, `memory_forget`, `memory_directory`, `memory_link`, `memory_promote`, `memory_prune`, `memory_health`, `memory_gaps` |
| **Episodes & timeline** | `memory_record_episode`, `memory_search_episodes`, `memory_recall_timeline`, `memory_checkpoint` |
| **Procedures & reflection** | `memory_recall_procedures`, `memory_reflect`, `memory_reflect_rules`, `memory_reflect_meta`, `memory_procedure_feedback` |
| **Graph & documents** | `memory_graph`, `memory_clusters`, `memory_ingest_document`, `memory_ingest_folder`, `memory_path` |
| **Edicts & verification** | `memory_add_edict`, `memory_update_edict`, `memory_remove_edict`, `memory_list_edicts`, `memory_get_edicts`, `memory_edict_stats`, `memory_verify`, `memory_verification_status`, `memory_verified_list`, `memory_provenance` |
| **Goals & tasks** | `goal_register`, `goal_assess`, `goal_update`, `goal_complete`, `goal_abandon`, `active_task_checkpoint`, `active_task_propose_goal` |
| **Credentials vault** | `credential_store`, `credential_get`, `credential_list`, `credential_delete` — secrets stay in vault; memory holds pointers only |
| **Crystallization & skills** | `memory_crystallize`, `memory_crystallize_list`, `memory_crystallize_approve`, `memory_crystallize_reject`, `memory_crystallize_skills_rescan`, `memory_workshop` |
| **Issues & proposals** | `memory_issue_*`, `persona_propose`, `persona_proposals_list`, `memory_propose_tool`, `memory_tool_proposals`, `memory_tool_approve`, `memory_tool_reject` |
| **Workflows & capture** | `memory_workflows`, `apitap_capture`, `apitap_list`, `apitap_peek`, `apitap_to_skill`, `memory_session_observability` |

When vault is **off**, credential-like content is blocked from ordinary `memory_store`. When vault is **on**, use `credential_get` — recall returns pointers, not secrets.

## Credentials vault (when `credentials.enabled: true`)

| Task | CLI |
| --- | --- |
| Vault health | `openclaw hybrid-mem credentials vault-status` |
| List entries (no values) | `credentials list [--service pattern]` |
| Get secret | `credentials get --service <name> [--type api_key]` |
| Scripting / piping | `credentials get --service <name> --value-only` (alias: `--quiet`) — value only, no trailing newline |
| Migrate facts → vault | `credentials migrate-to-vault` |
| Re-encrypt after key change | `credentials encrypt-vault --backup --verify --yes` |
| Audit / clean | `credentials audit`, `credentials prune [--yes]` |

**Encryption key:** `env:VAR`, `file:/absolute/path` (reads **file contents**), or inline secret. Legacy vaults encrypted with the literal string `file:…` still open with a one-time warning — see repo **`docs/CREDENTIALS.md`**.

Agent tools: **`credential_store`**, **`credential_get`**, **`credential_list`**, **`credential_delete`**.

## Generated skills lifecycle

Procedures and crystallization produce skill proposals under the workspace. Operator CLI:

| Task | Command |
| --- | --- |
| Proposal queue | `openclaw hybrid-mem skills queue [--status pending\|approved\|…]` |
| Inspect one | `skills show <id>` · `skills validate <id>` |
| Install / reject | `skills install <id>` · `skills reject <id> --reason "…"` |
| On-disk health | `skills rescan` · `skills doctor` |
| Telemetry | `skills telemetry summary` · `skills telemetry issues` |
| Run crystallization cycle | `skills crystallize [--dry-run]` |

Repo: **`docs/SKILL-PIPELINES.md`**. Agent tools: **`memory_crystallize*`**, **`memory_workshop`**.

## Workboard integration (when `workboard.enabled: true`)

When Workboard integration is enabled, active tasks and goals sync to OpenClaw's Workboard Kanban UI as cards. The sync is bidirectional: moving a card between columns in Workboard updates the task/goal status in hybrid-memory.

- Sync runs automatically every N minutes (default: 5)
- Cards are tagged with `hybrid-memory` for filtering
- Status values map to Workboard columns (e.g. `in_progress` → "In Progress", `done` → "Done")
- No extra agent tools needed — the sync is transparent

Config: `workboard.enabled`, `workboard.syncTasks`, `workboard.syncGoals`, `workboard.bidirectional`, `workboard.columns.*`. See [CONFIGURATION.md](../../docs/CONFIGURATION.md#workboard-integration-workboard).

## Wiki integration and Dreaming UI (when `wikiIntegration.enabled: true`)

Bridges hybrid-memory with the `memory-wiki` plugin and OpenClaw's Dreaming UI tab:

- **Dreaming UI:** Facts appear in "Imported Insights" and "Memory Palace" sections
- **Unified search:** Facts are included in `memory_search corpus=all` / `wiki_search corpus=all`
- **Dream findings:** When the nightly dream cycle runs, discovered patterns and summaries are stored as tagged facts (`dream-finding`) and bridged to the Dreaming UI
- **Workspace mirror:** When `workspaceExportIntervalMinutes` > 0, facts are also written to `{workspace}/memory/hybrid-wiki/` (human-readable; does not touch root `MEMORY.md`)
- **Manual sync:** `openclaw hybrid-mem wiki export` · **Status:** `openclaw hybrid-mem wiki status`
- **Verify:** `openclaw hybrid-mem verify` reports wiki/workboard connectivity when enabled
- **Bidirectional editing:** When `mutations.enabled` is true, external clients (memory-wiki, WebUI) can create, update, supersede, and delete facts via `hybrid-mem.facts.*` Gateway RPC or HTTP endpoints

Config: `wikiIntegration.enabled`, `wikiIntegration.publicArtifacts`, `wikiIntegration.corpusSupplement`, `wikiIntegration.workspaceExportIntervalMinutes` (0 = disable mirror), `wikiIntegration.mutations.enabled`. See [CONFIGURATION.md](../../docs/CONFIGURATION.md#wiki-integration-wikiintegration).

## Configuration mindset

- **Embedding provider** must be valid or the plugin fails to load—fix provider, model, and dimensions before debugging "no memories."
- **LLM tiers** (`llm.nano` → `llm.default` → `llm.heavy`): put **cheapest** models first in each list. Nano is for HyDE/classify/summarize; default covers maintenance and dream cycle (unless `nightlyCycle.model` is set); heavy is for distill and hard quality steps. Run `openclaw hybrid-mem config` to see effective first choices.
- **Scopes** (global / user / agent / session) matter for who sees a fact; match the user's intent.
- **Decay / tiering** affect how long items stay hot—do not assume everything is permanent unless configured.

## Progressive disclosure

- For deep behavior (HyDE, RRF, procedures, crystallization, cron jobs), rely on **this skill for basics**, then read **`references/memory-optimization.md`** or repo docs when a task requires a specific subsystem.

## Optimizing memory (inspection, settings, task order)

When the user wants **maximum memory quality**, **which toggles are on**, **what to enable next**, or a **maintenance / digest / optimization run**:

1. **`openclaw hybrid-mem verify`** and **`openclaw hybrid-mem config`** — ground truth for health + flags.
2. **`openclaw hybrid-mem maintenance steps`** — see which orchestrator steps are due.
3. **Catch-up:** **`openclaw hybrid-mem maintenance full --verbose`** (same as **`run-all`**). Use **`--force`** after long downtime.
4. **Nightly-only (mirrors cron):** **`maintenance nightly --verbose`**.

Read the bundled reference for settings priorities, individual step overrides, and cron architecture:

**`references/memory-optimization.md`** (under `{workspace}/skills/hybrid-memory/` — copied on first gateway start if missing, refreshed by **`openclaw hybrid-mem install`**)

## Reference

- **Optimization guide (bundled):** `references/memory-optimization.md`
- **Maintenance matrix (repo):** [MAINTENANCE-TASKS-MATRIX.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/MAINTENANCE-TASKS-MATRIX.md)
- **Credentials:** [CREDENTIALS.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CREDENTIALS.md)
- **Skills pipelines:** [SKILL-PIPELINES.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/SKILL-PIPELINES.md)
- Upstream docs: [openclaw-hybrid-memory repository](https://github.com/markus-lassfolk/openclaw-hybrid-memory) (`docs/QUICKSTART.md`, `docs/CONFIGURATION.md`, `docs/GRAPH-MEMORY.md`, `docs/MULTILINGUAL-SUPPORT.md`).
- OpenClaw skills layout: [Creating skills](https://docs.openclaw.ai/tools/creating-skills).
