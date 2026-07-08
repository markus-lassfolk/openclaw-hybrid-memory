/**
 * Resolve a promise early when an AbortSignal fires (stage timeout / superseded recall).
 * When both abort and the underlying promise settle, the promise result wins.
 */

export async function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  fallback: T,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return fallback;

  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      // Resolve the fallback immediately on abort — do NOT wait on `promise` to settle first.
      // `promise` is already a direct entry in this same Promise.race array, so if it settles
      // before abort fires, that settlement naturally wins the race on its own; gating this
      // resolve behind `promise.then(...)` (as a prior version did) meant a promise that never
      // settles also never triggered the fallback, so an abort during a genuinely hung call
      // (e.g. a stuck embedding request) left the whole race — and the stage timeout it exists
      // to enforce — hanging forever instead of falling back.
      const onAbort = () => resolve(fallback);
      signal.addEventListener("abort", onAbort, { once: true });
      // `.finally()` returns a new promise that rejects if `promise` rejects — a separate
      // promise object from the one `Promise.race` consumes. Left unhandled, that derived
      // promise becomes a genuine unhandled rejection (and can crash the process under Node's
      // default --unhandled-rejections=throw) whenever `promise` rejects, independent of
      // whether the caller's race result was itself handled.
      void promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
    }),
  ]);
}
