/**
 * Multi-vault routing — lazy open of configured sqlite/lance pairs (Issue #1917).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  listConfiguredVaultNames,
  resolveVaultDbPath,
  resolveVaultLancePath,
  validateVaultPath,
} from "../config/vaults.js";

export type VaultHandle = {
  name: string;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  sqlitePath: string;
  lancePath: string;
};

export type VaultRegistry = {
  resolve: (vaultName?: string) => VaultHandle;
  resolveAll: () => VaultHandle[];
  listNames: () => string[];
  closeAll: () => void;
};

export function createVaultRegistry(opts: {
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
  defaultFactsDb: FactsDB;
  defaultVectorDb: VectorDB;
  defaultSqlitePath: string;
  defaultLancePath: string;
  vectorDim: number;
}): VaultRegistry {
  const { cfg, api, defaultFactsDb, defaultVectorDb, defaultSqlitePath, defaultLancePath, vectorDim } = opts;
  const cache = new Map<string, VaultHandle>();
  const defaultHandle: VaultHandle = {
    name: "default",
    factsDb: defaultFactsDb,
    vectorDb: defaultVectorDb,
    sqlitePath: defaultSqlitePath,
    lancePath: defaultLancePath,
  };

  function openNamedVault(name: string): VaultHandle {
    const path = cfg.vaults?.[name];
    if (!path) throw new Error(`Unknown vault "${name}". Configured: ${listConfiguredVaultNames(cfg.vaults).join(", ") || "(none)"}`);
    const sqlitePath = api.resolvePath(path);
    const validation = validateVaultPath(sqlitePath);
    if (!validation.ok) throw new Error(`Invalid vault path for "${name}": ${validation.reason}`);
    const lancePath = api.resolvePath(resolveVaultLancePath(path));
    const factsDb = new FactsDB(sqlitePath, {
      fuzzyDedupe: cfg.store.fuzzyDedupe,
      storeConfig: cfg.store,
    });
    const vectorDb = new VectorDB(lancePath, vectorDim, cfg.vector.autoRepair);
    vectorDb.setLogger(api.logger);
    const handle: VaultHandle = { name, factsDb, vectorDb, sqlitePath, lancePath };
    cache.set(name, handle);
    return handle;
  }

  return {
    resolve(vaultName?: string) {
      const trimmed = vaultName?.trim();
      if (!trimmed || trimmed === "default") return defaultHandle;
      const cached = cache.get(trimmed);
      if (cached) return cached;
      return openNamedVault(trimmed);
    },
    resolveAll() {
      const names = listConfiguredVaultNames(cfg.vaults);
      if (names.length === 0) return [defaultHandle];
      return [defaultHandle, ...names.map((name) => this.resolve(name))];
    },
    listNames: () => listConfiguredVaultNames(cfg.vaults),
    closeAll() {
      for (const handle of cache.values()) {
        try {
          handle.vectorDb.close?.();
        } catch {
          /* non-fatal */
        }
      }
      cache.clear();
    },
  };
}
