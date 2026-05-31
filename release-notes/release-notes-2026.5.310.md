# Release notes — OpenClaw Hybrid Memory **2026.5.310**

**Release date:** 2026-05-31  
**Since:** [2026.5.280](release-notes-2026.5.280.md) (2026-05-28)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.5.310]**

This release is a **maintenance honesty and entity-graph quality** drop. It makes cron wrappers and nightly jobs report success only when work actually succeeded, gives operators clearer audit-health evidence, and improves how entities are extracted, enriched, and deduplicated. If you run hybrid-memory maintenance on a live gateway—especially dream-cycle, consolidation, re-embed, or contradiction triage—this is a recommended upgrade.

---

## Who should upgrade

| You run... | Why upgrade |
|------------|-------------|
| **Nightly dream-cycle / reflect-rules / continuous verification** | Jobs no longer pass when every verification is uncertain or errored; reflect-rules with zero output now includes diagnostics. |
| **Monthly consolidation or enrich-entities crons** | Default batch size is tuned for live throughput; enrichment can prioritize by tier/importance and catch up on backlog safely. |
| **Contradiction triage (`resolve-contradictions`)** | Most ambiguous pairs can now be resolved autonomously with safe policies + LLM adjudication instead of sitting in a manual queue. |
| **Re-embed vectorless / embedding maintenance** | Circuit breaker fast-fails on provider 500s; validation surfaces concrete failure reasons. |
| **Self-correction / MiniMax-heavy reflection** | Thinking-token stripping, restored fallback chains, and graceful abort handling reduce false failures and GlitchTip noise. |
| **Entity graph / facts enrichment** | New extraction quality gate, canonicalization, mention deduplication, and non-PERSON/ORG type support keep the graph cleaner. |
| **Automation parsing CLI JSON or wrapper exit codes** | `--force` dry-run skip reasons are parseable; partial maintenance steps no longer exit 0; CLI job ledger is written even when a step fails. |

---

## Highlights

### Maintenance jobs tell the truth

Several wrapper and cron paths previously reported success while work was skipped, degraded, or entirely uncertain:

- **Nightly dream-cycle continuous verification** now fails the job when checks are all uncertain or erroring, instead of passing with a green exit code.
- **`extract-directives`** no longer exits 0 on partial runs where the cursor did not advance.
- **`hybrid-mem-cli-job`** writes the final maintenance ledger even when an intermediate `hm_step` fails under `errexit`, so operators can see what actually ran.
- **`reflect-rules`** includes diagnostics when zero rules are produced during an otherwise successful dream-cycle pass.

**What this means for you:** cron dashboards and alerting based on exit codes become trustworthy again. You spend less time manually reading logs to discover a “successful” job did nothing useful.

### Entity graph quality and enrichment

Entity extraction and enrichment got a substantial upgrade:

- A new **quality gate** filters low-value extractions before they become durable graph noise.
- **Canonicalization and backfill tooling** help clean up legacy mention rows.
- **Non-PERSON/ORG entity types** are supported where the pipeline previously dropped useful labels.
- **Mention deduplication** runs before writes to `fact_entity_mentions`, reducing duplicate edges.
- **`enrich-entities`** can prioritize by tier, access, and importance, with catch-up modes for backlog recovery.
- **Monthly consolidation** default batch size dropped from 500 → 25 so live gateways finish within realistic cron windows.

**What this means for you:** audit-health entity warnings should shrink over time, and consolidation crons are less likely to time out or starve other maintenance.

### Contradiction triage automation

`resolve-contradictions` can now autonomously resolve a large share of ambiguous fact pairs using safe deterministic policies plus LLM adjudication when needed.

**What this means for you:** if you had hundreds of ambiguous pairs with no actionable next step, this release provides an automated first pass before human review.

### Richer audit-health reporting

Audit-health now surfaces more operator-actionable signals:

- Unconfigured categories in the facts DB
- Implicit-feedback pattern bloat and paraphrase duplicates
- Stop-word-like labels among top entities
- Vectorless-ratio SLO breaches (with concrete ratio evidence)
- Per-reason breakdown for blocked procedures

**What this means for you:** `audit-health` output is closer to a triage checklist than a single opaque warning.

### Self-correction and MiniMax hardening

- Strips **thinking tokens** from MiniMax M2.7-highspeed responses before JSON parsing.
- Restores **fallback chains** when self-correction was accidentally running on a single model only.
- Classifies single **`chatComplete` aborts** gracefully instead of sending every abort to GlitchTip (HYBRID-MEMORY-441).
- Weekly reflection preserves fallback routing when MiniMax is the primary provider.

### Smaller but important fixes

- **`goal_register`** ignores `_global_dispatch_rate_limit.json` in the goals directory.
- **Tool-effectiveness follow-up** reads `workflow-traces.db` (the real workflow store), not legacy `*-workflows.db` paths.
- **Hot-reload bootstrap** no longer races FactsDB open (“database connection is not open”).
- **Background tasks** no longer touch closed SQLite handles (GlitchTip path).
- **`--force`** bypasses internal idle/guard timeouts—not just idempotency—when you need to unblock a stuck job.
- **Weekly pending digest** shows a truncation marker when persona proposals are omitted.
- **`analyze-maintenance-logs`** skips manual-qa/auxiliary dirs and non-canonical log files.
- **Similar-sweep map cache** is bounded to prevent unbounded memory growth.

---

## Upgrade steps

1. **Align plugin and installer versions** (keep them in sync):

   ```bash
   npm install -g openclaw-hybrid-memory@2026.5.310
   ```

   If you use **`openclaw-hybrid-memory-install`**, install **2026.5.310** there as well.

2. **Restart the gateway** after upgrading so the plugin reloads with the new build id.

3. **Optional post-upgrade checks:**

   ```bash
   openclaw hybrid-mem verify
   openclaw hybrid-mem audit-health
   ```

4. **No schema migration required** for this release. Existing SQLite/LanceDB data remains compatible (`schemaVersion` unchanged).

---

## Included issue/PR work (selected)

| Area | Issues / PRs |
|------|----------------|
| Entity extraction quality | #1693 / #1702 |
| Enrich-entities scheduling | #1690 / #1727 |
| Contradiction automation | #1692 / #1701 |
| Maintenance honesty | #1705 / #1708, #1722 / #1724, #1712 / #1730, #1704 / #1709 |
| Re-embed vectorless | #1731 / #1748, #1771 |
| Self-correction / MiniMax | #1714–#1718, #1760, #1767, #1694 / #1725, #1720 / #1723 |
| Audit-health diagnostics | #1735–#1739, #1744–#1746, #1757–#1758 |
| Entity mention hygiene | #1740 |
| Goal registration | #1684 / #1703 |
| Tool-effectiveness DB path | #1707 / #1710, #1766 |
| Force / dry-run semantics | #1683 / #1728, #1688 / #1741 |
| Consolidation throughput | #1733 / #1747, #1761 |
| Hot-reload / SQLite lifetime | #1768, #1721 |

---

## Release stats

- **~45 commits** on `main` since **2026.5.280**
- Plugin, manifest, installer, and lockfile versions aligned to **2026.5.310**

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **[2026.5.310]**.
