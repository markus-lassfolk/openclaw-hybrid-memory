# Release v2026.7.222

Implements **The Loom** (Epic #2150): an agent-native continuity, belief, evidence, and open-loop operating layer on top of hybrid-memory. The Loom helps an agent answer: *what do I believe, why do I believe it, how current is it, what evidence supports it, what remains open, and what must I verify before acting?*

Disabled by default (`loom.enabled: false`). See `docs/THE-LOOM.md` for the full data model, agent tools, CLI surface, and config reference.

## Added

- **Evidence capsules (#2148)** — `memory_evidence_capsule_create`/`_show`/`_attach`/`_list`, `hybrid-mem evidence create|attach|show|list`. Durable proof objects: what was checked, what changed, what remains unverified. Secret-like values are redacted before storage; capsule creation is refused (not silently redacted-and-stored) when content still looks unstrippable and `loom.evidence.rejectUnredactable` is true.
- **Belief graph / claim ledger (#2151)** — `memory_belief_assert`/`_get`/`_verify`/`_contradict`/`_supersede`/`_explain`, `hybrid-mem belief assert|get|verify|contradict|supersede|explain`. A claim is a justified, inspectable statement distinct from a raw recalled fact, with confidence, evidence citations, contradiction/supersession tracking, and automatic degradation to `stale` after `loom.beliefs.staleAfterDays`.
- **Live-check contracts (#2156)** — `memory_live_check_list`/`_satisfy`/`_require`, `hybrid-mem live-checks list|satisfy`. Claims can declare that mutable external state must be verified live before use; satisfaction expires after `loom.liveChecks.defaultTtlHours`.
- **Open-loop obligations ledger (#2152)** — `memory_loop_create`/`_list`/`_update`/`_close`, `hybrid-mem loops create|list|close|resurface`. Unfinished promises, blocked work, and unresolved incidents tracked independently of active tasks, with evidence-required closure and due-date resurfacing.
- **Drift scout (#2146)** — `memory_drift_scout`, `hybrid-mem drift scout`. Detects deprecated command references (via a configurable `loom.drift.deprecatedCommands` map) and unresolved fact contradictions. `--apply-safe` mechanically rewrites already-identified `auto_safe` deprecated-command findings only; everything else is report-only.
- **Memory lifecycle workflows (#2155)** — `memory_lifecycle_candidates`/`_update`, `hybrid-mem memory-lifecycle candidates|demote|archive|delete`. Report-only candidate detection (contradicted, superseded, exact-duplicate, stale/low-access, prompt-injection-like) plus demote/archive/quarantine/delete actions, all audited. Deleting a verified/critical fact requires an explicit strong-confirm token.
- **Attention steward (#2153)** — `memory_attention_rank`/`_update`, `hybrid-mem attention rank|demote|snooze`. Ranks claims, open loops, drift findings, and serendipity findings into actionable categories with reasons; snooze/demote overrides never delete provenance.
- **Loom brief (#2154)** — `memory_loom_brief`, `hybrid-mem loom brief`. A bounded, prompt-safe pre-action briefing for a free-text scope — every item labeled `memory`, `evidence`, `live_check_requirement`, or `recommendation` so an agent never confuses recalled context with proof.
- **Agent Runway API (#2145)** — `memory_runway`, `hybrid-mem runway`. The front door: active tasks read live from the facts ledger, active goals, fragile procedure surfaces, stale/contradicted high-importance-fact warnings, and a Loom summary — always carrying the "memory is context, not proof" warning.
- **Loom dashboard/report (#2157)** — `hybrid-mem loom report --format html|md`. Markdown/HTML report for human review: top attention items, open loops by status, stale/contradicted beliefs, recent evidence, drift findings, procedure promotion candidates, serendipity highlights, and lifecycle candidates — bounded, with stable IDs and follow-up commands.
- **Procedure refinery triage (#2147)** — extends the existing `hybrid-mem procedures …` CLI with ranked, clustered, deduplicated triage batches, existing-wrapper detection, and persisted no-action decisions so a 500+ item backlog becomes a small reviewable batch.
- **Serendipity inbox — Loom alignment (#2149)** — the existing Serendipity Protocol gains links into claims/open loops/drift findings, `leverage`/`riskReduction`/`timeSaved`/`cognitiveLoadReduction` scores, and an explicit `notAnActiveTask` flag (true until a finding is promoted) so the attention steward and runway summary automatically exclude findings that have already become real tracked work.

## Data model

One new SQLite store, `LoomStore` (`loom.db`), decomposed into `backends/loom/*` modules — one table per concept (evidence capsules, claims, live-check events, open loops, drift findings, attention overrides, lifecycle audit, procedure-triage decisions). `serendipity_findings` gains eight additive columns via a new migration (`ALTER TABLE … ADD COLUMN`).

24 new agent tools are registered (see `contracts/agent-tool-names.ts`); every one is gated behind `loom.enabled` (and, per-section, `loom.<section>.enabled`).

## Notes

- No `schemaVersion` bump — `LoomStore` is a new, separate database file; the `serendipity_findings` migration is additive-only and backward compatible.
- The lifecycle CLI group for this feature is named `memory-lifecycle`, not `lifecycle` — that name is already used by the GitHub-sync-adapters command group (#1196).
- Every new service and store ships with unit tests (`tests/loom-*.test.ts`, `tests/drift-scout.test.ts`, `tests/memory-lifecycle.test.ts`, `tests/attention-steward.test.ts`, `tests/agent-runway.test.ts`, `tests/procedure-triage.test.ts`, `tests/serendipity-loom-alignment.test.ts`), including an end-to-end flow test exercising evidence capsule → claim → live check → open loop → brief.
