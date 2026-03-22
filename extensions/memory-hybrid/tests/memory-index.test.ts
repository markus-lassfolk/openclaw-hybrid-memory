import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateMemoryIndex } from "../services/memory-index.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;
const silentLogger = { info: () => undefined, warn: () => undefined };

describe("generateMemoryIndex", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-index-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes MEMORY_INDEX.md with required sections using deterministic fallback", async () => {
    const f1 = factsDb.store({
      text: "Decision: Use TypeScript for plugin services",
      category: "decision",
      importance: 0.9,
      entity: "memory-hybrid",
      key: "language",
      value: "TypeScript",
      source: "test",
      decayClass: "stable",
    });
    const f2 = factsDb.store({
      text: "Decision: run nightly dream cycle at 2:45 AM",
      category: "decision",
      importance: 0.8,
      entity: "nightly-cycle",
      key: "schedule",
      value: "45 2 * * *",
      source: "test",
      decayClass: "stable",
    });
    const f3 = factsDb.store({
      text: "Memory index should summarize clusters and entities",
      category: "fact",
      importance: 0.7,
      entity: "memory-index",
      key: null,
      value: null,
      source: "test",
      decayClass: "stable",
    });
    factsDb.createLink(f1.id, f2.id, "RELATED_TO", 0.9);
    factsDb.createLink(f2.id, f3.id, "RELATED_TO", 0.9);

    const openaiStub = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("no key")),
        },
      },
    } as never;

    const result = await generateMemoryIndex(
      factsDb,
      openaiStub,
      {
        workspaceRoot: tmpDir,
        model: "gpt-4o-mini",
        reflectWindowDays: 30,
      },
      silentLogger,
    );

    const content = readFileSync(join(tmpDir, "MEMORY_INDEX.md"), "utf-8");
    expect(result.generated).toBe(true);
    expect(result.usedLlm).toBe(false);
    expect(content).toContain("## Active Clusters");
    expect(content).toContain("## Recent Decisions");
    expect(content).toContain("## Key Entities");
    expect(content).toContain("fact:");
  });

  it("enforces output size budget", async () => {
    for (let i = 0; i < 60; i++) {
      factsDb.store({
        text: `Decision number ${i} ${"very long detail ".repeat(20)}`,
        category: "decision",
        importance: 0.6,
        entity: `entity-${i % 10}`,
        key: `k-${i}`,
        value: `v-${i}`,
        source: "test",
        decayClass: "stable",
      });
    }
    const openaiStub = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("no key")),
        },
      },
    } as never;

    await generateMemoryIndex(
      factsDb,
      openaiStub,
      {
        workspaceRoot: tmpDir,
        model: "gpt-4o-mini",
        reflectWindowDays: 30,
      },
      silentLogger,
    );
    const content = readFileSync(join(tmpDir, "MEMORY_INDEX.md"), "utf-8");
    expect(content.length).toBeLessThanOrEqual(3200);
  });
});

