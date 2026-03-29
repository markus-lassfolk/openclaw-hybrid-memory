/**
 * Shared embedding call policy: timeout + limited retries with exponential backoff (#871).
 */

export const EMBED_CALL_TIMEOUT_MS = 120_000;
/** Total attempts (initial + retries). */
export const EMBED_CALL_MAX_ATTEMPTS = 3;
export const EMBED_CALL_BASE_DELAY_MS = 400;

export function embedCallWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`embedding timed out after ${EMBED_CALL_TIMEOUT_MS}ms (${label})`)),
      EMBED_CALL_TIMEOUT_MS,
    );

    // In Node.js, avoid keeping the event loop alive just because of this timer.
    const maybeTimer = timeoutId as unknown as { unref?: () => void } | undefined;
    if (maybeTimer && typeof maybeTimer.unref === "function") {
      maybeTimer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

/**
 * Run an embedding producer with per-attempt timeout and exponential backoff between failures.
 */
export async function embedCallWithTimeoutAndRetry<T>(producer: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < EMBED_CALL_MAX_ATTEMPTS; attempt++) {
    try {
      return await embedCallWithTimeout(producer(), `${label} (attempt ${attempt + 1})`);
    } catch (err) {
      last = err;
      if (attempt < EMBED_CALL_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, EMBED_CALL_BASE_DELAY_MS * 2 ** attempt));
      }
    }
  }
  throw last;
}
