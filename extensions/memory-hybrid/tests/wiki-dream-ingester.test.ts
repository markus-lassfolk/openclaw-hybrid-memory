import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ingestDreamFindings } from "../services/wiki-dream-ingester.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockFactsDb() {
  return {
    lookup: vi.fn(() => []),
    store: vi.fn(() => ({ id: "stored-fact-id" })),
    getAll: vi.fn(() => []),
    getById: vi.fn(),
    search: vi.fn(() => []),
  } as any;
}

describe("wiki-dream-ingester", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dream-ingester-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty result when log dir does not exist", async () => {
    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: "/nonexistent/path",
    });

    expect(result.runsProcessed).toBe(0);
    expect(result.findingsIngested).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty result when log dir is empty", async () => {
    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.runsProcessed).toBe(0);
    expect(result.findingsIngested).toBe(0);
  });

  it("skips already-ingested runs", async () => {
    const runDir = join(tempDir, "run-001");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "reflection.json"),
      JSON.stringify({ stage: "reflection", patterns: ["Pattern A is long enough to store"] }),
    );

    const factsDb = createMockFactsDb();
    factsDb.lookup.mockReturnValue([{ entry: { id: "sentinel" }, score: 1 }]);

    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.runsSkipped).toBe(1);
    expect(result.runsProcessed).toBe(0);
    expect(factsDb.store).not.toHaveBeenCalled();
  });

  it("extracts patterns from reflection stage artifacts", async () => {
    const runDir = join(tempDir, "run-001");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "reflection.json"),
      JSON.stringify({
        stage: "reflection",
        patterns: [
          "User consistently prefers TypeScript over JavaScript in new projects",
          "short",
        ],
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.runsProcessed).toBe(1);
    expect(result.findingsIngested).toBe(1);
    const storeCall = factsDb.store.mock.calls[0][0];
    expect(storeCall.text).toContain("Pattern discovered:");
    expect(storeCall.tags).toContain("dream-finding");
  });

  it("extracts consolidation findings", async () => {
    const runDir = join(tempDir, "run-002");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "consolidation.json"),
      JSON.stringify({
        stage: "consolidation",
        factsCreated: 5,
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.findingsIngested).toBe(1);
    const storeCall = factsDb.store.mock.calls[0][0];
    expect(storeCall.text).toContain("consolidated 5 event(s)");
  });

  it("extracts digest summary findings", async () => {
    const runDir = join(tempDir, "run-003");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "digest.json"),
      JSON.stringify({
        stage: "digest",
        digestSummary: "The agent has been primarily focused on TypeScript integration and memory optimization.",
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.findingsIngested).toBe(1);
    const storeCall = factsDb.store.mock.calls[0][0];
    expect(storeCall.text).toContain("focused on TypeScript");
  });

  it("marks run as ingested with sentinel fact", async () => {
    const runDir = join(tempDir, "run-004");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "reflection.json"),
      JSON.stringify({
        stage: "pattern-analysis",
        patterns: ["Users prefer dark mode which is a consistent pattern"],
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.runsProcessed).toBe(1);
    const sentinelCall = factsDb.store.mock.calls.find(
      (call: any[]) => call[0].entity === "system" && call[0].key?.startsWith("dream-ingested-run:"),
    );
    expect(sentinelCall).toBeDefined();
    expect(sentinelCall![0].key).toBe("dream-ingested-run:run-004");
  });

  it("respects maxRunsToProcess", async () => {
    for (const name of ["run-001", "run-002", "run-003"]) {
      const dir = join(tempDir, name);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "reflection.json"),
        JSON.stringify({
          stage: "reflection",
          patterns: ["Some pattern that is long enough to be stored"],
        }),
      );
    }

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
      maxRunsToProcess: 2,
    });

    expect(result.runsProcessed).toBe(2);
  });

  it("handles pattern objects with text field", async () => {
    const runDir = join(tempDir, "run-005");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "reflection.json"),
      JSON.stringify({
        stage: "reflection",
        patternsFound: [
          { text: "Object pattern with enough text to exceed minimum" },
          { text: "too short" },
          "String pattern that is also long enough to store",
        ],
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.findingsIngested).toBe(2);
  });

  it("skips non-JSON files in run directory", async () => {
    const runDir = join(tempDir, "run-006");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "notes.txt"), "not json");
    writeFileSync(
      join(runDir, "reflection.json"),
      JSON.stringify({
        stage: "reflection",
        patterns: ["A valid pattern that should be extracted from JSON"],
      }),
    );

    const factsDb = createMockFactsDb();
    const result = await ingestDreamFindings({
      factsDb,
      dreamCycleLogDir: tempDir,
    });

    expect(result.findingsIngested).toBe(1);
  });
});
