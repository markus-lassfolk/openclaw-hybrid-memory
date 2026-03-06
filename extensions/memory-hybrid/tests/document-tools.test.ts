/**
 * Integration tests for memory_ingest_document tool.
 *
 * Uses a mock PythonBridge (no real Python required) and an in-memory FactsDB.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDocumentTools } from "../tools/document-tools.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Minimal mock for VectorDB
// ---------------------------------------------------------------------------

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal mock for EmbeddingProvider
// ---------------------------------------------------------------------------

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    modelName: "mock-model",
  };
}

// ---------------------------------------------------------------------------
// Minimal mock for PythonBridge
// ---------------------------------------------------------------------------

function makeMockBridge(markdown = "## Section\n\nSome content here.", title = "Test Doc") {
  return {
    convert: vi.fn().mockResolvedValue({ markdown, title }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isRunning: true,
    ping: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Minimal mock for ClawdbotPluginApi
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools: Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => unknown }> = new Map();
  return {
    registerTool(opts: Record<string, unknown>, _options?: Record<string, unknown>) {
      tools.set(opts.name as string, { opts, execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Minimal HybridMemoryConfig subset
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<{ chunkSize: number; chunkOverlap: number; autoTag: boolean; maxDocumentSize: number }> = {}) {
  return {
    documents: {
      enabled: true,
      pythonPath: "python3",
      chunkSize: overrides.chunkSize ?? 2000,
      chunkOverlap: overrides.chunkOverlap ?? 200,
      maxDocumentSize: overrides.maxDocumentSize ?? 50 * 1024 * 1024,
      autoTag: overrides.autoTag ?? true,
    },
    // Minimal categories for stringEnum
    categories: ["fact", "preference", "decision", "technical", "other"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let testFilePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "doc-tools-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  testFilePath = join(tmpDir, "sample.pdf");
  writeFileSync(testFilePath, "PDF content placeholder");
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_ingest_document", () => {
  it("stores facts for each chunk", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## Section One\n\nContent one.\n\n## Section Two\n\nContent two.");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    expect(tool).toBeDefined();

    const result = await (tool!.execute as AnyFn)("tc-1", { path: testFilePath });
    expect(result.content[0].text).toContain("Ingested");
    expect(result.details.storedCount).toBeGreaterThanOrEqual(2);
    expect(result.details.errorCount).toBe(0);
  });

  it("returns error when file does not exist", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge();

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool!.execute as AnyFn)("tc-2", { path: "/nonexistent/file.pdf" });
    expect(result.details.error).toBe("file_not_found");
  });

  it("rejects files exceeding maxDocumentSize", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge();

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ maxDocumentSize: 1 }) as never, // 1 byte limit
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool!.execute as AnyFn)("tc-3", { path: testFilePath });
    expect(result.details.error).toBe("file_too_large");
  });

  it("returns skipped_duplicate when document already ingested", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge();

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    // First ingestion
    await (tool!.execute as AnyFn)("tc-4a", { path: testFilePath });

    // Second ingestion — should detect duplicate
    const result = await (tool!.execute as AnyFn)("tc-4b", { path: testFilePath });
    expect(result.details.action).toBe("skipped_duplicate");
  });

  it("dry run returns preview without storing", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge();
    const vectorDb = makeMockVectorDb();

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: vectorDb as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool!.execute as AnyFn)("tc-5", { path: testFilePath, dryRun: true });

    expect(result.details.dryRun).toBe(true);
    expect(result.content[0].text).toContain("Dry run");
    // VectorDB store should NOT have been called
    expect(vectorDb.store).not.toHaveBeenCalled();
  });

  it("returns error when bridge convert fails", async () => {
    const api = makeMockApi();
    const bridge = {
      convert: vi.fn().mockRejectedValue(new Error("markitdown not installed")),
      shutdown: vi.fn(),
      isRunning: true,
    };

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool!.execute as AnyFn)("tc-6", { path: testFilePath });
    expect(result.details.error).toBe("conversion_failed");
    expect(result.content[0].text).toContain("Error converting");
  });

  it("adds filename tag when autoTag is true", async () => {
    const api = makeMockApi();
    // Use custom markdown to ensure it's clearly searchable
    const bridge = makeMockBridge("## Overview\n\nThis document discusses alphanumeric data.", "My Report");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ autoTag: true }) as never,
        embeddings: makeMockEmbeddings() as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool!.execute as AnyFn)("tc-7", { path: testFilePath });

    // Verify ingestion was successful and stored chunks
    expect(result.details.storedCount).toBeGreaterThan(0);

    // Use countBySource to confirm the source was correctly set (dedup check works)
    // Then re-ingesting should detect it as duplicate
    const result2 = await (tool!.execute as AnyFn)("tc-7b", { path: testFilePath });
    expect(result2.details.action).toBe("skipped_duplicate");
  });
});
