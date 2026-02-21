/**
 * Export memory to vanilla OpenClaw–compatible MEMORY.md + memory/ directory layout.
 * Plain markdown, no frontmatter. One file per fact. Filterable by source and credentials.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";

export type ExportOpts = {
  /** Output directory (must exist or be creatable). */
  outputPath: string;
  /** Exclude credential pointer facts (entity "Credentials"). Default true. */
  excludeCredentials?: boolean;
  /** Include credential pointer facts. Overrides excludeCredentials when true. */
  includeCredentials?: boolean;
  /** Filter by fact source (e.g. conversation, distillation, cli, ingest, reflection). Empty = all. */
  sources?: string[];
  /** replace = clear output dir first; additive = add/overwrite only (always overwrite on conflict). */
  mode?: "replace" | "additive";
};

export type ExportResult = {
  factsExported: number;
  proceduresExported: number;
  filesWritten: number;
  outputPath: string;
};

/** Sanitize a string for use as a filesystem-safe filename (no path separators, no special chars). */
function sanitizeFileName(s: string): string {
  return s
    .replace(/[/\\?*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

/** Format fact text for vanilla-compatible markdown (backfill can re-extract). */
function formatFactContent(entry: MemoryEntry): string {
  const parts: string[] = [];
  if (entry.entity && entry.key && entry.value) {
    parts.push(`${entry.entity}'s ${entry.key} is ${entry.value}.`);
  }
  if (entry.text && !parts.some((p) => p.includes(entry.text!.slice(0, 30)))) {
    parts.push(entry.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : entry.text;
}

/** Generate unique filename for a fact. */
function factFileName(entry: MemoryEntry): string {
  const slug = sanitizeFileName(entry.text.slice(0, 50));
  const shortId = entry.id.slice(0, 8);
  return `${slug}-${shortId}.md`;
}

/** Category → directory name. */
function categoryDir(category: string): string {
  const safe = sanitizeFileName(category);
  return safe || "other";
}

/** Subdir by tag if present, else "general". */
function tagSubdir(tags: string[] | null | undefined): string {
  const first = tags?.[0];
  return first ? sanitizeFileName(first) : "general";
}

export function runExport(
  factsDb: FactsDB,
  opts: ExportOpts,
  versionInfo: { pluginVersion: string; schemaVersion: number },
): ExportResult {
  const { outputPath, mode = "replace", sources = [], excludeCredentials = true, includeCredentials = false } = opts;

  const includeCreds = includeCredentials || !excludeCredentials;
  const sourceSet = new Set(sources.map((s) => s.toLowerCase().trim()).filter(Boolean));

  const all = factsDb.getAll({ includeSuperseded: false });
  let facts = all.filter((f) => {
    if (!includeCreds && (f.entity?.toLowerCase() === "credentials" || f.category === "credential")) return false;
    if (sourceSet.size > 0) {
      const src = (f.source ?? "conversation").toLowerCase();
      if (!sourceSet.has(src)) return false;
    }
    return true;
  });

  const procedures = factsDb.listProcedures(10_000);

  if (mode === "replace" && existsSync(outputPath)) {
    const entries = readdirSync(outputPath);
    for (const e of entries) {
      rmSync(join(outputPath, e), { recursive: true, force: true });
    }
  }

  mkdirSync(outputPath, { recursive: true });
  const memoryDir = join(outputPath, "memory");
  mkdirSync(memoryDir, { recursive: true });

  let filesWritten = 0;

  // Group facts by category
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const f of facts) {
    const cat = categoryDir(f.category);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f);
  }

  const memLinks: string[] = [];

  for (const [cat, entries] of byCategory) {
    const catDir = join(memoryDir, cat);
    mkdirSync(catDir, { recursive: true });

    // Optionally use tag subdirs
    const byTag = new Map<string, MemoryEntry[]>();
    for (const e of entries) {
      const sub = tagSubdir(e.tags);
      if (!byTag.has(sub)) byTag.set(sub, []);
      byTag.get(sub)!.push(e);
    }

    for (const [sub, items] of byTag) {
      const subDir = sub === "general" ? catDir : join(catDir, sub);
      if (sub !== "general") mkdirSync(subDir, { recursive: true });

      for (const entry of items) {
        const fname = factFileName(entry);
        const relPath = sub === "general" ? join(cat, fname) : join(cat, sub, fname);
        const fullPath = join(memoryDir, relPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        const content = formatFactContent(entry);
        writeFileSync(fullPath, content, "utf-8");
        filesWritten++;
        memLinks.push(`- [[memory/${relPath.replace(/\\/g, "/")}]] — ${entry.text.slice(0, 60)}${entry.text.length > 60 ? "…" : ""}`);
      }
    }
  }

  // Procedures: memory/procedures/
  const procDir = join(memoryDir, "procedures");
  mkdirSync(procDir, { recursive: true });
  for (const p of procedures) {
    const slug = sanitizeFileName(p.taskPattern.slice(0, 40));
    const fname = `${slug}-${p.id.slice(0, 8)}.md`;
    const fullPath = join(procDir, fname);
    const content = `# Procedure: ${p.taskPattern}\n\nType: ${p.procedureType}\nConfidence: ${p.confidence}\n\n## Steps\n\n${p.recipeJson}`;
    writeFileSync(fullPath, content, "utf-8");
    filesWritten++;
    memLinks.push(`- [[memory/procedures/${fname}]] — ${p.taskPattern.slice(0, 50)}${p.taskPattern.length > 50 ? "…" : ""}`);
  }

  // MEMORY.md root index
  const memContent = `# Long-Term Memory Index

Exported from memory-hybrid v${versionInfo.pluginVersion} (schema ${versionInfo.schemaVersion}).

## Facts by Category

${Array.from(byCategory.keys())
  .sort()
  .map((c) => `### ${c}\n- See \`memory/${c}/\`\n`)
  .join("\n")}

## Procedures

- See \`memory/procedures/\`

## Index (all exported items)

${memLinks.slice(0, 200).join("\n")}
${memLinks.length > 200 ? `\n... and ${memLinks.length - 200} more\n` : ""}
`;
  writeFileSync(join(outputPath, "MEMORY.md"), memContent, "utf-8");
  filesWritten++;

  // manifest.json (increment filesWritten first to include manifest itself)
  filesWritten++;
  const manifest = {
    version: versionInfo.pluginVersion,
    schemaVersion: versionInfo.schemaVersion,
    exportedAt: new Date().toISOString(),
    factsExported: facts.length,
    proceduresExported: procedures.length,
    filesWritten,
    filters: {
      excludeCredentials: !includeCreds,
      sources: sources.length > 0 ? sources : null,
      mode,
    },
  };
  writeFileSync(join(outputPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  return {
    factsExported: facts.length,
    proceduresExported: procedures.length,
    filesWritten,
    outputPath,
  };
}
