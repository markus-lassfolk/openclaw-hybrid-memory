/**
 * Deterministic JSON serialization with sorted object keys.
 *
 * Produces stable, order-independent fingerprints for deduplication and caching.
 * Arrays preserve order, objects are sorted alphabetically by key.
 */

/**
 * Stringify a value with sorted object keys for stable, order-independent serialization.
 *
 * @param value - Any JSON-serializable value (object, array, primitive, null, undefined).
 * @returns Deterministic JSON string with sorted object keys.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}
