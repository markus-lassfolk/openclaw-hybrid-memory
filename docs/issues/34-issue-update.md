# Issue #34 — Status update (paste this as a comment on the issue)

## Verification (2026-02-18)

Checked the repo for full implementation, documentation, and tests.

**Result: Not implemented.**

---

### What was checked

| Component | Status |
|-----------|--------|
| **Phase 1** — `scripts/self-correction/extract.py` (regex extraction) | ❌ Not present. No `scripts/self-correction/` directory. |
| **Phase 2** — `scripts/self-correction/analyze-prompt.md` | ❌ Not present. |
| **Phase 3** — Remediation logic (memory_store, TOOLS.md append, proposals) | ❌ Not present. |
| **Phase 4** — Report generation + delivery | ❌ Not present. |
| **Protocol doc** — `memory/technical/self-correction-pipeline.md` | ❌ Not present. |
| **Cron job** — "Self-Correction Analysis" (02:30 Europe/Stockholm) | ❌ Not in `install-hybrid-config.mjs` or deploy snippet. Only `nightly-memory-sweep` (session distillation) and `weekly-reflection` exist. |
| **Tests** | ❌ No tests for self-correction extraction or remediation. |

**Related but different:** Session distillation (`openclaw hybrid-mem distill`, `scripts/distill-sessions/`) extracts *facts* from sessions and does not detect user correction phrases or remediate TOOLS/AGENTS. Procedural memory (issue #23) learns from *tool sequences*, not from correction signals.

---

### In-repo documentation

- **[docs/SELF-CORRECTION-ANALYSIS.md](../SELF-CORRECTION-ANALYSIS.md)** — Status, gap analysis (what exists vs missing), and implementation plan checklist. Use this as the single source of truth for implementation progress.

---

### Implementation plan (summary)

1. **Phase 1** — Add `scripts/self-correction/`, extract script (Python or Node), regex patterns and skip filters from issue, structured output.
2. **Phase 2** — Add `analyze-prompt.md`, wire to Gemini (or configured LLM) for category/severity/remediation type + content.
3. **Phase 3** — Implement remediators: MEMORY_STORE (with dedup), TOOLS_RULE (append-only), AGENTS_RULE/SKILL_UPDATE (propose only); guardrails (cap 5, no overwrite, log).
4. **Phase 4** — Report to `memory/reports/self-correction-YYYY-MM-DD.md` and user channel.
5. **Doc & cron** — Protocol in `memory/technical/self-correction-pipeline.md` (or docs), add Self-Correction Analysis job to install/snippet.
6. **Tests** — Phase 1 extraction tests, Phase 3 guardrail/dedup tests.

Full checklist and success criteria are in [docs/SELF-CORRECTION-ANALYSIS.md](../SELF-CORRECTION-ANALYSIS.md).

---

### Suggested issue labels

- **Status:** `not started` or `backlog`
- **Type:** `enhancement` / `feature`

---

*This update was generated from a repo scan. Update the issue description or add a "Status" section if you want the issue body to reflect "Not implemented" and link to docs/SELF-CORRECTION-ANALYSIS.md.*
