import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { buildMemoryIndexSnapshot, renderMemoryIndexMarkdown, writeMemoryIndex } from "../services/memory-index.js";

const { FactsDB } = _testing;

const silentLogger = { info: () => undefined, warn: () => undefined };

describe("memory index", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-index-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    originalWorkspace = process.env.OPENCLAW_WORKSPACE;
    process.env.OPENCLAW_WORKSPACE = tmpDir;
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalWorkspace !== undefined) process.env.OPENCLAW_WORKSPACE = originalWorkspace;
    else process.env.OPENCLAW_WORKSPACE = undefined;
  });

  it("builds a compact awareness snapshot from clusters, decisions, entities, and patterns", () => {
    const factA = factsDb.store({
      text: "TypeScript build pipeline prefers strict mode for shared services and agent tools",
      category: "preference",
      importance: 0.8,
      entity: "TypeScript",
      key: "strict-mode",
      value: "true",
      source: "test",
    });
    const factB = factsDb.store({
      text: "TypeScript lint workflow runs before test workflow in CI",
      category: "workflow",
      importance: 0.7,
      entity: "TypeScript",
      key: "ci-order",
      value: "lint-before-test",
      source: "test",
    });
    const factC = factsDb.store({
      text: "Vitest coverage checks belong to the TypeScript quality cluster",
      category: "observation",
      importance: 0.6,
      entity: "Vitest",
      key: "coverage",
      value: "enabled",
      source: "test",
    });
    factsDb.createLink(factA.id, factB.id, "RELATED_TO");
    factsDb.createLink(factB.id, factC.id, "RELATED_TO");

    const decision = factsDb.store({
      text: "Use the strict validation gate for release deployments after nightly verification completes successfully",
      category: "decision",
      importance: 0.9,
      entity: "Release",
      key: "validation-gate",
      value: "strict",
      source: "test",
    });
    const pattern = factsDb.store({
      text: "Agent consistently validates TypeScript changes with targeted tests before broad suite execution",
      category: "pattern",
      importance: 0.85,
      entity: "TypeScript",
      key: "validation",
      value: "targeted-tests-first",
      source: "test",
    });

    const snapshot = buildMemoryIndexSnapshot(factsDb, { recentWindowDays: 30 });
    const markdown = renderMemoryIndexMarkdown(snapshot);

    expect(snapshot.clusters).toHaveLength(1);
    expect(snapshot.recentDecisions[0]?.ref).toBe(`decision:${decision.id.slice(0, 8)}`);
    expect(snapshot.recentPatterns[0]?.ref).toBe(`pattern:${pattern.id.slice(0, 8)}`);
    expect(snapshot.keyEntities.map((entity) => entity.entity)).toContain("TypeScript");
    expect(markdown).toContain("## Active Clusters");
    expect(markdown).toContain("## Recent Decisions");
    expect(markdown).toContain("## Key Entities");
    expect(markdown).toContain("## Recent Patterns");
    expect(markdown).not.toContain(decision.text);
  });

  it("writes MEMORY_INDEX.md during fallback synthesis without duplicating raw fact text", async () => {
    factsDb.store({
      text: "Deployments for API Gateway require staged rollout approval in production environments",
      category: "decision",
      importance: 0.95,
      entity: "API Gateway",
      key: "rollout-policy",
      value: "staged",
      source: "test",
    });

    const openaiStub = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("no key")),
        },
      },
    } as never;

    const result = await writeMemoryIndex(
      factsDb,
      openaiStub,
      { workspaceRoot: tmpDir, model: "test-model", recentWindowDays: 30 },
      silentLogger,
    );

    const outputPath = join(tmpDir, "MEMORY_INDEX.md");
    expect(result.usedFallback).toBe(true);
    expect(result.path).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);

    const written = readFileSync(outputPath, "utf-8");
    expect(written).toContain("# MEMORY_INDEX");
    expect(written).toContain("## Recent Decisions");
    expect(written).toContain("decision:");
    expect(written).not.toContain(
      "Deployments for API Gateway require staged rollout approval in production environments",
    );
  });
});
