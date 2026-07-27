/**
 * Coerce a scalar-or-array filter value into an array.
 *
 * Several store `list()`/filter-building functions used to do
 * `if (filter?.field && filter.field.length > 0) { ...filter.field.map(...) }`. A bare string
 * passes the truthy/`.length` check (strings have `.length`) and then `.map` throws
 * `TypeError: filter.field.map is not a function`. LLM tool callers frequently pass a bare
 * scalar (e.g. `status: "open"`) for a field a tool schema declares as an array, so this
 * crash was reachable from ordinary tool use, not just misuse.
 *
 * `toArrayFilter` normalizes `undefined`/`null` to `undefined` (no filter), wraps a bare
 * scalar into a single-element array, and passes an actual array through unchanged. Use it in
 * both places a filter value crosses a trust boundary: where a tool handler builds a filter
 * object from raw params (before it reaches the store), and inside the store's own
 * filter-building code (replacing the bare truthy/`.length` check above) — so the store stays
 * safe and behaves the same way even if some other, non-tool caller ever passes a scalar
 * directly, not just when a tool handler mediates.
 *
 * (GitHub issue #2185 / GlitchTip issue 20.)
 */
export function toArrayFilter<T>(value: T | T[] | null | undefined): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}
