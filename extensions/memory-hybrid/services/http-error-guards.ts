/**
 * Shared HTTP-like error detection helpers used to suppress expected operator
 * or provider errors from GlitchTip.
 */

/**
 * Unified 404 detection helper.
 * Checks the HTTP status code property first (reliable), then falls back to
 * targeted message pattern matching. Only matches HTTP-like "not found"
 * scenarios, NOT generic filesystem/module lookup failures.
 */
export function is404Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 404 || status === "404") return true;
  }
  if (err instanceof Error) {
    return (
      /\bHTTP\s+404\b|\b404\b.*not\s+found|model.*not\s+found|not\s+found.*model/i.test(err.message) ||
      /^\b404\b/.test(err.message.trim()) ||
      /\bError\s+code:\s*404\b|\b404\s+[A-Za-z]/.test(err.message) ||
      /is not found for api version/i.test(err.message)
    );
  }
  return false;
}
