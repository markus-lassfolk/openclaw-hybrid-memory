/**
 * hybrid-mem bootstrap — one-shot install + optional mine (Issue #1917).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ConfigCliResult } from "./cmd-config.js";

const VALID_PRESETS = new Set(["local", "minimal", "enhanced", "complete"]);

export function registerBootstrapCommand(
  program: Chainable,
  _cfg: HybridMemoryConfig,
  factsDb: FactsDB,
  deps?: {
    runInstall?: () => Promise<void>;
    runConfigMode?: (mode: string) => ConfigCliResult | Promise<ConfigCliResult>;
    runMine?: (path: string) => Promise<void>;
  },
): void {
  program
    .command("bootstrap")
    .description("One-command setup: install plugin, optional mine, verify")
    .option("--with-mine <path>", "Import transcripts after install")
    .option("--with-config <preset>", "Apply config preset (local|minimal|enhanced|complete)")
    .option("--force", "Overwrite existing openclaw.json when applying --with-config")
    .action(async (opts: { withMine?: string; withConfig?: string; force?: boolean }) => {
      console.log("hybrid-mem bootstrap starting…");
      const configPath = join(homedir(), ".openclaw", "openclaw.json");

      if (opts.withConfig) {
        const preset = opts.withConfig.trim().toLowerCase();
        if (!VALID_PRESETS.has(preset)) {
          console.error(`Invalid preset "${opts.withConfig}". Use: ${[...VALID_PRESETS].join(", ")}`);
          process.exitCode = 1;
          return;
        }
        if (!opts.force && existsSync(configPath)) {
          console.error(
            `Config already exists at ${configPath}. Re-run with --force to apply preset "${preset}".`,
          );
          process.exitCode = 1;
          return;
        }
        if (deps?.runConfigMode) {
          const res = await deps.runConfigMode(preset);
          if (!res.ok) {
            console.error(res.error ?? "Failed to apply config preset");
            process.exitCode = 1;
            return;
          }
          console.log(res.message ?? `Applied preset "${preset}".`);
        } else {
          console.log(`Run: openclaw hybrid-mem config-mode ${preset}`);
        }
      }

      if (deps?.runInstall) {
        await deps.runInstall();
      } else {
        console.log("Run: openclaw hybrid-mem install");
      }

      if (opts.withMine) {
        if (deps?.runMine) {
          await deps.runMine(opts.withMine);
        } else {
          console.log(`Run: openclaw hybrid-mem mine ${opts.withMine}`);
        }
      }

      const count = factsDb.getCount();
      console.log(`Bootstrap complete. Facts in vault: ${count}`);
    });
}
