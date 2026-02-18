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
- `created_at`, `updated_at`

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

- [SESSION-DISTILLATION.md](SESSION-DISTILLATION.md) — Fact extraction from session logs (same JSONL source).
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All `hybrid-mem` commands.
- [CONFIGURATION.md](CONFIGURATION.md) — Full plugin config reference.
