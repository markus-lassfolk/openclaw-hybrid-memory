/**
 * Commander helpers for hybrid-mem: per-subcommand --verbose parity and reliable exits
 * on parse errors (Issue #1224).
 */

import { CommanderError, type Command } from "commander";

const VERBOSE_DESC =
  "Verbose output (same as `openclaw hybrid-mem -v` before this subcommand). Subcommands that already define detailed --verbose behavior treat this as the same flag.";

function commandHasVerbose(cmd: Command): boolean {
  for (const o of cmd.options) {
    if (o.long === "--verbose" || o.short === "-v") return true;
  }
  return false;
}

/**
 * After the full hybrid-mem command tree is registered, ensure every subcommand accepts
 * `-v` / `--verbose` so `openclaw hybrid-mem <cmd> --verbose` does not trip unknown-option
 * handling (Issue #1224).
 */
export function ensureVerboseFlagOnHybridMemTree(mem: Command): void {
  function walk(cmd: Command): void {
    for (const sub of cmd.commands) {
      walk(sub);
    }
    if (!commandHasVerbose(cmd)) {
      cmd.option("-v, --verbose", VERBOSE_DESC, false);
    }
  }
  for (const sub of mem.commands) {
    walk(sub);
  }
}

/**
 * After Commander prints `error: unknown option …`, `_exit` runs `exitOverride` and then still
 * calls `process.exit` synchronously unless the override throws. Hosts that replace `exitOverride`
 * with a non-throwing callback can skip that `process.exit`, leaving DBs/timers alive (Issue #1224).
 *
 * We schedule async teardown, then **rethrow** so Commander's synchronous `process.exit` is skipped
 * and we exit only after teardown completes.
 */
export function attachHybridMemCliFatalExit(mem: Command, teardown?: () => void | Promise<void>): void {
  mem.exitOverride((err: CommanderError) => {
    if (err.code === "commander.executeSubCommandAsync") {
      return;
    }
    const exitCode = err.exitCode ?? 1;
    void (async () => {
      try {
        await teardown?.();
      } catch {
        /* best-effort */
      }
      process.exit(exitCode);
    })();
    throw err;
  });
}
