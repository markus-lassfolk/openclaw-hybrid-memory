# Release v2026.7.219

This release closes out nine open issues surfaced by live production hosts (Maeve/Doris): three related cron-harness/maintenance-analyzer incidents from the same overnight run, three memory-health/graph data-quality issues, and two installer/upgrade-safety issues. Each is fixed at the root cause with regression tests.

## Fixed — Cron harness & maintenance observability

- **`validate-cron-exit --json` produced unparseable validation JSON** (#2133) — the OpenClaw host prints plugin bootstrap logs to stdout before this plugin's own code runs, so no in-process stdout patch can keep them out of `--json` output. `validate-cron-exit` gains `--output-json <path>`, which writes the JSON payload directly to a file via `fs`, bypassing stdout entirely. The cron harness now uses it when capturing `HM_VALIDATION_JSON`, so the artifact is parseable from byte 0 regardless of host bootstrap noise.
- **Cron harness could leave a truly zero-byte `.log` + `.exit.txt` pair** (#2131) — a run killed between artifact creation and the first trap left no diagnostics at all. The harness now writes a durable `harness-bootstrap` marker to both files immediately after they're created. The analyzer recognizes a ledger containing only that marker (once stale) as a specific `orchestration-bootstrap-only-exit` finding instead of the generic empty-exit class, and never flags a fresh (still-in-progress) run.
- **`maintenance-log-analyzer` recursively failed on its own prior-run artifacts** (#2132) — once one analyzer run strict-failed while reporting a root cause, the next run rescanned that run's own exit-ledger rows as fresh findings, compounding daily. The analyzer now suppresses its own job's self-referential rows unless something else already classified them as a genuine crash or orchestration bug — the root finding is still reported once, not recursively re-derived.

## Fixed — Memory health & graph

- **`memory_health` reported an impossible far-future "Last prune" timestamp** (#2129) — a millisecond-scale value stored where seconds were expected got multiplied by 1000 again. `formatTimestampUtc`/`formatDateUtc` now self-correct a ms-scale input (mirroring the existing `parseTimestamp` guard), and `memory_health` additionally reports `invalid (corrupt stored value: N)` instead of ever displaying a fabricated date.
- **`/api/graph` returned nodes but zero edges despite thousands of explicit links** (#2126) — the endpoint sampled the most-recent N facts as nodes, then only kept edges between sampled nodes; on an append-heavy corpus that's routinely empty, since recent facts are rarely linked to each other yet. The default view now reserves budget for the seed facts' direct link-neighbors (`mode=recent` preserves the old behavior for callers that want it) and fetches edges via a new store method scoped directly to the selected node set. The payload also gains a `coverage` block and a per-edge `layer` field (#2128) so a sampled subgraph is never mistaken for "the whole graph is disconnected."
- **Memory graph under-linked: ~88% of active facts had no explicit link** (#2127) — new bounded, dry-run-by-default `openclaw hybrid-mem maintenance graph-link-enrichment [--apply] [--limit N]` promotes an already-computed deterministic signal (shared `provenance_json.sourceEventIds`) into explicit `RELATED_TO` links for orphan facts, without inventing any new similarity judgment and without ever touching a fact that already has a link. `memory_health` now reports `orphanRate` and warns above 70%.

## Fixed — Installer & upgrade safety

- **Duplicate-install cleanup missed stale root/nested copies** (#2125) — extends the #2117 reconcile logic, which only ever compared `extensions/` against the managed `npm/projects/` copy, to also detect and quarantine (move, never delete) a stale root `~/.openclaw/node_modules/<id>` copy and an accidental nested `~/.openclaw/.openclaw/...` state-dir copy. `doctor` and `verify --fix` both pick this up.
- **Live upgrade could mutate the active package path underneath a running gateway** (#2130) — `scripts/post-upgrade.sh` and `scripts/upgrade-plugin-manual.sh` (this plugin's own shipped upgrade helpers) could mutate/replace the live plugin directory while the gateway was still running, risking a transient `ERR_MODULE_NOT_FOUND` on a lazy import. Both now build/install the new version before stopping the gateway and swapping it in, and the manual script preserves the previous version as a timestamped backup.

## Notes

- No `schemaVersion` bump — no storage-schema changes.
- No agent-tool contract changes.
- The managed `~/.openclaw/npm/projects/<id>` upgrade path itself is driven by OpenClaw core's own plugin manager, not this plugin's scripts — #2130's fix covers this plugin's own shipped upgrade helpers only.
