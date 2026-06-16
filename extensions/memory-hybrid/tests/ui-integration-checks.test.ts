import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWikiWorkspaceMirror } from "../cli/verify/ui-integration-checks.js";
import { syncWikiWorkspaceExport, WIKI_WORKSPACE_EXPORT_SUBDIR } from "../services/wiki-workspace-export.js";
import type { HybridMemoryConfig } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";

function makeCfg(overrides: Partial<HybridMemoryConfig["wikiIntegration"]> = {}): HybridMemoryConfig {
  return {
    wikiIntegration: {
      enabled: true,
      publicArtifacts: true,
      corpusSupplement: true,
      workspaceExportIntervalMinutes: 30,
      mutations: { enabled: false },
      ...overrides,
    },
  } as HybridMemoryConfig;
}

function makeFact(id: string): MemoryEntry {
  return {
    id,
    text: "Sample fact",
    category: "general",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1717200000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1717200000,
    confidence: 0.8,
  };
}

describe("ui-integration-checks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ui-integration-check-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports mirror disabled when interval is 0", () => {
    const factsDb = { getAll: vi.fn(() => []) } as any;
    const result = inspectWikiWorkspaceMirror(makeCfg({ workspaceExportIntervalMinutes: 0 }), tmpDir, factsDb);

    expect(result.enabled).toBe(false);
    expect(result.intervalMinutes).toBe(0);
  });

  it("reads sync metadata and counts markdown files", () => {
    const factsDb = {
      getAll: vi.fn(() => [makeFact("fact-a"), makeFact("fact-b")]),
    } as any;

    syncWikiWorkspaceExport(factsDb, tmpDir);

    const result = inspectWikiWorkspaceMirror(makeCfg(), tmpDir, factsDb);

    expect(result.enabled).toBe(true);
    expect(result.directoryExists).toBe(true);
    expect(result.markdownFileCount).toBe(2);
    expect(result.exportableFactCount).toBe(2);
    expect(result.lastSyncedAt).toBeTruthy();
    expect(result.lastSyncFactCount).toBe(2);
    expect(result.exportRoot).toBe(join(tmpDir, WIKI_WORKSPACE_EXPORT_SUBDIR));
  });

  it("detects stale mirror when DB has more facts than last sync", () => {
    let facts = [makeFact("fact-a")];
    const factsDb = { getAll: vi.fn(() => facts) } as any;

    syncWikiWorkspaceExport(factsDb, tmpDir);
    facts = [makeFact("fact-a"), makeFact("fact-b")];

    const result = inspectWikiWorkspaceMirror(makeCfg(), tmpDir, factsDb);
    expect(result.exportableFactCount).toBe(2);
    expect(result.lastSyncFactCount).toBe(1);
  });

  it("handles missing mirror directory", () => {
    const factsDb = { getAll: vi.fn(() => [makeFact("x")]) } as any;
    const result = inspectWikiWorkspaceMirror(makeCfg(), tmpDir, factsDb);

    expect(result.enabled).toBe(true);
    expect(result.directoryExists).toBe(false);
    expect(result.markdownFileCount).toBe(0);
  });

  it("parses corrupt sync metadata gracefully", () => {
    const exportRoot = join(tmpDir, WIKI_WORKSPACE_EXPORT_SUBDIR);
    mkdirSync(exportRoot, { recursive: true });
    writeFileSync(join(exportRoot, ".hybrid-wiki-sync.json"), "{not json", "utf-8");

    const factsDb = { getAll: vi.fn(() => []) } as any;
    const result = inspectWikiWorkspaceMirror(makeCfg(), tmpDir, factsDb);

    expect(result.lastSyncedAt).toBeNull();
    expect(result.lastSyncFactCount).toBeNull();
  });
});
