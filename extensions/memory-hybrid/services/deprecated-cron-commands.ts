import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DeprecatedCronToken {
  token: string;
  replacement?: string;
  note?: string;
}

export const DEPRECATED_HYBRID_MEM_CRON_TOKENS: readonly DeprecatedCronToken[] = [
  {
    token: "hybrid-mem analyze-maintenance-logs",
    replacement: "maintenance analyze-logs",
    note: "Flat `analyze-maintenance-logs` subcommand moved under `hybrid-mem maintenance analyze-logs`.",
  },
  {
    token: "workshop remind-pending",
    replacement: "digest pending --since 7d",
    note: "Removed `hybrid-mem workshop` CLI subcommand; use `openclaw hybrid-mem digest pending`.",
  },
  {
    token: "consolidate-episodes",
    replacement: "dream-cycle",
    note: "Old nightly dream-cycle step name; replaced by `openclaw hybrid-mem dream-cycle`.",
  },
  {
    token: "enrich-entities --limit 500",
    replacement: `enrich-entities --limit "\${HYBRID_MEM_CLI_JOB_ENRICH_LIMIT:-25}" --verbose`,
    note: "Old monthly-consolidation entity enrichment cap was too large for live throughput; use the safe configurable cap.",
  },
  {
    token: "audit health --strict --json",
    replacement: "audit health --strict-errors --json",
    note: "Weekly audit-health cron should use --strict-errors so sustained store-backlog warnings do not hard-fail (#1955).",
  },
  {
    token: "Workshop approval reminder. Run:",
    note: "Free-form workshop reminder predates bash harness digest step (#1962).",
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

export interface DeprecatedWrapperScriptHit {
  path: string;
  token: DeprecatedCronToken;
}

/** Scan shell/script files for deprecated hybrid-mem CLI tokens (#1990). */
export function findDeprecatedTokensInWrapperScripts(roots: string[]): DeprecatedWrapperScriptHit[] {
  const hits: DeprecatedWrapperScriptHit[] = [];
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
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
        if (st.isDirectory()) {
          if (name === "node_modules" || name.startsWith(".")) continue;
          walk(full);
          continue;
        }
        if (!/\.(sh|bash|inc\.sh)$/.test(name)) continue;
        const content = readFileSync(full, "utf-8");
        for (const token of findDeprecatedHybridMemCronTokens(content)) {
          const key = `${full}::${token.token}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ path: full, token });
        }
      } catch {
        /* skip unreadable */
      }
    }
  };
  for (const root of roots) walk(root);
  return hits;
}
