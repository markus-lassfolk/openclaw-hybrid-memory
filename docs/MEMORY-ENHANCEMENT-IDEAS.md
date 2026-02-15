# Hybrid Memory Manager — Enhancement Ideas

**Purpose:** Concrete ideas to improve memory management, long-term and in-depth memory, and token usage. Each item can be implemented independently.

---

## 1. Reduce token count

### 1.1 Token cap on auto-recall injection

**Current:** Auto-recall injects up to 5 memories with full text and `[backend/category]` prefix; no token limit.

**Enhancement:** Add config (e.g. `autoRecall.maxTokens` default 600–800). When building `prependContext`, truncate or drop lowest-score memories until the injected block is under the cap. Optionally truncate each memory to a configurable max length (e.g. 120 chars) with "…" when over.

**Config sketch:**
```json
"autoRecall": {
  "maxTokens": 800,
  "maxPerMemoryChars": 200
}
```

**Files:** `config.ts` (add options), `index.ts` (before_agent_start: count/truncate before building `memoryContext`).

---

### 1.2 Shorter injection format

**Current:** Each memory is `- [sqlite/preference] User prefers dark mode.`

**Enhancement:** For auto-recall only, use a compact format to save tokens, e.g. `- preference: User prefers dark mode` or even `- User prefers dark mode`. Backend/category can stay in tool responses and logs. Make format configurable (full / short / minimal).

---

### 1.3 Honor `captureMaxChars` in auto-capture

**Current:** Docs mention `captureMaxChars` (e.g. 5000) but the plugin schema and code do not use it; `shouldCapture()` uses a hardcoded 500-char max.

**Enhancement:** Add `captureMaxChars` to config and schema; in `shouldCapture()` reject when `text.length > captureMaxChars`. Optionally truncate before store (e.g. store first `captureMaxChars` + " [truncated]") so long messages still produce one fact instead of being dropped.

**Files:** `config.ts`, `openclaw.plugin.json`, `index.ts` (`shouldCapture` and possibly store path).

---

### 1.4 Summarize when over token budget (optional LLM)

**Enhancement:** If after merging and sorting the top-N memories the total text still exceeds `autoRecall.maxTokens`, run an optional step: call a cheap LLM to summarize the list into 2–3 short sentences (e.g. "User prefers dark mode and Postgres. Key project: X. Recent decision: Y."). Use that as the single injected block. Only when `autoRecall.summarizeWhenOverBudget: true` and over cap.

**Implemented.** Config: `autoRecall.summarizeWhenOverBudget` (default false), `autoRecall.summarizeModel` (default gpt-4o-mini). When the token cap forces dropping candidates (`lines.length < candidates.length`), the plugin sends all candidate bullets to the LLM, gets 2–3 sentences, and injects that as the single block; on LLM failure it falls back to the truncated list.

---

## 2. Better memory management

### 2.1 Configurable auto-recall limit and min score

**Current:** FTS and vector each return 3, merge to 5; vector minScore 0.3 fixed.

**Enhancement:** Add `autoRecall.limit` (default 5) and `autoRecall.minScore` (default 0.3 for vector). Use these in the `before_agent_start` handler instead of literals. Lets users trade off relevance vs. number of memories.

---

### 2.2 Semantic deduplication at store (vector-based)

**Current:** `hasDuplicate` is exact text match in SQLite; vector DB uses embedding similarity (0.95). So two phrased-differently but semantically identical facts both get stored.

**Original enhancement idea:** Before storing, run vector search with a high similarity threshold (e.g. 0.92); if near-duplicate exists, skip store or update existing fact.

**Design considerations (revised approach):**

1. **Latency:** The store path already does one embedding call and one vector search (`hasDuplicate(vector, 0.95)`). Adding a *lower* threshold (0.92) doesn’t add extra round-trips. If we instead *merge* (fetch existing, update, delete new), we add DB and possibly sync work on every store, which can slow the hot path. So: *skip-if-duplicate* is low cost; *merge-at-store* is not recommended on the hot path.

2. **Similar but distinct data:** Embeddings can make two nearly identical strings (e.g. IPs `192.168.1.1` vs `192.168.1.2`, or two different emails) very close. Treating high similarity as “duplicate” and skipping or merging would be dangerous for identifiers, credentials, and any structured key/value. We must either **exclude** such content from semantic dedupe (e.g. never skip/merge when text or entity/key match IP, email, phone, UUID, API key patterns) or **avoid** semantic dedupe at store for those facts entirely.

3. **Defer to maintenance instead of at-store:** To avoid latency and catastrophic mix-ups:
   - **Do not** add semantic skip/merge on the store path for anything that could be an identifier.
   - **Do** keep the current strict vector `hasDuplicate(0.95)` as-is (or make threshold configurable for power users).
   - **Do** add a **maintenance path**: a CLI (e.g. `hybrid-mem find-duplicates [--threshold 0.92] [--include-structured] [--dry-run]`) and/or a scheduled job that:
     - Finds pairs/clusters of semantically similar facts (e.g. vector similarity ≥ threshold).
     - **By default skips** facts that look like identifiers (IP, email, phone, UUID, API key, etc.) and numbers in general, so they are never auto-merged. Use **`--include-structured`** to opt in to processing those too (opt-in for risk).
     - **Reports** candidate pairs for review, or merges only when a safe policy applies (e.g. same category + no structured content).
   - Optionally: during **search/recall**, detect “these two results are very similar” and **flag** them for a later maintenance/verification job instead of merging at store.

**Recommended implementation:** Skip semantic dedupe at store (or limit it to a configurable threshold with strict safeguards). Implement **2.2 as a maintenance feature**: `find-duplicates` CLI and/or daily job that outputs candidate pairs. By default skip identifier- and number-like facts; use `--include-structured` to process everything. Later optionally a “merge after verification” step. That aligns with **2.4** (background consolidation); 2.2 can be the “report/flag” step and 2.4 the “merge” step with LLM.

---

**Concrete next step:** Add `openclaw hybrid-mem find-duplicates [--threshold 0.92] [--include-structured] [--dry-run]` that scans LanceDB for high-similarity pairs. **Default:** skip facts that look like identifiers (IP, email, phone, UUID, etc.) and numbers in general. Use **`--include-structured`** to opt in to processing those too. Prints candidate pairs for review; no change to the store path.

### 2.3 Fuzzy text deduplication in SQLite

**Current:** SQLite dedupe is `WHERE text = ?` only.

**Enhancement:** Add an optional check using FTS5: e.g. search for the new text and treat a very high FTS rank as duplicate (or use a simple heuristic: normalize whitespace/case and compare; or store a hash of normalized text). Lowers duplicate facts from small rephrasings.

---

### 2.4 Background consolidation job (merge near-duplicates)

**Enhancement:** A periodic job (e.g. weekly, or after N new facts): find clusters of semantically similar facts (vector search with high threshold), then for each cluster call a cheap LLM to produce one concise fact. Store the merged fact, delete the cluster (or keep one and update it). Improves long-term quality and reduces total facts (and thus tokens when multiple similar items would be recalled).

**Files:** New function in `index.ts`; call from service timer or CLI `hybrid-mem consolidate --dry-run`.

---

## 3. Long-term memory

### 3.1 Decay-class–aware auto-recall

**Current:** Merge results by score only; decay class affects TTL and refresh, not ranking.

**Enhancement:** In auto-recall, optionally boost score for `permanent` and `stable` so that lasting facts are preferred when scores are close. E.g. `score *= 1.2` for permanent, `1.1` for stable. Config: `autoRecall.preferLongTerm: true`.

---

### 3.2 Small “anchor” set always injected

**Enhancement:** Allow a small list of fact IDs or tags (e.g. "identity", "core_preferences") that are always included in auto-recall (e.g. up to 2–3 facts), then fill the rest by relevance. Ensures critical long-term facts are never dropped when the query is narrow. Could be implemented as a special category or a separate table/list in config.

---

### 3.3 Importance and recency in composite score

**Current:** FTS composite uses BM25, freshness, confidence. Vector side uses distance only.

**Enhancement:** When merging, combine relevance score with importance and recency (e.g. `lastConfirmedAt`). So a slightly less relevant but more important or recently confirmed fact can rank higher. Helps long-term facts that are still relevant surface more reliably.

---

## 4. In-depth memory

### 4.1 Entity-centric recall

**Current:** Recall is global search; no explicit “all facts about entity X”.

**Enhancement:** In auto-recall, if the query clearly mentions an entity (e.g. from a small allowlist or NER), do an extra `factsDb.lookup(entity)` and merge 1–2 of those facts into the result set (if not already in). Gives deeper, entity-specific context without changing the main search.

---

### 4.2 Richer memory_recall output (optional)

**Enhancement:** Add an optional parameter to `memory_recall`, e.g. `includeRelated: true`. When set, for each result with an `entity`, fetch 1–2 more facts for that entity and append short lines (e.g. "Related: …"). Helps the agent get “in-depth” context in one call.

---

### 4.3 Chunked long facts (summary + detail)

**Current:** Each fact is one blob; long facts consume many tokens when recalled.

**Enhancement:** For facts over N characters (e.g. 300), optionally store a short “summary” (e.g. first 80 chars or LLM-generated) in a separate column or in the main text. At recall, inject the summary by default; agent can call `memory_recall` with the fact id to get full text if needed. Reduces tokens while keeping detail available.

---

## 5. Implementation priority (suggested)

| Priority | Item                         | Effort | Token impact      | Quality impact      |
|----------|------------------------------|--------|-------------------|---------------------|
| 1        | 1.1 Token cap on auto-recall | Low    | High              | Neutral             | ✅ Implemented |
| 2        | 1.3 Honor captureMaxChars    | Low    | Medium            | Prevents drop/long  | ✅ Implemented |
| 3        | 1.2 Shorter injection format | Low    | Medium            | Neutral             | ✅ Implemented |
| 4        | 2.1 Configurable recall limit/minScore | Low  | Config-driven     | Better relevance    | ✅ Implemented |
| 5        | 2.2 Semantic dedupe (maintenance: find-duplicates CLI) | Medium | Medium (fewer dupes) | High — revised, not at store |
| 6        | 3.1 Decay-class–aware recall | Low    | Slight            | Better long-term    | ✅ Implemented |
| 7        | 3.3 Importance/recency in score | Low | Slight            | Better ranking      | ✅ Implemented |
| 8        | 4.1 Entity-centric recall     | Medium | Slight            | Deeper context      | ✅ Implemented |
| 9        | 2.4 Consolidation job        | High   | High over time    | High                | ✅ Implemented |
| 10       | 1.4 Summarize over budget    | Medium | When over cap     | When over cap       | ✅ Implemented |
| —        | 4.3 Chunked long facts       | Medium | Token savings     | In-depth available  | ✅ Implemented |

---

## 6. Doc and config updates

- **hybrid-memory-manager-v3.md:** Add a short “Enhancements” or “Roadmap” section linking to this file; document any new config keys (e.g. under §4).
- **openclaw.plugin.json:** Add `captureMaxChars`, `autoRecall.maxTokens`, `autoRecall.maxPerMemoryChars`, `autoRecall.limit`, `autoRecall.minScore` to the schema and UI hints when implemented.

---

*Document version: 1.0 — 2026-02-15*
