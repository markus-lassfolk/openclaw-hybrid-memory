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

type WriteChunk = Parameters<NodeJS.WriteStream["write"]>[0];
type WriteCallback = (error?: Error | null) => void;

const stdoutWriteState: {
  originalWrite: NodeJS.WriteStream["write"] | null;
  patched: boolean;
  suppressMirrorDepth: number;
  cleanupHooksInstalled: boolean;
} = {
  originalWrite: null,
  patched: false,
  suppressMirrorDepth: 0,
  cleanupHooksInstalled: false,
};

/** Preserve callback semantics for stream.write in both callback and non-callback forms. */
function resolveWriteArgs(
  encodingOrCb?: BufferEncoding | WriteCallback,
  cb?: WriteCallback,
): { encoding?: BufferEncoding; callback?: WriteCallback } {
  if (typeof encodingOrCb === "function") {
    return { callback: encodingOrCb };
  }
  return { encoding: encodingOrCb, callback: cb };
}

function writeToStream(
  stream: Pick<NodeJS.WriteStream, "write">,
  write: NodeJS.WriteStream["write"],
  chunk: WriteChunk,
  encoding?: BufferEncoding,
  callback?: WriteCallback,
): boolean {
  if (encoding !== undefined && callback) {
    return (
      write as unknown as (
        this: Pick<NodeJS.WriteStream, "write">,
        chunk: WriteChunk,
        encoding: BufferEncoding,
        callback: WriteCallback,
      ) => boolean
    ).call(stream, chunk, encoding, callback);
  }
  if (encoding !== undefined) {
    return (
      write as unknown as (
        this: Pick<NodeJS.WriteStream, "write">,
        chunk: WriteChunk,
        encoding: BufferEncoding,
      ) => boolean
    ).call(stream, chunk, encoding);
  }
  if (callback) {
    return (
      write as unknown as (
        this: Pick<NodeJS.WriteStream, "write">,
        chunk: WriteChunk,
        callback: WriteCallback,
      ) => boolean
    ).call(stream, chunk, callback);
  }
  return (write as unknown as (this: Pick<NodeJS.WriteStream, "write">, chunk: WriteChunk) => boolean).call(
    stream,
    chunk,
  );
}

/**
 * Temporarily disable stderr mirroring for the current sync call stack.
 * Used by JSON CLI output paths so payloads remain stdout-only.
 */
export function withJsonCliStdoutMirrorSuppressed<T>(fn: () => T): T {
  if (!stdoutWriteState.patched) return fn();
  stdoutWriteState.suppressMirrorDepth += 1;
  try {
    return fn();
  } finally {
    stdoutWriteState.suppressMirrorDepth = Math.max(0, stdoutWriteState.suppressMirrorDepth - 1);
  }
}

function chunkAsUtf8String(chunk: WriteChunk): string | null {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return null;
}

function isJsonPayloadChunk(chunk: WriteChunk): boolean {
  const text = chunkAsUtf8String(chunk)?.trim();
  if (!text) return false;
  // Final hybrid-mem JSON output is always an object/array. Do not classify arbitrary
  // primitives as payloads; diagnostics such as "true" or "123" should still mirror.
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function shouldMirrorStdoutChunk(chunk: WriteChunk): boolean {
  if (stdoutWriteState.suppressMirrorDepth > 0) return false;
  return !isJsonPayloadChunk(chunk);
}

function mirrorToStderr(chunk: WriteChunk, encoding?: BufferEncoding): void {
  const stderr = process.stderr;
  if (!stderr || typeof stderr.write !== "function") return;
  try {
    if (encoding !== undefined) {
      stderr.write(chunk, encoding);
      return;
    }
    stderr.write(chunk);
  } catch {
    // Stderr mirroring is best-effort; diagnostics must not make JSON commands fail.
  }
}

function installCleanupHooks(): void {
  if (stdoutWriteState.cleanupHooksInstalled) return;
  stdoutWriteState.cleanupHooksInstalled = true;
  process.once("exit", () => {
    restoreStdoutAfterJsonCli();
  });
}

function installStdoutTeeForJsonCli(): void {
  if (stdoutWriteState.patched) return;

  const originalWrite = process.stdout.write;
  stdoutWriteState.originalWrite = originalWrite;

  const patchedWrite: NodeJS.WriteStream["write"] = function patched(
    chunk: WriteChunk,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean {
    const { encoding, callback } = resolveWriteArgs(encodingOrCb, cb);

    let stdoutOk = true;
    try {
      stdoutOk = writeToStream(process.stdout, originalWrite, chunk, encoding, callback);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
        throw err;
      }
      stdoutOk = false;
    }

    if (shouldMirrorStdoutChunk(chunk)) {
      mirrorToStderr(chunk, encoding);
    }

    return stdoutOk;
  };

  process.stdout.write = patchedWrite;
  stdoutWriteState.patched = true;
  installCleanupHooks();
}

/**
 * For hybrid-mem `--json` / `--format json` CLI runs, OpenClaw's default `api.logger` may write
 * telemetry to stdout (e.g. `[plugins] …`), which breaks `jq` and cron harnesses.
 * Redirect plugin logger output to stderr to keep stdout clean for JSON.
 *
 * Issue: #1618 / JSON-CLI-OUTPUT.md — JSON must stay on stdout only, diagnostics on stderr only.
 */
export function wrapApiLoggerStderrForJsonCli(api: ClawdbotPluginApi): ClawdbotPluginApi {
  if (!isHybridMemJsonInvocation(process.argv)) return api;

  // Tee bootstrap/plugin stdout writes to stderr in JSON CLI mode. JSON payload chunks
  // are detected/suppressed centrally so command implementations do not need bespoke
  // output plumbing just to preserve the stdout JSON contract.
  installStdoutTeeForJsonCli();

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
 * Called from performHybridMemCliTeardown and process exit cleanup.
 */
export function restoreStdoutAfterJsonCli(): void {
  if (!stdoutWriteState.patched || !stdoutWriteState.originalWrite) return;

  process.stdout.write = stdoutWriteState.originalWrite;
  stdoutWriteState.originalWrite = null;
  stdoutWriteState.patched = false;
  stdoutWriteState.suppressMirrorDepth = 0;
}
