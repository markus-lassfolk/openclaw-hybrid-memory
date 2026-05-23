import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

/**
 * Detect if this is a hybrid-mem CLI invocation with --json or --format json flag.
 * Exported for tests. Stops at `--` to avoid false positives.
 *
 * When --json is present, plugin/api logger output should go to stderr to keep stdout
 * parseable as pure JSON (issue #1230 / #1234).
 */
export function isHybridMemJsonInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "--json") return true;
    if (a === "--format" && i + 1 < argv.length && argv[i + 1] === "json") return true;
    if (a.startsWith("--format=") && a.slice("--format=".length) === "json") return true;
  }
  return false;
}

/**
 * Track whether stdout.write has been modified, for cleanup in teardown.
 * Note: We no longer tee stdout to stderr (that would duplicate JSON payloads),
 * but keep this structure for potential future use.
 */
class StdoutTracker {
  private modified = false;

  /**
   * Mark that stdout handling has been set up for JSON mode.
   * Currently a no-op since we don't modify stdout.write anymore.
   */
  tee(): void {
    this.modified = true;
  }

  /**
   * Restore/cleanup after JSON CLI mode.
   */
  restore(): void {
    this.modified = false;
  }
}

const stdoutTracker = new StdoutTracker();

/**
 * For hybrid-mem `--json` / `--format json` CLI runs, OpenClaw's default `api.logger` may write
 * telemetry to stdout (e.g. `[plugins] …`), which breaks `jq` and cron harnesses.
 * Redirect plugin logger output to stderr to keep stdout clean for JSON.
 *
 * Issue: #1618 / JSON-CLI-OUTPUT.md — JSON must stay on stdout only, diagnostics on stderr only.
 */
export function wrapApiLoggerStderrForJsonCli(api: ClawdbotPluginApi): ClawdbotPluginApi {
  if (!isHybridMemJsonInvocation(process.argv)) return api;

  // Mark that we're in JSON mode (no actual stdout modification needed).
  stdoutTracker.tee();

  const log = (msg: string) => {
    console.error(msg);
  };

  return {
    ...api,
    logger: {
      ...api.logger,
      info: log,
      warn: log,
      error: log,
      debug: log,
    },
  };
}

/**
 * Restore stdout after JSON CLI mode.
 * Called from performHybridMemCliTeardown.
 */
export function restoreStdoutAfterJsonCli(): void {
  if (isHybridMemJsonInvocation(process.argv)) {
    stdoutTracker.restore();
  }
}
