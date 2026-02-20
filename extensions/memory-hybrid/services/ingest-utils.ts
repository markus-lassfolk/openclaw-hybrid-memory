/**
 * Utilities for ingest-files CLI.
 * Exported for unit testing.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Expand glob patterns into absolute file paths under workspaceRoot.
 * Recursive patterns (e.g. skills/dir/*.md) walk subdirs; simple paths match single files.
 */
export function gatherIngestFiles(workspaceRoot: string, patterns: string[]): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push(full);
    }
  }

  for (const p of patterns) {
    if (p.includes("**")) {
      const base = p.split("**")[0].replace(/\/$/, "");
      const dir = join(workspaceRoot, base);
      walk(dir);
    } else {
      const fp = join(workspaceRoot, p);
      if (existsSync(fp)) {
        const st = statSync(fp);
        if (st.isFile()) out.push(fp);
      }
    }
  }

  return [...new Set(out)];
}
