import { describe, expect, it, vi } from "vitest";
import { toolInstallers } from "../setup/tool-installers.js";
import type { MemoryToolsContext } from "../tools/memory-tools.js";

describe("tool installers", () => {
  it("keeps core installers ahead of optional feature installers", () => {
    expect(toolInstallers.map((installer) => `${installer.bootstrapPhase}:${installer.id}`)).toEqual([
      "core:memoryCore",
      "core:retrievalGraph",
      "core:memoryUtility",
      "optional:provenance",
      "optional:credentials",
      "optional:persona",
      "optional:documents",
      "optional:verification",
      "optional:issues",
      "optional:workflow",
      "optional:crystallization",
      "optional:selfExtension",
      "optional:apitap",
      "optional:dashboard",
    ]);
  });

  it("selects a narrow memory-core context and binds wal helpers", async () => {
    const wal = { kind: "wal" };
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const walRemove = vi.fn().mockResolvedValue(undefined);
    const buildToolScopeFilter = vi.fn();
    const findSimilarByEmbedding = vi.fn().mockResolvedValue([]);

    const memoryCoreInstaller = toolInstallers.find((installer) => installer.id === "memoryCore");
    expect(memoryCoreInstaller).toBeTruthy();

    const selected = memoryCoreInstaller?.selectContext(
      {
        factsDb: { kind: "facts" },
        vectorDb: { kind: "vectors" },
        cfg: { kind: "cfg" },
        embeddings: { kind: "embeddings" },
        embeddingRegistry: { kind: "registry" },
        openai: { kind: "openai" },
        wal,
        credentialsDb: { kind: "credentials" },
        eventLog: { kind: "events" },
        narrativesDb: { kind: "narratives" },
        provenanceService: { kind: "provenance" },
        aliasDb: { kind: "aliases" },
        verificationStore: { kind: "verification" },
        variantQueue: { kind: "variants" },
        lastProgressiveIndexIds: ["fact-1"],
        currentAgentIdRef: { value: "agent-1" },
        pendingLLMWarnings: { kind: "warnings" },
        buildToolScopeFilter,
        findSimilarByEmbedding,
        walWrite,
        walRemove,
        issueStore: { kind: "issues" },
        workflowStore: { kind: "workflow" },
      } as never,
      { logger: { warn: vi.fn() } } as never,
    ) as MemoryToolsContext & Record<string, unknown>;

    expect(Object.keys(selected).sort()).toEqual([
      "aliasDb",
      "buildToolScopeFilter",
      "cfg",
      "credentialsDb",
      "currentAgentIdRef",
      "embeddingRegistry",
      "embeddings",
      "eventLog",
      "factsDb",
      "findSimilarByEmbedding",
      "lastProgressiveIndexIds",
      "narrativesDb",
      "openai",
      "pendingLLMWarnings",
      "provenanceService",
      "variantQueue",
      "vectorDb",
      "verificationStore",
      "walRemove",
      "walWrite",
    ]);
    expect(selected).not.toHaveProperty("wal");
    expect(selected).not.toHaveProperty("issueStore");
    expect(selected).not.toHaveProperty("workflowStore");

    const logger = { warn: vi.fn() };
    await selected.walWrite("store", { foo: "bar" }, logger);
    await selected.walRemove("wal-id", logger);

    expect(walWrite).toHaveBeenCalledWith(wal, "store", { foo: "bar" }, logger);
    expect(walRemove).toHaveBeenCalledWith(wal, "wal-id", logger);
    expect(selected.buildToolScopeFilter).toBe(buildToolScopeFilter);
    expect(selected.findSimilarByEmbedding).toBe(findSimilarByEmbedding);
  });
});
