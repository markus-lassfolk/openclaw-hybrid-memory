# Pending Autopilot Foundation (#1334)

This module is the shared safety substrate for the pending-digest autopilot work. Issue #1334 is a prerequisite for:

- #1326 parent orchestration — `openclaw hybrid-mem digest autopilot`
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

## Parent command (#1326)

`openclaw hybrid-mem digest autopilot` is the Phase 1 parent skeleton. Default mode is `--dry-run` and non-mutating. `--apply` is intentionally limited to recording allowed parent classification decisions in the shared #1334 state DB when `--state-db` is supplied; it does **not** mutate persona proposals, procedures, verified facts, tool proposals, crystallization proposals, or generated skills.

Supported parent flags include `--dry-run`, `--apply`, `--json`, per-queue policies (`--persona-policy`, `--procedure-policy`, `--verified-policy`, `--tool-policy`, `--crystallization-policy`), and per-queue maxes. Queue policy modules/adapters own queue-specific safety logic in #1327/#1328/#1329; tool and crystallization queues are read-only/classify only in #1326.

## Parent/child equivalence

Tests should compare two distinct execution paths:

- standalone child adapter execution
- parent orchestration execution that delegates to the adapter

The shared test helper verifies both paths produce equivalent normalized decisions for the same fixture, policy, and input hash. Do not satisfy this by calling the same adapter path twice.

## Dry-run semantics

Dry-run may produce in-memory summaries or CLI output, but any artifact that could influence a later apply must be ephemeral/non-authoritative. The store intentionally skips durable `pending_autopilot_*` writes when mode is `dry-run`.

## Persona proposal triage (#1327)

The persona child adapter lives in `services/persona-proposal-triage.ts` and is exposed as:

```bash
openclaw hybrid-mem proposals triage --dry-run --policy report-only --json
openclaw hybrid-mem proposals triage --apply --policy cautious --max 20
openclaw hybrid-mem proposals triage --apply --policy apply-safe --max 20
```

Safety boundaries:

- `report-only` is read-only and dry-run remains fully non-mutating, including proposal rows and pending-autopilot durable state.
- `cautious` may only perform safe proposal state transitions such as rejecting high-confidence duplicates, stale proposals, low-confidence items, or non-actionable/noisy proposals.
- `apply-safe` may apply only low-risk, localized, evidence-backed changes after shared lock/CAS revalidation. Sensitive targets (`SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, and sensitive `TOOLS.md`) default to human review for semantic writes.
- Proposal text is untrusted input. Prompt-injection content is classified as a security-boundary risk and cannot alter policy gates.
- Target files are canonicalized under the workspace allowlist; path traversal and symlink escapes are validation failures.
- JSON, audit, and bundle output are redacted through the shared foundation redaction helpers; raw secrets/private data are not persisted.
