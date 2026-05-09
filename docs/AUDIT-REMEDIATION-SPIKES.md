# Hybrid-memory audit remediation (spikes + operator runbook)

This document backs the audit-health remediation work: **operator commands** for your live store, **spike conclusions** from code inspection, and **follow-up fixes** shipped in the plugin.

## Phase 0 — Run on your live deployment (Node 22+)

Requires OpenClaw CLI with hybrid-memory loaded (`openclaw hybrid-mem …`). If the CLI reports a Node version error, use Node 22+ (see project `.nvmrc`).

Execute **in order**:

1. **Collapse implicit-feedback paraphrase bloat** (preview then apply):

   ```bash
   openclaw hybrid-mem reflect-meta --collapse-implicit-feedback --include-legacy --threshold 0.8 --limit 1000 --dry-run
   openclaw hybrid-mem reflect-meta --collapse-implicit-feedback --include-legacy --threshold 0.8 --limit 1000
   ```

2. **Categories** — defaults now include `forge`, `monitoring`, `ops_*`, etc. For legacy rows still tagged `forge_busy` / `forge_dispatch` / `forge_ops`, remap into `forge`:

   ```bash
   openclaw hybrid-mem categories audit
   openclaw hybrid-mem categories remap --apply   # after configuring mappings for forge_* → forge
   ```

3. **Re-embed vectorless facts** (after collapse):

   ```bash
   openclaw hybrid-mem reembed-vectorless --apply
   ```

4. **Lance maintenance**:

   ```bash
   openclaw hybrid-mem vectordb-optimize --older-than-days 7
   ```

5. **Re-baseline**:

   ```bash
   openclaw hybrid-mem audit health
   ```

## Spike: vectorless auto-capture / reflection

**Finding:** `audit health` counts “vectorless” as facts **without a `fact_embeddings` row** (`variant = canonical`), not “missing Lance rows”. Ingest paths (`stage-capture`, `reflection`) previously called `vectorDb.store` + `setEmbeddingModel` but **did not** call `factsDb.storeEmbedding`, so large stores looked vectorless while Lance still held vectors.

**Fix:** Persist canonical embeddings via `factsDb.storeEmbedding` alongside Lance on successful embed paths (`lifecycle/stage-capture.ts`, `services/reflection.ts`).

## Spike: procedures stuck in `low_recall`

**Finding:** `procedureFeedback` intentionally avoids bumping `procedures.success_count`, while triage uses **enriched** `ProcedureEntry.successCount`. Validated procedures could still show `successCount === 0` with **no** `procedure_versions` rows → `low_recall`.  

**Fix:** `enrichProcedureWithFeedback` applies an **implied success** of `1` when `last_validated` is set, base counts are zero, and there are no version failures yet (both branches: no versions / merged versions).

## Spike: `registerContextEngine` log line

**Finding:** Older OpenClaw runtimes omit `registerContextEngine` from `openclaw/plugin-sdk/core`; registration is already feature-detected.  

**Follow-up:** Type shim now declares optional `registerContextEngine` for clarity; runtime still uses `typeof registerContextEngine === "function"`.

## Spike: entity stop-words (`User` vs `user`)

**Finding:** Historical facts and tool-credential capture can still use stop-word entities; `cleanEntityStopwords` exists for one-shot cleanup. Audit output now lists **`topEntitiesFiltered`** (retrieval-aligned) separately from the stop-word **warning** (raw `topEntities`).

## Scheduled maintenance (install cron)

New / updated jobs in `cli/cmd-install.ts`:

| Job | Schedule (UTC) | Command |
|-----|----------------|---------|
| `daily-storage-growth-sample` | `5 4 * * *` | `openclaw hybrid-mem record-storage-sample` |
| `weekly-implicit-feedback-collapse` | `30 4 * * 0` | `reflect-meta --collapse-implicit-feedback --include-legacy …` |
| `weekly-vectordb-optimize-sunday` | `45 4 * * 0` | `vectordb-optimize --older-than-days 7` |

Re-run **plugin install / cron sync** after upgrading so OpenClaw picks up new jobs.

## Manual ad hoc sampling

```bash
openclaw hybrid-mem record-storage-sample
```

Idempotent: at most one insert per UTC calendar day; enables **7d storage deltas** in `audit health` once daily samples exist.
