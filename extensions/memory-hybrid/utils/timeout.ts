/**
 * Shared timeout utility for lifecycle stages.
 * Races a promise against a timeout, returning null if the timeout wins.
 */

export function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T | null>;
export function withTimeout<T, F>(ms: number, fn: () => Promise<T>, fallback: F): Promise<T | F>;
export function withTimeout<T, F = null>(ms: number, fn: () => Promise<T>, fallback?: F): Promise<T | F | null> {
  const fallbackValue = (fallback === undefined ? null : fallback) as F | null;
  return Promise.race([fn(), new Promise<F | null>((resolve) => setTimeout(() => resolve(fallbackValue), ms))]);
}
