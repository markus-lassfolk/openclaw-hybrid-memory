# Self-Correction Analysis (Issue #34) — Status & Implementation Plan

**Issue:** [Feature: Nightly Self-Correction Analysis — Automated Failure Detection & Remediation #34](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/34)

**Last checked:** 2026-02-18

---

## Current status: **Not implemented**

The nightly self-correction pipeline (extract → analyse → remediate → report) is **not** present in the repo. Session distillation and procedural memory are separate features and do not implement user-correction detection or TOOLS.md/AGENTS.md remediation.

---

## What exists vs what’s missing

| Component | Issue #34 spec | In repo |
|-----------|----------------|--------|
| **Phase 1: Extract** | `scripts/self-correction/extract.py` — regex on user messages, output structured extract | ❌ No `scripts/self-correction/` |
| **Phase 2: Analyse** | `scripts/self-correction/analyze-prompt.md` — LLM (Gemini) for category, severity, remediation type | ❌ Missing |
| **Phase 3: Remediate** | Auto memory_store, append TOOLS.md, propose AGENTS/SKILL, guardrails | ❌ Missing |
| **Phase 4: Report** | Summary to user channel (e.g. `memory/reports/self-correction-YYYY-MM-DD.md`) | ❌ Missing |
| **Protocol doc** | `memory/technical/self-correction-pipeline.md` | ❌ Missing |
| **Cron job** | “Self-Correction Analysis” at 02:30 Europe/Stockholm, payload per issue | ❌ Only `nightly-memory-sweep` (distillation) and `weekly-reflection` exist |
| **Tests** | Unit/integration for extract + remediate | ❌ No self-correction tests |

**Related but different:**

- **Session distillation** (`openclaw hybrid-mem distill`, `scripts/distill-sessions/`) — extracts *facts* from session logs; does not detect correction phrases or remediate TOOLS/AGENTS.
- **Procedural memory** (`extract-procedures`, PROCEDURAL-MEMORY.md) — learns from *tool-call sequences*; does not use user correction patterns.
- **nightly-memory-sweep** — runs session distillation, not self-correction analysis.

---

## Implementation plan (checklist)

1. **Phase 1 — Extract**
   - [ ] Add `scripts/self-correction/` directory.
   - [ ] Implement extract script (Python or Node): scan last 3 days of session JSONL, `type: "message"`, `role: "user"`.
   - [ ] Apply issue’s regex correction patterns (and skip filters: heartbeat, cron definitions, system, pre-compaction, sub-agent).
   - [ ] For each match: user message (≤800 chars), preceding assistant (≤500), following assistant (≤500), timestamp, session file.
   - [ ] Output structured extract (JSON or Markdown) for Phase 2.

2. **Phase 2 — Analyse**
   - [ ] Add `scripts/self-correction/analyze-prompt.md` with the issue’s analyst prompt (categories, severity, remediation type/content, dedup).
   - [ ] Wire to LLM (Gemini recommended): feed extract, get JSON array of analysed incidents.

3. **Phase 3 — Remediate**
   - [ ] MEMORY_STORE: call memory_store with provided text/entity/tags; dedup against existing memories (e.g. semantic search).
   - [ ] TOOLS_RULE: append-only to TOOLS.md under appropriate section.
   - [ ] AGENTS_RULE / SKILL_UPDATE: produce proposals only, notify user (no auto-apply).
   - [ ] Guardrails: cap 5 remediations per run; never delete/overwrite; log to `memory/reports/self-correction-YYYY-MM-DD.md`.

4. **Phase 4 — Report**
   - [ ] Generate short summary (scanned sessions, incidents found, auto-fixed count, needs-review count, skipped).
   - [ ] Write report to `memory/reports/self-correction-YYYY-MM-DD.md` and deliver to user’s channel (per OpenClaw job config).

5. **Documentation & automation**
   - [ ] Add `memory/technical/self-correction-pipeline.md` (or equivalent under `docs/`) with full protocol for the cron agent.
   - [ ] Add “Self-Correction Analysis” job to install/snippet (schedule `30 2 * * *`, Europe/Stockholm; payload as in issue; `sessionTarget: isolated`, Sonnet for execution, Gemini for Phase 2).

6. **Tests**
   - [ ] Tests for Phase 1: sample JSONL → correct extraction and no false positives on skip filters.
   - [ ] Tests for Phase 3: append-only TOOLS.md, cap, dedup behaviour (mocked memory_store/recall).

---

## Success criteria (from issue)

- Detects ≥80% of user corrections within 24 hours.
- Auto-remediates ≥50% of detected issues (memory stores + TOOLS rules).
- Reduces repeat corrections by ≥60% over 30 days.
- False positive rate &lt;20%.

---

## References

- Issue #34: [Feature: Nightly Self-Correction Analysis](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/34)
- Related: [Procedural Memory #23](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/23) (stores learned procedures; this pipeline *discovers* what to learn).
- Manual analysis: `memory/reports/maeve-failure-analysis-v2-2026-02-18.md` (if present in workspace).
- Raw extracts POC: `memory/reports/correction-extracts-raw.md` (if present).
