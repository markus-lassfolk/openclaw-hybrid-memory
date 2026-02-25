# Memory-to-Skills — Auto-Generate Skill Drafts from Procedural Memories

**Issue:** [#114](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/114)

The **memory-to-skills** pipeline mines procedural memories, clusters them by task type, applies quality gates, and uses an LLM to synthesize **SKILL.md** drafts into `skills/auto-generated/`. This is distinct from **generate-auto-skills**, which writes one template-based skill per single procedure in `skills/auto/`. Memory-to-skills **clusters** similar procedures and **synthesizes** one coherent skill per cluster.

---

## Overview

| Step | What it does |
|------|----------------|
| **Collect** | Procedures updated in the last N days (positive only). |
| **Cluster** | Group by similarity of `task_pattern` (embedding-based). |
| **Filter** | Clusters with ≥ minInstances, step consistency ≥ threshold, and ≥ 2 distinct tools. |
| **Generate** | LLM synthesizes one SKILL.md (and recipe.json) per qualifying cluster. |
| **Write** | Drafts go to `skills/auto-generated/<slug>/`. |
| **Dedup** | Skip if a skill with the same slug already exists under workspace skills; the cluster is counted as `skippedOther`. |
| **Notify** | Cron job message asks the agent to notify the user when new drafts are created. |

---

## Configuration

Under `plugins.entries["openclaw-hybrid-memory"].config.memoryToSkills`:

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | same as `procedures.enabled` | Enable the pipeline. |
| `schedule` | `"15 2 * * *"` | Cron for nightly run (2:15 AM, staggered after nightly-distill). |
| `windowDays` | `30` | Procedures updated in last N days. |
| `minInstances` | `3` | Minimum procedure instances per cluster. |
| `consistencyThreshold` | `0.7` | Step consistency 0–1 required. |
| `outputDir` | `"skills/auto-generated"` | Output path relative to workspace. |
| `notify` | `true` | Informational hint: whether the cron job should notify on new drafts. Currently not consumed by the pipeline; reserved for future use. |
| `autoPublish` | `false` | Informational toggle for auto-publishing; currently a no-op. Always requires human review. |

Example:

```json
{
  "memoryToSkills": {
    "enabled": true,
    "schedule": "15 2 * * *",
    "windowDays": 30,
    "minInstances": 3,
    "consistencyThreshold": 0.7,
    "outputDir": "skills/auto-generated",
    "notify": true,
    "autoPublish": false
  }
}
```

---

## CLI

```bash
# Run pipeline (uses config windowDays, minInstances, etc.)
openclaw hybrid-mem skills-suggest

# Preview only
openclaw hybrid-mem skills-suggest --dry-run

# Procedures from last 14 days
openclaw hybrid-mem skills-suggest --days 14

# Verbose logging
openclaw hybrid-mem skills-suggest --verbose
```

If `memoryToSkills.enabled` is false, the command exits successfully with no work done.

---

## Cron Job

When you run `openclaw hybrid-mem install` or `openclaw hybrid-mem verify --fix`, the plugin adds a **nightly-memory-to-skills** job (default schedule: 2:15 AM, staggered after nightly-distill at 2:00 AM). The job runs `openclaw hybrid-mem skills-suggest`. If new drafts were generated, the job message instructs the agent to notify the user in the system channel with a short summary and paths.

To disable the job, set `memoryToSkills.enabled: false` or disable the job in `~/.openclaw/cron/jobs.json`.

---

## Quality Gates

- **Min instances:** Config `minInstances` (default 3).
- **Step consistency:** For each cluster, step positions are compared across procedures; the fraction of positions where the majority tool matches must be ≥ `consistencyThreshold` (0.7).
- **2+ tools:** The cluster must use at least two distinct tool names across steps.
- **Dedup:** Existing skill directories under `skills/`, `skills/auto/`, and `skills/auto-generated/` are scanned; if the chosen slug already exists, the draft is skipped.

External validation (e.g. `quick_validate.py` from the skill-creator skill) is not run by this plugin. You can set `memoryToSkills.validateScript` to document a script path for your own workflow; the plugin does not invoke it.

---

## Related

- [PROCEDURAL-MEMORY.md](PROCEDURAL-MEMORY.md) — Procedure extraction and `generate-auto-skills`
- [REFLECTION.md](REFLECTION.md) — Pattern synthesis from facts
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All `hybrid-mem` commands
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
