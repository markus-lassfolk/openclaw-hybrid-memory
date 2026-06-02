/**
 * VM Memory Incident Capture — Issue #1828
 *
 * Guarantees that `memory-diagnostics-live.json` inside an incident bundle is
 * never left at 0 bytes. When the live-diagnostics command fails, times out,
 * or produces non-JSON output the file is replaced with a structured failure
 * envelope so operators always have actionable JSON to inspect.
 *
 * Design:
 *  1. All writes go through a temp-file + atomic rename so a mid-write crash
 *     cannot leave the destination empty.
 *  2. On any capture failure a well-typed failure object is written instead.
 *  3. After bundle assembly a manifest file records each artifact size and
 *     warns about empty or missing critical files.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "../utils/process-runner.js";
import { getEnv } from "../utils/env-manager.js";
import { capturePluginError } from "./error-reporter.js";

/**
 * Promisified wrapper around execFile that correctly preserves the full
 * `(err, stdout, stderr)` callback signature.  Using an explicit wrapper
 * instead of `util.promisify` avoids losing the `util.promisify.custom`
 * symbol when the function is replaced by test doubles.
 */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // Attach stdout/stderr to the error so callers can inspect them.
        const augmented = Object.assign(err, {
          stdout: stdout as string,
          stderr: stderr as string,
        });
        reject(augmented);
      } else {
        resolve({ stdout: stdout as string, stderr: (stderr ?? "") as string });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Written when live diagnostics were captured successfully. */
export interface LiveDiagnosticsSuccess {
  ok: true;
  timestamp: string;
  exitCode: 0;
  /** The raw parsed JSON output from the diagnostics command. */
  diagnostics: unknown;
}

/**
 * Written when live diagnostics could not be captured. Always valid JSON and
 * always non-empty — this is the primary guarantee of Issue #1828.
 */
export interface LiveDiagnosticsFailure {
  ok: false;
  status: "command_failed" | "timeout" | "invalid_json" | "empty_output" | "spawn_error";
  /** Human-readable error description. */
  error: string;
  /** Process exit code (−1 when the process never started or was killed). */
  exitCode: number;
  /** True when the command exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Captured stderr, if any. */
  stderr?: string;
  /** Fallback memory snapshot taken from process.memoryUsage() at failure time. */
  fallbackMemory?: FallbackMemory;
  timestamp: string;
}

export type LiveDiagnosticsResult = LiveDiagnosticsSuccess | LiveDiagnosticsFailure;

/** Lightweight memory snapshot captured in-process as a fallback. */
export interface FallbackMemory {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
}

/** Per-file metadata entry in the incident manifest. */
export interface IncidentArtifactInfo {
  /** Filename relative to the bundle directory. */
  filename: string;
  /** File size in bytes (−1 when the file does not exist). */
  size: number;
  /** True when the file does not exist on disk. */
  missing: boolean;
  /** True when the file exists but contains no bytes. */
  empty: boolean;
  /** True for artifacts whose absence degrades incident diagnosis significantly. */
  critical: boolean;
}

/** Written as `incident-manifest.json` in the bundle directory. */
export interface IncidentManifest {
  timestamp: string;
  bundleDir: string;
  artifacts: IncidentArtifactInfo[];
  /** Human-readable warning strings for empty or missing critical artifacts. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Default critical artifacts
// ---------------------------------------------------------------------------

/** Files that are expected in every incident bundle and flagged when missing/empty. */
export const DEFAULT_CRITICAL_ARTIFACTS = [
  "memory-diagnostics-live.json",
  "snapshot.json",
  "leak-report.json",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Atomically writes `content` to `destPath` by writing to a sibling temp file
 * first, then renaming. Guarantees `destPath` is never partially written.
 */
function atomicWrite(destPath: string, content: string): void {
  const tmpPath = `${destPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
}

function captureFallbackMemory(): FallbackMemory {
  const m = process.memoryUsage();
  return { rssBytes: m.rss, heapTotalBytes: m.heapTotal, heapUsedBytes: m.heapUsed };
}

function isTimeoutError(err: unknown): boolean {
  return (
    (err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ||
    (err as { killed?: boolean })?.killed === true ||
    (typeof (err as { signal?: string })?.signal === "string" &&
      (err as { signal: string }).signal === "SIGTERM")
  );
}

// ---------------------------------------------------------------------------
// Core capture function
// ---------------------------------------------------------------------------

export interface CaptureLiveDiagnosticsOptions {
  /** Path to the executable (e.g. `"node"`, `"/usr/bin/python3"`). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Milliseconds before the child process is killed (default: 30 000). */
  timeoutMs?: number;
  /**
   * When true the in-process RSS/heap snapshot is included in failure envelopes
   * (default: true).
   */
  includeFallbackMemory?: boolean;
}

/**
 * Runs a live-diagnostics command and writes its JSON output to `destPath`.
 *
 * Guarantees:
 * - `destPath` is **never** left at 0 bytes.
 * - On any capture failure a structured failure envelope is written instead of
 *   leaving an empty file.
 * - All writes are atomic (temp-file + rename).
 *
 * @returns The result object that was serialised to `destPath`.
 */
export async function captureLiveDiagnosticsToFile(
  destPath: string,
  opts: CaptureLiveDiagnosticsOptions,
): Promise<LiveDiagnosticsResult> {
  const { command, args = [], timeoutMs = 30_000, includeFallbackMemory = true } = opts;
  const timestamp = new Date().toISOString();

  let result: LiveDiagnosticsResult;

  try {
    const { stdout, stderr } = await runCommand(command, args, timeoutMs);

    const trimmed = stdout.trim();

    if (!trimmed) {
      const trimmedStderr = stderr?.trim();
      const failure: LiveDiagnosticsFailure = {
        ok: false,
        status: "empty_output",
        error: "Diagnostics command produced no output",
        exitCode: 0,
        timedOut: false,
        ...(trimmedStderr ? { stderr: trimmedStderr } : {}),
        ...(includeFallbackMemory ? { fallbackMemory: captureFallbackMemory() } : {}),
        timestamp,
      };
      result = failure;
    } else {
      let parsedResult: LiveDiagnosticsResult;
      try {
        const parsed = JSON.parse(trimmed);
        parsedResult = {
          ok: true,
          timestamp,
          exitCode: 0,
          diagnostics: parsed,
        } satisfies LiveDiagnosticsSuccess;
      } catch (parseErr) {
        const trimmedStderr = stderr?.trim();
        parsedResult = {
          ok: false,
          status: "invalid_json",
          error: `Diagnostics command output was not valid JSON: ${String(parseErr)}`,
          exitCode: 0,
          timedOut: false,
          ...(trimmedStderr ? { stderr: trimmedStderr } : {}),
          ...(includeFallbackMemory ? { fallbackMemory: captureFallbackMemory() } : {}),
          timestamp,
        } satisfies LiveDiagnosticsFailure;
      }
      result = parsedResult;
    }
  } catch (err: unknown) {
    // execFile rejects on non-zero exit or timeout
    const timedOut = isTimeoutError(err);

    const exitCode =
      typeof (err as { code?: unknown })?.code === "number"
        ? ((err as { code: number }).code as number)
        : -1;

    const stderr =
      typeof (err as { stderr?: string })?.stderr === "string"
        ? ((err as { stderr: string }).stderr.trim() as string)
        : undefined;

    const failure: LiveDiagnosticsFailure = {
      ok: false,
      status: timedOut ? "timeout" : "command_failed",
      error: err instanceof Error ? err.message : String(err),
      exitCode,
      timedOut,
      ...(stderr ? { stderr } : {}),
      ...(includeFallbackMemory ? { fallbackMemory: captureFallbackMemory() } : {}),
      timestamp,
    };
    result = failure;
  }

  try {
    atomicWrite(destPath, JSON.stringify(result, null, 2));
  } catch (writeErr) {
    capturePluginError(writeErr instanceof Error ? writeErr : new Error(String(writeErr)), {
      subsystem: "vm-memory-incident",
      operation: "write-live-diagnostics",
    });
    // Re-throw: the caller needs to know the write failed.
    throw writeErr;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Zero-byte repair helper
// ---------------------------------------------------------------------------

/**
 * If `filePath` exists and is 0 bytes, replace it with a structured failure
 * envelope so the bundle never contains empty JSON files.
 *
 * @returns `true` when a repair was performed, `false` otherwise.
 */
export function repairZeroByteIncidentFile(
  filePath: string,
  context?: { command?: string; reason?: string },
): boolean {
  if (!existsSync(filePath)) return false;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return false;
  }
  if (size !== 0) return false;

  const envelope: LiveDiagnosticsFailure = {
    ok: false,
    status: "empty_output",
    error:
      context?.reason ??
      "Artifact was 0 bytes at bundle assembly time; capture command likely crashed or was killed before writing output.",
    exitCode: -1,
    timedOut: false,
    fallbackMemory: captureFallbackMemory(),
    timestamp: new Date().toISOString(),
  };

  try {
    atomicWrite(filePath, JSON.stringify(envelope, null, 2));
    return true;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "vm-memory-incident",
      operation: "repair-zero-byte",
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Incident manifest
// ---------------------------------------------------------------------------

export interface WriteIncidentManifestOptions {
  /**
   * Filenames that should exist in the bundle (checked for empty/missing).
   * Defaults to {@link DEFAULT_CRITICAL_ARTIFACTS}.
   */
  criticalFiles?: readonly string[];
}

/**
 * Writes `incident-manifest.json` to `bundleDir`, listing every file's size
 * and flagging empty or missing critical artifacts.
 *
 * @returns The manifest that was written.
 */
export function writeIncidentManifest(
  bundleDir: string,
  opts?: WriteIncidentManifestOptions,
): IncidentManifest {
  const criticalSet = new Set<string>(opts?.criticalFiles ?? DEFAULT_CRITICAL_ARTIFACTS);

  // Collect all filenames from the directory (excluding the manifest itself).
  const dirFiles = new Set<string>();
  if (existsSync(bundleDir)) {
    try {
      for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== "incident-manifest.json") {
          dirFiles.add(entry.name);
        }
      }
    } catch {
      // If we can't read the dir, continue with an empty set
    }
  }

  // Union of existing files and expected critical files.
  const allFiles = new Set([...dirFiles, ...criticalSet]);

  const artifacts: IncidentArtifactInfo[] = [];
  const warnings: string[] = [];

  for (const filename of [...allFiles].sort()) {
    const fullPath = join(bundleDir, filename);
    const missing = !existsSync(fullPath);
    let size = -1;
    if (!missing) {
      try {
        size = statSync(fullPath).size;
      } catch {
        size = -1;
      }
    }
    const empty = !missing && size === 0;
    const critical = criticalSet.has(filename);

    artifacts.push({ filename, size, missing, empty, critical });

    if (critical && missing) {
      warnings.push(`Critical artifact missing: ${filename}`);
    } else if (critical && empty) {
      warnings.push(`Critical artifact is empty (0 bytes): ${filename}`);
    }
  }

  const manifest: IncidentManifest = {
    timestamp: new Date().toISOString(),
    bundleDir,
    artifacts,
    warnings,
  };

  try {
    atomicWrite(join(bundleDir, "incident-manifest.json"), JSON.stringify(manifest, null, 2));
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "vm-memory-incident",
      operation: "write-manifest",
    });
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Convenience: resolve the incident bundle directory
// ---------------------------------------------------------------------------

/**
 * Returns the root directory for VM memory incident bundles, honouring the
 * `OPENCLAW_HOME` environment variable.
 */
export function resolveIncidentBundleRoot(): string {
  const home = getEnv("OPENCLAW_HOME")?.trim() || join(homedir(), ".openclaw");
  return join(home, "logs", "vm-memory-incidents");
}
