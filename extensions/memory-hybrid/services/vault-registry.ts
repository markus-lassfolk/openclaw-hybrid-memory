/**
 * Multi-vault routing — lazy open of configured sqlite/lance pairs (Issue #1917).
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  listConfiguredVaultNames,
  resolveVaultLancePath,
  resolveVaultWalPath,
  validateVaultPath,
} from "../config/vaults.js";
import { capturePluginError } from "./error-reporter.js";

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
  resolveWal: (vaultName?: string) => WriteAheadLog | null;
  listNames: () => string[];
  closeAll: () => void;
};

function closeNamedVaultHandle(handle: VaultHandle): void {
  try {
    handle.vectorDb.close?.();
  } catch {
    /* non-fatal */
  }
  try {
    if (typeof handle.factsDb.permanentClose === "function") {
      handle.factsDb.permanentClose();
    } else {
      handle.factsDb.close?.();
    }
  } catch {
    /* non-fatal */
  }
}

export function createVaultRegistry(opts: {
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
  defaultFactsDb: FactsDB;
  defaultVectorDb: VectorDB;
  defaultSqlitePath: string;
  defaultLancePath: string;
  defaultWal: WriteAheadLog | null;
  vectorDim: number;
}): VaultRegistry {
  const { cfg, api, defaultFactsDb, defaultVectorDb, defaultSqlitePath, defaultLancePath, defaultWal, vectorDim } =
    opts;
  const cache = new Map<string, VaultHandle>();
  const walCache = new Map<string, WriteAheadLog>();
  const walEnabled = cfg.wal?.enabled === true;
  const walMaxAge = cfg.wal?.maxAge ?? 5 * 60 * 1000;
  const defaultHandle: VaultHandle = {
    name: "default",
    factsDb: defaultFactsDb,
    vectorDb: defaultVectorDb,
    sqlitePath: defaultSqlitePath,
    lancePath: defaultLancePath,
  };

  function openNamedVault(name: string): VaultHandle {
    const path = cfg.vaults?.[name];
    if (!path) {
      throw new Error(
        `Unknown vault "${name}". Configured: ${listConfiguredVaultNames(cfg.vaults).join(", ") || "(none)"}`,
      );
    }
    const sqlitePath = api.resolvePath(path);
    const validation = validateVaultPath(sqlitePath);
    if (!validation.ok) throw new Error(`Invalid vault path for "${name}": ${validation.reason}`);
    const lancePath = api.resolvePath(resolveVaultLancePath(path));
    const factsDb = new FactsDB(sqlitePath, {
      fuzzyDedupe: cfg.store?.fuzzyDedupe ?? false,
      storeConfig: cfg.store ?? {},
    });
    const vectorDb = new VectorDB(lancePath, vectorDim, cfg.vector?.autoRepair ?? false);
    vectorDb.setLogger(api.logger);
    const handle: VaultHandle = { name, factsDb, vectorDb, sqlitePath, lancePath };
    cache.set(name, handle);
    return handle;
  }

  function resolveWal(vaultName?: string): WriteAheadLog | null {
    if (!walEnabled) return null;
    const trimmed = vaultName?.trim();
    if (!trimmed || trimmed === "default") return defaultWal;
    const handle = resolve(vaultName);
    const cached = walCache.get(handle.name);
    if (cached) return cached;
    const walPath = resolveVaultWalPath(handle.sqlitePath);
    const wal = new WriteAheadLog(walPath, walMaxAge);
    void wal.init().catch((err) => {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "wal",
        operation: "vault-wal-init",
        severity: "warning",
      });
      api.logger.warn(`memory-hybrid: vault WAL init failed for "${handle.name}": ${err}`);
    });
    walCache.set(handle.name, wal);
    api.logger.info(`memory-hybrid: vault WAL enabled for "${handle.name}" (${walPath})`);
    return wal;
  }

  function resolve(vaultName?: string): VaultHandle {
    const trimmed = vaultName?.trim();
    if (!trimmed || trimmed === "default") return defaultHandle;
    const cached = cache.get(trimmed);
    if (cached) return cached;
    return openNamedVault(trimmed);
  }

  return {
    resolve,
    resolveAll() {
      const names = listConfiguredVaultNames(cfg.vaults);
      if (names.length === 0) return [defaultHandle];
      return [defaultHandle, ...names.map((name) => resolve(name))];
    },
    resolveWal,
    listNames: () => listConfiguredVaultNames(cfg.vaults),
    closeAll() {
      walCache.clear();
      for (const handle of cache.values()) {
        closeNamedVaultHandle(handle);
      }
      cache.clear();
    },
  };
}
