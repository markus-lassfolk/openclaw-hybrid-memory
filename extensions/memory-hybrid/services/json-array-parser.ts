/**
 * Shared JSON array extraction utility.
 *
 * LLM responses often wrap a JSON array in prose or code fences.
 * This module provides a single canonical extractor used by
 * contextual-variants, query-expander, and reranker.
 */

import { tryParseFirstJsonArray } from "../utils/llm-json-array.js";

/**
 * Extract the first valid JSON array from an LLM response string.
 * Handles code fences, prose wrapping, and literal "]" inside string values.
 * Returns the parsed array elements, or an empty array if nothing found.
 */
export function extractJsonArray(response: string): unknown[] {
  return tryParseFirstJsonArray(response) ?? [];
}
