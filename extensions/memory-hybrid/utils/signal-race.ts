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
      void promise.finally(() => signal.removeEventListener("abort", onAbort));
    }),
  ]);
}
