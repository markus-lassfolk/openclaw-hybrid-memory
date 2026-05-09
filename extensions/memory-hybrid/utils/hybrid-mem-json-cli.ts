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
 * For hybrid-mem `--json` / `--format json` CLI runs, OpenClaw's default `api.logger` may write
 * telemetry to stdout (e.g. `[plugins] …`), which breaks `jq` and cron harnesses.
 * Return a shallow copy of `api` whose `logger` methods write only to stderr.
 */
export function wrapApiLoggerStderrForJsonCli(api: ClawdbotPluginApi): ClawdbotPluginApi {
  if (!isHybridMemJsonInvocation(process.argv)) return api;

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
