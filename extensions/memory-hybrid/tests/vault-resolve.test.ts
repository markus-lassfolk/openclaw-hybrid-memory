/**
 * Vault resolve helpers (#1917).
 */

import { describe, expect, it } from "vitest";
import { resolveToolVaultBackends, shouldFanOutVaultRecall, listToolVaultHandles } from "../tools/memory/vault-resolve.js";
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
      {
        name: "default",
        factsDb: {} as MemoryToolRuntime["factsDb"],
        vectorDb: {} as MemoryToolRuntime["vectorDb"],
        sqlitePath: "",
        lancePath: "",
      },
      {
        name: "work",
        factsDb: {} as MemoryToolRuntime["factsDb"],
        vectorDb: {} as MemoryToolRuntime["vectorDb"],
        sqlitePath: "",
        lancePath: "",
      },
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

describe("resolveToolVaultBackends (#1917)", () => {
  // A resolveVault that behaves like the real VaultRegistry.resolve(): throws for any name it
  // doesn't recognize, including reserved names like "all" that never appear in cfg.vaults.
  // The mock in mockRuntime() above never throws, which is exactly what let vault:"all" reach
  // resolveVault("all") unnoticed in production — regression-test against a stricter mock here.
  function strictMockRuntime(): MemoryToolRuntime {
    return mockRuntime({
      resolveVault: (name?: string) => {
        if (!name || name === "default") {
          return {
            name: "default",
            factsDb: {} as MemoryToolRuntime["factsDb"],
            vectorDb: {} as MemoryToolRuntime["vectorDb"],
            sqlitePath: "",
            lancePath: "",
          };
        }
        if (name === "work") {
          return {
            name: "work",
            factsDb: {} as MemoryToolRuntime["factsDb"],
            vectorDb: {} as MemoryToolRuntime["vectorDb"],
            sqlitePath: "",
            lancePath: "",
          };
        }
        throw new Error(`Unknown vault "${name}". Configured: work`);
      },
    });
  }

  it("does not throw for vault='all' and resolves to the default vault backends", () => {
    const rt = strictMockRuntime();
    expect(() => resolveToolVaultBackends(rt, "all")).not.toThrow();
    expect(resolveToolVaultBackends(rt, "all").vaultName).toBe("default");
  });

  it("still resolves an explicit named vault normally", () => {
    const rt = strictMockRuntime();
    expect(resolveToolVaultBackends(rt, "work").vaultName).toBe("work");
  });

  it("still throws for a genuinely unknown vault name", () => {
    const rt = strictMockRuntime();
    expect(() => resolveToolVaultBackends(rt, "nonexistent")).toThrow(/Unknown vault/);
  });
});
