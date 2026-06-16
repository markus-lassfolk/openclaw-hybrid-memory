/**
 * Per-folder CONTEXT.md generation (Issue #1917).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";

export type PerFolderContextResult = {
  pathsWritten: number;
  factsScanned: number;
};

const PATH_RE = /(?:\/[\w.-]+)+\/?/g;

/** Extract filesystem paths from fact text. */
export function extractPathsFromText(text: string): string[] {
  const matches = text.match(PATH_RE) ?? [];
  return [...new Set(matches.filter((p) => p.length > 3 && !p.startsWith("//")))];
}

/** Regenerate CONTEXT.md stubs under memory/projects for paths touched by recent decisions. */
export function regeneratePerFolderContext(
  factsDb: FactsDB,
  memoryDir: string,
  opts?: { days?: number; minFactsPerPath?: number },
): PerFolderContextResult {
  const days = opts?.days ?? 7;
  const minFacts = opts?.minFactsPerPath ?? 1;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
  const db = factsDb.getRawDb();
  const rows = db
    .prepare(
      `SELECT text, category, key, value, created_at FROM facts
       WHERE superseded_at IS NULL AND category IN ('decision', 'preference', 'milestone', 'project')
         AND created_at >= ?
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(cutoff) as Array<{
    text: string;
    category: string;
    key: string | null;
    value: string | null;
    created_at: number;
  }>;

  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    const blob = [row.text, row.key, row.value].filter(Boolean).join(" ");
    for (const path of extractPathsFromText(blob)) {
      const list = byPath.get(path) ?? [];
      const line = `- [${row.category}] ${row.text.slice(0, 200)}`;
      list.push(line);
      byPath.set(path, list);
    }
  }

  let pathsWritten = 0;
  for (const [path, lines] of byPath.entries()) {
    if (lines.length < minFacts) continue;
    const rel = path.replace(/^\/+/, "").replace(/\//g, "-");
    const outDir = join(memoryDir, "projects", rel);
    const outFile = join(outDir, "CONTEXT.md");
    mkdirSync(outDir, { recursive: true });
    const header = `# Context: ${path}\n\nRecent decisions touching this path:\n\n`;
    const body = [...new Set(lines)].slice(0, 20).join("\n");
    writeFileSync(outFile, `${header}${body}\n`, "utf8");
    pathsWritten++;
  }

  return { pathsWritten, factsScanned: rows.length };
}

/** True when memory/projects exists (for maintenance gating). */
export function perFolderContextTargetExists(memoryDir: string): boolean {
  return existsSync(join(memoryDir, "projects")) || existsSync(memoryDir);
}
