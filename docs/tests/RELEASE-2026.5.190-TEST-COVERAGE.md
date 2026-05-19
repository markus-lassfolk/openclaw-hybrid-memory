# Test coverage map — release 2026.5.190

This document maps **2026.5.190** changelog items to regression tests. It is maintained for release sign-off, not as a substitute for reading test names in CI.

**How to run (Node ≥ 22.16):**

```bash
cd extensions/memory-hybrid && npm test
```

**CI:** Push to `main` or open a PR — `.github/workflows/ci.yml` runs typecheck, lint, and tests on Node **22.16** and **24**.

**Operator smoke (installed OpenClaw):**

```bash
bash scripts/release-smoke-2026.5.190.sh
```

---

## Release sign-off checklist

- [ ] CI green on Node 22 and 24 (`extensions/memory-hybrid` test job)
- [ ] New regression files pass locally or in Docker (see below)
- [ ] `bash scripts/release-smoke-2026.5.190.sh` on a staging host with real config (optional but recommended)
- [ ] Changelog `[2026.5.190]` matches shipped behavior

**Focused test files added for this release sign-off:**

| File | What it guards |
|------|----------------|
| `vector-db-semantic-cache-uninitialized.test.ts` | Semantic cache no-op when table missing (#1469) |
| `facts-db.test.ts` (`store` SQLITE_BUSY) | Concurrent store retry (#1506, `storeFact` path) |
| `dashboard-server.test.ts` (cached Lance size) | Dashboard Lance TOCTOU (#1501) |
| `run-all-maintenance.test.ts` | `run-all` dry-run + backfill marker idempotency |
| `maintenance-jsonl-pipeline.test.ts` | Malformed JSONL does not break backfill / analyze-feedback |
| `dream-cycle.test.ts` (episodic consolidation idempotent) | Nightly consolidation does not double-process events |

**Docker (local Node 20 host):**

```bash
docker run --rm -v "$PWD:/work" -w /work/extensions/memory-hybrid node:22.16-bookworm-slim \
  bash -c "npm ci && npm test"
```

---

## Summary

| Area | Coverage | Notes |
|------|----------|--------|
| Similarity-sweep hardening | **Strong** | Dedicated tests per surface (sensor, backfill, distill, language-keywords, config await, extract paths) |
| Atomic writes | **Strong** | `stage-capture`, `cmd-selfcorrection-atomic`, `install-workspace-skill`, crystallization / generated-skill validation |
| Vector DB | **Strong** | Init timeout (#1495), semantic cache uninitialized (#1469), optimize/cache, count timeout |
| CLI JSON contracts | **Strong** | `verify-fix-config-error`, `register-corrections-config-*`, `config-view-json` |
| Bootstrap / Ollama | **Strong** | `bootstrap-databases-ollama`, `ollama-llm` (localAutoStart, dedupe), `embedding-global-inheritance` (AbortSignal.timeout) |
| Guards / multi-agent | **Strong** | `session-ref-matches`, `pre-finalization-guard-*`, `lifecycle-agent-end-guard` |
| Procedures / skills | **Strong** | `procedure-extractor` (any-failure-wins), `procedure-promotion-policy` (staticValidation), `procedures-db` (enum drift), `skills-rescan` |
| Dashboard | **Strong** | Concurrent + cached Lance size (#1501 / #1529) in `dashboard-server.test.ts` |
| Storage concurrency | **Strong** | `facts-db.test` store + storeFact SQLITE_BUSY (#1506) |
| Dream cycle / stewardship | **Strong** | `dream-cycle.test` (idempotent second run), `run-all-maintenance.test`, `maintenance-jsonl-pipeline.test` |
| Autopilot foundation | **Moderate** | `pending-autopilot-foundation`, `pending-digest-autopilot*`, triage adapter tests |
| Cost optimization (#1319) | **Light** | Mostly integration / e2e; see `COST-OPTIMIZATION-PLAYBOOK.md` for manual checks |

**Verdict:** Release **2026.5.190** is well covered for operator-facing fixes and skill/procedure pipelines. Gaps are mostly **integration breadth** (full gateway e2e under load), not missing unit tests for the listed fixes.

---

## Fixes — test file index

| Changelog item | Primary test file(s) |
|----------------|----------------------|
| Sensor sweep JSON / invalid HA entities (#1476, #1512) | `sensor-sweep.test.ts` |
| Backfill analyze-feedback JSONL (#1472, #1511) | `cmd-backfill-analyze-feedback.test.ts`, `cmd-backfill-jsonl.test.ts` |
| Distill JSON parse (#1471) | `cmd-distill.test.ts` |
| Language-keywords JSON (#1477) | `language-keywords.test.ts` |
| Procedure `avoidance_notes` (#1470) | `procedures-db.test.ts` |
| Config/features `runConfigView` await (#1496, #1524) | `config-view-await-regression.test.ts` |
| Extract missing-await (#1493) | `cmd-extract-session-paths.test.ts` |
| Stage-capture atomic writes (#1498) | `stage-capture.test.ts` |
| Self-correction atomic (#1499) | `cmd-selfcorrection-atomic.test.ts` |
| Install workspace skill atomic (#1500) | `install-workspace-skill.test.ts` |
| Vector init timeout (#1495) | `vector-db-init-timeout.test.ts` |
| Semantic cache table missing (#1469) | `vector-db-semantic-cache-uninitialized.test.ts` |
| Verify stderr for `--json` (#1492, #1520) | `verify-fix-config-error.test.ts` |
| Corrections config stdout (#1519) | `register-corrections-config-cli.test.ts`, `register-corrections-config-output-sink.test.ts` |
| Ollama auto-start / unref (#1480, #1514) | `bootstrap-databases-ollama.test.ts`, `ollama-llm.test.ts` |
| Provider-router AbortSignal.timeout | `embedding-global-inheritance.test.ts` (`probeOllamaEndpoint`) |
| Pre-finalization multi-agent (#1504, #1486) | `pre-finalization-guard-allow.test.ts`, `session-ref-matches.test.ts` |
| SQLITE_BUSY retry (#1506) | `facts-db.test.ts` |
| Dashboard Lance cache TOCTOU (#1501, #1529) | `dashboard-server.test.ts` |
| Retrieval breadcrumb failures (#1507) | `retrieval-modes.test.ts` |
| Alias index closed-state (#1494) | `retrieval-aliases-schema.test.ts` |
| Procedure enum drift (#1487, #1515) | `procedures-db.test.ts` |
| `staticValidation` semantics | `procedure-promotion-policy.test.ts` |
| Any-failure-wins session success | `procedure-extractor.test.ts` |
| `run-all` backfill marker idempotency | `run-all-maintenance.test.ts` |
| Malformed JSONL in maintenance inputs | `maintenance-jsonl-pipeline.test.ts`, `cmd-backfill-jsonl.test.ts` |
| Dream cycle episodic idempotent re-run | `dream-cycle.test.ts` (`runEpisodicConsolidation`) |

---

## Added features — test file index

| Feature area | Primary test file(s) |
|--------------|----------------------|
| Generated skill validation / safety | `generated-skill-validation.test.ts`, `crystallization.test.ts` |
| Skill pipelines / lifecycle | `generated-skill-telemetry.test.ts`, `skills-rescan.test.ts`, `procedure-skill-generator.test.ts` |
| Promotion policy | `procedure-promotion-policy.test.ts` |
| Crystallization store / proposer | `crystallization-store.test.ts`, `crystallization-proposer.test.ts` |
| Evidence hash / legacy | `evidence-hash-legacy.test.ts` |
| Pending autopilot / digest | `pending-autopilot-foundation.test.ts`, `pending-digest-autopilot*.test.ts` |
| Persona / verified-fact triage | `persona-proposal-triage.test.ts`, `verified-fact-triage.test.ts` |
| Doctor / user-friendly CLI | `user-friendly-cli.test.ts` |
| Session observability | `session-observability.test.ts` |
| Comprehensive e2e | `comprehensive-e2e.test.ts`, `plugin-e2e.test.ts` |

---

## When to add more tests

Add focused regression tests when:

1. A bug escaped CI because behavior was only covered indirectly.
2. A new **public CLI contract** changes (document in `CLI-REFERENCE.md` + JSON sink tests).
3. A new **failure mode** is degraded (return null / stderr) rather than thrown.

Prefer extending an existing `*.test.ts` beside the module under test before adding one-off e2e unless the bug is lifecycle-wide.
