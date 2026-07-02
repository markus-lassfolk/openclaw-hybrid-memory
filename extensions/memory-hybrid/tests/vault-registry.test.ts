/**
 * Vault registry and injection attribution tests (#1917, #1916).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { createVaultRegistry } from "../services/vault-registry.js";
import { resolveVaultWalPath } from "../config/vaults.js";
import { WriteAheadLog } from "../backends/wal.js";
import { recordInjectionAttribution } from "../services/injection-attribution-store.js";

describe("vault registry (#1917)", () => {
  it("resolves default vault without opening extra handles", () => {
    const dir = mkdtempSync(join(homedir(), "hm-vault-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: join(dir, "project.db") },
          wal: { enabled: false, maxAge: 60_000 },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        defaultWal: null,
        vectorDim: 8,
      });
      const def = registry.resolve();
      expect(def.name).toBe("default");
      expect(def.factsDb).toBe(factsDb);
      expect(registry.listNames()).toEqual(["project"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveAll returns default plus configured vaults", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-all-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: join(dir, "project.db") },
          wal: { enabled: false, maxAge: 60_000 },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        defaultWal: null,
        vectorDim: 8,
      });
      const all = registry.resolveAll();
      expect(all.map((h) => h.name)).toEqual(["default", "project"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeAll tears down lazy named vault facts and vector handles", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-close-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const projectDbPath = join(dir, "project.db");
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: projectDbPath },
          wal: { enabled: true, maxAge: 60_000 },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        defaultWal: null,
        vectorDim: 8,
      });
      const named = registry.resolve("project");
      expect(named.name).toBe("project");
      registry.closeAll();
      expect(() => named.factsDb.getRawDb().prepare("SELECT 1").get()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveWal returns vault-specific WAL path", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-wal-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const projectDbPath = join(dir, "project.db");
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: projectDbPath },
          wal: { enabled: true, maxAge: 60_000 },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        defaultWal: new WriteAheadLog(join(dir, "default.wal"), 60_000),
        vectorDim: 8,
      });
      const wal = registry.resolveWal("project");
      expect(wal).toBeInstanceOf(WriteAheadLog);
      expect(wal?.getPath()).toBe(resolveVaultWalPath(projectDbPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects two vaults resolving to the same sqlite path", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-collide-sqlite-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const sharedPath = join(dir, "shared.db");
      expect(() =>
        createVaultRegistry({
          cfg: {
            vaults: { alpha: sharedPath, beta: sharedPath },
            wal: { enabled: false, maxAge: 60_000 },
            store: { fuzzyDedupe: false },
            vector: { autoRepair: false },
          } as never,
          api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
          defaultFactsDb: factsDb,
          defaultVectorDb: vectorDb,
          defaultSqlitePath: sqlitePath,
          defaultLancePath: lancePath,
          defaultWal: null,
          vectorDim: 8,
        }),
      ).toThrow(/same sqlite path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects two vaults whose sqlite paths differ only by a .db suffix (same derived lance path)", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-collide-lance-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      // "personal.db" and "personal" are distinct sqlite paths, but resolveVaultLancePath()
      // strips a trailing ".db" before appending ".lance" — both derive "personal.lance".
      const withExt = join(dir, "personal.db");
      const withoutExt = join(dir, "personal");
      expect(() =>
        createVaultRegistry({
          cfg: {
            vaults: { personal: withExt, "personal-noext": withoutExt },
            wal: { enabled: false, maxAge: 60_000 },
            store: { fuzzyDedupe: false },
            vector: { autoRepair: false },
          } as never,
          api: { resolvePath: (p: string) => p, logger: { warn: () => {}, info: () => {} } } as never,
          defaultFactsDb: factsDb,
          defaultVectorDb: vectorDb,
          defaultSqlitePath: sqlitePath,
          defaultLancePath: lancePath,
          defaultWal: null,
          vectorDim: 8,
        }),
      ).toThrow(/same LanceDB path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveAll skips a vault that fails to open instead of throwing for the whole fan-out", () => {
    const dir = mkdtempSync(join(homedir(), ".hm-vault-broken-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const healthyPath = join(dir, "healthy.db");
      // Outside $HOME → validateVaultPath() rejects it, so resolve("broken") throws inside
      // resolveAll()'s per-vault loop, exercising the same failure mode as a missing/corrupted
      // sqlite file (both throw synchronously from openNamedVault before any handle is cached).
      const outsideHomePath = "/tmp/hm-vault-registry-outside-home-test.db";
      const warnCalls: string[] = [];
      const registry = createVaultRegistry({
        cfg: {
          vaults: { healthy: healthyPath, broken: outsideHomePath },
          wal: { enabled: false, maxAge: 60_000 },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: {
          resolvePath: (p: string) => p,
          logger: { warn: (msg: string) => warnCalls.push(msg), info: () => {} },
        } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        defaultWal: null,
        vectorDim: 8,
      });

      let all: ReturnType<typeof registry.resolveAll> = [];
      expect(() => {
        all = registry.resolveAll();
      }).not.toThrow();
      expect(all.map((h) => h.name).sort()).toEqual(["default", "healthy"]);
      expect(warnCalls.some((m) => m.includes("broken") && m.includes("excluded"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("injection attribution store (#1916)", () => {
  it("persists attribution rows", () => {
    const dir = mkdtempSync(join(homedir(), "hm-attr-"));
    try {
      const factsDb = new FactsDB(join(dir, "facts.db"), { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
      const db = factsDb.getRawDb();
      recordInjectionAttribution(db, {
        sessionKey: "sess-1",
        agentId: "main",
        attribution: {
          turnIndex: 2,
          injectedFactIds: ["abc-123"],
          referencedFactIds: ["abc-123"],
        },
      });
      const row = db
        .prepare("SELECT injected_fact_ids, referenced_fact_ids FROM injection_attribution LIMIT 1")
        .get() as { injected_fact_ids: string; referenced_fact_ids: string };
      expect(JSON.parse(row.injected_fact_ids)).toEqual(["abc-123"]);
      expect(JSON.parse(row.referenced_fact_ids)).toEqual(["abc-123"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
