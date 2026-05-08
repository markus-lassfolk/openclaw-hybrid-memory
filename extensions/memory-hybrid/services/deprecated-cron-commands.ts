export interface DeprecatedCronToken {
  token: string;
  replacement?: string;
  note?: string;
}

export const DEPRECATED_HYBRID_MEM_CRON_TOKENS: readonly DeprecatedCronToken[] = [
  {
    token: "consolidate-episodes",
    replacement: "dream-cycle",
    note: "Old nightly dream-cycle step name; replaced by `openclaw hybrid-mem dream-cycle`.",
  },
];

function tokenRegex(token: string): RegExp {
  // Treat token as a word-like command/step name, not a substring of another identifier.
  return new RegExp(`(^|[^a-zA-Z0-9_-])${token}([^a-zA-Z0-9_-]|$)`, "i");
}

export function findDeprecatedHybridMemCronTokens(text: string): DeprecatedCronToken[] {
  const hits: DeprecatedCronToken[] = [];
  const input = text ?? "";
  for (const entry of DEPRECATED_HYBRID_MEM_CRON_TOKENS) {
    if (tokenRegex(entry.token).test(input)) hits.push(entry);
  }
  return hits;
}

export interface DeprecatedHmExitHit {
  token: DeprecatedCronToken;
  iso?: string;
  step?: string;
  exitCode?: number;
  line: string;
}

/**
 * Parse HM_EXIT content emitted by the cron bash harness:
 *   2026-05-08T06:47:17Z consolidate-episodes exit=1
 */
export function findDeprecatedTokensInHmExitContent(content: string): DeprecatedHmExitHit[] {
  const hits: DeprecatedHmExitHit[] = [];
  const lines = (content ?? "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+exit=(\d+)\b/);
    const iso = m?.[1];
    const step = m?.[2];
    const exitCode = m ? Number.parseInt(m[3] ?? "", 10) : undefined;
    for (const token of DEPRECATED_HYBRID_MEM_CRON_TOKENS) {
      if (tokenRegex(token.token).test(line) || (step && tokenRegex(token.token).test(step))) {
        hits.push({ token, iso, step, exitCode, line });
      }
    }
  }
  return hits;
}
