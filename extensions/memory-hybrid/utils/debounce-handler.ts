/**
 * Coalesce rapid repeated callbacks (Phase 6 — for future memory markdown watchers).
 */

export function createDebouncedHandler(fn: () => void, delayMs = 500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
    timer.unref?.();
  };
}
