# The Loom

An agent-native continuity, belief, evidence, and open-loop operating layer on top of hybrid-memory. The Loom does not just store more information — it helps an agent answer:

> What do I believe, why do I believe it, how current is it, what evidence supports it, what remains open, and what must I verify before acting?

Tracking epic: [#2150](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/2150).

The Loom is **enabled by default**. It instantiates the `LoomStore` and registers every tool/CLI surface below, and runs a nightly maintenance step (stale-claim sweep + drift scan) as part of the normal maintenance cycle. Set `loom.enabled: false` in plugin config to turn the whole subsystem off, or disable individual sections independently (`loom.<section>.enabled: false`) without turning off everything else.

## Non-goals

- Not an autonomous planning system that acts without user/task intent.
- Memory is context, not proof of mutable live state — that's the entire point of live-check contracts.
- Not "preserve everything forever at equal importance" — the attention steward and lifecycle workflows exist specifically to prevent that.
- Never exposes credential values; evidence capsules are redacted before storage.

## Data model

One SQLite file (`loom.db`), one table per concept, via `backends/loom-store.ts` (decomposed into `backends/loom/*` modules, mirroring the FactsDB/SerendipityStore pattern).

### Evidence capsules (#2148)

Durable proof objects: what was checked, what changed, what remains unverified. Fields: `title`, `claim`, `evidence[]` (kind + text), `commandsRun[]`, `artifacts[]`, `unverifiedItems[]`, `riskFlags[]`, `limits`, `redactionStatus`/`redactionCount`, `linkedClaimIds`/`linkedTaskLabel`/`linkedGoalId`. Secret-like values are redacted (`services/evidence-redaction.ts`, built on the same `redactAutopilotText` used by the pending-autopilot subsystem) before a capsule is ever written; if `loom.evidence.rejectUnredactable` is true and content still looks unstrippable (e.g. an oversized PEM block), capsule creation is refused instead of silently storing a partially-redacted secret.

### Belief graph / claim ledger (#2151)

A `Claim` is a justified statement distinct from a raw recalled fact: `entity`/`predicate`/`value`, `status` (`believed | verified | stale | contradicted | superseded | unverified | must_live_check`), `confidence`, `why`, `sourceFactIds`/`evidenceCapsuleIds`, `contradictsClaimIds`/`supersedesClaimIds`/`supersededByClaimId`, `invalidationConditions`. Claims degrade `verified`/`believed` → `stale` automatically once `lastVerifiedAt` (or `createdAt`) is older than `loom.beliefs.staleAfterDays` (default 30).

### Live-check contracts (#2156)

A claim can declare `liveCheckRequired: true` with a `liveCheckReason` and `suggestedChecks[]` (command/api_call/manual + expected value). Satisfying a check (`memory_live_check_satisfy` / `loom live-checks satisfy`) records a `loom_live_check_events` row with an expiry (`loom.liveChecks.defaultTtlHours`, default 24) and flips the claim back to `verified`. `memory_live_check_list` / `getLiveCheckStatus` reports `not_required | required_unsatisfied | satisfied | expired`.

### Open-loop obligations ledger (#2152)

Unfinished promises, blocked work, unresolved incidents that shouldn't depend on human memory. `loopType` (`promise_made | blocked_task | unresolved_incident | needs_verification | pending_decision | operator_followup | future_cleanup | watch_condition`), `owner`, `status` (`open | waiting | blocked | ready | closed | superseded`), `nextAction`/`closureCriteria`, `evidenceRequired` (closing then requires an evidence capsule id — `OpenLoopEvidenceRequiredError` otherwise), `urgency`/`importance`/`operatorLoadRisk` (0–1), `resurfaceAt` (defaults to `loom.openLoops.defaultResurfaceDays` days out). `listLoopsDueForResurface` returns loops whose `resurfaceAt` has passed without re-notifying (`markLoopResurfaced` bookkeeping).

### Drift scout (#2146)

`services/drift-scout.ts` scans facts for two real signals today: **deprecated command references** (configured via `loom.drift.deprecatedCommands`, a `{ "old text": "replacement text" }` map) and **unresolved contradictions** (reusing the existing `backends/facts-db/contradictions.ts` machinery). Findings dedup by `(driftType, oldText)` hash. `--apply-safe` mechanically rewrites the affected fact text for `auto_safe` deprecated-command findings only and marks them `resolved`; everything else is report-only.

### Memory lifecycle workflows (#2155)

`services/memory-lifecycle.ts`. `listLifecycleCandidates` is **report-only** and flags facts as `contradicted`, `superseded`, `duplicate` (exact normalized-text match — the newer copy is the candidate), `stale_low_access` (low importance + untouched past `loom.lifecycle.staleAfterDays`), or `prompt_injection_like` (classic override phrasing pasted verbatim into memory). `applyLifecycleAction` performs one of:

- **demote** — lowers confidence, tags `lifecycle-demoted`. Non-destructive.
- **archive** — tags `lifecycle-archived`. Fact stays fully intact and searchable as historical context.
- **quarantine** — replaces fact text with a `[quarantined: reason]` placeholder; the original text is preserved only in the lifecycle audit log metadata. Requires `confirm: true`.
- **delete** — hard delete via `FactsDB.delete()`. Requires `confirm: true`; a verified fact additionally requires `strongConfirm: "DELETE-VERIFIED"` when `loom.lifecycle.requireStrongConfirmForVerified` (default true).

Every mutating action is recorded in `loom_lifecycle_audit`.

### Attention steward (#2153)

`services/attention-steward.ts` ranks claims, open loops, drift findings, and serendipity findings into `urgent | important_not_urgent | blocked | needs_verification | stale_or_noisy | candidate_for_deletion | candidate_for_skill_or_wrapper | interesting_not_actionable`, each with a numeric score and plain-English reasons. `memory_attention_update` (`snooze` / `demote` / `restore`) stores a non-destructive override (`loom_attention_overrides`, latest-wins per target) — snoozed items are excluded from ranking by default (`includeSnoozed` to see them), demoted items stay visible but score near zero.

### Loom brief (#2154)

`services/loom-brief.ts` composes a bounded, prompt-safe pre-action briefing for a free-text `scope` (empty = workspace-wide): beliefs split into `verifiedBeliefs` / `staleOrUnverifiedBeliefs` / `contradictions`, `mustLiveCheck` items, matching `openLoops`, `recentEvidence`, `driftWarnings`, top `attentionPriorities`, and derived `nextActions`. Every item carries an explicit `label` (`memory | evidence | live_check_requirement | recommendation`) so an agent never confuses recalled context with proof. The brief is trimmed section-by-section until it fits `loom.brief.maxChars` (default 4000), setting `truncated: true` when it had to cut anything.

### Agent Runway (#2145)

`services/agent-runway.ts` is the front door: active tasks (read live from the `project`-category checkpoint facts written by `active_task_checkpoint`, not a Markdown projection — `source: "facts_ledger"`), active goals (via `goal-registry.ts`), fragile surfaces (procedures with recorded failures at `medium`/`high` risk, via the existing `determineRiskLevel` heuristic), stale/contradicted high-importance-fact warnings, and a `loom` summary object (top claims, must-live-check claims, open loops, drift warnings, top attention items — including relevant serendipity findings). Always includes the warning *"Memory is context, not proof; verify live state before acting."*

### Loom dashboard/report (#2157)

`services/loom-report.ts` renders Markdown or HTML for human review: top attention items, open loops by status, stale/contradicted beliefs, recent evidence capsules, drift findings, procedure promotion candidates, serendipity inbox highlights, and lifecycle/demotion candidates — each with counts plus bounded top examples and stable IDs for follow-up commands. No raw fact text is ever rendered for lifecycle candidates (ids + reasons only); evidence capsules are already redacted at write time.

### Procedure refinery triage (#2147)

`services/procedure-triage.ts` turns the raw procedure backlog into a bounded, ranked batch: clusters near-duplicate procedures (`services/procedure-cluster.ts`, Jaccard similarity ≥ 0.6), scores risk (`utils/procedure-risk.ts`), and recommends `promote_to_skill` / `promote_to_wrapper` / `file_issue` / `no_action` per cluster — `no_action` if a `skillPath` already exists (detected wrapper) or after an explicit `loom procedures triage` decision is recorded (`loom_procedure_triage_decisions`, keyed by a stable slug-derived cluster id so decisions persist across runs).

### Serendipity inbox — Loom alignment (#2149)

The existing Serendipity Protocol (`docs/SERENDIPITY-PROTOCOL.md`) gained additive columns: `relatedClaims`/`relatedLoops`/`relatedDriftFindings` (link a finding into the rest of the Loom via `serendipity_store.linkRecord(id, "claim" | "loop" | "drift_finding", targetId)`), `leverage`/`riskReduction`/`timeSaved`/`cognitiveLoadReduction` (0–1 scores), and `notAnActiveTask` — `true` until the finding transitions to `fixed`/`filed`/`proposed`, at which point it's real tracked work elsewhere and drops out of the attention-steward ranking and runway summary automatically.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `memory_evidence_capsule_create` / `_show` / `_attach` / `_list` | Evidence capsules |
| `memory_belief_assert` / `_get` / `_verify` / `_contradict` / `_supersede` / `_explain` | Belief graph |
| `memory_live_check_list` / `_satisfy` / `_require` | Live-check contracts |
| `memory_loop_create` / `_list` / `_update` / `_close` | Open-loop ledger |
| `memory_drift_scout` | Drift scout |
| `memory_lifecycle_candidates` / `_update` | Lifecycle workflows |
| `memory_attention_rank` / `_update` | Attention steward |
| `memory_loom_brief` | Pre-action synthesis |
| `memory_runway` | Preflight bundle |

## CLI

All under `openclaw hybrid-mem`:

```bash
openclaw hybrid-mem evidence create "Doris M365 auth restored" --claim "..." --evidence "m365-agent-cli whoami"
openclaw hybrid-mem belief assert --entity Doris --key m365_identity --value doris@lassfolk.net --why "..." --live-check --live-check-reason "mutable auth state"
openclaw hybrid-mem belief explain <claimId>
openclaw hybrid-mem belief sweep-stale --json                 # degrade beliefs past the staleness window (also runs nightly)
openclaw hybrid-mem live-checks list
openclaw hybrid-mem live-checks satisfy <claimId> --evidence <capsuleId>
openclaw hybrid-mem loops create "Verify Doris M365 auth" --type needs_verification --closure "whoami succeeds"
openclaw hybrid-mem loops close <loopId> --evidence <capsuleId>
openclaw hybrid-mem drift scout --json
openclaw hybrid-mem memory-lifecycle candidates --json
openclaw hybrid-mem memory-lifecycle demote <factId> --reason "stale"
openclaw hybrid-mem attention rank --scope workspace --json
openclaw hybrid-mem runway --json
openclaw hybrid-mem loom brief --scope "Doris M365 auth" --format md
openclaw hybrid-mem loom report --format html --output ./loom-report.html
openclaw hybrid-mem loom maintenance --json                   # run the nightly upkeep (stale-claim sweep + drift scan) on demand
openclaw hybrid-mem procedures triage --batch 20 --json   # (#2147, extends the existing procedure CLI)
```

### Nightly maintenance

The Loom registers a `loom-maintenance` step in the standard maintenance orchestrator (nightly tier). Each night it runs the belief **stale-claim sweep** (degrading `verified`/`believed` claims past `loom.beliefs.staleAfterDays` to `stale`) and a **drift scan** over facts (deprecated commands + unresolved contradictions), recording findings for later review. It is **report-only** by default — it never rewrites fact text unless `loom.maintenance.applySafeDrift` is set. Gated on `loom.maintenance.enabled` (which follows `loom.enabled`). Run it on demand with `hybrid-mem loom maintenance`, or run just the sweep with `hybrid-mem belief sweep-stale`.

`memory-lifecycle` (not `lifecycle`) is used for the CLI group because `lifecycle` is already the GitHub-sync-adapters command group (#1196).

## Config

```jsonc
{
  "loom": {
    "enabled": true,
    "evidence": { "redactSecrets": true, "rejectUnredactable": true },
    "beliefs": { "staleAfterDays": 30 },
    "liveChecks": { "defaultTtlHours": 24 },
    "openLoops": { "defaultResurfaceDays": 7 },
    "drift": { "deprecatedCommands": { "old-cmd": "new-cmd" } },
    "lifecycle": { "staleAfterDays": 45, "requireStrongConfirmForVerified": true },
    "attention": { "defaultLimit": 20 },
    "runway": { "maxItemsPerSection": 8 },
    "brief": { "maxChars": 4000 },
    "report": { "maxItemsPerSection": 10 },
    "procedureTriage": { "defaultBatchSize": 20 },
    "maintenance": { "applySafeDrift": false }
  }
}
```

Every section's `enabled` key defaults to the top-level `loom.enabled` value (which itself defaults to `true`), so an empty `{}` (or no `loom` key at all) turns on everything; set the top-level `loom.enabled: false` to disable the whole subsystem, or an individual section's `enabled: false` to opt one slice back out.

## End-to-end flow

1. `memory_evidence_capsule_create` — record what was checked (redacted automatically).
2. `memory_belief_assert` (citing the capsule, optionally `live_check_required: true`).
3. `memory_loop_create` for anything still open.
4. `memory_loom_brief` / `memory_runway` before the next action — separates memory from proof.
5. `memory_drift_scout` to catch stale instructions.
6. `memory_loop_close` (with evidence, if `evidenceRequired`).

This flow is exercised end-to-end in `tests/loom-tools.test.ts`.
