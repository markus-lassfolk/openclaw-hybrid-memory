/**
 * Vault resolve helpers (#1917).
 */

import { describe, expect, it } from "vitest";
import {
  resolveToolVaultBackends,
  resolveToolVaultWal,
  shouldFanOutVaultRecall,
  listToolVaultHandles,
  groupByResultVault,
} from "../tools/memory/vault-resolve.js";
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

describe("resolveToolVaultWal (#1917)", () => {
  // A resolveVaultWal that behaves like the real WAL router: throws for any name it doesn't
  // recognize, including "all" (never a real vault entry). The plain mockRuntime() above has no
  // resolveVaultWal at all, which is exactly why vault:"all" reaching resolveVaultWal("all")
  // unnoticed went untested in production — regression-test against a stricter mock here.
  function strictWalMockRuntime(): MemoryToolRuntime {
    return mockRuntime({
      wal: { path: "default-wal" } as unknown as MemoryToolRuntime["wal"],
      resolveVaultWal: (name?: string) => {
        if (name === "work") return { path: "work-wal" } as unknown as ReturnType<NonNullable<MemoryToolRuntime["resolveVaultWal"]>>;
        throw new Error(`Unknown vault "${name}". Configured: work`);
      },
    });
  }

  it("does not throw for vault='all' and resolves to the default WAL", () => {
    const rt = strictWalMockRuntime();
    expect(() => resolveToolVaultWal(rt, "all")).not.toThrow();
    expect(resolveToolVaultWal(rt, "all")).toBe(rt.wal);
  });

  it("still resolves an explicit named vault's WAL normally", () => {
    const rt = strictWalMockRuntime();
    expect(resolveToolVaultWal(rt, "work")).toEqual({ path: "work-wal" });
  });

  it("still throws for a genuinely unknown vault name", () => {
    const rt = strictWalMockRuntime();
    expect(() => resolveToolVaultWal(rt, "nonexistent")).toThrow(/Unknown vault/);
  });
});

describe("groupByResultVault (loop iteration 83 regression — graph expansion multi-vault fan-out)", () => {
  const defaultDb = { name: "default-db" };
  const workDb = { name: "work-db" };
  const vaultHandles = [
    { name: "default", factsDb: defaultDb },
    { name: "work", factsDb: workDb },
  ];

  it("routes each item to its own vault's factsDb per vaultByFactId", () => {
    const items = ["fact-a", "fact-b", "fact-c"];
    const vaultByFactId = new Map([
      ["fact-a", "default"],
      ["fact-b", "work"],
      ["fact-c", "work"],
    ]);

    const groups = groupByResultVault(items, (id) => id, vaultByFactId, vaultHandles, defaultDb);

    expect(groups.get(defaultDb)).toEqual(["fact-a"]);
    expect(groups.get(workDb)).toEqual(["fact-b", "fact-c"]);
    expect(groups.size).toBe(2);
  });

  it("falls back to defaultFactsDb for an id missing from vaultByFactId (single-vault mode, or entity-lookup merge)", () => {
    const items = ["fact-a", "fact-b"];

    const groups = groupByResultVault(items, (id) => id, undefined, vaultHandles, defaultDb);

    expect(groups.get(defaultDb)).toEqual(["fact-a", "fact-b"]);
    expect(groups.size).toBe(1);
  });

  it("falls back to defaultFactsDb when vaultByFactId names a vault absent from vaultHandles", () => {
    const items = ["fact-a"];
    const vaultByFactId = new Map([["fact-a", "some-other-vault-not-in-handles"]]);

    const groups = groupByResultVault(items, (id) => id, vaultByFactId, vaultHandles, defaultDb);

    expect(groups.get(defaultDb)).toEqual(["fact-a"]);
    expect(groups.size).toBe(1);
  });

  it("collapses to a single group in single-vault mode (no-op grouping, preserves existing behavior)", () => {
    const items = [{ factId: "fact-a" }, { factId: "fact-b" }];

    const groups = groupByResultVault(items, (item) => item.factId, undefined, [], defaultDb);

    expect(groups.size).toBe(1);
    expect(groups.get(defaultDb)).toEqual(items);
  });
});
