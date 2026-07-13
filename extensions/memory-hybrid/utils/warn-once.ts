/**
 * Shared "emit this at most once per process" primitive, keyed by an arbitrary caller-chosen
 * string. Prevents noisy warnings (credential/vault migration hints, config deprecations, …)
 * from repeating on every CLI invocation or plugin bootstrap within the same process.
 *
 * Callers should namespace their keys (e.g. prefix with a module tag) to avoid collisions with
 * unrelated warnings sharing this module-level registry.
 */

const warnedKeys = new Set<string>();

/** Invoke `emit` at most once per process for a given `key`. Subsequent calls are no-ops. */
export function warnOnce(key: string, emit: () => void): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  emit();
}

/** Test-only: clear a single warn-once key, or all of them when `key` is omitted. */
export function resetWarnOnceForTests(key?: string): void {
  if (key === undefined) {
    warnedKeys.clear();
  } else {
    warnedKeys.delete(key);
  }
}

/**
 * Test-only: clear every warn-once key starting with `prefix`. For callers whose keys are
 * per-instance (e.g. namespaced by a file path) rather than a single fixed string, so their test
 * reset hook doesn't have to clear the whole shared registry and risk wiping unrelated modules'
 * warned-once state.
 */
export function resetWarnOnceForTestsByPrefix(prefix: string): void {
  for (const key of warnedKeys) {
    if (key.startsWith(prefix)) warnedKeys.delete(key);
  }
}
