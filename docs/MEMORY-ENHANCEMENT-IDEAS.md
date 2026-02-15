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

---

## 2. Better memory management

### 2.1 Configurable auto-recall limit and min score

**Current:** FTS and vector each return 3, merge to 5; vector minScore 0.3 fixed.

**Enhancement:** Add `autoRecall.limit` (default 5) and `autoRecall.minScore` (default 0.3 for vector). Use these in the `before_agent_start` handler instead of literals. Lets users trade off relevance vs. number of memories.

---

### 2.2 Semantic deduplication at store (vector-based)

**Current:** `hasDuplicate` is exact text match in SQLite; vector DB uses embedding similarity (0.95). So two phrased-differently but semantically identical facts both get stored.

**Enhancement:** Before storing a new fact, run a vector search with the new embedding and a high similarity threshold (e.g. 0.92). If a near-duplicate exists, either skip store or update the existing fact (e.g. refresh `last_confirmed_at`, optionally merge text). Reduces redundancy and token usage at recall.

**Files:** `index.ts` (in `memory_store` and in agent_end auto-capture): after embedding, call `vectorDb.hasDuplicate(vector)` (already exists); optionally add a "merge or skip" policy in config.

---

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
| 3        | 1.2 Shorter injection format | Low    | Medium            | Neutral             |
| 4        | 2.1 Configurable recall limit/minScore | Low  | Config-driven     | Better relevance    |
| 5        | 2.2 Semantic dedupe at store| Medium | Medium (fewer dupes) | High             |
| 6        | 3.1 Decay-class–aware recall | Low    | Slight            | Better long-term    |
| 7        | 3.3 Importance/recency in score | Low | Slight            | Better ranking      |
| 8        | 4.1 Entity-centric recall     | Medium | Slight            | Deeper context      |
| 9        | 2.4 Consolidation job        | High   | High over time    | High                |
| 10       | 1.4 Summarize over budget    | Medium | When over cap     | When over cap       |

---

## 6. Doc and config updates

- **hybrid-memory-manager-v3.md:** Add a short “Enhancements” or “Roadmap” section linking to this file; document any new config keys (e.g. under §4).
- **openclaw.plugin.json:** Add `captureMaxChars`, `autoRecall.maxTokens`, `autoRecall.maxPerMemoryChars`, `autoRecall.limit`, `autoRecall.minScore` to the schema and UI hints when implemented.

---

*Document version: 1.0 — 2026-02-15*
