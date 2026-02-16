# Feature Requests

Enhancements inspired by analysis of [virtual-context](https://github.com/virtual-context/virtual-context) — a context-window paging system for LLM agents. While their overall architecture solves a different problem (infinite single-session context) than ours (persistent cross-session knowledge), two ideas translate well to our hybrid memory model.

See full comparison: [virtual-context-vs-hybrid-memory analysis](../../.openclaw/workspace/memory/technical/virtual-context-vs-hybrid-memory.md)

---

## FR-001: Auto-Tagging on Fact Capture

**Inspired by:** virtual-context's automatic topic tagging system, which tags every conversation turn with topics (e.g., `#auth`, `#zigbee`, `#nibe`) using a lightweight classifier.

**Problem:**
Our facts are categorised manually via the `category` field in `memory_store` (e.g., `preference`, `fact`, `technical`). These categories are broad — a query for "NIBE heat pump settings" relies entirely on vector similarity and FTS5 keyword matching. There's no structured topic index.

**Proposal:**
Add an auto-tagging enrichment step to the `memory_store` pipeline:

1. When a fact is stored, run a lightweight classifier (regex patterns for known domains + optional cheap LLM call) to extract topic tags.
2. Store tags in a new `tags` column in the SQLite facts table (comma-separated or JSON array).
3. On recall, support tag-filtered queries: "give me everything tagged `#nibe`" alongside existing vector + FTS5 search.
4. Optionally expose a `memory_recall(tag="nibe")` parameter.

**Expected benefit:**
- Sharper retrieval — topic filtering before vector ranking reduces noise
- Zero manual effort — tags are inferred at write time
- Cheap — regex handles 80% of cases; LLM fallback only for ambiguous facts

**Complexity:** Low-Medium
**Priority:** Medium

---

## FR-002: Compaction-to-File Summarisation

**Inspired by:** virtual-context's recursive summarisation engine, which compresses old conversation segments into summaries instead of discarding them during context window management.

**Problem:**
When OpenClaw's context window fills up during a long main session, the standard behaviour is sliding-window truncation — old turns are simply dropped. Any context in those evicted turns is lost unless it was explicitly saved via `memory_store` or written to a file. This creates a silent knowledge gap.

**Proposal:**
Add a compaction hook that fires *before* OpenClaw truncates the context window:

1. Detect when compaction/truncation is about to occur (hook into OpenClaw's `compaction.memoryFlush` or equivalent event).
2. Summarise the turns being evicted (using a cheap model like `gpt-4o-mini` or the current session model).
3. Append the summary to the daily notes file (`memory/YYYY-MM-DD.md`) with a timestamp and session identifier.
4. Optionally extract any explicit facts from the evicted turns and auto-store them via `memory_store`.

**Expected benefit:**
- No more silent context loss during long debugging/research sessions
- Daily notes become a richer automatic journal, not just manually-written entries
- Facts mentioned in passing (but never explicitly stored) get a second chance at capture

**Complexity:** Medium-High (requires hooking into OpenClaw's compaction lifecycle)
**Priority:** Low-Medium (our aggressive delegation pattern means main sessions rarely hit compaction, but sub-agents doing long coding tasks would benefit)

---

## FR-003: Source Date Column for Facts

**Inspired by:** Session log distillation project — extracting historical facts from conversation logs.

**Problem:**
Our SQLite facts table has no `source_date` field. When we store a fact, the only timestamp is the insertion time. For facts mined from historical session logs, this means a fact from January 2026 would appear to be from February 2026 (when it was extracted). This breaks time-based conflict resolution and makes provenance tracking unreliable.

**Current workaround:**
Prefix fact text with a date tag: `[2026-01-15] Markus switched from X to Y`. This is fragile and not queryable.

**Proposal:**
1. Add a `source_date` column (ISO-8601 timestamp) to the SQLite facts table.
2. Default to insertion time when not provided.
3. Accept an optional `sourceDate` parameter in `memory_store`.
4. On recall, expose `source_date` in results for conflict resolution.
5. When two facts contradict, prefer the one with the newer `source_date`.

**Expected benefit:**
- Accurate provenance for all facts, whether captured live or mined from history
- Enables time-aware deduplication ("this fact is newer, so it wins")
- Critical for the session log distillation pipeline

**Complexity:** Low (schema migration + one new parameter)
**Priority:** High (blocks clean historical fact extraction)

---

## Attribution

Both feature requests are inspired by concepts from the [virtual-context](https://github.com/virtual-context/virtual-context) project. Their approach to automatic tagging and recursive summarisation is excellent — we're adapting the ideas to fit our hybrid (SQLite + LanceDB + Markdown) architecture rather than their conversation-segment model.
