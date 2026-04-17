/**
 * FTS5 query sanitization for facts search paths (#870, #898).
 * Extracted from FactsDB for reuse and smaller core file size.
 */

const NULL_BYTE_PATTERN = new RegExp(String.fromCharCode(0), "g");

/**
 * Sanitize query for FTS5 MATCH operator: strip FTS5 special characters and operators.
 * Removes: NOT, AND, OR, NEAR (case-insensitive), null bytes, *, :, {, }, (, ), and quotes.
 */
export function sanitizeFts5QueryForFacts(query: string): string {
	return query
		.replace(NULL_BYTE_PATTERN, " ")
		.replace(/['"*(){}:]/g, "")
		.replace(/\b(NOT|AND|OR|NEAR)\b/gi, "")
		.trim();
}
