/**
 * Multi-vault config helpers (Issue #1917).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type VaultsConfig = Record<string, string>;

const RESTRICTED_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/proc", "/sys"];

/**
 * "default" and "all" are reserved sentinels throughout vault resolution
 * (VaultRegistry.resolve, listToolVaultHandles, shouldFanOutVaultRecall):
 * "default" always short-circuits to the plugin's primary DB before a configured
 * vault of that name is ever consulted, and "all" always triggers multi-vault
 * fan-out on the recall path (while the store path treats it as a literal vault
 * name) — so a configured vault under either name is unreachable via one path and
 * silently double-counted or misrouted via the other. Reject both at parse time.
 */
const RESERVED_VAULT_NAMES = new Set(["default", "all"]);

export function parseVaultsConfig(raw: unknown): VaultsConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: VaultsConfig = {};
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    const trimmedName = name.trim();
    if (RESERVED_VAULT_NAMES.has(trimmedName.toLowerCase())) continue;
    if (typeof path === "string" && path.trim()) out[trimmedName] = path.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Refuse vault paths outside $HOME (except explicit home subpaths). */
export function validateVaultPath(path: string): { ok: boolean; reason?: string } {
  const resolved = resolve(path);
  const home = homedir();
  if (resolved === "/" || resolved === home) {
    return { ok: false, reason: "vault path cannot be filesystem root or home directory" };
  }
  for (const prefix of RESTRICTED_PREFIXES) {
    if (resolved.startsWith(`${prefix}/`) || resolved === prefix) {
      return { ok: false, reason: `vault path under restricted prefix ${prefix}` };
    }
  }
  if (!resolved.startsWith(`${home}/`)) {
    return { ok: false, reason: "vault path must be under $HOME" };
  }
  return { ok: true };
}

export function resolveVaultDbPath(vaults: VaultsConfig | undefined, vaultName?: string, defaultPath?: string): string {
  if (vaultName && vaults?.[vaultName]) return vaults[vaultName];
  return defaultPath ?? join(homedir(), ".openclaw", "facts.db");
}

/** Derive a sibling Lance path from a vault sqlite path. */
export function resolveVaultLancePath(sqlitePath: string): string {
  if (sqlitePath.endsWith(".db")) return `${sqlitePath.slice(0, -3)}.lance`;
  return `${sqlitePath}.lance`;
}

/** Per-vault WAL path colocated with the vault sqlite file (Issue #1917). */
export function resolveVaultWalPath(sqlitePath: string): string {
  if (sqlitePath.endsWith(".db")) return `${sqlitePath.slice(0, -3)}.wal`;
  return `${sqlitePath}.wal`;
}

export function listConfiguredVaultNames(vaults: VaultsConfig | undefined): string[] {
  return vaults ? Object.keys(vaults) : [];
}
