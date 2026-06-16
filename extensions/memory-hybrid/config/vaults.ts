/**
 * Multi-vault config helpers (Issue #1917).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type VaultsConfig = Record<string, string>;

const RESTRICTED_PREFIXES = ["/etc", "/var", "/usr", "/bin", "/sbin", "/proc", "/sys"];

export function parseVaultsConfig(raw: unknown): VaultsConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: VaultsConfig = {};
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof path === "string" && path.trim()) out[name] = path.trim();
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
