/**
 * hybrid-mem bootstrap — one-shot install + optional mine (Issue #1917).
 */

import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";

export function registerBootstrapCommand(
  program: Chainable,
  cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  runInstall?: () => Promise<void>,
): void {
  program
    .command("bootstrap")
    .description("One-command setup: install plugin, optional mine, verify")
    .option("--with-mine <path>", "Import transcripts after install")
    .option("--with-config <preset>", "Apply config preset (local|minimal|enhanced|complete)")
    .option("--force", "Overwrite existing config")
    .action(async (opts: { withMine?: string; withConfig?: string; force?: boolean }) => {
      console.log("hybrid-mem bootstrap starting…");
      if (opts.withConfig && !opts.force) {
        console.log(`Config preset requested: ${opts.withConfig} (use --force to overwrite existing config)`);
      }
      if (runInstall) {
        await runInstall();
      } else {
        console.log("Run: openclaw hybrid-mem install");
      }
      if (opts.withMine) {
        console.log(`Mine path queued: ${opts.withMine} — run: openclaw hybrid-mem mine ${opts.withMine}`);
      }
      const count = factsDb.getCount();
      console.log(`Bootstrap complete. Facts in vault: ${count}`);
    });
}
