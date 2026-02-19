# Phase 2 Implementation Summary: Procedure Reinforcement

## Overview

Phase 2 extends the reinforcement system from Phase 1 (issue #40) to also target the **procedures table** (skills), not just facts. This creates a complete user-feedback loop where reinforcement validates both declarative knowledge (facts) and procedural knowledge (skills).

## Completed Implementation

### 1. Schema Changes (backends/facts-db.ts)

**New migration: `migrateReinforcementColumnsProcedures()`**

Added to `procedures` table:
- `reinforced_count INTEGER NOT NULL DEFAULT 0` — tracks reinforcement count
- `last_reinforced_at INTEGER` — when last reinforced (epoch seconds)
- `reinforced_quotes TEXT` — JSON array of user praise quotes (max 10)
- `promoted_at INTEGER` — when auto-promoted via reinforcement
- Index on `reinforced_count` for efficient queries

**Integration:**
- Called from constructor after `migrateReinforcementColumns()`
- Idempotent: checks for column existence before adding

### 2. Database Methods (backends/facts-db.ts)

**`reinforceProcedure(id, quoteSnippet, promotionThreshold = 2)`**

Annotates a procedure with reinforcement:
- Increments `reinforced_count`
- Updates `last_reinforced_at`
- Appends quote (truncated to 200 chars), keeps last 10
- **Auto-promotion**: When `reinforced_count >= promotionThreshold` and `confidence < 0.8`:
  - Sets `confidence = max(confidence, 0.8)` (user-verified)
  - Records `promoted_at` timestamp
- Returns `true` if procedure was updated

**Pattern matching with `reinforceFact()`:**
- Same quote truncation (200 chars)
- Same quote limit (10 max)
- Same incremental update logic
- Additional promotion logic for procedures

### 3. Procedure Ranking Boost (backends/facts-db.ts)

**Updated `searchProcedures(taskDescription, limit, reinforcementBoost = 0.1)`**

- Extracts `reinforced_count` from query results
- Applies boost: `boostedScore = confidence + (reinforcedCount > 0 ? reinforcementBoost : 0)`
- Sorts by:
  1. `procedure_type` (positive first)
  2. `boostedScore` (confidence + reinforcement)
  3. `last_validated` (most recent first)
- **Effect**: Reinforced procedures rank higher than unreinforced ones with equal confidence

### 4. Type Definitions (types/memory.ts)

**Updated `ProcedureEntry`:**

```typescript
export type ProcedureEntry = {
  // ... existing fields ...
  reinforcedCount?: number;
  lastReinforcedAt?: number | null;
  reinforcedQuotes?: string[] | null;
  promotedAt?: number | null;
};
```

**Updated `procedureRowToEntry()` in facts-db.ts:**
- Parses `reinforced_quotes` JSON (with error handling)
- Maps all new columns from SQLite rows

### 5. Reinforcement Extraction (services/reinforcement-extract.ts)

**Updated `ReinforcementIncident` type:**
```typescript
export type ReinforcementIncident = {
  // ... existing fields ...
  toolCallSequence: string[];  // Phase 2: for procedure matching
};
```

**New helper: `extractToolCallSequence(content)`**
- Scans assistant message for `tool_use` blocks
- Returns array of tool names in order (e.g. `["memory_recall", "exec", "write"]`)
- Used to match agent actions against stored procedures

**Updated `runReinforcementExtract()`:**
- Calls `extractToolCallSequence()` for each agent response
- Includes `toolCallSequence` in incident output
- Enables CLI/integration layer to match incidents with procedures

### 6. Directive-to-Procedure Conversion (services/directive-extract.ts)

**New helper: `isProceduraDirective(incident)`**
- Returns `true` if incident contains category 7 ("procedural")
- Used by CLI to decide when to create procedure entries

**New helper: `extractTaskIntentFromDirective(userMessage, context)`**
- Heuristic extraction of task intent from procedural directives
- Patterns:
  - "before you do X" → task = X
  - "first check Y" → task = "check Y"
  - "when Z happens" → task = "when Z"
  - Fallback: first sentence with action verb
- Returns truncated string (max 200 chars) for `task_pattern` field

**Integration flow:**
1. Extract directives via `runDirectiveExtract()`
2. Filter for `isProceduraDirective(incident)`
3. Call `extractTaskIntentFromDirective()` to get task pattern
4. Create procedure entry:
   - `procedure_type: 'positive'` (user-taught rule)
   - `task_intent`: extracted task pattern
   - `confidence: 0.9` (high — user explicitly taught it)
   - `source: 'directive-extraction'`

### 7. Config Extension (config.ts)

**Updated `distill` config:**

```typescript
distill?: {
  // ... existing fields ...
  reinforcementProcedureBoost?: number;  // default: 0.1, range: 0-1
  reinforcementPromotionThreshold?: number;  // default: 2, min: 1
}
```

**Parsing logic:**
- `reinforcementProcedureBoost`: validated 0-1, default 0.1
- `reinforcementPromotionThreshold`: validated >= 1, default 2
- Both optional, graceful fallback to defaults

### 8. CLI Commands (cli/register.ts)

**New command: `extract-directives`**

```bash
openclaw hybrid-mem extract-directives [--days <n>] [--verbose] [--dry-run]
```

- Scans session JSONL for directive signals (10 categories)
- Optionally stores as facts (category `rule` or `preference`)
- Procedural directives → procedure entries (via `isProceduraDirective` check)
- Default: last 3 days

**New command: `extract-reinforcement`**

```bash
openclaw hybrid-mem extract-reinforcement [--days <n>] [--verbose] [--dry-run]
```

- Scans session JSONL for reinforcement signals
- Correlates with facts (via `recalledMemoryIds`) → calls `reinforceFact()`
- Correlates with procedures (via `toolCallSequence`) → calls `reinforceProcedure()`
- Default: last 3 days

**Updated command: `distill`**

Added flags:
- `--directives`: Also run directive extraction
- `--reinforcement`: Also run reinforcement extraction

**Status:** Placeholders implemented (TODO: full integration logic)

### 9. Tests (tests/)

**`tests/directive-extract.test.ts`**

Test coverage:
- ✅ Detect explicit memory requests (category 1)
- ✅ Detect future behavior changes (category 2)
- ✅ Detect procedural directives (category 7)
- ✅ Detect emotional emphasis (category 9)
- ✅ Skip heartbeat/cron messages (noise filtering)
- ✅ Extract task intent from procedural directives
- ✅ Handle multiple categories in one message

**`tests/reinforcement-extract.test.ts`**

Test coverage:
- ✅ Detect explicit praise
- ✅ Extract recalled memory IDs (UUID matching)
- ✅ Extract tool call sequence (Phase 2)
- ✅ Filter out generic politeness (confidence threshold)
- ✅ Detect method confirmation ("yes, like that")
- ✅ Detect relief/finally ("finally!")
- ✅ Skip heartbeat/cron messages
- ✅ Boost confidence for substantial agent response

**Test framework:** Vitest
**Pattern:** Temp directory creation, JSONL file generation, cleanup

## Integration Flow

### Reinforcement → Procedures

1. **Detection**: `runReinforcementExtract()` scans JSONL
2. **Tool sequence extraction**: `extractToolCallSequence()` captures agent's tools
3. **Procedure matching**: CLI/integration layer matches `toolCallSequence` against stored procedures (via `searchProcedures()` or custom matching logic)
4. **Annotation**: For each match, call `reinforceProcedure(procedureId, quoteSnippet, promotionThreshold)`
5. **Auto-promotion**: When `reinforced_count >= threshold`, procedure confidence is boosted to 0.8+

### Directives → Procedures

1. **Detection**: `runDirectiveExtract()` scans JSONL
2. **Category check**: Filter for `isProceduraDirective(incident)`
3. **Task extraction**: `extractTaskIntentFromDirective()` → task pattern
4. **Storage**: Create procedure entry:
   ```typescript
   factsDb.upsertProcedure({
     taskPattern: extractedTaskIntent,
     recipeJson: JSON.stringify([]), // empty recipe for user-taught rule
     procedureType: 'positive',
     confidence: 0.9,
     successCount: 0,
     failureCount: 0,
     sourceSessionId: sessionName,
   });
   ```

## Configuration Example

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "distill": {
            "extractDirectives": true,
            "extractReinforcement": true,
            "reinforcementBoost": 0.1,
            "reinforcementProcedureBoost": 0.1,
            "reinforcementPromotionThreshold": 2
          }
        }
      }
    }
  }
}
```

## Usage Examples

### Extract reinforcement from last 7 days

```bash
openclaw hybrid-mem extract-reinforcement --days 7 --verbose
```

### Extract directives and create procedures

```bash
openclaw hybrid-mem extract-directives --days 3
```

### Integrate with distill

```bash
openclaw hybrid-mem distill --directives --reinforcement --days 3
```

### Search procedures with reinforcement boost

```typescript
import { factsDb } from "./backends/facts-db.js";
import { config } from "./config.js";

const boost = config.distill?.reinforcementProcedureBoost ?? 0.1;
const procedures = factsDb.searchProcedures("check logs before restart", 10, boost);

// Reinforced procedures will rank higher than unreinforced ones
for (const proc of procedures) {
  console.log(`${proc.taskPattern} (confidence: ${proc.confidence}, reinforced: ${proc.reinforcedCount})`);
}
```

## Code Quality

- ✅ TypeScript strict mode
- ✅ Follows existing patterns EXACTLY
- ✅ Proper JSDoc comments
- ✅ No external dependencies
- ✅ Error handling with try-catch
- ✅ Safe JSON parsing with fallbacks
- ✅ SQL injection prevention (parameterized queries)
- ✅ Unicode-safe text processing
- ✅ Idempotent migrations

## Files Modified

1. `backends/facts-db.ts` — schema migration, reinforceProcedure method, searchProcedures boost
2. `types/memory.ts` — added reinforcement fields to ProcedureEntry
3. `services/reinforcement-extract.ts` — tool call sequence extraction
4. `services/directive-extract.ts` — procedural directive helpers
5. `config.ts` — added reinforcementProcedureBoost and reinforcementPromotionThreshold
6. `cli/register.ts` — added extract-directives and extract-reinforcement commands, updated distill
7. `tests/directive-extract.test.ts` — **NEW** comprehensive directive tests
8. `tests/reinforcement-extract.test.ts` — **NEW** comprehensive reinforcement tests

## Next Steps (Integration)

1. **CLI implementation**: Complete `runExtractDirectives` and `runExtractReinforcement` functions
   - Read session JSONL files (reuse existing patterns from distill)
   - Call `runDirectiveExtract()` and `runReinforcementExtract()`
   - Match tool sequences with procedures (fuzzy matching or exact sequence match)
   - Call `reinforceProcedure()` for matches
   - Create procedure entries from procedural directives

2. **Procedure matching logic**: Add helper to `procedure-extractor.ts`
   ```typescript
   export function matchToolSequenceWithProcedures(
     toolSequence: string[],
     factsDb: FactsDB,
     maxResults = 5
   ): ProcedureEntry[] {
     // Fuzzy match tool sequence against stored recipes
     // Return procedures with high overlap
   }
   ```

3. **Manual testing**:
   ```bash
   # Test directive extraction
   openclaw hybrid-mem extract-directives --days 1 --verbose --dry-run
   
   # Test reinforcement extraction
   openclaw hybrid-mem extract-reinforcement --days 1 --verbose --dry-run
   
   # Test with actual storage
   openclaw hybrid-mem extract-directives --days 1
   openclaw hybrid-mem extract-reinforcement --days 1
   
   # Verify procedures were created/reinforced
   openclaw hybrid-mem stats
   ```

4. **Documentation**: Update README.md with Phase 2 usage examples

## Estimated Remaining Work

- CLI integration functions: ~3 hours
- Procedure matching logic: ~2 hours
- Manual testing & fixes: ~2 hours
- Documentation updates: ~1 hour

**Total: ~8 hours remaining**

## Architecture Notes

### Reinforcement as User Feedback

Phase 2 completes the reinforcement feedback loop:
- **Facts**: Static knowledge validated by user praise
- **Procedures**: Dynamic behaviors validated by user praise
- **Auto-promotion**: High reinforcement = high confidence = user-verified skill

### Directive-Driven Learning

User-taught procedures complement auto-extracted ones:
- **Auto-extracted**: Tool sequences from successful sessions (empirical)
- **User-taught**: Explicit directives from user (prescriptive)
- **Validation**: Both can be reinforced via praise

### Confidence Scoring

Procedure confidence sources:
1. **Success rate**: `0.5 + 0.1 * (successCount - failureCount)` (existing)
2. **Reinforcement**: +0.1 per reinforcement (new)
3. **User-taught**: Start at 0.9 (new)
4. **Auto-promotion**: Boost to 0.8 when reinforced >= threshold (new)

Final confidence is clamped to 0.1-0.95.

---

**Implementation Status: Core Complete (100%), CLI Integration Remaining (~8 hours)**
