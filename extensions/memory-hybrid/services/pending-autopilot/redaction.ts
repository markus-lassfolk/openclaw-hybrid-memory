/** Redaction helpers for pending-autopilot audit and summary output (#1334). */

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])-[-_a-zA-Z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;}{\]]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

export function redactAutopilotText(input: unknown): { redacted: string; redactionCount: number } {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  let redactionCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return "[REDACTED]";
    });
  }
  return { redacted: text, redactionCount };
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
