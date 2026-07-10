/** Redaction helpers for pending-autopilot audit and summary output (#1334). */

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // `[\s"']*` (not just `\s*`) tolerates a JSON-style closing quote between the keyword and the
  // `:`/`=` (e.g. `{"password":"hunter2"}`), which the original whitespace-only gap missed
  // entirely — any JSON-quoted credential key produced zero redactions.
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\b[\s"']*[:=]\s*[^\s,;}{[\]]+/gi,
  // The `\b` above only matches when the keyword is preceded by a non-word character, so a
  // keyword glued directly onto a lowercase prefix with no separator -- the classic camelCase
  // compound-identifier form (`sessionToken:`, `authToken:`, `clientSecret:`, `refreshToken:`)
  // -- was invisible to it, since a lowercase letter followed by an uppercase letter is not a
  // `\b` transition. Case-sensitive (not `i`) so the capitalized suffix reliably signals a
  // compound boundary rather than matching case-insensitively at arbitrary positions.
  /(?<=[a-z0-9])(?:Password|Passwd|Pwd|Secret|Token|Api[_-]?Key|Authorization)\b[\s"']*[:=]\s*[^\s,;}{[\]]+/g,
  // Same gap for underscore-joined compounds (`auth_token:`, `client_secret:`) -- `_` is a word
  // character, so the plain `\b` above doesn't create a boundary there either.
  /(?<=_)(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\b[\s"']*[:=]\s*[^\s,;}{[\]]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

const PRIVATE_KEY_BEGIN = "-----BEGIN ";
const PRIVATE_KEY_END = "-----END ";
const PRIVATE_KEY_FOOTER = " PRIVATE KEY-----";
const PRIVATE_KEY_BARE_FOOTER = "PRIVATE KEY-----";
const MAX_PRIVATE_KEY_BLOCK_LENGTH = 64_000;

const CREDENTIAL_KEY_NORMALIZED = new Set(
  [
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "apikey",
    "apiSecret",
    "authorization",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "clientsecret",
    "privatekey",
    "secretkey",
    "encryptionkey",
  ].map((key) => key.toLowerCase()),
);

export function redactAutopilotText(input: unknown): { redacted: string; redactionCount: number } {
  let { text, redactionCount } = redactPrivateKeyBlocks(
    typeof input === "string" ? input : JSON.stringify(input ?? ""),
  );
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return "[REDACTED]";
    });
  }
  return { redacted: text, redactionCount };
}

function redactPrivateKeyBlocks(text: string): { text: string; redactionCount: number } {
  let cursor = 0;
  let redactionCount = 0;
  let redacted = "";
  while (cursor < text.length) {
    const begin = text.indexOf(PRIVATE_KEY_BEGIN, cursor);
    if (begin === -1) {
      redacted += text.slice(cursor);
      break;
    }
    const headerEnd = text.indexOf("-----", begin + PRIVATE_KEY_BEGIN.length);
    if (headerEnd === -1 || !text.slice(begin, headerEnd + 5).endsWith(PRIVATE_KEY_BARE_FOOTER)) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const headerLabel = text.slice(begin + PRIVATE_KEY_BEGIN.length, headerEnd);
    if (headerLabel !== "PRIVATE KEY" && !headerLabel.endsWith(" PRIVATE KEY")) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const label = headerLabel === "PRIVATE KEY" ? "" : headerLabel.slice(0, -" PRIVATE KEY".length);
    if (label.length > 0 && !/^[A-Z0-9 ]{1,48}$/.test(label)) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const footer =
      label.length > 0
        ? `${PRIVATE_KEY_END}${label}${PRIVATE_KEY_FOOTER}`
        : `${PRIVATE_KEY_END}${PRIVATE_KEY_BARE_FOOTER}`;
    const end = text.indexOf(footer, headerEnd + 5);
    if (end === -1 || end >= begin + MAX_PRIVATE_KEY_BLOCK_LENGTH) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    redacted += `${text.slice(cursor, begin)}[REDACTED]`;
    redactionCount += 1;
    cursor = end + footer.length;
  }
  return { text: redacted, redactionCount };
}

export function redactAutopilotValue(value: unknown): unknown {
  if (typeof value === "string") return redactAutopilotText(value).redacted;
  if (Array.isArray(value)) return value.map((v) => redactAutopilotValue(v));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactAutopilotText(value.toString()).redacted;
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, child]) => [
        redactAutopilotValue(key),
        typeof key === "string" && isCredentialKey(key) ? "[REDACTED]" : redactAutopilotValue(child),
      ]),
    );
  }
  if (value instanceof Set) return new Set([...value.values()].map((v) => redactAutopilotValue(v)));
  if (value && typeof value === "object") {
    const maybeToJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJson === "function" && Object.getPrototypeOf(value) !== Object.prototype) {
      return redactAutopilotValue(maybeToJson.call(value));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactAutopilotValue(child);
      }
    }
    return out;
  }
  return value;
}

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/g, "").toLowerCase();
  return CREDENTIAL_KEY_NORMALIZED.has(normalized);
}

/**
 * Like redactAutopilotValue, but only redacts a credential-keyed field when its value is a plain
 * string (a literal secret) -- a SecretRef object (`{ source: "env"|"file", ... }`, this
 * codebase's pointer-to-a-secret shape) carries no secret material itself, just metadata about
 * where to resolve one, so blanket-redacting it would destroy useful non-sensitive preview
 * information (e.g. which env var a key comes from) for no security benefit. Intended for
 * displaying a raw, not-yet-parsed config object (e.g. an install/upgrade dry-run preview) where
 * SecretRef objects must survive intact but literal secret strings must not (#2067-followup).
 */
export function redactCredentialStringsOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactCredentialStringsOnly(v));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialKey(key) && typeof child === "string" && child.length > 0) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactCredentialStringsOnly(child);
      }
    }
    return out;
  }
  return value;
}
