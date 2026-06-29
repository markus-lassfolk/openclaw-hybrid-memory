import type { Command } from "commander";
import { attachHybridMemCliFatalExit, ensureVerboseFlagOnHybridMemTree } from "../../cli/hybrid-mem-commander-utils.js";
import { registerHybridMemVersionFlag } from "../../cli/register-hybrid-mem-version-flag.js";
import { type HybridMemCliContext, registerHybridMemCli } from "../../cli/register.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { HYBRID_MEM_HELP_ACTIVE_TASKS, HYBRID_MEM_HELP_GROUPED } from "./help-text.js";
import type { RegisterHybridMemCliWithApiOptions } from "./register-full.js";
export function registerCliWithHelp(
  program: { command: (name: string) => { description: (d: string) => unknown } },
  ctx: HybridMemCliContext,
  options?: RegisterHybridMemCliWithApiOptions,
): void {
  const mem = program.command("hybrid-mem").description("Hybrid memory plugin commands") as Command;
  // Match OpenClaw's program: flags after the subcommand name apply to that subcommand (Issue #1224).
  mem.enablePositionalOptions();
  mem.option(
    "-v, --verbose",
    "Verbose output for subcommands that support it (same effect as per-command --verbose where available)",
    false,
  );
  registerHybridMemVersionFlag(mem);
  const onComplete = options?.onHybridMemCliComplete;
  // Before subcommands are registered — children inherit this exit handler (Issue #1224).
  attachHybridMemCliFatalExit(mem, onComplete);
  if (onComplete && typeof mem.hook === "function") {
    mem.hook("postAction", async () => {
      try {
        await onComplete();
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "hybrid-mem-post-action-teardown",
        });
      }
    });
  }
  try {
    registerHybridMemCli(mem as Parameters<typeof registerHybridMemCli>[0], ctx);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:hybrid-mem",
    });
    throw err;
  }
  ensureVerboseFlagOnHybridMemTree(mem);
  if (typeof (mem as { addHelpText?: (loc: string, text: string) => void }).addHelpText === "function") {
    const helpText = HYBRID_MEM_HELP_GROUPED + HYBRID_MEM_HELP_ACTIVE_TASKS;
    (mem as { addHelpText: (loc: string, text: string) => void }).addHelpText("after", helpText);
  }
}
