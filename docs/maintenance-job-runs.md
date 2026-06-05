# Maintenance Job Runs

Design for resumable, inspectable maintenance command execution. Parent issue: [#1877](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1877).

The **maintenance orchestrator** schedules which steps run (guards, tiers, rate-limit deferral). **Job runs** track how each long/heavy command executes: checkpoints, semantic outcomes, and durable artifacts.

---

## Two-tier run model

| Tier | ID pattern | Owner | Artifact prefix |
|------|-----------|-------|-----------------|
| **OrchestratorRun** | `orch-{iso}-{random}` or harness `RUN_ID` | `runMaintenanceOrchestrator` | `{job}-{runId}` beside HM_LOG |
| **JobRun** | `job-{command}-{fingerprint8}` | Individual heavy CLI handlers | `job-runs/{jobRunId}/` under run day dir |

Orchestrator runs are macro: one nightly cron invocation may execute many steps. Job runs are micro: one LLM-heavy command (e.g. `self-correction-run`) with batch checkpoints and phase events.

---

## Semantic outcome vocabulary

Unified enum used by JobRun summaries, orchestrator step metadata, and cron validation.

| Outcome | Meaning |
|---------|---------|
| `success` | Mechanical and semantic OK |
| `success_with_review` | Ran; operator should review (partial apply, low confidence) |
| `partial` | Some units completed; resumable |
| `failed` | Hard failure (parse error, abort, unrecoverable) |
| `skipped` | Intentional no-op (cooldown, feature gate, concurrency) |
| `empty` | Valid run with zero semantic output (no incidents, no matches) |
| `failed_semantic_empty` | Input present but zero parsed output (suspect model/parser failure) |

### Mapping from command-specific statuses

| Command status | JobRun outcome |
|----------------|----------------|
| `success_analyzed` | `success` |
| `success_no_incidents` | `empty` |
| `skipped_cooldown`, `skipped_concurrency` | `skipped` |
| `failed_parse`, `failed` | `failed` |
| `failed_partial` | `partial` |
| `failed_suspect_zero_parsed` | `failed_semantic_empty` |
| Log marker `semantic_empty` | `failed_semantic_empty` |

### Mapping to cron validator `semanticStatus`

| JobRun outcome | Validator `semanticStatus` |
|----------------|---------------------------|
| `success`, `empty`, `skipped` | `ok` |
| `success_with_review`, `partial` | `degraded` |
| `failed`, `failed_semantic_empty` | `semantic_fail` |

Orchestrator `StepStatus` mapping:

| Step status | Typical JobRun / rollup |
|-------------|-------------------------|
| `ok` | `success` (unless nested JobRun says otherwise) |
| `skipped_*` | `skipped` |
| `deferred`, `rate_limited` | `partial` |
| `failed` | `failed` |

---

## Artifact layout

Co-located with existing cron logs under `~/.openclaw/logs/cron-hybrid-mem/`:

```text
~/.openclaw/logs/cron-hybrid-mem/YYYYMMDD/
  {job}-{runId}.log              # HM_LOG (existing)
  {job}-{runId}.exit.txt         # HM_EXIT (existing)
  {job}-{runId}.summary.json     # Orchestrator + validation rollup
  {job}-{runId}.validation.json  # Persisted validate-cron-exit output
  job-runs/{jobRunId}/
    summary.json                 # Per-command JobRun summary
    events.jsonl                 # Append-only phase/batch events
    report.md                    # Human diagnosis (optional)
    checkpoint.json              # Resume state (while in progress)
```

Reference implementation: `pending-digest-autopilot-cron.ts` (HM_LOG + HM_EXIT + `summary.json`).

### Environment variables (cron harness)

| Variable | Purpose |
|----------|---------|
| `HM_RUN_ID` | Correlates orchestrator run with harness artifacts |
| `HM_JOB` | Cron job name (e.g. `maintenance-nightly`) |
| `HM_ORCHESTRATOR_RUN_ID` | Set by orchestrator CLI for child JobRuns |

---

## JobRun record schema (`schemaVersion: 1`)

See `extensions/memory-hybrid/services/maintenance-job-run/types.ts` for the canonical TypeScript definitions.

Key fields: `jobRunId`, `command`, `inputFingerprint`, `phases[]`, `semanticOutcome`, `progress`, `diagnostics`, `artifactPaths`.

Event types in `events.jsonl`: `phase_start`, `phase_end`, `batch_complete`, `retry`, `fallback`, `semantic_gate`.

---

## Checkpoint stores

| Store | Use case | State shape |
|-------|----------|-------------|
| `FileCheckpointStore<T>` | Generic atomic JSON checkpoint | arbitrary |
| `BatchCheckpointStore` | LLM batch analysis | `completedBatchIndexes`, `analysed[]`, `diagnostics` |
| `OffsetCheckpointStore` | Re-index / paging | `offset`, `total`, `migrated`, `skipped` |

Scan cursors remain in SQLite (`scan_cursors` table); JobRun summary records a snapshot for observability only.

---

## Migration plan

| Current pattern | Location | Migration |
|-----------------|----------|-----------|
| Self-correction batch JSON | `{workspace}/tmp/self-correction/m3-batches-*.json` | Import into JobRun `checkpoint.json`; legacy path deprecated |
| Reinforcement batch JSON | `{workspace}/tmp/reinforcement/` | Future adopter (same `BatchCheckpointStore`) |
| Re-index checkpoint | `{memoryDir}/.reindex_checkpoint.json` | `OffsetCheckpointStore` adapter |
| HM_EXIT / validator | Cron harness | Read `summary.json` first; HM_EXIT remains compatibility layer |

---

## Retention

- **On success:** delete `checkpoint.json` and `events.jsonl`; keep `summary.json` 30 days.
- **On partial/fail:** retain checkpoint and events until resume completes or operator deletes.
- **Stale legacy files:** pruned on new run start (existing self-correction behavior).

---

## Operator CLI

```bash
openclaw hybrid-mem maintenance run list [--since 7d] [--json]
openclaw hybrid-mem maintenance run status <id> [--json]
openclaw hybrid-mem maintenance run artifacts <id> [--json]
openclaw hybrid-mem maintenance run explain <id> [--json]
openclaw hybrid-mem maintenance run resume <id>
```

`<id>` accepts run id, job run id, or unique prefix.

---

## First adopter: self-correction-run

Phases: `extract` (informational), `analyze` (batch checkpoint), `apply` (idempotent).

Machine-readable stdout lines (`status=…`, `batches_completed=`) remain for cron grep until all consumers read `summary.json`.

---

## Related docs

- [MAINTENANCE-TASKS-MATRIX.md](MAINTENANCE-TASKS-MATRIX.md) — orchestrator scheduling
- [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md) — self-correction semantics
- [extensions/memory-hybrid/docs/cron-exit-validation.md](../extensions/memory-hybrid/docs/cron-exit-validation.md) — HM_EXIT validation
