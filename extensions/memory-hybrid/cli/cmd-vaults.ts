/**
 * Multi-vault CLI helpers (Issue #1917).
 */

import type { HybridMemoryConfig } from "../config.js";
import { validateVaultPath } from "../config/vaults.js";
import type { Chainable } from "./shared.js";

export function registerVaultCommands(program: Chainable, cfg: HybridMemoryConfig): void {
  program
    .command("list-vaults")
    .description("List configured memory vaults")
    .action(() => {
      const vaults = cfg.vaults;
      if (!vaults || Object.keys(vaults).length === 0) {
        console.log("Single-vault mode (default)");
        console.log(`  default: ${cfg.sqlitePath}`);
        return;
      }
      console.log("Configured vaults:");
      for (const [name, path] of Object.entries(vaults)) {
        const v = validateVaultPath(path);
        const status = v.ok ? "ok" : `INVALID (${v.reason})`;
        console.log(`  ${name}: ${path} [${status}]`);
      }
      console.log(`  default: ${cfg.sqlitePath}`);
    });

  program
    .command("vault-sync <name> <path>")
    .description("Validate a vault path and print merge snippet for openclaw.json")
    .action((name: string, path: string) => {
      if (["default", "all"].includes(name.trim().toLowerCase())) {
        console.error(
          `Vault name "${name}" is reserved (used as a sentinel throughout vault resolution) and will be silently ignored if configured. Choose a different name.`,
        );
        process.exit(1);
      }
      const v = validateVaultPath(path);
      if (!v.ok) {
        console.error(`Invalid vault path: ${v.reason}`);
        process.exit(1);
      }
      console.log(`Vault "${name}" path is valid.`);
      console.log(`Add to plugin config:\n  vaults: { "${name}": "${path}" }`);
    });
}
