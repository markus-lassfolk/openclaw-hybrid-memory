# Procedural Memory — Auto-Generated Skills from Learned Patterns

**Issue:** [#23](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/23)

Procedural memory extends the hybrid memory system with **“what have I learned to do”**: it extracts successful (and failed) multi-step tool-call patterns from session logs and turns them into reusable procedures and, when validated enough, into auto-generated skills that any session or sub-agent can discover.

---

## Overview

| Layer | What it does |
|-------|----------------|
| **1. Procedure tagging** | During session processing, multi-step tool sequences are extracted from JSONL logs; successful runs → positive procedures, failures → negative procedures. Stored in the `procedures` table and optionally as procedure-tagged facts. |
| **2. Procedure-aware recall** | `memory_recall_procedures(taskDescription)` and auto-recall inject **“Last time this worked”** and **“Known issue: avoid …”** so the agent reuses proven flows and avoids known failures. |
| **3. Skill generation** | After a procedure is validated N times (default 3), the plugin can auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`, discoverable by the standard skill system. |

---

## Configuration

All under `plugins.entries["openclaw-hybrid-memory"].config.procedures`:

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable procedure extraction, recall injection, and skill generation. |
| `sessionsDir` | `~/.openclaw/agents/main/sessions` | Directory containing session `.jsonl` files. |
| `minSteps` | `2` | Minimum tool-call steps to consider a sequence a procedure. |
| `validationThreshold` | `3` | Success count required before auto-generating a skill. |
| `skillTTLDays` | `30` | TTL (days) for procedure confidence / revalidation. |
| `skillsAutoPath` | `skills/auto` | Path (relative to workspace or absolute) for auto-generated skills. |
| `requireApprovalForPromote` | `true` | When true, human should move skills out of `auto/` to promote to permanent. |

---

## CLI Commands

### Extract procedures from session logs

```bash
# Default: use config sessionsDir, all files
openclaw hybrid-mem extract-procedures

# Only sessions modified in last 7 days
openclaw hybrid-mem extract-procedures --days 7

# Custom directory
openclaw hybrid-mem extract-procedures --dir /path/to/sessions

# Preview without writing
openclaw hybrid-mem extract-procedures --dry-run
```

Use this in your **nightly pipeline** together with (or after) session distillation: same session JSONL can be used for fact extraction and procedure extraction.

### Generate auto-skills

```bash
# Generate SKILL.md + recipe.json for procedures that reached validationThreshold
openclaw hybrid-mem generate-auto-skills

# Preview only
openclaw hybrid-mem generate-auto-skills --dry-run
```

Generated skills live under `skills/auto/` (or your `procedures.skillsAutoPath`). To promote one to a permanent skill, move the folder out of `auto/` (e.g. to `skills/` or a custom path).

### Generated skill telemetry

```bash
openclaw hybrid-mem skills telemetry
openclaw hybrid-mem skills telemetry moltbook-check
openclaw hybrid-mem skills demote moltbook-check --reason "over-triggering"
openclaw hybrid-mem skills reset moltbook-check --reason "agent prompt updated; false positives were stale"
openclaw hybrid-mem skills reject moltbook-check --reason "superseded by skill-xyz"
openclaw hybrid-mem skills doctor                 # scan for skills missing on disk
openclaw hybrid-mem skills doctor --fix           # mark missing skills as uninstalled
```

Generated skills start in the `experimental` lifecycle state. Each activation or near-miss can be recorded with `openclaw hybrid-mem skills record <skill-name> ...`, and a specific activation can later be marked as a false-positive with `openclaw hybrid-mem skills correct <activation-id> --reason "..."`.

Telemetry reports surface activations per week, near-misses, false-positive/false-negative signals, success/failure/partial rates, repeated corrections, and archive/revision candidates. The lifecycle policy:
- **Auto-promotes** experimental skills to `trusted` after repeated successful uses without correction.
- **Auto-demotes** when false-positive rate crosses the threshold.
- **Auto-archives** never-used skills after the configured window.
- **Auto-unblocks** demoted skills back to `experimental` after enough clean uses (configurable via `unblockAfterCleanUses`).

When a skill is reset from `demoted` back to `experimental` (manually or automatically), the evaluation window resets so pre-demotion signals don't block the recovery.

See [SKILL-PIPELINES.md](./SKILL-PIPELINES.md) for the full pipeline architecture and operator playbooks.

---

## Tools

### `memory_recall_procedures(taskDescription, limit?)`

Searches stored procedures by task description (FTS on `task_pattern`). Returns:

- **Last time this worked:** positive procedures with recipe steps.
- **Known issues (avoid):** negative procedures (e.g. dead endpoints, failing flows).

Example: when the user says “check Moltbook”, the agent can call `memory_recall_procedures("check Moltbook")` and get back working steps and warnings like “don’t use /api/v1/agents/notifications (returns HTML 404)”.

### Auto-recall injection

When **auto-recall** is enabled and **procedures** are enabled, each turn the plugin:

1. Searches procedures matching the current prompt.
2. If any match, prepends a `<relevant-procedures>` block to the injected context with:
   - Short “Last time this worked” lines (task + steps).
   - “Known issue (avoid)” lines for negative procedures.

So the model sees procedure hints without having to call the tool first.

---

## Schema (SQLite)

### Facts table (additions)

- `procedure_type` — `'positive' | 'negative' | NULL`
- `success_count` — integer, default 0
- `last_validated` — epoch seconds or NULL
- `source_sessions` — JSON array of session IDs (text)

### Procedures table

- `id`, `task_pattern`, `recipe_json`, `procedure_type` (`positive` | `negative`)
- `success_count`, `failure_count`, `last_validated`, `last_failed`
- `confidence`, `ttl_days`, `promoted_to_skill`, `skill_path`
- `skill_state`, `skill_state_reason`, `skill_version`, `skill_generated_at`
- `created_at`, `updated_at`

### Generated skill telemetry table

- `procedure_id`, `skill_name`, `skill_version`
- `request_hash`, `request_summary`, `decision`, `confidence`, `reason`
- `task_outcome`, `user_correction`, `correction_reason`
- `false_negative_signal`, `caused_rework`, `saved_tool_calls`, `saved_time_ms`
- `scope`, `scope_target`, `agent_id`, `session_id`, `created_at`

Full-text search: `procedures_fts` on `task_pattern` for `searchProcedures` and `getNegativeProceduresMatching`.

---

## Security and safety

- **Secrets:** Procedure recipes **never** store API keys, passwords, or tokens; the extractor redacts known secret keys from step args.
- **Sandbox:** Auto-generated skills are written only under `skills/auto/` (or your configured path), separate from human-authored skills.
- **Rate limiting:** Skill generation is capped per run (default 10) to avoid runaway self-modification.
- **Audit:** Each generated skill file includes the source procedure id and metadata (confidence, last validated).

---

## Example end-to-end

1. **Day 1:** User asks to “check Moltbook”. Agent calls `/api/v1/agents/notifications`, gets HTML 404. Session ends in failure.
2. **Nightly:** `openclaw hybrid-mem extract-procedures --days 1` runs. Parser sees tool sequence + error content → stores a **negative** procedure: “Check Moltbook …” with recipe and `procedure_type: negative`.
3. **Day 2:** User asks again to “check Moltbook”. Auto-recall injects: “Known issue (avoid): … /notifications …”. Agent uses a different endpoint and succeeds.
4. **Nightly:** Extract-procedures runs again; this time the session is successful → **positive** procedure stored or existing one’s `success_count` incremented.
5. **Day 7:** After several successful runs, `success_count` reaches 3. You run `openclaw hybrid-mem generate-auto-skills` → `skills/auto/moltbook-check/SKILL.md` and `recipe.json` are created.
6. **Later:** Any session or sub-agent that loads skills can use `skills/auto/moltbook-check` until you move it out of `auto/` to promote it.

---

## Related docs

- [MEMORY-TO-SKILLS.md](MEMORY-TO-SKILLS.md) — Cluster procedures and synthesize skill drafts (nightly or `skills-suggest`).
- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Fact extraction from session logs (same JSONL source).
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All `hybrid-mem` commands.
- [CONFIGURATION.md](CONFIGURATION.md) — Full plugin config reference.

## Procedure-to-skill promotion autopilot (#1328)

Procedure promotion uses the shared pending-autopilot foundation from #1334. The procedure adapter emits shared `PendingDecision` envelopes with queue `procedures`, input hash, policy version, reason/capability classes, redacted evidence, and parent/child equivalence tests. The parent digest-autopilot route (#1326) must consume these same adapter decisions; cron (#1330) only invokes/observes the parent.

Commands:

```bash
openclaw hybrid-mem procedures triage --not-promoted --policy draft-only --json
openclaw hybrid-mem generate-auto-skills --dry-run --max 50 --policy auto-safe --json
openclaw hybrid-mem generate-auto-skills --apply --max 50 --policy auto-safe --json
```

Policies are conservative:

- `draft-only` / `manual`: classify and report; mutation paths require human review.
- `auto-safe`: writes only draft/quarantined generated skill artifacts when all eligibility, safety, quality, duplicate, trigger, and usefulness gates pass.

Dry-run is non-mutating: it writes no skill files, does not mark procedures promoted, and does not update durable pending-autopilot state. Apply writes `SKILL.md`, `recipe.json`, `verification.json`, and `evals/evals.json` only for candidates that pass every gate. Generated skills are marked `enabled: false`; static validation alone never enables a skill.

Promotion gates reject or defer procedures with insufficient success evidence, insufficient distinct sessions/contexts, recent failures, low confidence/success rate, malformed/noisy/non-deterministic recipes, vague or context-specific triggers, missing validation checks, duplicate/overlapping existing skills, destructive/service/package/SSH/remote operations, credential/private-data/high-entropy leakage, external sends/posts/writes, or approval-bypass/prompt-injection content. Recipe JSON and generated `SKILL.md` are both scanned and redacted before durable output.

Generated skill drafts follow the skill-creator quality contract: trigger and near-miss examples, scope/non-scope, prerequisites, ordered workflow, safe tool usage, validation, failure handling, rollback/disable guidance, realistic examples, and provenance metadata. Verification metadata records source procedure ids, success/failure/session counts, input hash, policy version, static/safety/trigger/functional eval status, baseline comparison, rejection/defer reasons, and `enabled: false`.
