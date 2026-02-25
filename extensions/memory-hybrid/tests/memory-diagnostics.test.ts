import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMemoryDiagnostics } from "../services/memory-diagnostics.js";
import { _testing } from "../index.js";

const { FactsDB, VectorDB } = _testing;

class FakeEmbeddings {
  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

describe("runMemoryDiagnostics", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-diag-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), 3);
    vectorDb.open();
  });

  afterEach(() => {
    vectorDb.removeSession();
    vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores a marker and validates searches", async () => {
    const result = await runMemoryDiagnostics({
      factsDb,
      vectorDb,
      embeddings: new FakeEmbeddings(),
      minScore: 0.1,
      autoRecallLimit: 5,
    });

    expect(result.markerId).toMatch(/[0-9a-f-]{36}/i);
    expect(result.structured.ok).toBe(true);
    expect(result.semantic.ok).toBe(true);
    expect(result.hybrid.ok).toBe(true);
    expect(result.autoRecall.ok).toBe(true);
  });
});
