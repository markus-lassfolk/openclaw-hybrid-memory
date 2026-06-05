import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryEntry } from "../types/memory.js";
import {
  formatWikiFactMarkdown,
  syncWikiWorkspaceExport,
  WIKI_WORKSPACE_EXPORT_SUBDIR,
} from "../services/wiki-workspace-export.js";

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "aabb0011-0000-0000-0000-000000000001",
    text: "TypeScript is a typed superset of JavaScript",
    category: "technical",
    importance: 0.8,
    entity: "TypeScript",
    key: "description",
    value: "typed superset",
    source: "conversation",
    createdAt: 1717200000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1717200000,
    confidence: 0.9,
    ...overrides,
  };
}

describe("wiki-workspace-export", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wiki-export-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes exportable facts under memory/hybrid-wiki/", () => {
    const factsDb = {
      getAll: vi.fn(() => [makeFact()]),
    } as any;

    const result = syncWikiWorkspaceExport(factsDb, tmpDir);

    expect(result.factsWritten).toBe(1);
    expect(result.exportRoot).toBe(join(tmpDir, WIKI_WORKSPACE_EXPORT_SUBDIR));

    const files = readdirSync(join(result.exportRoot, "technical"));
    expect(files).toHaveLength(1);

    const content = readFileSync(join(result.exportRoot, "technical", files[0]!), "utf-8");
    expect(content).toContain("TypeScript is a typed superset");
    expect(content).toContain("## Metadata");
    expect(existsSync(join(result.exportRoot, ".hybrid-wiki-sync.json"))).toBe(true);
  });

  it("skips credential and internal sentinel facts", () => {
    const factsDb = {
      getAll: vi.fn(() => [
        makeFact({
          id: "cred-1",
          text: "API key",
          category: "credential",
          entity: "Credentials",
        }),
        makeFact({
          id: "sentinel-1",
          text: "ingested",
          category: "meta",
          entity: "system",
          key: "dream-ingested-run:run-001",
          tags: ["dream-ingester-sentinel"],
        }),
        makeFact({ id: "good-1", text: "User prefers dark mode", category: "preference", entity: null, key: null, value: null }),
      ]),
    } as any;

    const result = syncWikiWorkspaceExport(factsDb, tmpDir);

    expect(result.factsWritten).toBe(1);
    expect(existsSync(join(result.exportRoot, "credential"))).toBe(false);
    expect(readdirSync(join(result.exportRoot, "preference"))).toHaveLength(1);
  });

  it("removes stale markdown when facts disappear", () => {
    let facts = [makeFact({ id: "old-fact-id-000000000001" })];
    const factsDb = {
      getAll: vi.fn(() => facts),
    } as any;

    syncWikiWorkspaceExport(factsDb, tmpDir);
    facts = [];

    const second = syncWikiWorkspaceExport(factsDb, tmpDir);
    expect(second.filesRemoved).toBe(1);
  });

  it("does not rewrite unchanged files on second sync", () => {
    const factsDb = {
      getAll: vi.fn(() => [makeFact()]),
    } as any;

    const first = syncWikiWorkspaceExport(factsDb, tmpDir);
    expect(first.factsWritten).toBe(1);

    const second = syncWikiWorkspaceExport(factsDb, tmpDir);
    expect(second.factsWritten).toBe(0);
    expect(second.factsSkipped).toBe(1);
  });

  it("formatWikiFactMarkdown includes title and metadata", () => {
    const entry = makeFact({ text: "React uses a virtual DOM", entity: "React", key: "architecture" });
    const md = formatWikiFactMarkdown(entry);
    expect(md).toContain("# React / architecture");
    expect(md).toContain("React uses a virtual DOM");
    expect(md).toContain(`**ID:** \`${entry.id}\``);
  });
});
