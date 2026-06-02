/**
 * Tests for vm-memory-incident-capture (Issue #1828).
 *
 * Covers:
 *  - Successful capture writes valid non-empty JSON
 *  - Command failure writes a structured failure envelope (never 0 bytes)
 *  - Command timeout writes a failure envelope with timedOut: true
 *  - Invalid (non-JSON) command output is represented as failure
 *  - Existing 0-byte file is repaired to a non-empty failure envelope
 *  - Incident manifest lists artifacts, sizes, and flags empty/missing critical files
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  DEFAULT_CRITICAL_ARTIFACTS,
  captureLiveDiagnosticsToFile,
  repairZeroByteIncidentFile,
  resolveIncidentBundleRoot,
  writeIncidentManifest,
  type IncidentManifest,
  type LiveDiagnosticsFailure,
  type LiveDiagnosticsSuccess,
} from "../services/vm-memory-incident-capture.js";
import { getEnv, setEnv } from "../utils/env-manager.js";
import { execFileSync } from "../utils/process-runner.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_DIAGNOSTICS = {
  rssBytes: 1_073_741_824,
  heapTotalBytes: 512_000_000,
  heapUsedBytes: 400_000_000,
  gcStats: { collections: 12 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

function fileSize(path: string): number {
  return statSync(path).size;
}

/** Matches the (error, stdout, stderr) execFile callback signature. */
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Constructs a fake execFile error with attached stdout/stderr and exit code. */
function makeExecError(
  message: string,
  code: number | string,
  stderr: string,
  killed = false,
): Error & { code: number | string; killed: boolean; signal: string | null; stderr: string } {
  return Object.assign(new Error(message), { code, killed, signal: null as string | null, stderr });
}

// ---------------------------------------------------------------------------
// Mock process-runner so we don't spawn real child processes
// ---------------------------------------------------------------------------

// We vi.mock the entire module to intercept execFile calls.
vi.mock("../utils/process-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/process-runner.js")>("../utils/process-runner.js");
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let execFileMock: MockInstance;

beforeEach(async () => {
  tmpDir = makeTmpDir("vm-incident-test");
  const runner = await import("../utils/process-runner.js");
  execFileMock = vi.mocked(runner.execFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// captureLiveDiagnosticsToFile — success path
// ---------------------------------------------------------------------------

describe("captureLiveDiagnosticsToFile — success", () => {
  it("writes valid non-empty JSON when the command succeeds", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(null, JSON.stringify(FAKE_DIAGNOSTICS), "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "fake-diagnostic",
    });

    expect(result.ok).toBe(true);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsSuccess>(destPath);
    expect(written.ok).toBe(true);
    expect(written.exitCode).toBe(0);
    expect(written.diagnostics).toMatchObject(FAKE_DIAGNOSTICS);
    expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fixture: successful diagnostics object matches expected shape", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(null, JSON.stringify(FAKE_DIAGNOSTICS), "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    await captureLiveDiagnosticsToFile(destPath, { command: "fake-diagnostic" });

    const written = readJsonFile<LiveDiagnosticsSuccess>(destPath);
    expect(written).toMatchObject({
      ok: true,
      exitCode: 0,
      diagnostics: {
        rssBytes: 1_073_741_824,
        heapTotalBytes: 512_000_000,
        heapUsedBytes: 400_000_000,
        gcStats: { collections: 12 },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// captureLiveDiagnosticsToFile — command failure
// ---------------------------------------------------------------------------

describe("captureLiveDiagnosticsToFile — command failure", () => {
  it("classifies executable spawn errors as spawn_error", async () => {
    const fakeError = makeExecError("spawn fake-diagnostic ENOENT", "ENOENT", "");

    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(fakeError, "", "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "missing-diagnostic-binary",
    });

    expect(result.ok).toBe(false);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("spawn_error");
    expect(written.exitCode).toBe(-1);
    expect(written.timedOut).toBe(false);
  });

  it("writes a non-empty failure envelope when the command exits non-zero", async () => {
    const fakeError = makeExecError("Command exited with code 1", 1, "Fatal: out of memory");

    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(fakeError, "", "Fatal: out of memory");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "fake-diagnostic",
    });

    expect(result.ok).toBe(false);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("command_failed");
    expect(written.timedOut).toBe(false);
    expect(written.stderr).toBe("Fatal: out of memory");
    expect(written.fallbackMemory).toBeDefined();
    expect(written.fallbackMemory?.rssBytes).toBeGreaterThan(0);
    expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fixture: failed diagnostics object matches expected shape", async () => {
    const fakeError = makeExecError("exit code 2", 2, "diagnostics tool crashed");

    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(fakeError, "", "diagnostics tool crashed");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    await captureLiveDiagnosticsToFile(destPath, { command: "fake-diagnostic" });

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written).toMatchObject({
      ok: false,
      status: "command_failed",
      timedOut: false,
      stderr: "diagnostics tool crashed",
    });
    expect(written.fallbackMemory).toBeDefined();
    expect(typeof written.fallbackMemory?.rssBytes).toBe("number");
    expect(typeof written.fallbackMemory?.heapTotalBytes).toBe("number");
    expect(typeof written.fallbackMemory?.heapUsedBytes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// captureLiveDiagnosticsToFile — timeout
// ---------------------------------------------------------------------------

describe("captureLiveDiagnosticsToFile — timeout", () => {
  it("writes a non-empty failure envelope with timedOut: true when the command is killed", async () => {
    const timeoutError = Object.assign(makeExecError("Command timed out", "ETIMEDOUT", "", true), {
      signal: "SIGTERM",
    });

    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(timeoutError, "", "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "fake-diagnostic",
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("timeout");
    expect(written.timedOut).toBe(true);
    expect(written.fallbackMemory).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// captureLiveDiagnosticsToFile — invalid JSON output
// ---------------------------------------------------------------------------

describe("captureLiveDiagnosticsToFile — invalid output", () => {
  it("writes a failure envelope when the command produces non-JSON output", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(null, "not json at all <<<>>>", "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "fake-diagnostic",
    });

    expect(result.ok).toBe(false);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("invalid_json");
    expect(written.timedOut).toBe(false);
  });

  it("writes a failure envelope when the command produces empty output", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecFileCallback) => {
      cb(null, "   \n\t  ", "");
    });

    const destPath = join(tmpDir, "memory-diagnostics-live.json");
    const result = await captureLiveDiagnosticsToFile(destPath, {
      command: "fake-diagnostic",
    });

    expect(result.ok).toBe(false);
    expect(fileSize(destPath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(destPath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("empty_output");
  });
});

// ---------------------------------------------------------------------------
// repairZeroByteIncidentFile
// ---------------------------------------------------------------------------

describe("repairZeroByteIncidentFile", () => {
  it("replaces a 0-byte file with a structured failure envelope", () => {
    const filePath = join(tmpDir, "memory-diagnostics-live.json");
    writeFileSync(filePath, "", "utf-8");
    expect(fileSize(filePath)).toBe(0);

    const repaired = repairZeroByteIncidentFile(filePath, {
      reason: "capture command was killed before writing output",
    });

    expect(repaired).toBe(true);
    expect(fileSize(filePath)).toBeGreaterThan(0);

    const written = readJsonFile<LiveDiagnosticsFailure>(filePath);
    expect(written.ok).toBe(false);
    expect(written.status).toBe("empty_output");
    expect(written.error).toContain("capture command was killed");
    expect(written.fallbackMemory).toBeDefined();
  });

  it("does not modify a file that already has content", () => {
    const filePath = join(tmpDir, "memory-diagnostics-live.json");
    const original = JSON.stringify({ ok: true, diagnostics: { x: 1 } });
    writeFileSync(filePath, original, "utf-8");

    const repaired = repairZeroByteIncidentFile(filePath);

    expect(repaired).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("returns false when the file does not exist", () => {
    const missing = join(tmpDir, "does-not-exist.json");
    expect(repairZeroByteIncidentFile(missing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeIncidentManifest
// ---------------------------------------------------------------------------

describe("writeIncidentManifest", () => {
  it("writes incident-manifest.json with artifact sizes", () => {
    const bundleDir = join(tmpDir, "bundle1");
    mkdirSync(bundleDir, { recursive: true });

    // Write some artifacts
    writeFileSync(join(bundleDir, "snapshot.json"), JSON.stringify({ rss: 1 }), "utf-8");
    writeFileSync(join(bundleDir, "ps-gateway.txt"), "pid 1234\n", "utf-8");
    // Leave memory-diagnostics-live.json empty (the problem case)
    writeFileSync(join(bundleDir, "memory-diagnostics-live.json"), "", "utf-8");

    writeIncidentManifest(bundleDir);

    expect(existsSync(join(bundleDir, "incident-manifest.json"))).toBe(true);

    const stored = readJsonFile<IncidentManifest>(join(bundleDir, "incident-manifest.json"));
    expect(stored.bundleDir).toBe(bundleDir);
    expect(stored.warnings.length).toBeGreaterThan(0);
    expect(stored.warnings.some((w) => w.includes("memory-diagnostics-live.json"))).toBe(true);
  });

  it("flags empty critical artifacts as warnings", () => {
    const bundleDir = join(tmpDir, "bundle2");
    mkdirSync(bundleDir, { recursive: true });

    // Empty memory-diagnostics-live.json
    writeFileSync(join(bundleDir, "memory-diagnostics-live.json"), "", "utf-8");

    const manifest = writeIncidentManifest(bundleDir);

    const diagArtifact = manifest.artifacts.find((a) => a.filename === "memory-diagnostics-live.json");
    expect(diagArtifact?.empty).toBe(true);
    expect(diagArtifact?.critical).toBe(true);
    expect(manifest.warnings).toContain("Critical artifact is empty (0 bytes): memory-diagnostics-live.json");
  });

  it("flags missing critical artifacts as warnings", () => {
    const bundleDir = join(tmpDir, "bundle3");
    mkdirSync(bundleDir, { recursive: true });

    // No files — just an empty directory
    const manifest = writeIncidentManifest(bundleDir);

    expect(manifest.warnings.some((w) => w.includes("memory-diagnostics-live.json"))).toBe(true);
    const diagArtifact = manifest.artifacts.find((a) => a.filename === "memory-diagnostics-live.json");
    expect(diagArtifact?.missing).toBe(true);
    expect(diagArtifact?.size).toBe(-1);
  });

  it("reports no warnings when all critical artifacts are present and non-empty", () => {
    const bundleDir = join(tmpDir, "bundle4");
    mkdirSync(bundleDir, { recursive: true });

    for (const name of DEFAULT_CRITICAL_ARTIFACTS) {
      writeFileSync(join(bundleDir, name), JSON.stringify({ ok: true }), "utf-8");
    }

    const manifest = writeIncidentManifest(bundleDir);
    expect(manifest.warnings).toHaveLength(0);
  });

  it("records correct file sizes in the artifact list", () => {
    const bundleDir = join(tmpDir, "bundle5");
    mkdirSync(bundleDir, { recursive: true });

    const content = JSON.stringify({ heap: 123_456 });
    writeFileSync(join(bundleDir, "memory-diagnostics-live.json"), content, "utf-8");

    const manifest = writeIncidentManifest(bundleDir);
    const artifact = manifest.artifacts.find((a) => a.filename === "memory-diagnostics-live.json");
    expect(artifact?.size).toBe(Buffer.byteLength(content, "utf-8"));
    expect(artifact?.empty).toBe(false);
    expect(artifact?.missing).toBe(false);
  });

  it("accepts custom critical file list", () => {
    const bundleDir = join(tmpDir, "bundle6");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "custom-artifact.json"), "", "utf-8");

    const manifest = writeIncidentManifest(bundleDir, {
      criticalFiles: ["custom-artifact.json"],
    });

    expect(manifest.warnings).toContain("Critical artifact is empty (0 bytes): custom-artifact.json");
  });
});

// ---------------------------------------------------------------------------
// resolveIncidentBundleRoot
// ---------------------------------------------------------------------------

describe("resolveIncidentBundleRoot", () => {
  const originalHome = getEnv("OPENCLAW_HOME");

  afterEach(() => {
    setEnv("OPENCLAW_HOME", originalHome);
  });

  it("uses OPENCLAW_HOME when set", () => {
    setEnv("OPENCLAW_HOME", "/custom/openclaw");
    expect(resolveIncidentBundleRoot()).toBe("/custom/openclaw/logs/vm-memory-incidents");
  });

  it("falls back to ~/.openclaw when OPENCLAW_HOME is not set", () => {
    setEnv("OPENCLAW_HOME", undefined);
    const root = resolveIncidentBundleRoot();
    expect(root).toMatch(/vm-memory-incidents$/);
    expect(root).toMatch(/\.openclaw/);
  });
});

// ---------------------------------------------------------------------------
// vm-memory-collect-diagnostics.sh integration guard
// ---------------------------------------------------------------------------

describe("vm-memory-collect-diagnostics.sh", () => {
  it("writes a non-empty failure envelope and manifest when live HTTP diagnostics fail", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const scriptPath = join(repoRoot, "scripts", "vm-memory-collect-diagnostics.sh");
    const openclawHome = join(tmpDir, "openclaw-home");
    const incidentDir = join(openclawHome, "logs", "vm-memory-incidents", "test-incident");
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(openclawHome, ".secrets"), { recursive: true });
    writeFileSync(join(openclawHome, ".secrets", "gateway-token"), "test-token", "utf-8");

    // Keep the test hermetic and fast: the real script shells out to systemctl,
    // journalctl, and optionally openclaw, so shadow them with harmless stubs.
    for (const name of ["systemctl", "journalctl", "openclaw"]) {
      writeFileSync(join(binDir, name), "#!/usr/bin/env bash\nexit 1\n", { encoding: "utf-8", mode: 0o755 });
    }
    writeFileSync(join(binDir, "curl"), "#!/usr/bin/env bash\necho 'simulated connection refused' >&2\nexit 7\n", {
      encoding: "utf-8",
      mode: 0o755,
    });

    execFileSync("/bin/bash", [scriptPath, incidentDir], {
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
        PATH: `${binDir}:${getEnv("PATH") ?? ""}`,
      },
      stdio: "pipe",
      timeout: 20_000,
    });

    const livePath = join(incidentDir, "memory-diagnostics-live.json");
    expect(fileSize(livePath)).toBeGreaterThan(0);
    const live = readJsonFile<LiveDiagnosticsFailure>(livePath);
    expect(live).toMatchObject({
      ok: false,
      status: "command_failed",
      exitCode: 7,
      timedOut: false,
    });
    expect(live.stderr).toContain("simulated connection refused");

    const manifest = readJsonFile<IncidentManifest>(join(incidentDir, "incident-manifest.json"));
    const liveArtifact = manifest.artifacts.find((a) => a.filename === "memory-diagnostics-live.json");
    expect(liveArtifact?.empty).toBe(false);
    expect(manifest.warnings).not.toContain("Critical artifact is empty (0 bytes): memory-diagnostics-live.json");
  });
});
