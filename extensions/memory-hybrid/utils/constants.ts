import { getEnv } from "./env-manager.js";
/**
 * Shared constants to avoid magic numbers across the plugin.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Plugin identifier used across the codebase. */
export const PLUGIN_ID = "openclaw-hybrid-memory";

/** Path to marker file written by config-mode/config-set; cleared when gateway loads plugin. */
export function getRestartPendingPath(): string {
  return join(homedir(), ".openclaw", ".restart-pending.openclaw-hybrid-memory");
}

/** Max characters for a single fact in reflection/consolidation prompts. */
export const REFLECTION_MAX_FACT_LENGTH = 300;
/** Max facts per category in reflection prompt. */
export const REFLECTION_MAX_FACTS_PER_CATEGORY = 50;
/** Max characters for credential notes in vault (truncation). */
export const CREDENTIAL_NOTES_MAX_CHARS = 500;
/** Max characters for credential URL metadata (truncation). */
export const CREDENTIAL_URL_MAX_CHARS = 2000;

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
/** Cosine similarity threshold for distillation/ingest deduplication. */
export const DISTILL_DEDUP_THRESHOLD = 0.85;
/** LLM temperature for reflection/rules prompts. */
export const REFLECTION_TEMPERATURE = 0.2;
/** Batch throttle delay (ms) between embedding batches. */
export const BATCH_THROTTLE_MS = 200;
/** SQLite busy timeout (ms). Mitigates SQLITE_BUSY under concurrent writers (#875). */
export const SQLITE_BUSY_TIMEOUT_MS = 30_000;
/** Seconds per day. */
export const SECONDS_PER_DAY = 86400;

/** Max tokens for HOT tier (always-loaded session context). */
const HOT_TIER_MAX_TOKENS = 2000;

// Python Bridge constants
/** Maximum number of retries for Python bridge startup. */
export const PYTHON_BRIDGE_MAX_RETRIES = 3;
/** Timeout for Python bridge ping health check (ms). */
export const PYTHON_BRIDGE_PING_TIMEOUT_MS = 5_000;
/** Grace period for Python bridge shutdown (ms). */
export const PYTHON_BRIDGE_SHUTDOWN_WAIT_MS = 2_000;

// Ollama embedding provider constants
/** Maximum consecutive failures before circuit breaker opens. */
export const OLLAMA_MAX_FAILS = 3;
/** Circuit breaker cooldown period after max failures (ms). */
export const OLLAMA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// LLM chat completion constants
/** Default timeout for chat completion requests (ms). */
export const DEFAULT_CHAT_TIMEOUT_MS = 45_000;

// VectorDB constants
/** Threshold for warning about consecutive optimize failures. */
export const VECTORDB_OPTIMIZE_FAILURE_WARN_THRESHOLD = 3;
/** Maximum retries for VectorDB initialization during concurrent re-registration. */
export const VECTORDB_INIT_MAX_RETRIES = 10;
/** Delay between VectorDB initialization retries (ms). */
export const VECTORDB_INIT_RETRY_DELAY_MS = 500;

/**
 * UUID v1–v5 validation regex (case-insensitive).
 * Used as the security boundary before LanceDB string interpolation and
 * as the user-facing guard in memory_forget.
 * Centralised here to avoid drift between vector-db.ts and memory-tools.ts.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Substring of the LanceDB error thrown on vector-dimension mismatch.
 * Used to suppress known schema errors from GlitchTip reporting.
 */
export const LANCE_NO_VECTOR_COL_MSG = "No vector column found";

/** Timeout (ms) for vectorDB reader drain. */
export const VECTORDB_READER_DRAIN_TIMEOUT_MS = 30_000;

/** LanceDB semantic search: maximum rows to request from vectorSearch (#882). */
export const LANCE_VECTOR_SEARCH_MAX_LIMIT = 1000;

/** Default session transcript file suffix (override with OPENCLAW_SESSION_LOG_SUFFIX, e.g. `.jsonl`). */
export function getSessionLogFileSuffix(): string {
  const raw = getEnv("OPENCLAW_SESSION_LOG_SUFFIX")?.trim();
  if (!raw) return ".jsonl";
  return raw.startsWith(".") ? raw : `.${raw}`;
}
