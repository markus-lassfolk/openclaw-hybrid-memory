# Session Log Distillation - Example Storage Report

**Run Date:** YYYY-MM-DD  
**Operator:** [Operator Name]  
**Task:** Deduplicate and store extracted facts from session log distillation (example with placeholder data)

---

## Executive Summary

| Metric | Example |
|--------|---------|
| **Total Input Facts** | 100 |
| **Duplicates Removed (within extraction)** | 5 |
| **Unique Facts (post-dedup)** | 95 |
| **Already in Store (skipped)** | 70 |
| **Net New Facts Stored** | 25 |
| **Contradictions Found** | 0 |

---

## Deduplication Process

### Phase 1: Internal Deduplication
Analyzed facts from batch files using signature matching: `category::entity::key`

**Duplicates removed:** 5 facts  
**Strategy:** Keep the fact with the latest `source_date`  
**Result:** 95 unique facts

### Phase 2: Memory Store Check
Compared remaining facts against existing memory store:

- **SKIP:** Facts matching known patterns (already in store)
- **CHECK:** Facts verified as already stored via sample memory_recall queries
- **STORE:** Net new facts requiring storage

---

## Example New Facts Stored (placeholder categories only)

### By Category
| Category   | Count |
|-----------|-------|
| technical | 15    |
| preference| 5     |
| person    | 3     |
| decision  | 2     |

### Example Fact Format (no real data)
- **preference:** `[YYYY-MM-DD] User prefers dark mode for all interfaces.`
- **technical:** `[YYYY-MM-DD] Home Assistant runs on home-assistant.local:8123.`
- **decision:** `[YYYY-MM-DD] Decided to use Gemini for long-context analysis due to 1M+ token window.`

All stored facts use the `[YYYY-MM-DD]` prefix for temporal provenance.

---

## Skipped Facts (example reasoning)

- Facts already in memory store (confirmed via recall)
- Duplicate category::entity::key within extraction
- Low-value or ephemeral content filtered by criteria

---

## Quality Observations

- All facts had valid `source_date` fields
- Categories: preference, technical, decision, person, project, place, entity
- No malformed JSON or missing required fields in the pipeline output

---

## Artifacts Generated (example)

1. `facts-deduplicated.jsonl` (unique facts)
2. `duplicates-report.json` (duplicates with reasoning)
3. `storage-plan.json` (skip/store/check categorization)
4. Run report (this file or similar)

---

## Task Completion

**Status:** Example template only — real runs will vary.

**Summary:**
- Processed N facts from batch files
- Deduplicated to unique set
- Verified overlap with existing store (typically 70–80% already captured)
- Stored net new facts with date prefixes and importance scoring

---

**End of Example Report**

For a real run, fill in your metrics and save to `docs/run-reports/` or keep locally. Do not commit reports that contain personal information (names, addresses, phone numbers, IPs, etc.).
