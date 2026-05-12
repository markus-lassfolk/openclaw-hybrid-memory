/** Redaction helpers for pending-autopilot audit and summary output (#1334). */

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;}{\]]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

const PRIVATE_KEY_BEGIN = "-----BEGIN ";
const PRIVATE_KEY_END = "-----END ";
const PRIVATE_KEY_FOOTER = " PRIVATE KEY-----";
const MAX_PRIVATE_KEY_BLOCK_LENGTH = 64_000;

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
    if (headerEnd === -1 || !text.slice(begin, headerEnd + 5).endsWith(PRIVATE_KEY_FOOTER)) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const headerLabel = text.slice(begin + PRIVATE_KEY_BEGIN.length, headerEnd);
    if (!headerLabel.endsWith(" PRIVATE KEY")) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const label = headerLabel.slice(0, -" PRIVATE KEY".length);
    if (!/^[A-Z0-9 ]{1,48}$/.test(label)) {
      redacted += text.slice(cursor, begin + PRIVATE_KEY_BEGIN.length);
      cursor = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    const footer = `${PRIVATE_KEY_END}${label}${PRIVATE_KEY_FOOTER}`;
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
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (/password|passwd|pwd|secret|token|api[_-]?key|authorization/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactAutopilotValue(child);
      }
    }
    return out;
  }
  return value;
}
