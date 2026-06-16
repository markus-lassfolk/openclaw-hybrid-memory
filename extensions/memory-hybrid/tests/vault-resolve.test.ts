/**
 * Vault resolve helpers (#1917).
 */

import { describe, expect, it } from "vitest";
import { shouldFanOutVaultRecall, listToolVaultHandles } from "../tools/memory/vault-resolve.js";
import type { MemoryToolRuntime } from "../tools/memory/runtime.js";

function mockRuntime(overrides: Partial<MemoryToolRuntime> = {}): MemoryToolRuntime {
  return {
    cfg: { vaults: { work: "/tmp/work.db" }, retrieval: { multiVaultFanOut: true } },
    factsDb: {} as MemoryToolRuntime["factsDb"],
    vectorDb: {} as MemoryToolRuntime["vectorDb"],
    resolveVault: (name?: string) => ({
      name: name ?? "default",
      factsDb: {} as MemoryToolRuntime["factsDb"],
      vectorDb: {} as MemoryToolRuntime["vectorDb"],
      sqlitePath: "",
      lancePath: "",
    }),
    resolveAllVaults: () => [
      { name: "default", factsDb: {} as MemoryToolRuntime["factsDb"], vectorDb: {} as MemoryToolRuntime["vectorDb"], sqlitePath: "", lancePath: "" },
      { name: "work", factsDb: {} as MemoryToolRuntime["factsDb"], vectorDb: {} as MemoryToolRuntime["vectorDb"], sqlitePath: "", lancePath: "" },
    ],
    ...overrides,
  } as MemoryToolRuntime;
}

describe("shouldFanOutVaultRecall (#1917)", () => {
  it("fans out when vault=all", () => {
    const rt = mockRuntime();
    expect(shouldFanOutVaultRecall(rt.cfg, "all")).toBe(true);
    expect(listToolVaultHandles(rt, "all")).toHaveLength(2);
  });

  it("fans out when multiVaultFanOut enabled and no vault param", () => {
    const rt = mockRuntime();
    expect(shouldFanOutVaultRecall(rt.cfg)).toBe(true);
    expect(listToolVaultHandles(rt)).toHaveLength(2);
  });

  it("does not fan out for explicit vault name", () => {
    const rt = mockRuntime();
    expect(shouldFanOutVaultRecall(rt.cfg, "work")).toBe(false);
    expect(listToolVaultHandles(rt, "work")).toHaveLength(1);
    expect(listToolVaultHandles(rt, "work")[0]?.name).toBe("work");
  });
});
