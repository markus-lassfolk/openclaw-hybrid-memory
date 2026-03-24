/**
 * Performs a fetch request with a timeout.
 * Returns `null` if the request times out (AbortError), and throws on other fetch failures.
 *
 * @param url The URL to fetch.
 * @param timeoutMs The timeout in milliseconds.
 * @returns The Response object, or `null` if a timeout occurred.
 */
export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError") {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
