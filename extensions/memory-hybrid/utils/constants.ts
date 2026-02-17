/**
 * Shared constants to avoid magic numbers across the plugin.
 */

/** Max characters for a single fact in reflection/consolidation prompts. */
export const REFLECTION_MAX_FACT_LENGTH = 300;
/** Max facts per category in reflection prompt. */
export const REFLECTION_MAX_FACTS_PER_CATEGORY = 50;
/** Max characters for credential notes in vault (truncation). */
export const CREDENTIAL_NOTES_MAX_CHARS = 500;

/** Max characters for a single fact shown in LLM prompts (classify, consolidate). */
export const FACT_PREVIEW_MAX_CHARS = 300;
/** Max characters for a new fact candidate in classify prompt. */
export const CLASSIFY_CANDIDATE_MAX_CHARS = 500;
/** Default minimum vector similarity score for search. */
export const DEFAULT_MIN_SCORE = 0.3;
/** Default importance for CLI-stored facts. */
export const CLI_STORE_IMPORTANCE = 0.7;
/** Default importance for daily-scan/batch-stored facts. */
export const BATCH_STORE_IMPORTANCE = 0.8;
/** Default importance for reflection/pattern/meta/rule facts. */
export const REFLECTION_IMPORTANCE = 0.9;
/** Max characters for merged text in consolidation. */
export const CONSOLIDATION_MERGE_MAX_CHARS = 5000;
/** Max characters for reflection pattern text. */
export const REFLECTION_PATTERN_MAX_CHARS = 500;
/** Max characters for reflection meta-pattern text. */
export const REFLECTION_META_MAX_CHARS = 300;
/** Cosine similarity threshold for deduplicating reflection patterns. */
export const REFLECTION_DEDUPE_THRESHOLD = 0.85;
/** LLM temperature for reflection/rules prompts. */
export const REFLECTION_TEMPERATURE = 0.2;
/** Batch throttle delay (ms) between embedding batches. */
export const BATCH_THROTTLE_MS = 200;
/** SQLite busy timeout (ms). */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
/** Seconds per day. */
export const SECONDS_PER_DAY = 86400;
