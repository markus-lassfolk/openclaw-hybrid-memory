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
    const msg = err.message.toLowerCase();
    if (/\bhttp\s+404\b/.test(msg)) return true;
    if (/^\b404\b/.test(msg.trim())) return true;
    if (/\berror\s+code:\s*404\b/.test(msg)) return true;
    if (/\b404\s+[a-z]/.test(msg)) return true;
    if (msg.includes("is not found for api version")) return true;
    
    const hasNotFound = msg.includes("not found");
    if (hasNotFound && /\b404\b/.test(msg)) return true;
    if (hasNotFound && msg.includes("model")) return true;
  }
  return false;
}
