import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

type MachineOutputMode = "json-tee" | "value-only-strict";

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
 * Detect `credentials get --value-only` (or `--quiet`) for machine-readable secret output.
 * Issue #1882: stdout must contain only the credential value for piping into sshpass/curl/etc.
 */
export function isHybridMemCredentialsValueOnlyInvocation(argv: string[]): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;

  let sawCredentials = false;
  let sawGet = false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "credentials") {
      sawCredentials = true;
      sawGet = false;
      continue;
    }
    if (sawCredentials && a === "get") {
      sawGet = true;
      continue;
    }
    if (sawCredentials && sawGet && (a === "--value-only" || a === "--quiet")) {
      return true;
    }
  }
  return false;
}

/** True when stdout must carry a single machine-readable payload (JSON or raw secret). */
export function isHybridMemMachineOutputInvocation(argv: string[]): boolean {
  return isHybridMemJsonInvocation(argv) || isHybridMemCredentialsValueOnlyInvocation(argv);
}

function resolveMachineOutputMode(argv: string[]): MachineOutputMode | null {
  if (isHybridMemCredentialsValueOnlyInvocation(argv)) return "value-only-strict";
  if (isHybridMemJsonInvocation(argv)) return "json-tee";
  return null;
}

type WriteChunk = Parameters<NodeJS.WriteStream["write"]>[0];
type WriteCallback = (error?: Error | null) => void;

const stdoutWriteState: {
  originalWrite: NodeJS.WriteStream["write"] | null;
  patched: boolean;
  suppressMirrorDepth: number;
  cleanupHooksInstalled: boolean;
  mode: MachineOutputMode | null;
} = {
  originalWrite: null,
  patched: false,
  suppressMirrorDepth: 0,
  cleanupHooksInstalled: false,
  mode: null,
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
 * Temporarily allow stdout payload writes in machine-output CLI mode.
 * JSON: skip stderr mirroring for the payload chunk.
 * Value-only: allow writes to real stdout instead of stderr redirect.
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

/** Alias for machine-output modes beyond JSON (issue #1882). */
export const withMachineOutputStdoutSuppressed = withJsonCliStdoutMirrorSuppressed;

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

function installStdoutPatchForMachineOutputCli(mode: MachineOutputMode): void {
  if (stdoutWriteState.patched) return;

  const originalWrite = process.stdout.write;
  stdoutWriteState.originalWrite = originalWrite;
  stdoutWriteState.mode = mode;

  const patchedWrite: NodeJS.WriteStream["write"] = function patched(
    chunk: WriteChunk,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean {
    const { encoding, callback } = resolveWriteArgs(encodingOrCb, cb);

    if (stdoutWriteState.mode === "value-only-strict") {
      if (stdoutWriteState.suppressMirrorDepth > 0) {
        try {
          return writeToStream(process.stdout, originalWrite, chunk, encoding, callback);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
            throw err;
          }
          return false;
        }
      }
      return mirrorOnlyToStderr(chunk, encoding, callback);
    }

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

function mirrorOnlyToStderr(chunk: WriteChunk, encoding?: BufferEncoding, callback?: WriteCallback): boolean {
  const stderr = process.stderr;
  if (!stderr || typeof stderr.write !== "function") {
    callback?.();
    return false;
  }
  try {
    return writeToStream(stderr, stderr.write.bind(stderr), chunk, encoding, callback);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
    return false;
  }
}

/**
 * For hybrid-mem `--json` / `--format json` CLI runs, OpenClaw's default `api.logger` may write
 * telemetry to stdout (e.g. `[plugins] …`), which breaks `jq` and cron harnesses.
 * Redirect plugin logger output to stderr to keep stdout clean for JSON.
 *
 * Issue: #1618 / JSON-CLI-OUTPUT.md — JSON must stay on stdout only, diagnostics on stderr only.
 */
export function wrapApiLoggerStderrForJsonCli(api: ClawdbotPluginApi): ClawdbotPluginApi {
  const mode = resolveMachineOutputMode(process.argv);
  if (!mode) return api;

  // JSON: tee bootstrap/plugin stdout to stderr; value-only: redirect all stdout to stderr
  // until the command emits its payload inside withMachineOutputStdoutSuppressed().
  installStdoutPatchForMachineOutputCli(mode);

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
  stdoutWriteState.mode = null;
}
