# Code Review — Architecture & Edge Cases (Gemini)

## 🔴 Critical Issues (must fix before merge)

### 1. Broken Multi-language Support in Directive Extraction
**File:** `services/directive-extract.ts`
**Issue:** While `runDirectiveExtract` accepts a `directiveRegex` (derived from multilingual keywords) for initial filtering, the `detectDirectiveCategories` function uses **hardcoded English regexes** to classify directives and calculate confidence.
**Impact:** Non-English directives will pass the initial filter (if keywords are set) but will likely return empty categories or low confidence, failing to be extracted properly.
**Snippet:**
```typescript
// services/directive-extract.ts
function detectDirectiveCategories(text: string): { categories: DirectiveCategory[]; confidence: number } {
  // ...
  // Hardcoded English patterns!
  if (/\b(remember|don't forget|...)\b/i.test(text)) { ... }
```
**Fix:** Refactor `detectDirectiveCategories` to accept a configuration object containing the regexes for each category, constructed from `language-keywords.ts`. Alternatively, export the category-specific regex builders from `language-keywords.ts` and use them here.

### 2. Missing Reinforcement Logic in `FactsDB`
**File:** `backends/facts-db.ts`
**Issue:** The file contains migrations for reinforcement columns (`migrateReinforcementColumns`), but **no method to actually update them** (`reinforceFact` or similar). The `search` method *uses* `reinforced_count` for scoring, but there is no code to *increment* it.
**Impact:** The "Reinforcement-as-Metadata" feature is incomplete. Extracted reinforcement incidents cannot be applied to the database.
**Fix:** Implement `reinforceFact(id: string, quote: string): void` and `reinforceProcedure(id: string, quote: string): void` methods in `FactsDB`.

### 3. Potential SQL Injection / Query Error in Search
**File:** `backends/facts-db.ts`
**Issue:** In `search`, `safeQuery` splits by whitespace and joins with `OR`. If the query contains FTS5 special characters (like `NOT`, `AND`, `OR` in uppercase, or parentheses) that aren't stripped by `replace(/['"]/g, "")`, it could cause a syntax error or unexpected behavior in the `MATCH` operator.
**Snippet:**
```typescript
const safeQuery = query
  .replace(/['"]/g, "") // Only removes quotes
  .split(/\s+/)
  // ...
```
**Fix:** Sanitize the query more aggressively to escape or remove FTS5 operators, or use a bound parameter approach that handles FTS syntax safely (though `MATCH` requires a string literal/param). At minimum, strip `*`, `(`, `)`, `NOT`, `AND`, `OR`.

## 🟡 Important Issues (should fix)

### 1. Race Condition in `reinforced_quotes` Update
**File:** `backends/facts-db.ts` (conceptual, implementation missing)
**Issue:** When implementing the missing `reinforceFact` method, appending to `reinforced_quotes` (JSON array) via a simple read-modify-write pattern will be susceptible to race conditions if multiple reinforcements happen concurrently (unlikely in single-agent, possible if `distill` runs in background).
**Fix:** Use a SQLite transaction or a JSON patch approach if supported by the SQLite version (json extension). Since `better-sqlite3` is synchronous, a transaction around the read-modify-write is sufficient.

### 2. Heuristic Extraction in Directive Service
**File:** `services/directive-extract.ts`
**Issue:** `extractRule` simply returns the first 200 chars or the first sentence matching a keyword.
**Impact:** This will likely extract noisy text ("Remember that time we...") or cut off complex instructions.
**Fix:** The comment acknowledges this ("Future: use LLM"). For now, consider a slightly smarter heuristic: if a colon exists ("Remember: ..."), take text after it.

### 3. Hardcoded English in `reinforcement-extract.ts` Confidence
**File:** `services/reinforcement-extract.ts`
**Issue:** Similar to directive extraction, `calculateReinforcementConfidence` uses hardcoded English regexes (`strongPraise`, `methodConfirmation`, etc.).
**Impact:** Multi-language reinforcement detection will be inaccurate.
**Fix:** Move these patterns to `language-keywords.ts` and generate a combined regex or pass language-specific patterns.

## 🟢 Minor/Style Issues

### 1. Typos
**File:** `services/directive-extract.ts`
**Issue:** Function name `isProceduraDirective` is missing an 'l' (`isProceduralDirective`).

### 2. Magic Numbers
**File:** `services/directive-extract.ts`
**Issue:** `confidence` scoring uses magic numbers (0.7, 0.8, 0.1).
**Fix:** Extract to constants for easier tuning.

### 3. Incomplete Test Coverage
**File:** `tests/directive-extract.test.ts`
**Issue:** Tests only cover English scenarios.
**Fix:** Add a test case with a mocked non-English trigger to verify the regex passing mechanism (once fixed).

## 💡 Suggestions

### 1. Procedure Auto-Promotion Logic
**File:** `config.ts` / `facts-db.ts`
**Suggestion:** The `reinforcementPromotionThreshold` is set to 2. Consider adding a time component (e.g., "2 reinforcements on different days") to prevent immediate promotion from a single enthusiastic conversation.

### 2. Intent Template Completeness
**File:** `services/intent-template.ts`
**Suggestion:** The `KEYWORD_GROUP_INTENTS` are excellent. Consider adding negative examples to `directiveSignals` intent to help the LLM distinguish between "Remember to buy milk" (task) vs "Remember that I like milk" (preference/fact).

## ✅ What Looks Good

*   **Clean Separation:** The extraction logic is well-isolated in `services/`.
*   **Database Schema:** The migrations for `reinforced_count`, `last_reinforced_at`, and `procedures` are robust and follow the existing pattern.
*   **Configuration:** `config.ts` schema validation with Zod-like parsing is thorough.
*   **Testing:** The provided tests for extraction are clear and test the main positive/negative cases (for English).

## Summary Verdict: CHANGES REQUESTED

The **critical issue** of broken multi-language support in `directive-extract.ts` (and `reinforcement-extract.ts`) and the **missing implementation** of `reinforceFact` in `FactsDB` need to be addressed before this can be merged. The architecture is sound, but the implementation is incomplete.
