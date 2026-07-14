/**
 * Regression test for services/multi-vault-retrieval.ts:
 *
 * `runMultiVaultExplicitDeepRetrieval` fanned out to every configured vault with a bare
 * `Promise.all(handles.map(async h => ...))`. `runExplicitDeepRetrieval` has no internal
 * try/catch, so any SQLite/Lance error in one vault (locked file, corrupted index, disk
 * hiccup) rejected the whole `Promise.all` -- the caller got nothing back even though the
 * other vaults completed successfully and had results ready.
 */
import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../types/memory.js";
import type { FusedResult } from "../services/rrf-fusion.js";
import type { VaultHandle } from "../services/vault-registry.js";

const { runExplicitDeepRetrievalMock } = vi.hoisted(() => ({
  runExplicitDeepRetrievalMock: vi.fn(),
}));

vi.mock("../services/retrieval-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/retrieval-orchestrator.js")>();
  return { ...actual, runExplicitDeepRetrieval: runExplicitDeepRetrievalMock };
});

function makeHandle(name: string): VaultHandle {
  return {
    name,
    factsDb: { getRawDb: () => ({}) } as unknown as VaultHandle["factsDb"],
    vectorDb: {} as VaultHandle["vectorDb"],
    sqlitePath: `/tmp/${name}-facts.db`,
    lancePath: `/tmp/${name}-lance`,
  };
}

function makeFused(factId: string, finalScore: number): FusedResult {
  return { factId, rrfScore: finalScore, sources: [{ strategy: "fts", rank: 1 }], finalScore };
}

function makeEntry(id: string): MemoryEntry {
  return { id, text: `fact ${id}` } as MemoryEntry;
}

describe("runMultiVaultExplicitDeepRetrieval partial vault failure (regression)", () => {
  it("returns results from healthy vaults instead of failing entirely when one vault errors", async () => {
    runExplicitDeepRetrievalMock.mockImplementation(
      async (_q: string, _v: unknown, _db: unknown, _vec: unknown, factsDb: { getRawDb: () => { name?: string } }) => {
        const raw = factsDb.getRawDb() as unknown as { vaultName?: string };
        if (raw.vaultName === "vault-b") {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return {
          fused: [makeFused("fact-a", 0.9)],
          packed: ["fact-a text"],
          packedFactIds: ["fact-a"],
          tokensUsed: 5,
          entries: [makeEntry("fact-a")],
        };
      },
    );

    const handleA = makeHandle("vault-a");
    handleA.factsDb = { getRawDb: () => ({ vaultName: "vault-a" }) } as unknown as VaultHandle["factsDb"];
    const handleB = makeHandle("vault-b");
    handleB.factsDb = { getRawDb: () => ({ vaultName: "vault-b" }) } as unknown as VaultHandle["factsDb"];

    const { runMultiVaultExplicitDeepRetrieval } = await import("../services/multi-vault-retrieval.js");

    const result = await runMultiVaultExplicitDeepRetrieval("query", null, [handleA, handleB]);

    expect(result.fused).toHaveLength(1);
    expect(result.fused[0].factId).toBe("fact-a");
    expect(result.vaultByFactId.get("fact-a")).toBe("vault-a");
  });

  it("still throws when every vault fails", async () => {
    runExplicitDeepRetrievalMock.mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));

    const { runMultiVaultExplicitDeepRetrieval } = await import("../services/multi-vault-retrieval.js");

    await expect(
      runMultiVaultExplicitDeepRetrieval("query", null, [makeHandle("vault-a"), makeHandle("vault-b")]),
    ).rejects.toThrow(/all vaults failed/);
  });
});
