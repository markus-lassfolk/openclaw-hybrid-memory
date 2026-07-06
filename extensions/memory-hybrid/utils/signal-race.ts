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
      const onAbort = () => {
        void promise.then(
          (value) => resolve(value),
          () => {
            if (signal.aborted) resolve(fallback);
          },
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // `.finally()` returns a new promise that rejects if `promise` rejects — a separate
      // promise object from the one `Promise.race`/the `onAbort` `.then()` above consume.
      // Left unhandled, that derived promise becomes a genuine unhandled rejection (and can
      // crash the process under Node's default --unhandled-rejections=throw) whenever `promise`
      // rejects, independent of whether the caller's race result was itself handled.
      void promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
    }),
  ]);
}
