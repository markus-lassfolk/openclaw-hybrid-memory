import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function escapeRegExpLiteral(token: string): string {
  return token.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function tokenRegex(token: string): RegExp {
  // Treat token as a word-like command/step name, not a substring of another identifier.
  const escaped = escapeRegExpLiteral(token);
  return new RegExp(`(^|[^a-zA-Z0-9_-])${escaped}([^a-zA-Z0-9_-]|$)`, "i");
}

/**
 * Collect `.exit.txt` paths under the cron hybrid-mem log root modified on or after `cutoffMs`.
 * Walks recursively so both flat layouts (`logs/cron-hybrid-mem/*.exit.txt`) and dated subfolders are included.
 */
export function collectRecentHmExitLedgerPaths(logsRoot: string, cutoffMs: number): string[] {
  const paths: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && name.endsWith(".exit.txt") && st.mtimeMs >= cutoffMs) {
          paths.push(full);
        } else if (st.isDirectory()) {
          walk(full);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  if (existsSync(logsRoot)) walk(logsRoot);
  return paths
    .map((p) => {
      try {
        return { p, m: statSync(p).mtimeMs };
      } catch {
        return { p, m: 0 };
      }
    })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
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
