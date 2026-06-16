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
import { recordInjectionAttribution } from "../services/injection-attribution-store.js";

describe("vault registry (#1917)", () => {
  it("resolves default vault without opening extra handles", () => {
    const dir = mkdtempSync(join(homedir(), "hm-vault-"));
    try {
      const sqlitePath = join(dir, "facts.db");
      const lancePath = join(dir, "facts.lance");
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: {} });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: join(dir, "project.db") },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
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
      const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false, storeConfig: {} });
      const vectorDb = new VectorDB(lancePath, 8, false);
      const registry = createVaultRegistry({
        cfg: {
          vaults: { project: join(dir, "project.db") },
          store: { fuzzyDedupe: false },
          vector: { autoRepair: false },
        } as never,
        api: { resolvePath: (p: string) => p, logger: { warn: () => {} } } as never,
        defaultFactsDb: factsDb,
        defaultVectorDb: vectorDb,
        defaultSqlitePath: sqlitePath,
        defaultLancePath: lancePath,
        vectorDim: 8,
      });
      const all = registry.resolveAll();
      expect(all.map((h) => h.name)).toEqual(["default", "project"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("injection attribution store (#1916)", () => {
  it("persists attribution rows", () => {
    const dir = mkdtempSync(join(homedir(), "hm-attr-"));
    try {
      const factsDb = new FactsDB(join(dir, "facts.db"), { fuzzyDedupe: false, storeConfig: {} });
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
