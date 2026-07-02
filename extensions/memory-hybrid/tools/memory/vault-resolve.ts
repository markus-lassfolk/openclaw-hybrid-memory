/**
 * Resolve optional vault parameter for memory tools (Issue #1917).
 */

import type { FactsDB } from "../../backends/facts-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import type { HybridMemoryConfig } from "../../config.js";
import type { VaultHandle } from "../../services/vault-registry.js";
import type { WriteAheadLog } from "../../backends/wal.js";
import type { MemoryToolRuntime } from "./runtime.js";

export type ResolvedVaultBackends = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  vaultName: string;
};

export function resolveToolVaultBackends(runtime: MemoryToolRuntime, vaultName?: string): ResolvedVaultBackends {
  const trimmed = vaultName?.trim();
  // "all" has no single backing store — it means "fan out via listToolVaultHandles" — so it
  // falls back to the default vault here rather than being forwarded to resolveVault(), which
  // has no "all" entry (it's a reserved name, never a configured vault) and would throw.
  if (!trimmed || trimmed === "default" || trimmed === "all") {
    return { factsDb: runtime.factsDb, vectorDb: runtime.vectorDb, vaultName: "default" };
  }
  if (!runtime.resolveVault) {
    throw new Error(`Vault "${trimmed}" requested but multi-vault routing is not configured`);
  }
  const handle = runtime.resolveVault(trimmed);
  return { factsDb: handle.factsDb, vectorDb: handle.vectorDb, vaultName: handle.name };
}

export function listToolVaultHandles(runtime: MemoryToolRuntime, vaultParam?: string): VaultHandle[] {
  const trimmed = vaultParam?.trim();
  if (trimmed && trimmed !== "default" && trimmed !== "all") {
    return runtime.resolveVault ? [runtime.resolveVault(trimmed)] : [];
  }
  if (trimmed === "all" || shouldFanOutVaultRecall(runtime.cfg, vaultParam)) {
    if (runtime.resolveAllVaults) return runtime.resolveAllVaults();
  }
  if (runtime.resolveVault) return [runtime.resolveVault()];
  return [
    {
      name: "default",
      factsDb: runtime.factsDb,
      vectorDb: runtime.vectorDb,
      sqlitePath: "",
      lancePath: "",
    },
  ];
}

export function shouldFanOutVaultRecall(cfg: HybridMemoryConfig, vaultParam?: string): boolean {
  const trimmed = vaultParam?.trim();
  if (trimmed === "all") return true;
  if (trimmed && trimmed !== "default") return false;
  return cfg.retrieval?.multiVaultFanOut === true && Boolean(cfg.vaults && Object.keys(cfg.vaults).length > 0);
}

/** WAL for store durability — routes to vault-specific path for named vaults (#1917). */
export function resolveToolVaultWal(runtime: MemoryToolRuntime, vaultName?: string): WriteAheadLog | null {
  const trimmed = vaultName?.trim();
  // "all" is a fan-out sentinel, not a real vault entry (see resolveToolVaultBackends above) —
  // a store always targets exactly one vault, so alias it to the default WAL rather than
  // forwarding to resolveVaultWal(), which has no "all" entry and would throw.
  if (!trimmed || trimmed === "default" || trimmed === "all") return runtime.wal;
  if (runtime.resolveVaultWal) return runtime.resolveVaultWal(trimmed);
  return runtime.wal;
}
