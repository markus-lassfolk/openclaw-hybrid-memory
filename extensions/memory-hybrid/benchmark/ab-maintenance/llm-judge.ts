/**
 * Optional LLM-as-judge spot-test (Phase 7 — deferred).
 *
 * Compare side-by-side samples from `.ab-fixtures/out/<run>/samples/` using a strong
 * referee model. Not run by default; enable when you want automated quality confirmation
 * after human spot-check.
 *
 * Usage (when implemented):
 *   OPENAI_API_KEY=... npx tsx benchmark/ab-maintenance/llm-judge.ts .ab-fixtures/out/<timestamp>
 */
console.log("llm-judge: not implemented — review samples/*.md manually or extend this script.");
