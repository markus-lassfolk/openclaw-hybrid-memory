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
- **Search or verify what is stored:** prefer `memory_retrieve` for intent-routed recall (compact summaries, auto-routing); use `memory_recall` when you need explicit hybrid/semantic search or full control over mode and scope.
- **List people, or everything tied to a company/org:** use `memory_directory` (`list_contacts` or `org_view` with `org_name`) for **structured** results; use `memory_recall` when you need semantic search ranking.
- **User asks to forget or correct a bad fact:** use the appropriate forget/update flow (e.g. `memory_forget` or supersede via store) per plugin behavior.

If **auto-capture** and **auto-recall** are on, many turns need no tool call—but still **store** when the user explicitly asks to remember, or when the information is important and might not be captured automatically.

## Goal Stewardship (when `goalStewardship.enabled: true`)

When goal stewardship is enabled, use these tools for long-running, multi-session objectives.

**When to use:** When the user assigns an outcome-oriented goal ("deploy X", "fix Y and get it merged", "keep Z healthy") that will take multiple sessions, subagents, or heartbeat cycles to complete.

**Critical — goals are NOT memories:**

| Need | Use | Do NOT use |
| --- | --- | --- |
| List or read registered goals | `goal_list`, `goal_get` | `memory_recall` (searches facts, not `state/goals/`) |
| Save a durable fact | `memory_store` | `goal_register` (strategic outcomes only) |
| Checkpoint tactical work-in-progress | `active_task_checkpoint` | ad-hoc `memory_store` without project fields |

**Every turn:** When stewardship is enabled, the plugin prepends a compact `<active-goals-summary>` block (config: `injectActiveGoalsEveryTurn`, default on). Use it — do not ignore active goals.

**Two automation layers (do not confuse them):**

| Layer | What it does |
| --- | --- |
| **Watchdog** (~every 5 min, no LLM) | Updates goal JSON: budgets, stalled/blocked, mechanical verification, PID links. Does **not** start a chat turn. |
| **Heartbeat stewardship** | On **`before_agent_start`**, if the **last user message** matches **heartbeat patterns** (defaults include `heartbeat`, `scheduled ping`, `cron heartbeat`), prepends full goal context so you run `goal_assess` etc. **Requires a real agent turn** — schedule via OpenClaw cron. |

**Registering goals — clarity first:**

1. When the user assigns a multi-session outcome, call **`goal_register`** with a clear `description` and **measurable** `acceptance_criteria` (verifiable commands, PR merge, file exists, health check, test pass, etc.).
2. If criteria are vague, **`goal_register` returns suggested criteria and follow-up questions** — ask the user, refine, then call again with **`confirmed: true`**.
3. Optionally pass **`task_entity`** (and `related_session` / `initial_next`) on **`goal_register`** to link an active-task row with `related_goal` in one step.
4. Never register goals with criteria like "done", "complete", or "fix it" without concrete verification steps.
5. For **critical/high** priority, `confirmed: true` is required after user approval (confirmation policy).

**While working toward a goal:**

| Tool | When to call |
|------|-------------|
| `goal_list` | Start of pulse turns or when you need the active goal set |
| `goal_get` | Before acting on a specific goal — read criteria, blockers, linked tasks |
| `goal_register` | User assigns a new multi-session outcome (after criteria are clear) |
| `goal_assess` | Every heartbeat stewardship turn — record observations, blockers, next action |
| `goal_update` | Criteria or description need refinement mid-flight |
| `goal_complete` | ALL acceptance criteria are **verifiably** met — mechanical verification must pass, or use `confirmed: true` with reason documenting manual acceptance |
| `goal_abandon` | User explicitly cancels the goal |
| `active_task_checkpoint` | Before ending a turn with pending external work; set `next`, `status`, `relatedSession`, `relatedGoal` (goal id); defaults `refreshProjection` when ledger=facts |
| `active_task_list` / `active_task_get` | Discover tasks from facts ledger or ACTIVE-TASKS.md (use when injection is budget-starved) |
| `active_task_propose_goal` | Promote a long-running task row to a stewardship goal (reads facts when `ledger: facts`) |

**Do not end a turn early when:**

- CI, reviews, deploys, or background commands are still pending — call **`active_task_checkpoint`** with `resumeAt` / wake scheduling when appropriate.
- A goal-backed task had progress this turn — call **`goal_assess`**.
- On heartbeat pulses: do **not** reply `HEARTBEAT_OK` until you have assessed active goals and updated checkpoints.

**Subagent naming convention for automatic goal linkage:**
When spawning a subagent to work on a goal, name the subagent with the goal's label as a prefix.
For example, for goal `deploy-api`, name subagents `deploy-api-run-tests`, `deploy-api-create-pr`,
`deploy-api-deploy`. This creates an automatic link between the subagent and the goal.

**Tool Search wrapper:** If `memory_*` or `goal_*` tools return `wrapper_args_dropped`, retry via top-level tools or restart the session (upstream OpenClaw #96115).

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
| **Core memory** | `memory_store`, `memory_retrieve`, `memory_recall`, `memory_pin`, `memory_snooze`, `memory_forget`, `memory_directory`, `memory_link`, `memory_promote`, `memory_prune`, `memory_health`, `memory_gaps` |
| **Episodes & timeline** | `memory_record_episode`, `memory_search_episodes`, `memory_recall_timeline`, `memory_checkpoint` |
| **Procedures & reflection** | `memory_recall_procedures`, `memory_reflect`, `memory_reflect_rules`, `memory_reflect_meta`, `memory_procedure_feedback` |
| **Graph & documents** | `memory_graph`, `memory_clusters`, `memory_ingest_document`, `memory_ingest_folder`, `memory_path` |
| **Edicts & verification** | `memory_add_edict`, `memory_update_edict`, `memory_remove_edict`, `memory_list_edicts`, `memory_get_edicts`, `memory_edict_stats`, `memory_verify`, `memory_verification_status`, `memory_verified_list`, `memory_provenance` |
| **Goals & tasks** | `goal_list`, `goal_get`, `goal_register`, `goal_assess`, `goal_update`, `goal_complete`, `goal_abandon`, `active_task_list`, `active_task_get`, `active_task_checkpoint`, `active_task_propose_goal` |
| **Credentials vault** | `credential_store`, `credential_get`, `credential_list`, `credential_delete` — secrets stay in vault; memory holds pointers only |
| **Crystallization & skills** | `memory_crystallize`, `memory_crystallize_list`, `memory_crystallize_approve`, `memory_crystallize_reject`, `memory_crystallize_skills_rescan`, `memory_workshop` |
| **Issues & proposals** | `memory_issue_*`, `persona_propose`, `persona_proposals_list`, `memory_propose_tool`, `memory_tool_proposals`, `memory_tool_approve`, `memory_tool_reject` |
| **Workflows & capture** | `memory_workflows`, `apitap_capture`, `apitap_list`, `apitap_peek`, `apitap_to_skill`, `memory_session_observability` |

### Procedures workflow

1. **Recall** — call `memory_recall_procedures` before repeating a known task pattern; use the returned **`id`** for feedback.
2. **Execute** the steps from the recalled recipe.
3. **Feedback** — call `memory_procedure_feedback` with that exact `id`, `success`, and optional `context`.
4. **First run / no procedure yet** — either:
   - `memory_record_episode` (+ `memory_store` for durable facts); maintenance `extract-procedures` promotes patterns asynchronously, **or**
   - `memory_procedure_feedback` with `registerIfMissing: true`, plus `taskPattern` and `steps[]` (creates a **draft** procedure, then records feedback).

**Anti-patterns**

- Do **not** invent slug ids and retry `memory_procedure_feedback` after `procedure_not_found` — that error is **`isError: true`**; stop after one failure unless using `registerIfMissing`.
- Do **not** use `memory_procedure_feedback` to create procedures without `registerIfMissing` — it updates existing rows only.
- `memory_store` writes **facts**, not procedure rows.

When vault is **off**, credential-like content is blocked from ordinary `memory_store`. When vault is **on**, use `credential_get` — recall returns pointers, not secrets.

## Credentials vault (when `credentials.enabled: true`)

Secrets live in the encrypted vault only; memory holds **pointer facts** (no secret values in recall).

| Task | CLI |
| --- | --- |
| Vault health | `openclaw hybrid-mem credentials vault-status` |
| List entries (no values) | `credentials list [--service pattern]` |
| Get secret | `credentials get --service <name> [--type bearer]` |
| Scripting / piping | `credentials get --service <name> --value-only` (alias: `--quiet`) |
| Migrate facts → vault | `credentials migrate-to-vault` |
| Re-encrypt after key change | `credentials encrypt-vault --backup --verify --yes` |
| Audit / clean | `credentials audit`, `credentials prune [--yes]` |

**Credential `type` vs `url` field:** `type` is the kind of **secret** — `token`, `password`, `api_key`, `ssh`, `bearer`, or `other`. **Do not** use `type=url`. Put endpoint/base URLs in the optional **`url`** parameter on `credential_store` (or in `notes`). Example: `credential_store(service="my-api", type="bearer", value="<token>", url="https://api.example.com")`.

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
