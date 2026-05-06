/**
 * HTTP rate-limit / quota header helpers shared by chat, embeddings, and migration paths (#943).
 * Keep behavior identical to the former chat.ts implementations — tests live in chat.test.ts.
 */

export type HeaderBag = Headers | Record<string, string | undefined>;

export function getHeaderCaseInsensitive(headers: HeaderBag, key: string): string | undefined {
  const asHeaders = headers as Partial<Headers>;
  if (typeof asHeaders.get === "function") {
    return asHeaders.get(key) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const target = key.toLowerCase();
  for (const existing of Object.keys(record)) {
    if (existing.toLowerCase() === target) return record[existing];
  }
  return undefined;
}

/** Unwrap OpenClaw {@link LLMRetryError} chains without importing that class (avoids circular imports). */
function unwrapLlmRetryErrorChain(err: unknown): unknown {
  let e: unknown = err;
  while (e instanceof Error && e.name === "LLMRetryError" && "cause" in e) {
    e = (e as { cause: Error }).cause;
  }
  return e;
}

/**
 * Some gateways (incl. Azure OpenAI / APIM) return **403** with `retry-after` and/or
 * `remaining-tokens: 0` when quota is exhausted — not the same as geo/billing "forbidden".
 */
export function is403QuotaOrRateLimitLike(err: unknown): boolean {
  const inner = unwrapLlmRetryErrorChain(err);
  if (!inner || typeof inner !== "object") return false;
  const e = inner as { status?: unknown; headers?: unknown };
  if (e.status !== 403 && e.status !== "403") return false;
  const h = e.headers;
  if (!h || typeof h !== "object") return false;
  const headers = h as HeaderBag;
  const retryAfter = getHeaderCaseInsensitive(headers, "retry-after");
  const remaining = getHeaderCaseInsensitive(headers, "remaining-tokens");
  if (retryAfter != null && String(retryAfter).trim() !== "") return true;
  if (remaining === "0") return true;
  return false;
}

/**
 * Parse OpenAI `x-ratelimit-reset-*` values: Go-style durations (`6m0s`, `1s`, `500ms`).
 */
export function parseGoDurationToMs(input: string): number | undefined {
  const s = input.trim();
  if (!s) return undefined;
  let totalMs = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|m|h)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const val = Number.parseFloat(m[1]);
    if (Number.isNaN(val)) continue;
    const u = m[2].toLowerCase();
    if (u === "ns") totalMs += val / 1e6;
    else if (u === "us" || u === "µs") totalMs += val / 1e3;
    else if (u === "ms") totalMs += val;
    else if (u === "s") totalMs += val * 1000;
    else if (u === "m") totalMs += val * 60 * 1000;
    else if (u === "h") totalMs += val * 60 * 60 * 1000;
  }
  if (matched) return Math.max(0, Math.ceil(totalMs));
  return undefined;
}

function delayMsUntilUnixEpoch(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  if (Number.isNaN(n) || n <= 0) return undefined;
  if (trimmed.length >= 10 && trimmed.length <= 11 && n >= 1_000_000_000 && n < 100_000_000_000) {
    return Math.max(0, n * 1000 - Date.now());
  }
  if (trimmed.length >= 13 && n >= 1_000_000_000_000) {
    return Math.max(0, n - Date.now());
  }
  return undefined;
}

/**
 * Try to parse a Retry-After delay (in ms) from an API error.
 * Exported for unit tests.
 */
export function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const headers =
    (err as { response?: { headers?: HeaderBag }; headers?: HeaderBag }).response?.headers ??
    (err as { headers?: HeaderBag }).headers;
  if (!headers) return undefined;

  const retryAfter = getHeaderCaseInsensitive(headers, "retry-after");
  if (retryAfter) {
    const secs = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(secs) && secs > 0 && /^\s*\d+\s*$/.test(retryAfter)) return secs * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  const resetTokens =
    getHeaderCaseInsensitive(headers, "x-ratelimit-reset-tokens") ??
    getHeaderCaseInsensitive(headers, "x-ratelimit-reset-requests");
  if (resetTokens) {
    const go = parseGoDurationToMs(resetTokens);
    if (go !== undefined) return go;
    const epochDelay = delayMsUntilUnixEpoch(resetTokens);
    if (epochDelay !== undefined) return epochDelay;
    const secs = Number.parseInt(resetTokens, 10);
    if (!Number.isNaN(secs) && secs > 0) return secs * 1000;
  }

  const remaining = getHeaderCaseInsensitive(headers, "remaining-tokens");
  const hadResetHint = Boolean(retryAfter || resetTokens);
  if (remaining === "0" && !hadResetHint) return 10_000;
  return undefined;
}

function headersFromObject(obj: unknown): HeaderBag | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as { response?: { headers?: unknown }; headers?: unknown };
  if (o.response?.headers && typeof o.response.headers === "object") {
    return o.response.headers as HeaderBag;
  }
  if (o.headers && typeof o.headers === "object") {
    return o.headers as HeaderBag;
  }
  return undefined;
}

/**
 * Walk `.cause` from the innermost LLMRetryError leaf and return the first HTTP header bag found.
 */
export function getHeaderBagFromUnknownError(err: unknown): HeaderBag | undefined {
  let e: unknown = unwrapLlmRetryErrorChain(err);
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 12 && e && typeof e === "object"; depth++) {
    if (seen.has(e)) break;
    seen.add(e);
    const bag = headersFromObject(e);
    if (bag) return bag;
    const next = (e as { cause?: unknown }).cause;
    if (next == null) break;
    e = next;
  }
  return undefined;
}

export type RateLimitLikelyBucket = "requests" | "tokens" | "both" | "unknown";

/** Best-effort: OpenAI-style `x-ratelimit-remaining-*` at zero usually marks the exhausted bucket. */
export function inferRateLimitBucket(headers: HeaderBag | undefined): RateLimitLikelyBucket {
  if (!headers) return "unknown";
  const remTok = getHeaderCaseInsensitive(headers, "x-ratelimit-remaining-tokens");
  const remReq = getHeaderCaseInsensitive(headers, "x-ratelimit-remaining-requests");
  const tokNum = remTok != null ? Number.parseInt(String(remTok), 10) : NaN;
  const reqNum = remReq != null ? Number.parseInt(String(remReq), 10) : NaN;
  const tok0 = Number.isFinite(tokNum) && tokNum === 0;
  const req0 = Number.isFinite(reqNum) && reqNum === 0;
  if (tok0 && req0) return "both";
  if (tok0) return "tokens";
  if (req0) return "requests";
  return "unknown";
}

/**
 * One-line summary for logs when a 429 / quota-style 403 fires (provider-dependent headers).
 */
export function formatProviderRateLimitHeaderSummary(err: unknown): string {
  const headers = getHeaderBagFromUnknownError(err);
  if (!headers) {
    return "provider headers: none parsed on error chain (RPM vs TPM not inferable from headers alone)";
  }
  const parts: string[] = [];
  const entries: Array<[label: string, headerName: string]> = [
    ["reqLim", "x-ratelimit-limit-requests"],
    ["reqRem", "x-ratelimit-remaining-requests"],
    ["reqReset", "x-ratelimit-reset-requests"],
    ["tokLim", "x-ratelimit-limit-tokens"],
    ["tokRem", "x-ratelimit-remaining-tokens"],
    ["tokReset", "x-ratelimit-reset-tokens"],
    ["retryAfter", "retry-after"],
    ["reqId", "x-request-id"],
    ["azReqId", "x-ms-request-id"],
  ];
  for (const [label, name] of entries) {
    const v = getHeaderCaseInsensitive(headers, name);
    if (v != null && String(v).trim() !== "") {
      const val = String(v).replace(/\s+/g, " ").trim();
      parts.push(`${label}=${val.length > 56 ? val.slice(0, 53) + "..." : val}`);
    }
  }
  const bucket = inferRateLimitBucket(headers);
  const hint =
    bucket === "unknown"
      ? "likely limit: unknown from headers (429 is often RPM or TPM; compare tokRem/reqRem when present)"
      : bucket === "both"
        ? "likely exhausted: requests+tokens per provider headers"
        : bucket === "tokens"
          ? "likely exhausted: token budget (TPM-style) per provider headers"
          : "likely exhausted: request budget (RPM-style) per provider headers";
  if (parts.length === 0) {
    return `provider headers: no known rate-limit keys on bag; ${hint}`;
  }
  return `${parts.join(", ")}; ${hint}`;
}
