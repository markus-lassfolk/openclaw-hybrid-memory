/**
 * Shared JSON array extraction utility.
 *
 * LLM responses often wrap a JSON array in prose or code fences.
 * This module provides a single canonical extractor used by
 * contextual-variants, query-expander, and reranker.
 */

/**
 * Extract the first valid JSON array from an LLM response string.
 * Handles code fences, prose wrapping, and literal "]" inside string values.
 * Returns the parsed array elements, or an empty array if nothing found.
 */
export function extractJsonArray(response: string): unknown[] {
	const candidates: string[] = [];
	let start = response.indexOf("[");
	while (start !== -1) {
		let end = response.indexOf("]", start + 1);
		while (end !== -1) {
			candidates.push(response.slice(start, end + 1));
			end = response.indexOf("]", end + 1);
		}
		start = response.indexOf("[", start + 1);
	}
	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (Array.isArray(parsed)) return parsed;
	}
	return [];
}
