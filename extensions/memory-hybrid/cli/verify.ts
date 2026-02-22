/**
 * CLI commands for verification and installation (verify, install).
 */

import type { InstallCliResult, VerifyCliSink } from "./types.js";
import { capturePluginError } from "../services/error-reporter.js";

export type VerifyContext = {
  runVerify: (opts: { fix: boolean; logFile?: string }, sink: VerifyCliSink) => Promise<void>;
  runInstall: (opts: { dryRun: boolean }) => Promise<InstallCliResult>;
};

type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: any[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  requiredOption(flags: string, desc?: string, defaultValue?: string): Chainable;
};

/** Wrap async action to exit on completion (only for standalone CLI). */
const withExit = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A) => {
    const isStandaloneCli = process.argv.some((arg) => arg.includes("openclaw") || arg.includes("hybrid-mem"));
    Promise.resolve(fn(...args)).then(
      () => {
        if (isStandaloneCli) process.exit(process.exitCode ?? 0);
      },
      (err: unknown) => {
        console.error(err);
        if (isStandaloneCli) process.exit(1);
        else throw err;
      },
    );
  };

export function registerVerifyCommands(mem: Chainable, ctx: VerifyContext): void {
  const { runVerify, runInstall } = ctx;

  mem
    .command("verify")
    .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
    .option("--fix", "Print or apply default config for missing items")
    .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
    .action(withExit(async (opts: { fix?: boolean; logFile?: string }) => {
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
