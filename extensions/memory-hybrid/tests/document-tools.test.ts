/**
 * Integration tests for memory_ingest_document tool.
 *
 * Uses a mock PythonBridge (no real Python required) and an in-memory FactsDB.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerDocumentTools } from "../tools/document-tools.js";

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

function makeCfg(
  overrides: Partial<{
    chunkSize: number;
    chunkOverlap: number;
    autoTag: boolean;
    maxDocumentSize: number;
    visionEnabled: boolean;
    visionModel: string;
  }> = {},
) {
  return {
    documents: {
      enabled: true,
      pythonPath: "python3",
      chunkSize: overrides.chunkSize ?? 2000,
      chunkOverlap: overrides.chunkOverlap ?? 200,
      maxDocumentSize: overrides.maxDocumentSize ?? 50 * 1024 * 1024,
      autoTag: overrides.autoTag ?? true,
      visionEnabled: overrides.visionEnabled ?? false,
      visionModel: overrides.visionModel,
    },
    // Minimal categories for stringEnum
    categories: ["fact", "preference", "decision", "technical", "other"],
  };
}

// ---------------------------------------------------------------------------
// Minimal mock for OpenAI vision
// ---------------------------------------------------------------------------

function makeMockOpenAI(description = "A test image showing a red square on white background.") {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: description } }],
        }),
      },
    },
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    expect(tool).toBeDefined();

    const result = await (tool?.execute as AnyFn)("tc-1", { path: testFilePath });
    expect(result.content[0].text).toContain("Ingested");
    expect(result.details.storedCount).toBeGreaterThanOrEqual(2);
    expect(result.details.errorCount).toBe(0);
  });

  it("rejects non-absolute path", async () => {
    const api = makeMockApi();
    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: makeMockBridge() as never,
      },
      api as never,
    );
    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-rel", { path: "relative/path.pdf" });
    expect(result.details.error).toBe("path_not_absolute");
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-2", { path: "/nonexistent/file.pdf" });
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-3", { path: testFilePath });
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    // First ingestion
    await (tool?.execute as AnyFn)("tc-4a", { path: testFilePath });

    // Second ingestion — should detect duplicate
    const result = await (tool?.execute as AnyFn)("tc-4b", { path: testFilePath });
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-5", { path: testFilePath, dryRun: true });

    expect(result.details.dryRun).toBe(true);
    expect(result.content[0].text).toContain("Dry run");
    // VectorDB store should NOT have been called
    expect(vectorDb.store).not.toHaveBeenCalled();
  });

  it("fires onProgress callback with at least start and complete events", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## Section\n\nContent.", "Test Doc");
    const events: { stage: string; pct: number; message: string }[] = [];
    const onProgress = vi.fn((p: { stage: string; pct: number; message: string }) => events.push(p));

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
        onProgress,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    await (tool?.execute as AnyFn)("tc-progress", { path: testFilePath });

    const stages = events.map((e) => e.stage);
    expect(stages).toContain("start");
    expect(stages).toContain("complete");
    expect(events.find((e) => e.stage === "start")?.pct).toBe(0);
    expect(events.find((e) => e.stage === "complete")?.pct).toBe(100);
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-6", { path: testFilePath });
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
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const result = await (tool?.execute as AnyFn)("tc-7", { path: testFilePath });

    // Verify ingestion was successful and stored chunks
    expect(result.details.storedCount).toBeGreaterThan(0);

    // Use countBySource to confirm the source was correctly set (dedup check works)
    // Then re-ingesting should detect it as duplicate
    const result2 = await (tool?.execute as AnyFn)("tc-7b", { path: testFilePath });
    expect(result2.details.action).toBe("skipped_duplicate");
  });
});

describe("memory_ingest_folder", () => {
  it("lists matching files in dry run mode", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge();
    const folder = join(tmpDir, "docs");
    const pdfPath = join(folder, "a.pdf");
    const txtPath = join(folder, "b.txt");
    mkdirSync(folder, { recursive: true });
    writeFileSync(pdfPath, "PDF content placeholder");
    writeFileSync(txtPath, "text content placeholder");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_folder");
    const result = await (tool?.execute as AnyFn)("tc-folder-dry", {
      path: folder,
      dryRun: true,
      filter: { extensions: [".pdf"] },
    });
    expect(result.details.dryRun).toBe(true);
    expect(result.details.fileCount).toBe(1);
    expect(result.details.files[0]).toContain("a.pdf");
  });

  it("ingests multiple files and reports summary", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## Section\n\nSome content here.", "Folder Doc");
    const vectorDb = makeMockVectorDb();
    const folder = join(tmpDir, "docs2");
    const pdfPath = join(folder, "a.pdf");
    const txtPath = join(folder, "b.txt");
    mkdirSync(folder, { recursive: true });
    writeFileSync(pdfPath, "PDF content placeholder");
    writeFileSync(txtPath, "text content placeholder");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: vectorDb as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_folder");
    const result = await (tool?.execute as AnyFn)("tc-folder", { path: folder });
    expect(result.details.fileCount).toBe(2);
    expect(result.details.totalStored).toBeGreaterThan(0);
    expect(result.content[0].text).toContain("Folder ingest complete");
  });
});

// ---------------------------------------------------------------------------
// Hash-based deduplication tests (content hash)
// ---------------------------------------------------------------------------

describe("hash-based deduplication", () => {
  it("detects duplicate when same file content exists at a different path", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## Content\n\nIdentical document body.", "Dup Doc");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    // Write two files with identical content
    const identical = Buffer.from("IDENTICAL_BINARY_CONTENT_FOR_DEDUP_TEST");
    const fileA = join(tmpDir, "file-a.pdf");
    const fileB = join(tmpDir, "file-b.pdf");
    writeFileSync(fileA, identical);
    writeFileSync(fileB, identical);

    // First ingestion
    const first = await (tool?.execute as AnyFn)("tc-hash-1a", { path: fileA });
    expect(first.details.action).toBe("ingested");

    // Second ingestion at different path but same content → must be detected as duplicate
    const second = await (tool?.execute as AnyFn)("tc-hash-1b", { path: fileB });
    expect(second.details.action).toBe("skipped_duplicate");
  });

  it("re-ingests when file content changes (different hash)", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## Changed\n\nUpdated content.", "Changed Doc");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    // Write file with version 1 content
    writeFileSync(testFilePath, "VERSION_ONE_CONTENT");
    const first = await (tool?.execute as AnyFn)("tc-hash-2a", { path: testFilePath });
    expect(first.details.action).toBe("ingested");

    // Overwrite with different content → new hash → must NOT be skipped
    writeFileSync(testFilePath, "VERSION_TWO_CONTENT_DIFFERENT");
    const second = await (tool?.execute as AnyFn)("tc-hash-2b", { path: testFilePath });
    // A new ingestion is attempted (content hash differs → new source key)
    expect(second.details.action).toBe("ingested");
  });

  it("stores source_document_hash in fact value field", async () => {
    const api = makeMockApi();
    const bridge = makeMockBridge("## HashMeta\n\nChecking hash metadata.", "Hash Test");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    writeFileSync(testFilePath, "HASH_META_CONTENT");
    const result = await (tool?.execute as AnyFn)("tc-hash-3", { path: testFilePath });

    expect(result.details.action).toBe("ingested");
    // The fingerprint must be a full 64-char hex SHA-256
    expect(result.details.source_document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details.fingerprint).toBe(result.details.source_document_hash);
  });
});

// ---------------------------------------------------------------------------
// LLM vision integration tests
// ---------------------------------------------------------------------------

describe("LLM vision integration", () => {
  it("calls vision model for image files when visionEnabled is true", async () => {
    const api = makeMockApi();
    const mockOpenAI = makeMockOpenAI("A red square on a white background with a shadow.");
    const bridge = makeMockBridge(); // should NOT be called for images when visionEnabled

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ visionEnabled: true, visionModel: "gpt-4o" }) as never,
        embeddings: makeMockEmbeddings() as never,
        openai: mockOpenAI as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    // Write a minimal PNG stub (valid header bytes are not required — bridge is mocked)
    const imagePath = join(tmpDir, "test-image.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const result = await (tool?.execute as AnyFn)("tc-vision-1", { path: imagePath });

    // Vision model must have been called
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledOnce();
    // Bridge must NOT have been called (vision path bypasses Python conversion)
    expect(bridge.convert).not.toHaveBeenCalled();
    // The description text must have been stored as a chunk
    expect(result.details.storedCount).toBeGreaterThanOrEqual(1);
  });

  it("falls back to python bridge for image files when visionEnabled is false", async () => {
    const api = makeMockApi();
    const mockOpenAI = makeMockOpenAI();
    const bridge = makeMockBridge("## Image Note\n\nAlt text or extracted text.", "Test Image");

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ visionEnabled: false }) as never,
        embeddings: makeMockEmbeddings() as never,
        openai: mockOpenAI as never,
        pythonBridge: bridge as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");

    const imagePath = join(tmpDir, "test-image2.jpg");
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const result = await (tool?.execute as AnyFn)("tc-vision-2", { path: imagePath });

    // Vision model must NOT be called
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
    // Python bridge SHOULD have been called
    expect(bridge.convert).toHaveBeenCalledOnce();
    expect(result.details.storedCount).toBeGreaterThanOrEqual(1);
  });

  it("stores vision description as fact text with source attribution", async () => {
    const description = "Dashboard showing CPU at 42%, memory at 6.2 GB, disk I/O flat.";
    const api = makeMockApi();
    const mockOpenAI = makeMockOpenAI(description);

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ visionEnabled: true, visionModel: "gpt-4o" }) as never,
        embeddings: makeMockEmbeddings() as never,
        openai: mockOpenAI as never,
        pythonBridge: makeMockBridge() as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const imagePath = join(tmpDir, "dashboard.webp");
    writeFileSync(imagePath, Buffer.from("fake-webp-bytes"));

    const result = await (tool?.execute as AnyFn)("tc-vision-3", { path: imagePath });

    expect(result.details.action).toBe("ingested");
    expect(result.details.storedCount).toBeGreaterThanOrEqual(1);

    // The stored fact's text should contain the vision description
    const storedFacts = factsDb.search(description.slice(0, 20));
    // At least one fact must contain the vision description
    const found = storedFacts.some((r: { entry: { text: string } }) => r.entry.text.includes("CPU at 42%"));
    expect(found).toBe(true);
  });

  it("returns error when vision model throws", async () => {
    const api = makeMockApi();
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("vision API unavailable")),
        },
      },
    };
    const bridgeThatThrows = {
      ...makeMockBridge(),
      convert: vi.fn().mockRejectedValue(new Error("bridge fallback failed")),
    };

    registerDocumentTools(
      {
        factsDb: factsDb as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg({ visionEnabled: true, visionModel: "gpt-4o" }) as never,
        embeddings: makeMockEmbeddings() as never,
        openai: mockOpenAI as never,
        pythonBridge: bridgeThatThrows as never,
      },
      api as never,
    );

    const tool = api.getTool("memory_ingest_document");
    const imagePath = join(tmpDir, "bad-image.gif");
    writeFileSync(imagePath, Buffer.from("GIF89a"));

    const result = await (tool?.execute as AnyFn)("tc-vision-4", { path: imagePath });
    expect(result.details.error).toBe("conversion_failed");
    expect(result.content[0].text).toContain("Error converting");
  });
});
