/**
 * CLI commands for verification and installation (verify, install).
 */

import type { InstallCliResult, VerifyCliSink } from "./types.js";
import { capturePluginError } from "../services/error-reporter.js";
import { withExit, type Chainable } from "./shared.js";

export type VerifyContext = {
  runVerify: (opts: { fix: boolean; logFile?: string }, sink: VerifyCliSink) => Promise<void>;
  runInstall: (opts: { dryRun: boolean }) => Promise<InstallCliResult>;
};

export function registerVerifyCommands(mem: Chainable, ctx: VerifyContext): void {
  const { runVerify, runInstall } = ctx;

  mem
    .command("verify")
    .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
    .option("--fix", "Print or apply default config for missing items")
    .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
    .option("--no-emoji", "Use plain text indicators instead of emoji (for terminals with poor Unicode support)")
    .action(withExit(async (opts: { fix?: boolean; logFile?: string; noEmoji?: boolean }) => {
      if (opts.noEmoji) process.env.HYBRID_MEM_NO_EMOJI = "1";
      try {
        await runVerify(
          { fix: !!opts.fix, logFile: opts.logFile },
          { log: (s) => console.log(s), error: (s) => console.error(s) },
        );
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "verify" });
        throw err;
      }
    }));

  mem
    .command("install")
    .description("Apply full recommended config, prompts, and optional jobs (idempotent). Run after first plugin setup for best defaults.")
    .option("--dry-run", "Print what would be merged without writing")
    .action(withExit(async (opts: { dryRun?: boolean }) => {
      let result;
      try {
        result = await runInstall({ dryRun: !!opts.dryRun });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "cli", operation: "install" });
        throw err;
      }
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (result.dryRun) {
        console.log("Would merge into " + result.configPath + ":");
        console.log(result.configJson ?? "");
        return;
      }
      console.log("Config written: " + result.configPath);
      console.log(`Applied: plugins.slots.memory=${result.pluginId}, ${result.pluginId} config (all features), memorySearch, compaction prompts, bootstrap limits, autoClassify. Add cron jobs via 'openclaw cron add' if needed (see docs/SESSION-DISTILLATION.md).`);
      console.log("\nNext steps:");
      console.log(`  1. Set embedding.apiKey in plugins.entries["${result.pluginId}"].config (or use env:OPENAI_API_KEY in config).`);
      console.log("  2. Restart the gateway: openclaw gateway stop && openclaw gateway start");
      console.log("  3. Run: openclaw hybrid-mem verify [--fix]");
    }));
}
