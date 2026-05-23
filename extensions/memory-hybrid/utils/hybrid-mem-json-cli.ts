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
 * Tee write stream that mirrors all writes to both stdout and stderr.
 * Used in JSON mode so diagnostics on stderr are visible AND the JSON
 * document on stdout remains clean for `jq` / cron consumers.
 */
class TeeStderr {
  private originalWrite: (chunk: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => boolean;

  constructor() {
    // Capture the original stdout.write before we replace it
    this.originalWrite = process.stdout.write.bind(process.stdout);
  }

  /**
   * Replace process.stdout.write to tee all output to stderr as well.
   * This ensures JSON emitted via `console.log` ends up on BOTH stdout and stderr,
   * so cron harnesses that capture stderr still see the JSON while human operators
   * can see diagnostics on stderr.
   *
   * Issue: #1618 — `hybrid-mem --json` stdout is empty; all output including JSON
   * goes to stderr. Using a tee so stdout always has the JSON payload even if a
   * host/process setup redirects stdout away.
   */
  tee(): void {
    const originalWrite = this.originalWrite;
    process.stdout.write = (
      chunk: unknown,
      encoding?: BufferEncoding | (() => void),
      cb?: () => void,
    ): boolean => {
      const str = typeof chunk === "string" ? chunk : String(chunk);
      originalWrite(str, encoding as BufferEncoding, cb);
      process.stderr.write(str);
      return true;
    };
  }

  /**
   * Restore the original stdout.write.
   */
  restore(): void {
    process.stdout.write = this.originalWrite;
  }
}

const teeStderr = new TeeStderr();

/**
 * For hybrid-mem `--json` / `--format json` CLI runs, OpenClaw's default `api.logger` may write
 * telemetry to stdout (e.g. `[plugins] …`), which breaks `jq` and cron harnesses.
 * Also tee stdout→stderr so JSON payloads are visible on stderr as a fallback stream.
 *
 * Issue: #1618 — the repro showed stdout=0 bytes, all output including JSON on stderr.
 * Teeing stdout→stderr means any JSON written to stdout is ALSO captured on stderr,
 * making the command work regardless of which stream the caller monitors.
 */
export function wrapApiLoggerStderrForJsonCli(api: ClawdbotPluginApi): ClawdbotPluginApi {
  if (!isHybridMemJsonInvocation(process.argv)) return api;

  // Tee stdout→stderr so JSON appears on both streams.
  teeStderr.tee();

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
    teeStderr.restore();
  }
}
