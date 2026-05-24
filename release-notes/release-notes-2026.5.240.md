# Release notes - OpenClaw Hybrid Memory **2026.5.240**

**Release date:** 2026-05-24  
**Since:** [2026.5.190](release-notes-2026.5.190.md) (2026-05-19)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) - section **[2026.5.240]**

This is a reliability release for active-task state convergence, memory safety, JSON/stdout hygiene, and operational diagnostics. The headline fix is that active tasks can now converge from live GitHub issue/PR state during normal stewardship instead of waiting for a later deep verification pass.

---

## Who should upgrade

| You run... | Why upgrade |
|----------|-------------|
| **Active tasks / goal stewardship** | Fixes stale task rows, deterministic fact selection, and live GitHub reconciliation for closed issues and merged PRs. |
| **Automation that parses JSON output** | Human diagnostics are kept off stdout in the fixed tee path. |
| **Memory auto-capture / fallback storage** | Stronger guards prevent credentials, NOOP/classification artifacts, and prompt-injection-like recalled content from becoming durable memory. |
| **Production hybrid-memory installs** | WAL, FTS, SQLite handle, pending error, and memory-pressure diagnostics are safer and easier to inspect. |
| **Maintainers reviewing frequent PRs** | Core module split and active-task instrumentation make future repair PRs smaller and easier to verify. |

---

## Highlights

### Active tasks now converge more reliably

The active-task ledger had two separate problems:

1. When multiple project facts landed in the same timestamp bucket, the renderer could keep an older in-progress status while showing newer evidence that the task was already closed.
2. Normal stewardship could observe that GitHub issues/PRs were closed, but the active-task projection might not refresh until a deeper verification pass.

This release fixes both.

- Same-timestamp task facts now use deterministic tie-breaks and prefer terminal status where appropriate.
- Live-state reconciliation can check referenced GitHub issues and PRs during normal render/hygiene flows.
- Terminal live state, such as a closed issue or merged PR, can checkpoint the task as done with evidence in the task next/updated fields.
- The reconciliation is bounded and failure-tolerant, so missing GitHub auth or request-budget exhaustion does not break projection.

### Safer memory intake

Several capture paths were tightened:

- Credential-looking data no longer falls back into normal memory storage.
- credential_get secrets are redacted from normal tool content.
- NOOP notes, classification decisions, and generated artifacts are guarded before storage.
- memory_store validates input before WAL, embedding, or DB side effects.
- Recalled memory blocks are hardened so retrieved text is treated as context data, not instructions.

### Better operator diagnostics

Operators get more direct evidence when state drifts:

- Memory pressure snapshots for recall-budget and vector/native-memory investigations.
- FTS doctor consistency checks and safer verified-reconcile delete confirmation.
- Active-task selection instrumentation and context-audit visibility.
- Pending error reports are persisted and WAL initialization failures are surfaced more clearly.

### CLI and automation fixes

- JSON mode avoids stdout pollution from tee output.
- Active-task injection filters stale rows and requires real active-task status facts.
- PR hygiene checks live review threads before marking PRs waiting.
- Goal lifecycle finalization no longer crashes on incomplete subagent completion data.

---

## What changed by area

### Active tasks and goals

- Deterministic active-task fact grouping for same-timestamp updates ([#1624](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1624), [#1628](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1628)).
- Opt-in live GitHub issue/PR reconciliation for active tasks ([#1625](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1625), [#1628](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1628)).
- Active-task projection now skips stale rows, filters by active-task source, requires status facts, and canonicalizes labels.
- Goal lifecycle crash fixed in updateGoalOnSubagentEnd ([#1623](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1623)).

### Memory safety and context hygiene

- Capability hints are session-only by default ([#1604](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1604)).
- Universal NOOP/classification/artifact pre-store guards ([#1596](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1596), [#1610](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1610)).
- Credential-like fallback storage prevention and credential_get secret redaction ([#1591](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1591), [#1590](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1590)).
- Prompt-injection hardening for recalled memory blocks ([#1592](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1592)).
- Hot/progressive recall self-reinforcement fix ([#1595](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1595)).

### Storage and health

- WAL replay metadata, breaker persistence, health checks, and scoped-fact replay fixes.
- Pending error reports persist and WAL init failures are visible ([#1600](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1600)).
- FTS doctor consistency checks and verified reconcile delete confirmation ([#1601](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1601)).
- Duplicate SQLite handles after plugin re-registration are prevented ([#1564](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1564)).

### Diagnostics and maintainability

- Memory pressure snapshot for native/vector pressure and recall-budget investigations ([#1597](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1597)).
- Targeted project-fact query and context audit for active-task projection.
- Core module split to reduce conflict-prone maintenance work ([#1619](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1619)).
- Operator architecture map added ([#1599](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1599)).

### Dependencies

- qs bumped to 6.15.2.
- protobufjs bumped in the plugin dependency tree.

---

## Upgrade notes

1. Install the plugin at the matching version:

       npm install -g openclaw-hybrid-memory@2026.5.240

2. If you use the standalone installer, keep it aligned:

       npm install -g openclaw-hybrid-memory-install@2026.5.240

3. Live active-task reconciliation is designed to be bounded and safe. If GitHub auth is missing or a budget is exhausted, it should skip rather than fail the whole render/hygiene flow.

4. No manual schema migration is called out for this release.

---

## Verification performed before release

- PR #1628 was merged into main.
- Release prep updates plugin package, plugin manifest, installer package, and lockfile versions to **2026.5.240**.
- CI must pass on the release commit before publishing.

---

## Statistics

- **30 commits** since v2026.5.190
- **Date range:** 2026-05-19 to 2026-05-24
- **Headline PR:** [#1628](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1628)

---

## Changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** - section **[2026.5.240]**.
