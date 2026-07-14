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
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "vault-registry",
      operation: "close-vector-db",
      severity: "warning",
      vault: handle.name,
    });
  }
  try {
    if (typeof handle.factsDb.permanentClose === "function") {
      handle.factsDb.permanentClose();
    } else {
      handle.factsDb.close?.();
    }
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "vault-registry",
      operation: "close-facts-db",
      severity: "warning",
      vault: handle.name,
    });
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

  // Vaults are meant to be isolated silos — dedupe, contradiction checks, and multi-vault fan-out
  // merge all assume distinct underlying storage per vault name. Two vault names pointing at the
  // same resolved sqlite file would silently share state while every consumer treats them as
  // independent, so this must be caught eagerly (at registry creation) rather than left to
  // whichever vault happens to be opened first lazily.
  //
  // Distinct sqlite paths are not sufficient: resolveVaultLancePath/resolveVaultWalPath only
  // strip a trailing ".db" before appending ".lance"/".wal", so e.g. "personal.db" and
  // "personal" (no extension) resolve to distinct sqlite paths but the SAME derived lance/WAL
  // path — the fact stores stay isolated but the two vaults' VectorDB instances would silently
  // share one LanceDB dataset. Check the derived paths too.
  {
    const seenPaths = new Map<string, string>([[defaultSqlitePath, "default"]]);
    const seenLancePaths = new Map<string, string>([[defaultLancePath, "default"]]);
    const seenWalPaths = new Map<string, string>([[resolveVaultWalPath(defaultSqlitePath), "default"]]);
    for (const name of listConfiguredVaultNames(cfg.vaults)) {
      const rawPath = cfg.vaults?.[name];
      if (!rawPath) continue;
      const resolvedPath = api.resolvePath(rawPath);
      const collidesWith = seenPaths.get(resolvedPath);
      if (collidesWith) {
        throw new Error(
          `Vault "${name}" resolves to the same sqlite path as vault "${collidesWith}" (${resolvedPath}). ` +
            "Each vault must use a distinct path — sharing a path would silently merge state that other vault code assumes is isolated.",
        );
      }
      seenPaths.set(resolvedPath, name);

      const resolvedLancePath = api.resolvePath(resolveVaultLancePath(rawPath));
      const lanceCollidesWith = seenLancePaths.get(resolvedLancePath);
      if (lanceCollidesWith) {
        throw new Error(
          `Vault "${name}" resolves to the same LanceDB path as vault "${lanceCollidesWith}" (${resolvedLancePath}), ` +
            `even though their sqlite paths differ. Vault sqlite paths must not differ only by a ".db" suffix ` +
            '(e.g. "personal.db" and "personal" both derive lance path "personal.lance") — ' +
            "sharing a LanceDB dataset would silently merge embeddings that other vault code assumes is isolated.",
        );
      }
      seenLancePaths.set(resolvedLancePath, name);

      const resolvedWalPath = resolveVaultWalPath(resolvedPath);
      const walCollidesWith = seenWalPaths.get(resolvedWalPath);
      if (walCollidesWith) {
        throw new Error(
          `Vault "${name}" resolves to the same WAL path as vault "${walCollidesWith}" (${resolvedWalPath}), ` +
            'even though their sqlite paths differ. Vault sqlite paths must not differ only by a ".db" suffix.',
        );
      }
      seenWalPaths.set(resolvedWalPath, name);
    }
  }

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
      const handles: VaultHandle[] = [defaultHandle];
      for (const name of names) {
        try {
          handles.push(resolve(name));
        } catch (err) {
          // A single unopenable named vault (missing/corrupted sqlite file, schema-incompatible,
          // etc.) must not take down multi-vault fan-out for every other — including the
          // default — vault. resolveAll() is the hot interactive-recall/injection path
          // (stage-recall/run-recall.ts, stage-injection.ts have no try/catch around it), so a
          // thrown error here previously broke auto-recall for the whole session on every turn
          // until the broken vault was fixed. Skip it and keep serving the healthy vaults.
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "vault-registry",
            operation: "resolve-all-skip-broken-vault",
            severity: "warning",
          });
          api.logger.warn(
            `memory-hybrid: vault "${name}" failed to open and was excluded from this fan-out: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return handles;
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
