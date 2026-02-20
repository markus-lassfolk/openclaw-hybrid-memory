# Self-Correction Analysis — Status & Implementation Plan

**Issue:** [Feature: Nightly Self-Correction Analysis — Automated Failure Detection & Remediation #34](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/34)

**Last updated:** 2026-02-18

---

## Current status: **Implemented (multi-language)**

The pipeline is implemented in the **memory-hybrid** extension with **multi-language support** via `.language-keywords.json` (see **`openclaw hybrid-mem build-languages`**).

| Component | Status |
|-----------|--------|
| **Phase 1: Extract** | ✅ `openclaw hybrid-mem self-correction-extract` — uses merged correction signals (English + translated from `.language-keywords.json`) |
| **Phase 2: Analyse** | ✅ Prompt `self-correction-analyze.txt`; LLM via `self-correction-run` |
| **Phase 3: Remediate** | ✅ MEMORY_STORE + TOOLS.md append (cap 5); AGENTS/SKILL as proposals only |
| **Phase 4: Report** | ✅ `memory/reports/self-correction-YYYY-MM-DD.md` |
| **Protocol doc** | ✅ [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md) |
| **Cron job** | Optional — add to OpenClaw jobs; see pipeline doc |
| **Tests** | ✅ Extract (`self-correction-extract.test.ts`), TOOLS section (`tools-md-section.test.ts`), config (`config.test.ts` for `selfCorrection`) |
| **Semantic dedup** | ✅ Optional (default on): skip MEMORY_STORE when embedding similarity ≥ threshold (config `selfCorrection.semanticDedup`, `semanticDedupThreshold`). |
| **TOOLS sectioning** | ✅ Rules inserted under configurable section (e.g. “Self-correction rules”), not appended at end. Dedup within section. |
| **Auto-rewrite vs approve** | ✅ Default: suggest TOOLS rules in report; apply with `--approve`. Opt-in `autoRewriteTools: true`: LLM rewrites TOOLS.md to integrate new rules (no duplicates/contradictions). |
| **Phase 2 via spawn** | ✅ Optional: `analyzeViaSpawn: true` + `spawnThreshold` → Phase 2 runs via `openclaw sessions spawn` (e.g. Gemini) for large batches. |

**Multi-language:** Run **`openclaw hybrid-mem build-languages`** once (or when you add languages). Correction phrases are translated into your top languages so detection works in all of them.

---

## Implementation checklist (done)

1. **Phase 1 — Extract** ✅  
   Implemented in `services/self-correction-extract.ts`; CLI `self-correction-extract`. Uses `getCorrectionSignalRegex()` (English + `.language-keywords.json` translations). Skip filters applied.

2. **Phase 2 — Analyse** ✅  
   Prompt `prompts/self-correction-analyze.txt`; invoked inside `self-correction-run` with configurable model.

3. **Phase 3 — Remediate** ✅  
   MEMORY_STORE (with dedup), TOOLS_RULE (append-only), AGENTS_RULE/SKILL_UPDATE as proposals; cap 5.

4. **Phase 4 — Report** ✅  
   Written to `memory/reports/self-correction-YYYY-MM-DD.md`.

5. **Documentation** ✅  
   [SELF-CORRECTION-PIPELINE.md](SELF-CORRECTION-PIPELINE.md) — protocol and multi-language usage. Cron job is optional (user/add-on).

6. **Tests** ✅  
   `self-correction-extract.test.ts` — extraction and skip filters.

---

## Success criteria (from issue)

- Detects ≥80% of user corrections within 24 hours.
- Auto-remediates ≥50% of detected issues (memory stores + TOOLS rules).
- Reduces repeat corrections by ≥60% over 30 days.
- False positive rate &lt;20%.

---

## References

- [GitHub issue #34: Nightly Self-Correction Analysis](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/34)
- Related: [Procedural Memory #23](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/23) (stores learned procedures; this pipeline *discovers* what to learn).
- Manual analysis: `memory/reports/maeve-failure-analysis-v2-2026-02-18.md` (if present in workspace).
- Raw extracts POC: `memory/reports/correction-extracts-raw.md` (if present).
