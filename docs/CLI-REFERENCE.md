---
layout: default
title: CLI Reference
parent: Operations & Maintenance
nav_order: 1
---
# CLI Reference — memory-hybrid

All commands are available via `openclaw hybrid-mem <command>`.

---

## Commands by category

| Category | Commands |
|----------|----------|
| **Setup & installation** | `install`, `verify [--fix]` |
| **Maintenance** | `run-all`, `compact`, `prune`, `checkpoint`, `backfill-decay`, `backfill`, `dream-cycle`, `resolve-contradictions` |
| **Stats & query** | `stats [--efficiency]`, `test`, `context-audit`, `search <query>`, `lookup <id>`, `forget <id> [--yes]`, `list [--limit, --category, --tier]`, `show <id>`, `categories` |
| **Proposals & corrections** | `proposals list|show|approve|reject <id>`, `corrections list`, `corrections approve-all`, `review` |
| **Store & ingestion** | `store <text>`, `ingest-files`, `distill`, `distill-window`, `record-distill`, `extract-daily`, `extract-procedures`, `extract-directives`, `extract-reinforcement`, `generate-auto-skills`, `skills-suggest`, `generate-proposals` |
| **Reflection & classification** | `reflect`, `reflect-rules`, `reflect-meta`, `classify`, `build-languages` |
| **Dedup & consolidation** | `find-duplicates`, `consolidate` |
| **Self-correction** | `self-correction-extract`, `self-correction-run` |
| **Export & config** | `export`, `config-mode <mode>`, `config-set <key> <value>` |
| **Credentials & scope** | `credentials migrate-to-vault`, `scope list|stats|prune|promote` |
| **Plugin lifecycle** | `upgrade [version]`, `uninstall` |
| **Working memory** | `active-tasks`, `active-tasks complete <label>`, `active-tasks stale`, `active-tasks add <label> <desc>` |

---

## Commands

| Command | Purpose |
|---------|---------|
| `stats [--efficiency] [--brief]` | **Rich output (default):** storage (SQLite/LanceDB sizes, WAL), knowledge (facts, entities, categories), learned behavior (procedures, directives, rules, patterns, meta-patterns), graph links, operational (credentials, proposals, last distill/reflect/compact), decay distribution. Use `--brief` for legacy storage + decay only. `--efficiency` adds tier/source breakdown, token estimates, and token-savings note. |
| `test` | Memory diagnostics: store a marker fact, verify structured/semantic/hybrid search and auto-recall, then clean up. |
| `context-audit` | Report token usage per injected context source (auto-recall, procedures, active tasks, workspace files) and recommendations. |
| `compact` | Run tier compaction: completed tasks → COLD, inactive preferences → WARM, active blockers → HOT. Prints hot/warm/cold counts. |
| `store --text <text> [options]` | Store a fact (for scripts; agents use `memory_store`). |
| `lookup <entity> [--key <key>] [--tag <tag>] [--as-of <date>] [--include-superseded]` | Exact lookup in SQLite. `--as-of` = point-in-time (ISO or epoch); `--include-superseded` = include historical facts. |
| `search <query> [--tag <tag>] [--as-of <date>] [--include-superseded] [--user-id <id>] ...` | Semantic search over LanceDB + FTS5. `--as-of`, `--include-superseded` for bi-temporal queries. Scope filters for user/agent/session. |
| `forget <id> [--yes]` | Remove a memory by ID (SQLite + LanceDB). ID can be full UUID or a short hex prefix. Without `--yes`, prints a preview and exits; use `--yes` to confirm. |
| `extract-daily [--dry-run] --days N` | Extract facts from daily logs (`memory/YYYY-MM-DD.md`). |
| `prune [--hard] [--soft] [--dry-run]` | Remove expired facts (decay/TTL). `--hard` only expired; `--soft` only confidence decay. |
| `checkpoint` | Create a checkpoint (pre-flight state). |
| `backfill [--dry-run] [--workspace path] [--limit N]` | Ingest facts from MEMORY.md / memory/**/*.md. Progress bar in TTY. |
| `backfill-decay` | Backfill decay classes for existing rows. |
| `build-languages [--dry-run] [--model M]` | Detect top 3 languages from fact samples, generate multilingual trigger/category/decay keywords via LLM, write `.language-keywords.json`. See [MULTILINGUAL-SUPPORT.md](MULTILINGUAL-SUPPORT.md). |
| `classify [--dry-run] [--limit N] [--model M]` | Auto-classify "other" facts using LLM. Progress bar in TTY. |
| `categories` | List all configured categories with per-category fact counts. |
| `list <type> [--limit N] [--status s]` | List items by type: **patterns**, **rules**, **directives**, **procedures**, **proposals**, or **corrections**. `--limit` caps output (default 50). For proposals/corrections, `--status` filters (e.g. pending). See [List, show, and review](#list-show-and-review-issue-56) below. |
| `show <id>` | Show full details of a fact, procedure, or persona proposal by ID. |
| `proposals list [--status s]` | List persona proposals (pending, approved, rejected, applied). |
| `proposals approve <id>` | Approve a persona proposal. Then use `openclaw proposals apply <id>` to apply to file. |
| `proposals reject <id> [--reason text]` | Reject a persona proposal. |
| `corrections list [--workspace path]` | List proposed corrections from the latest self-correction report (`memory/reports/self-correction-*.md`). |
| `corrections approve [--all] [--workspace path]` | Apply all suggested TOOLS rules from the latest report to TOOLS.md. Requires `--all`. |
| `review [--workspace path]` | Interactive review: step through pending proposals and corrections (a=approve, r=reject, s=skip). |
| `find-duplicates [--threshold 0.92] [--include-structured] [--limit 300]` | Report pairs of facts with embedding similarity ≥ threshold. Report-only; no merge. |
| `consolidate [--threshold 0.92] [--include-structured] [--dry-run] [--limit 300] [--model M]` | Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster. |
| `reflect [--window <days>] [--dry-run] [--model M] [--force]` | Analyze recent facts, extract behavioral patterns. |
| `reflect-rules [--dry-run] [--model M] [--force]` | Synthesize patterns into actionable rules. |
| `reflect-meta [--dry-run] [--model M] [--force]` | Synthesize higher-level meta-patterns. |
| `install [--dry-run]` | Apply full recommended config, compaction prompts, and **maintenance cron jobs** (nightly distill, weekly reflection, weekly extract-procedures, self-correction). Idempotent. See [Maintenance cron jobs](#maintenance-cron-jobs) below. |
| `config-mode <preset>` | Set preset: **essential** \| **normal** \| **expert** \| **full**. Writes to openclaw.json. Restart gateway after. Presets set defaults for most enable/disable options (autoCapture, autoRecall, autoClassify, graph, procedures, reflection, memoryTiering, personaProposals, selfCorrection, etc.); see [CONFIGURATION-MODES.md](CONFIGURATION-MODES.md). Alias: **set-mode** (e.g. `set-mode full`). |
| `help config-set <key>` | Show current value and a short description (tweet-length) for a config key. Example: `help config-set autoCapture`. |
| `config-set <key> [value]` | Set a plugin config key (use **true** / **false** for booleans). **Omit value** to show current value and description (same as `help config-set <key>`). For credentials use `credentials true` or `credentials false`. Writes to openclaw.json. Restart gateway after. **All enable/disable toggles shown in `verify` can be set here** (e.g. `autoRecall.retrievalDirectives.enabled true`, `nightlyCycle.enabled true`, `selfExtension.enabled true`). If you see **credentials: must be object**, run **`npx -y openclaw-hybrid-memory-install fix-config`** or edit `~/.openclaw/openclaw.json`. |
| `upgrade [version]` | Upgrade from npm. Removes current install, fetches version (or latest), rebuilds native deps. Restart gateway afterward. Optional version e.g. `2026.2.181`. |
| `verify [--fix] [--log-file <path>]` | Verify config, DBs, embedding API; suggest fixes. With `--fix`: create missing maintenance cron jobs (with stable `pluginJobId`), re-enable any previously disabled plugin jobs, and fix config placeholders. See [Maintenance cron jobs](#maintenance-cron-jobs) below. |
| `distill [--all] [--days N] [--since YYYY-MM-DD] [--dry-run] [--model M] [--verbose] [--max-sessions N] [--max-session-tokens N]` | Index session JSONL into memory (LLM extraction, dedup, store). Default: last 3 days. **Progress:** when run in a TTY, shows a progress bar. `--model M` overrides the LLM; otherwise uses `llm.heavy` (first model) or legacy `distill.defaultModel`. All LLM calls go through the OpenClaw gateway. Long-context models use larger batches (500k tokens). See [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md). |
| `ingest-files [--dry-run] [--workspace path] [--paths globs]` | Index workspace markdown (skills, TOOLS.md, etc.) as facts via LLM extraction. Config `ingest.paths` or defaults: `skills/**/*.md`, `TOOLS.md`, `AGENTS.md`. See [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md). |
| `export --output <path> [--include-credentials] [--sources X,Y,Z] [--mode replace\|additive]` | Export memory to vanilla OpenClaw–compatible `MEMORY.md` + `memory/` directory layout. Plain markdown, one file per fact. Default: exclude credentials, replace mode. Filter by fact source with `--sources` (e.g. conversation, distillation, cli, ingest, reflection). |
| `distill-window [--json]` | Print the session distillation window (full or incremental). |
| `record-distill` | Record that session distillation was run (timestamp for `verify`). |
| `extract-procedures [--dir path] [--days N] [--dry-run]` | Extract tool-call procedures from session JSONL; store positive/negative procedures. |
| `self-correction-extract [--days N] [--output path]` | Extract user correction incidents from session JSONL (last N days). Uses `.language-keywords.json` — run `build-languages` first for non-English. |
| `self-correction-run [--extract-path path] [--workspace path] [--dry-run] [--approve] [--model M] [--no-apply-tools]` | Analyze incidents, auto-remediate (memory + TOOLS section or LLM rewrite). Use `--approve` to apply suggested TOOLS rules; or set `selfCorrection.autoRewriteTools: true` for LLM rewrite. Report: `memory/reports/self-correction-YYYY-MM-DD.md`. See [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md). |
| `analyze-feedback-phrases [--days N] [--model M] [--output path] [--learn]` | Analyze session logs to discover *your* praise/frustration phrases. Uses nano-tier for sentiment pre-filter and heavy-tier for phrase extraction (model-agnostic; omit `--days` for auto 30 days first run, then 3 days). Use `--learn` to merge into `.user-feedback-phrases.json`. See [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md#learning-your-feedback-wording-user-specific-phrases). |
| `generate-auto-skills [--dry-run]` | Generate `skills/auto/{slug}/SKILL.md` and `recipe.json` for procedures that reached validation threshold. |
| `skills-suggest [--dry-run] [--days N] [--verbose]` | Memory-to-skills: cluster procedures, synthesize SKILL.md drafts to `skills/auto-generated/`. See [MEMORY-TO-SKILLS.md](MEMORY-TO-SKILLS.md). |
| `generate-proposals [--dry-run] [--verbose]` | Generate persona proposals from recent reflection (patterns, rules, meta). Requires personaProposals enabled. Cron: weekly-persona-proposals. |
| `run-all [--dry-run] [--verbose]` | Run all maintenance tasks in optimal order: backfill-decay (once), prune, compact, distill, extract-daily, extract-directives, extract-reinforcement, extract-procedures, generate-auto-skills, reflect, reflect-rules, reflect-meta, generate-proposals, self-correction-run, build-languages. Steps are feature-gated. See [MAINTENANCE-TASKS-MATRIX.md](MAINTENANCE-TASKS-MATRIX.md). |
| `dream-cycle` | Nightly pipeline: prune expired facts, consolidate event log into facts, reflect, reflect-rules. Requires `nightlyCycle.enabled`. Cron: nightly-dream-cycle. |
| `resolve-contradictions` | Resolve conflicting/superseded facts (classify-before-write style). Cron: step 4 of nightly-memory-sweep. |
| `credentials migrate-to-vault` | Move credential facts from memory into vault and redact originals. |
| `credentials list [--service <pattern>]` | List vault entries (service, type, url; no values). Use `--service` to filter by substring (e.g. `--service unifi`). |
| `credentials get --service <name> [--type <type>] [--value-only] [--show-value]` | Retrieve a credential value. Use `--type` when multiple types exist for the service. `--value-only`: print only the secret (for piping). `--show-value`: reveal the secret in the default (metadata) output. |
| `credentials audit [--json]` | Flag suspicious entries (natural language, long service names, duplicates). |
| `credentials prune [--yes] [--only-flags ...]` | Remove flagged entries (default: dry-run; use `--yes` to apply). |
| `scope list` | List all scopes present in memory (from facts). |
| `scope stats` | Show fact counts by scope (global, user, agent, session). |
| `scope prune --scope <s> [--scope-target <id>]` | Remove all facts in a given scope (destructive). Use `--scope-target` when scope is user/agent/session. |
| `scope promote [--dry-run] [--threshold-days N] [--min-importance 0.7]` | Promote high-importance session-scoped facts to global. Cron: weekly-deep-maintenance. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md). |
| `active-tasks` | List active tasks from ACTIVE-TASK.md. |
| `active-tasks complete <label>` | Mark task Done and flush to memory log. |
| `active-tasks stale` | Show tasks not updated within staleThreshold. |
| `active-tasks add <label> <desc>` | Add or update a task entry. |
| `uninstall [--clean-all] [--force-cleanup] [--leave-config]` | Revert to default OpenClaw memory (memory-core). |

---

## Export

```
openclaw hybrid-mem export --output <path> [--include-credentials] [--sources <sources>] [--mode replace|additive]
```

Export all memory (facts + procedures) to a vanilla OpenClaw–compatible layout: `MEMORY.md` root index + `memory/<category>/` markdown files. Plain markdown, one file per fact; compatible with memorySearch and memory-core. Use for inspection, backup, or copying to another bot.

| Option | Description |
|--------|-------------|
| `--output <path>` | Output directory (created if missing). **Required.** |
| `--include-credentials` | Include credential pointer facts (default: exclude). Never exports actual secrets. |
| `--sources <sources>` | Filter by fact source: comma-separated (e.g. `conversation,cli,distillation,ingest,reflection`). Omit for all. |
| `--mode replace` | Clear output directory first, then write (default). |
| `--mode additive` | Add/overwrite; do not clear. Existing files overwritten on conflict. |

**Layout:** `MEMORY.md`, `manifest.json`, `memory/<category>/<tag>/<slug>-<id>.md` (one file per fact). Re-import via `openclaw hybrid-mem backfill --workspace <path>` or copy into a vanilla workspace.

---

## Ingest-files

```
openclaw hybrid-mem ingest-files [--dry-run] [--workspace <path>] [--paths <glob1,glob2,...>]
```

Index workspace markdown as facts via LLM extraction. Default patterns: `skills/**/*.md`, `TOOLS.md`, `AGENTS.md` (or config `ingest.paths`).

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview without storing |
| `--workspace <path>` | Workspace root (default: `OPENCLAW_WORKSPACE` or cwd) |
| `--paths <globs>` | Comma-separated globs (overrides config) |

→ Full docs: [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md)

---

## Build-languages (multilingual)

```
openclaw hybrid-mem build-languages [--dry-run] [--model <model>]
```

Detect the top 3 languages in your stored facts, then generate intent-based trigger/category/decay keywords for those languages and write `~/.openclaw/memory/.language-keywords.json`. Used for multi-language capture, category detection, and decay classification.

| Option | Description |
|--------|-------------|
| `--dry-run` | Detect languages and generate keywords but do not write the file |
| `--model <model>` | LLM for detection and generation (default: same as autoClassify, e.g. gpt-4o-mini) |

→ Full docs: [LANGUAGE-KEYWORDS.md](LANGUAGE-KEYWORDS.md)

---

## Store options

```
openclaw hybrid-mem store --text <text> [--category <cat>] [--entity <e>] [--key <k>] [--value <v>] [--source-date YYYY-MM-DD] [--tags "a,b,c"] [--scope global|user|agent|session] [--scope-target <id>] [--supersedes <fact-id>]
```

- `--source-date`: When the fact originated (ISO-8601). Include when parsing old memories.
- `--tags`: Comma-separated topic tags. Omit for auto-tagging.
- `--category`: Override category (default: `other`).
- `--scope`: Memory scope: `global` (default), `user`, `agent`, or `session`. See [MEMORY-SCOPING.md](MEMORY-SCOPING.md).
- `--scope-target`: Required when scope is `user`, `agent`, or `session` — the userId, agentId, or sessionId.
- `--supersedes`: Fact id this one supersedes (replaces).
- When `store.classifyBeforeWrite` is true in config, `store` runs ADD/UPDATE/DELETE/NOOP classification against similar facts before writing.

---

## Stats and efficiency

`openclaw hybrid-mem stats` shows fact counts, LanceDB vectors, and decay breakdown.

Add `--efficiency` for an extended view:

```
openclaw hybrid-mem stats --efficiency
```

This adds:
- **By tier (hot/warm/cold):** Fact counts and estimated tokens per tier
- **By source:** How facts were added (conversation, cli, distillation, reflection, auto-capture, etc.)
- **Estimated tokens in memory:** Total token size of stored facts (same heuristic as auto-recall)
- **Token savings note:** Explains that providers can cache injected memories; Cache Read is typically 90%+ cheaper than Input. Compare your provider dashboard (Input vs Cache Read) to see actual savings — many users see 90–97% reduction.

---

## Verify and doctor

`openclaw hybrid-mem verify` checks config, DBs, and embedding API. Feature toggles are shown as **true** / **false** to match `openclaw.json`. It checks:

- Config (embedding required; optional llm model preference)
- SQLite and LanceDB accessibility
- Embedding API reachability
- Credentials vault (if enabled)
- Session distillation last run
- Optional/suggested jobs (all 9 maintenance jobs; see [Maintenance cron jobs](#maintenance-cron-jobs) below)
- Feature flags (autoCapture, autoRecall, autoClassify, credentials, fuzzyDedupe, classifyBeforeWrite)

Issues are listed as **load-blocking** (prevent OpenClaw from loading) or **other**, with **fixes for each**.

`--fix` applies safe fixes: missing embedding block, memory directory, and optional jobs. Adds any missing maintenance cron jobs to `~/.openclaw/cron/jobs.json` (see [Maintenance cron jobs](#maintenance-cron-jobs)); does not re-enable jobs you disabled.
`--log-file <path>` scans the file for memory-hybrid or cron errors.

**Exit codes (for scripting):** `0` = all checks passed, no restart needed; `1` = issues found (see output); `2` = all checks passed but **restart pending** (config was changed via `config-mode`/`config-set`; restart gateway for changes to take effect).

---

## Uninstall

`openclaw hybrid-mem uninstall` reverts to the default OpenClaw memory manager (memory-core). Safe: your data is kept unless you pass `--clean-all` (removes SQLite and LanceDB; irreversible). Use `--leave-config` to skip modifying `openclaw.json`. Full guide: [UNINSTALL.md](UNINSTALL.md).

---

## Tips

- Run `classify --dry-run` first to preview, then run without `--dry-run` to apply.
- Run `find-duplicates` to review candidates, then `consolidate --dry-run` before applying.
- Run `verify` as a health check after installation or upgrades.
- Use `install --dry-run` to preview config changes before applying.

---

## Related docs

- [QUICKSTART.md](QUICKSTART.md) — Installation and first run
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [FEATURES.md](FEATURES.md) — Categories, decay, tags, auto-classify
---

## List, show, and review

After running the maintenance pipeline (`distill`, `extract-*`, `reflect`, `self-correction-run`), the plugin produces patterns, rules, directives, procedures, persona proposals, and self-correction suggestions. These commands let you browse and act on them without querying SQLite directly.

### List by type

```bash
openclaw hybrid-mem list patterns [--limit 10]
openclaw hybrid-mem list rules [--limit 10]
openclaw hybrid-mem list directives [--limit 10]
openclaw hybrid-mem list procedures [--limit 10]
openclaw hybrid-mem list proposals [--status pending]
openclaw hybrid-mem list corrections [--workspace path]
```

- **patterns** / **rules** / **directives** — From the facts table (category or source). Non-superseded only.
- **procedures** — From the procedures table (task patterns, positive/negative).
- **proposals** — Persona proposals (requires persona proposals enabled). Filter by `--status pending|approved|rejected|applied`.
- **corrections** — Parses the latest `memory/reports/self-correction-YYYY-MM-DD.md` and shows the "Suggested TOOLS.md rules" and "Proposed (review before applying)" sections.

### Show one item

```bash
openclaw hybrid-mem show <fact-id-or-proposal-id>
```

Resolves the ID as a fact, procedure, or persona proposal and prints JSON details.

### Proposals (persona)

- **proposals list** — Same data as `list proposals`; optional `--status`.
- **proposals approve &lt;id&gt;** — Mark as approved. Apply to the target file with `openclaw proposals apply <id>` (top-level OpenClaw command).
- **proposals reject &lt;id&gt;** — Mark as rejected; optional `--reason`.

### Corrections (self-correction)

- **corrections list** — Show proposed TOOLS rules and other suggestions from the latest report.
- **corrections approve --all** — Insert all suggested TOOLS rules from that report into `TOOLS.md` under the configured self-correction section (e.g. "Self-correction rules"). Uses workspace root (default `OPENCLAW_WORKSPACE` or `~/.openclaw/workspace`).

### Interactive review

```bash
openclaw hybrid-mem review
```

Steps through pending persona proposals and the latest correction report. For each proposal: prompt for **[a]pprove**, **[r]eject**, or **[s]kip**. For corrections: **[a]pprove all** (apply TOOLS rules) or **[s]kip**.

---

## Maintenance cron jobs

**Install** and **verify --fix** create or repair maintenance cron jobs in `~/.openclaw/cron/jobs.json`. The canonical list is **9 jobs** (tiering, scope promote, persona proposals, memory-to-skills, dream cycle, and others; see table below).

| Job (pluginJobId) | Schedule | Purpose |
|-------------------|----------|---------|
| `hybrid-mem:nightly-distill` | 02:00 daily | **nightly-memory-sweep:** prune → distill --days 3 → extract-daily → resolve-contradictions. |
| `hybrid-mem:nightly-memory-to-skills` | 02:15 daily | **nightly-memory-to-skills:** skills-suggest (cluster procedures, draft skills). Exit 0 if memoryToSkills.enabled is false. |
| `hybrid-mem:self-correction-analysis` | 02:30 daily | **self-correction-analysis:** self-correction-run. Exit 0 if selfCorrection disabled. |
| `hybrid-mem:nightly-dream-cycle` | 02:45 daily | **nightly-dream-cycle:** dream-cycle (prune → consolidate → reflect). Requires nightlyCycle.enabled. Exit 0 if disabled. |
| `hybrid-mem:weekly-reflection` | Sun 03:00 | **weekly-reflection:** reflect → reflect-rules → reflect-meta. Requires reflection.enabled. |
| `hybrid-mem:weekly-extract-procedures` | Sun 04:00 | **weekly-extract-procedures:** extract-procedures → extract-directives → extract-reinforcement → generate-auto-skills. |
| `hybrid-mem:weekly-deep-maintenance` | Sat 04:00 | **weekly-deep-maintenance:** compact → scope promote. |
| `hybrid-mem:weekly-persona-proposals` | Sun 10:00 | **weekly-persona-proposals:** generate-proposals (persona proposals from reflection). Requires personaProposals enabled. |
| `hybrid-mem:monthly-consolidation` | 1st 05:00 | **monthly-consolidation:** consolidate → build-languages → backfill-decay. |

- **Install:** Adds any missing jobs (does not change existing jobs or re-enable disabled ones).
- **Verify --fix:** Adds any missing jobs and can normalize schedule/pluginJobId; does not re-enable disabled jobs by default.
- Jobs are identified by **pluginJobId** so upgrades can add new jobs without duplicating.

**Feature-gating:** When a feature is disabled in config, the corresponding CLI command exits 0 without doing work. Leave all jobs defined; they no-op when e.g. `procedures.enabled` or `reflection.enabled` is false. See [MAINTENANCE-TASKS-MATRIX.md](MAINTENANCE-TASKS-MATRIX.md) for full context.

---

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Common issues and fixes
- [REFLECTION.md](REFLECTION.md) — Reflection layer (`reflect`, `reflect-rules`, `reflect-meta`)
- [CREDENTIALS.md](CREDENTIALS.md) — Credentials vault (`credentials migrate-to-vault`)
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Session distillation (`distill-window`, `record-distill`)
- [SEARCH-RRF-INGEST.md](SEARCH-RRF-INGEST.md) — RRF merge, `ingest-files`, query expansion
- [MEMORY-SCOPING.md](MEMORY-SCOPING.md) — Scope types, store/recall filters, session cleanup, promote
- [PROCEDURAL-MEMORY.md](PROCEDURAL-MEMORY.md) — Procedural memory (`extract-procedures`, `generate-auto-skills`)
- [MULTILINGUAL-SUPPORT.md](MULTILINGUAL-SUPPORT.md) — Multi-language triggers, categories, decay (`build-languages`)
