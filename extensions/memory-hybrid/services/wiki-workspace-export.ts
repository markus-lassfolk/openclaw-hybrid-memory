/**
 * Wiki workspace mirror — incremental markdown export under `{workspace}/memory/hybrid-wiki/`.
 *
 * This is a **supplement** to `publicArtifacts` (the primary memory-wiki bridge path):
 * - Human-readable browse/edit in the workspace
 * - Fallback when memory-wiki file-based import is enabled
 * - Does NOT replace or overwrite the user's root MEMORY.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { globalOnlyScopeFilter } from "../utils/scope-filter.js";
import { nowIso } from "../utils/dates.js";
import { traceIntegration } from "../utils/integration-trace.js";
import { pluginLogger } from "../utils/logger.js";
import { isWikiExportableFact, wikiFactKind, wikiFactTitle, wikiFactUpdatedIso } from "./wiki-fact-filter.js";

/** Relative to OpenClaw workspace root. */
export const WIKI_WORKSPACE_EXPORT_SUBDIR = "memory/hybrid-wiki";

export type WikiWorkspaceExportResult = {
  factsWritten: number;
  factsSkipped: number;
  filesRemoved: number;
  exportRoot: string;
};

function sanitizeDirSegment(value: string): string {
  const out = value
    .replace(/[/\\?*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (!out || out === "." || out === "..") return "other";
  return out;
}

function factRelativePath(entry: MemoryEntry): string {
  const category = sanitizeDirSegment(entry.category || "other");
  return join(category, `${entry.id}.md`);
}

export function formatWikiFactMarkdown(entry: MemoryEntry): string {
  const title = wikiFactTitle(entry);
  const lines: string[] = [`# ${title}`, "", entry.text.trim(), "", "## Metadata", ""];

  lines.push(`- **ID:** \`${entry.id}\``);
  lines.push(`- **Category:** ${entry.category}`);
  lines.push(`- **Kind:** ${wikiFactKind(entry)}`);
  lines.push(`- **Confidence:** ${entry.confidence}`);
  if (entry.source) lines.push(`- **Source:** ${entry.source}`);
  if (entry.entity) lines.push(`- **Entity:** ${entry.entity}`);
  if (entry.key) lines.push(`- **Key:** ${entry.key}`);
  if (entry.value) lines.push(`- **Value:** ${entry.value}`);
  if (entry.tags?.length) lines.push(`- **Tags:** ${entry.tags.join(", ")}`);
  lines.push(`- **Updated:** ${wikiFactUpdatedIso(entry)}`);

  lines.push("");
  lines.push(
    "_Auto-synced from hybrid-memory for memory-wiki / Dreaming UI. Prefer `hybrid-mem.facts.*` mutations for edits._",
  );
  lines.push("");

  return lines.join("\n");
}

function collectMarkdownFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectMarkdownFiles(full, acc);
    } else if (name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

export function syncWikiWorkspaceExport(
  factsDb: FactsDB,
  workspaceRoot: string,
  verbose = false,
): WikiWorkspaceExportResult {
  const exportRoot = resolve(workspaceRoot, WIKI_WORKSPACE_EXPORT_SUBDIR);
  mkdirSync(exportRoot, { recursive: true });

  const facts = factsDb
    .getAll({ scopeFilter: globalOnlyScopeFilter(), includeSuperseded: false })
    .filter(isWikiExportableFact);
  const expectedPaths = new Set<string>();
  let factsWritten = 0;
  let factsSkipped = 0;

  for (const entry of facts) {
    const rel = factRelativePath(entry);
    expectedPaths.add(rel.replace(/\\/g, "/"));
    const fullPath = join(exportRoot, rel);
    mkdirSync(join(fullPath, ".."), { recursive: true });

    const nextContent = formatWikiFactMarkdown(entry);
    let needsWrite = true;
    if (existsSync(fullPath)) {
      try {
        needsWrite = readFileSync(fullPath, "utf-8") !== nextContent;
      } catch {
        needsWrite = true;
      }
    }

    if (needsWrite) {
      writeFileSync(fullPath, nextContent, "utf-8");
      factsWritten++;
      traceIntegration(verbose, `wiki workspace export wrote ${rel} (${entry.id})`);
    } else {
      factsSkipped++;
      traceIntegration(verbose, `wiki workspace export skipped unchanged ${rel}`);
    }
  }

  let filesRemoved = 0;
  for (const filePath of collectMarkdownFiles(exportRoot)) {
    const rel = relative(exportRoot, filePath).replace(/\\/g, "/");
    if (!expectedPaths.has(rel)) {
      try {
        rmSync(filePath, { force: true });
        filesRemoved++;
        traceIntegration(verbose, `wiki workspace export removed stale ${rel}`);
      } catch (err) {
        pluginLogger.warn?.(
          `memory-hybrid: wiki workspace export — failed to remove stale file ${rel}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  writeFileSync(
    join(exportRoot, ".hybrid-wiki-sync.json"),
    JSON.stringify(
      {
        syncedAt: nowIso(),
        factCount: facts.length,
        factsWritten,
        factsSkipped,
        filesRemoved,
      },
      null,
      2,
    ),
    "utf-8",
  );

  if (verbose || factsWritten > 0 || filesRemoved > 0) {
    pluginLogger.info(
      `memory-hybrid: wiki workspace export — wrote ${factsWritten}, skipped ${factsSkipped}, removed ${filesRemoved} stale file(s) → ${WIKI_WORKSPACE_EXPORT_SUBDIR}/`,
    );
  }

  return { factsWritten, factsSkipped, filesRemoved, exportRoot };
}
