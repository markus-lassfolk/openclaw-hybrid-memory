# Pending Autopilot Foundation (#1334)

This module is the shared safety substrate for the pending-digest autopilot work. Issue #1334 is a prerequisite for:

- #1326 parent orchestration
- #1327 persona queue adapter
- #1328 procedure/skill queue adapter
- #1329 verified-fact queue adapter
- #1330 cron wrapper and observability

Child, parent, and cron work must consume these contracts instead of defining bespoke action, capability, policy, cursor, lock, or audit models.

## Global invariants

- Deny by default.
- `dry-run` is non-mutating for durable foundation state. No run, decision, cursor, lock, or mutation rows are written in dry-run.
- Every persisted decision records queue, item id, input hash, policy, policy version, action, reason, capability, confidence, human-review flag, evidence, actor/run/job context, and timestamp.
- Durable summaries and audit payloads are redacted before persistence.
- Mutating paths must revalidate input hash and active lock ownership immediately before mutation.
- Mutation and audit write are transactional: if audit persistence fails, the mutation fails and rolls back.
- Cursors must not hide human-review-required, failed-validation, failed-audit, or unknown-decision items.
- Parent/child equivalence is required for queue adapters.
- Cron has no policy authority; it only invokes and observes the parent command.
- Trust-changing, external, destructive, credential-affecting, policy-broadening, or behaviour-enabling work requires explicit human approval.

## Capability boundaries

`--apply` is intent, not authority. Each planned action must map to one explicit capability level:

1. `read-only`
2. `dry-run`
3. `record-review-metadata`
4. `safe-state-transition`
5. `write-draft-artifact`
6. `apply-low-risk-change`
7. `enable-behaviour`
8. `trust-changing-action`
9. `external-side-effect`
10. `destructive-action`

Adapters may add queue-specific policy, but they must preserve these approval boundaries.

## Parent/child equivalence

Tests should compare two distinct execution paths:

- standalone child adapter execution
- parent orchestration execution that delegates to the adapter

The shared test helper verifies both paths produce equivalent normalized decisions for the same fixture, policy, and input hash. Do not satisfy this by calling the same adapter path twice.

## Dry-run semantics

Dry-run may produce in-memory summaries or CLI output, but any artifact that could influence a later apply must be ephemeral/non-authoritative. The store intentionally skips durable `pending_autopilot_*` writes when mode is `dry-run`.

## Verified-fact triage child adapter (#1329)

The verified-fact child adapter lives in `services/verified-fact-triage.ts` and reuses the shared
`PendingQueueAdapter` / `PendingDecision` contract from this foundation. Its review queue source is
explicit and intentionally narrow: **latest `verified_facts` rows due for reverification** according
to the same `next_verification`/staleness semantics used by `VerificationStore.listDueForReverification`.
Rows with checksum/canonical-text mismatches are filtered out before queueing to preserve integrity parity.
It must not accidentally treat every verified fact as pending review.

CLI surface:

```bash
openclaw hybrid-mem verified list --json
openclaw hybrid-mem verified triage --dry-run --policy report-only --max 100 --json
openclaw hybrid-mem verified triage --apply --policy classify --max 100 --json
openclaw hybrid-mem verified triage --apply --policy apply-obvious --max 100 --json
```

Safety boundaries:

- dry-run writes no durable pending-autopilot or verified-review state;
- apply policies record only non-destructive review/classification decisions in the shared
  pending-autopilot store;
- verified fact text, verification tier, critical status, canonical text, and core truth fields are
  never rewritten, deleted, or demoted by `apply-obvious`;
- sensitive credentials/security/privacy/persona/external-comms/operational-runbook facts are always
  deferred for human review;
- supersession requires an explicit newer fact id (`supersedes_id` / `superseded_by`) and matching
  scope;
- contradiction requires concrete structured evidence: same entity, scope, claim key/type, conflicting
  value, and source fact/verified ids. Semantic similarity or LLM judgment alone is not enough;
- provenance is preserved by appending/linking review metadata through pending-autopilot decisions
  rather than overwriting source or verification provenance.

Parent #1326 should call this adapter/policy logic for `digest-autopilot --verified-policy ...` rather
than implementing separate verified-fact semantics. Tests use the #1334 parent/child equivalence
harness so parent routing and standalone `verified triage` decisions stay identical.
