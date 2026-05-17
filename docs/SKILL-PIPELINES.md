# Skill Pipelines — Canonical Shape and Lifecycle

This document describes the two auto-skill generation pipelines and the shared lifecycle system that governs generated skills after installation.

> **Design decision (Issue #1407):** Both pipelines are kept separate but share a common kernel:
> the lifecycle state machine (`GeneratedSkillLifecycleService`), the telemetry recording system
> (`generated_skill_telemetry` table), and the operator CLI (`skills` sub-commands).
> No new SKILL.md authoring code is added outside these shared modules.

---

## Overview of the two pipelines

| | Pipeline A — Crystallization | Pipeline B — Procedure promotion |
|---|---|---|
| **Source** | Workflow patterns (`workflow_patterns` table) | Procedures (`procedures` table) |
| **Detector** | `detectCandidates(workflowStore, crystallizationStore, cfg)` | `evaluateProcedureForPromotion()` via `ProcedurePromotionPolicy` |
| **Generator** | `crystallize(cfg, input)` | `ProcedureSkillGenerator` |
| **Output path** | `cfg.outputDir/{slug}/SKILL.md` | `procedures.skillsAutoPath/auto/{slug}/SKILL.md` |
| **Proposal/lifecycle table** | `crystallization_proposals` (via `CrystallizationStore`) | `procedures` (rows marked `promoted_to_skill = 1`) |
| **Lifecycle tracking** | `procedures` via `skill_state` + `generated_skill_telemetry` | Same (`skill_state` on the `procedures` row) |

Both pipelines funnel into the **same lifecycle system** after a skill is first materialized on disk.

---

## Shared lifecycle system

### States

```
draft ──> experimental ──> trusted
                │               │
                ▼               ▼
            demoted ◀────────────
                │
                ▼ (auto-unblock after N clean uses)
            experimental (reset)
                │
                ▼
          archived / uninstalled / rejected
```

| State | Meaning |
|-------|---------|
| `draft` | Initial state before the skill is materialized on disk. |
| `experimental` | Default after installation. Policy evaluations are active. |
| `trusted` | Auto-promoted after `promoteAfterSuccessfulUses` clean activations. |
| `demoted` | Auto-demoted when false-positive rate exceeds `demoteFalsePositiveRate`. |
| `archived` | Auto-archived when the skill is never used within `archiveAfterUnusedDays`. |
| `uninstalled` | Set by `skills doctor --fix` when the SKILL.md file no longer exists on disk. |
| `rejected` | Terminal state: operator permanently rejected the skill. |

### Telemetry window reset

When a skill is reset from `demoted`/`archived` back to `experimental` (manually via
`skills reset` or automatically via the `unblockAfterCleanUses` policy), the evaluation
window is reset to the current timestamp. This prevents pre-demotion false-positive signals
from immediately re-triggering demotion during the recovery period.

Internally, `setGeneratedSkillLifecycleState(..., "experimental", ...)` updates
`skill_generated_at` to the transition time, which `summarizeSkillTelemetry` uses as the
evaluation window start for experimental skills.

---

## Pipeline A — Crystallization

The crystallization pipeline converts high-signal workflow patterns into managed skill proposals.

### Steps

1. **Detect** — `detectCandidates(workflowStore, crystallizationStore, cfg)` scans recent
   workflow patterns, applies min-usage and min-success-rate thresholds, and skips patterns
   that already have a pending or approved proposal.

2. **Crystallize** — `crystallize(cfg, input)` generates a `SKILL.md` document and an
   optional shell script (for exec-only tool sequences) from the candidate pattern.

3. **Validate** — `GeneratedSkillValidationService.validate()` checks the generated content
   against format and quality rules.

4. **Store** — The proposal is saved to `CrystallizationStore` as `pending` (awaiting human
   approval) or `approved` (when `autoApprove` is true).

5. **Install** — After human approval, `CrystallizationProposer.approve()` writes the skill
   to disk and marks the procedure promoted.

### Entry point

```ts
import { CrystallizationProposer } from "./services/crystallization-proposer.js";

const proposer = new CrystallizationProposer(workflowStore, crystallizationStore, cfg);
const result = proposer.runCycle(); // detect → crystallize → validate → store
```

### Free function usage (preferred for standalone use)

```ts
import { detectCandidates } from "./services/pattern-detector.js";
import { crystallize } from "./services/skill-crystallizer.js";

const candidates = detectCandidates(workflowStore, crystallizationStore, cfg);
for (const candidate of candidates) {
  const result = crystallize(cfg, candidate);
  // ...
}
```

---

## Pipeline B — Procedure promotion

The procedure promotion pipeline elevates validated procedures (from session log extraction)
into skills when they reach a confidence threshold.

### Steps

1. **Extract** — `procedure-extractor` processes session JSONL files and creates/updates rows
   in the `procedures` table.

2. **Evaluate** — `ProcedurePromotionPolicy.evaluateProcedureForPromotion()` computes a
   `candidateScore` and `riskLevel` from procedure metadata.

3. **Generate** — `ProcedureSkillGenerator` writes `SKILL.md`, `recipe.json`, and a
   companion `proposal-metadata.json` under `skills/auto/{slug}/`.

4. **Track** — `markProcedurePromoted(id, skillPath)` records the skill path on the
   procedure row and sets `skill_state = "experimental"`.

---

## Shared lifecycle commands

```bash
# Telemetry and monitoring
openclaw hybrid-mem skills telemetry [skillName]
openclaw hybrid-mem skills telemetry [skillName] --json

# State management
openclaw hybrid-mem skills demote <skillName> --reason "..."
openclaw hybrid-mem skills reset <skillName> --reason "..."   # demoted/archived → experimental
openclaw hybrid-mem skills reject <skillName> --reason "..."  # permanently reject

# Disk reconciliation
openclaw hybrid-mem skills doctor                             # scan for missing skill files
openclaw hybrid-mem skills doctor --fix                      # mark missing as uninstalled
openclaw hybrid-mem skills doctor --workspace /path/to/ws   # custom workspace root
openclaw hybrid-mem skills doctor --json                     # machine-readable output
```

---

## Operator playbook: "A skill was wrongly demoted — what now?"

### Symptoms
- A skill is in `demoted` state but the agent's behaviour has changed (e.g. after retraining
  or a prompt update) and the demotion was based on stale false-positive signals.
- The `skills telemetry` report shows high `falsePositiveSignals` in the historic window but
  recent activations would have been clean.

### Steps

1. **Review the telemetry** to understand why the skill was demoted:
   ```bash
   openclaw hybrid-mem skills telemetry <skillName>
   ```

2. **Reset the skill** back to experimental with an audit reason:
   ```bash
   openclaw hybrid-mem skills reset <skillName> \
     --reason "agent prompt updated; prior false positives are no longer representative"
   ```
   This clears the evaluation window — only activations AFTER the reset count toward the
   next promotion or demotion decision.

3. **Monitor** the skill through its next experimental phase:
   ```bash
   openclaw hybrid-mem skills telemetry <skillName>
   ```
   - If 3+ clean activations occur without correction → auto-promoted to `trusted`.
   - If the false-positive rate rises again → auto-demoted again.

4. **If the skill is fundamentally broken**, reject it permanently:
   ```bash
   openclaw hybrid-mem skills reject <skillName> --reason "scope too broad; superseded by skill-xyz"
   ```

### Automatic unblocking

If the `unblockAfterCleanUses` policy threshold is met (default: 5 clean activations after
demotion), the skill is automatically unblocked back to `experimental` without operator
intervention. The next telemetry refresh will then evaluate whether to promote it.

---

## Operator playbook: "A skill file is missing but the DB still tracks it"

This can happen when:
- The operator manually deleted a skill directory.
- A workspace was reset or the `skills/auto/` path was cleared.

### Steps

1. **Scan for discrepancies**:
   ```bash
   openclaw hybrid-mem skills doctor
   ```

2. **Review the report** — it lists any skill that exists in the DB (`promoted_to_skill = 1`)
   but whose `SKILL.md` file is no longer present on disk.

3. **Mark missing skills as uninstalled**:
   ```bash
   openclaw hybrid-mem skills doctor --fix
   ```
   This sets `skill_state = "uninstalled"` for the affected rows, stopping the lifecycle
   policy from continuing to evaluate and report on them.

4. If the skill should be **re-generated**, either:
   - Re-run `openclaw hybrid-mem generate-auto-skills` (Pipeline B), or
   - Re-run `openclaw hybrid-mem skills install` for a crystallization proposal (Pipeline A).

---

## Configuration reference

All lifecycle policy thresholds live under `plugins.entries["openclaw-hybrid-memory"].config`:

| Field | Default | Description |
|-------|---------|-------------|
| `crystallization.enabled` | `false` | Enable Pipeline A (crystallization). |
| `crystallization.minUsageCount` | `5` | Min workflow pattern uses before proposing. |
| `crystallization.minSuccessRate` | `0.7` | Min success rate for pattern candidates. |
| `crystallization.maxCrystallized` | `20` | Max approved crystallization proposals. |
| `crystallization.autoApprove` | `false` | Skip human approval and write immediately. |
| `procedures.enabled` | `true` | Enable Pipeline B (procedure extraction + promotion). |
| `procedures.validationThreshold` | `3` | Successes before auto-generating a skill. |
| `procedures.requireApprovalForPromote` | `true` | Require human to promote out of `auto/`. |

The lifecycle policy thresholds (promotion, demotion, archiving) are currently hardcoded in
`DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY` in `backends/facts-db/generated-skills.ts`.
Custom policies can be passed to `GeneratedSkillLifecycleService` for testing or per-agent
configuration.
