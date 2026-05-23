import type { ErrorLike } from "./types.js";

const NOISY_NETWORK_ERROR_RE =
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed|network timeout|connect\s+ETIMEDOUT|LLM request timeout)\b/i;
const NOISY_AUTH_ERROR_RE =
  /\b(?:401\b|403\b|unauthorized|forbidden|incorrect api key|invalid api key|authentication failed|country,\s*region,\s*or\s*territory\s+not\s+supported|PERMISSION_DENIED)\b/i;
const NOISY_CIRCUIT_BREAKER_RE = /\bcircuit\s+breaker\s+open\b/i;

function getErrorStatus(err: unknown): number | string | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as ErrorLike).status as number | string | undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as ErrorLike).message === "string") {
    return (err as ErrorLike).message as string;
  }
  return "";
}

function getNestedErrors(err: unknown): unknown[] {
  if (!err || typeof err !== "object") return [];
  const nested: unknown[] = [];
  const cause = (err as ErrorLike).cause;
  if (cause != null) nested.push(cause);

  const causes = (err as ErrorLike).causes;
  if (Array.isArray(causes)) nested.push(...causes);

  const errors = (err as ErrorLike).errors;
  if (Array.isArray(errors)) nested.push(...errors);

  return nested;
}

function isFilePermissionMessage(message: string): boolean {
  return /\b(file|directory|path|disk)\b/i.test(message);
}

function isDirectNoisyError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as ErrorLike).name === "UnconfiguredProviderError") {
    return true;
  }

  const status = getErrorStatus(err);
  if (status === 401 || status === "401" || status === 403 || status === "403") {
    return true;
  }

  const message = getErrorMessage(err).trim();
  if (!message) return false;

  if (NOISY_NETWORK_ERROR_RE.test(message)) return true;
  if (NOISY_CIRCUIT_BREAKER_RE.test(message)) return true;
  if (NOISY_AUTH_ERROR_RE.test(message) && !isFilePermissionMessage(message)) return true;

  return false;
}

/**
 * Returns true for known noisy, non-actionable errors that should never be sent
 * to GlitchTip: transient transport failures, external-provider auth failures,
 * local Ollama circuit-breaker errors, and aggregates whose nested causes are all noisy.
 */
export function shouldDropNoisyError(err: unknown, seen = new Set<unknown>()): boolean {
  if (!err || (typeof err !== "object" && !(err instanceof Error))) return false;
  if (seen.has(err)) return false;
  seen.add(err);

  if (isDirectNoisyError(err)) return true;

  const nested = getNestedErrors(err);
  if (nested.length === 0) return false;

  const uniqueNested = Array.from(new Set(nested));
  return uniqueNested.every((nestedErr) => shouldDropNoisyError(nestedErr, seen));
}
