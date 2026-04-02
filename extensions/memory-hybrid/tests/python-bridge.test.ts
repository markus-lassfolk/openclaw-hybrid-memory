/**
 * Python Bridge tests.
 *
 * Uses a mock subprocess rather than real Python to avoid requiring Python or
 * markitdown to be installed in the test environment.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PythonBridge } from "../services/python-bridge.js";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

/** Minimal fake ChildProcess for testing PythonBridge */
class FakeProcess extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;

  constructor() {
    super();
    this.stdin = { write: vi.fn(), end: vi.fn() };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit("exit", signal === "SIGTERM" ? null : 0, signal ?? null);
    return true;
  }

  /** Helper: simulate Python worker responding with a JSON-RPC result */
  respond(response: object): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`));
  }
}

let fakeProc: FakeProcess;

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      fakeProc = new FakeProcess();
      return fakeProc;
    }),
    spawnSync: spawnSyncMock,
  };
});

// PythonBridge uses readline over stdout — re-export readline to pass through
vi.mock("node:readline", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:readline")>();
  return {
    ...original,
    createInterface: (opts: { input: EventEmitter }) => {
      const rl = new EventEmitter() as EventEmitter & { close: () => void };
      rl.close = vi.fn();
      // Forward raw data events as "line" events (split on newline)
      opts.input.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) rl.emit("line", line.trim());
        }
      });
      return rl;
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PythonBridge", () => {
  let bridge: PythonBridge;

  beforeEach(() => {
    bridge = new PythonBridge("python3");
  });

  afterEach(async () => {
    // Prevent any pending timeouts from leaking between tests
    if (bridge.isRunning) {
      await bridge.shutdown().catch(() => {});
    }
  });

  it("is not running before first use", () => {
    expect(bridge.isRunning).toBe(false);
  });

  it("converts a file by sending a JSON-RPC request", async () => {
    const expectedResult = { markdown: "# Hello\n\nWorld", title: "test.pdf" };

    // Start convert — this will call ensureStarted → ping, then convert
    const convertPromise = bridge.convert("/tmp/test.pdf");

    // Wait a tick for spawn to be called and for ping to be sent
    await new Promise((r) => setImmediate(r));

    // Respond to ping (id=1)
    fakeProc.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    // Wait a tick for convert to be sent (id=2)
    await new Promise((r) => setImmediate(r));

    // Respond to convert (id=2)
    fakeProc.respond({ jsonrpc: "2.0", id: 2, result: expectedResult });

    const result = await convertPromise;
    expect(result.markdown).toBe(expectedResult.markdown);
    expect(result.title).toBe(expectedResult.title);
  });

  it("rejects on RPC error response", async () => {
    const convertPromise = bridge.convert("/tmp/bad.pdf");

    await new Promise((r) => setImmediate(r));

    // Respond to ping
    fakeProc.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // Respond with error
    fakeProc.respond({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "File not found" } });

    await expect(convertPromise).rejects.toThrow("File not found");
  });

  it("rejects all pending when process exits unexpectedly (retry also fails)", async () => {
    const convertPromise = bridge.convert("/tmp/test.pdf");

    await new Promise((r) => setImmediate(r));

    // Respond to ping so we get past ensureStarted (id=1)
    fakeProc.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // Simulate unexpected process exit before convert response
    fakeProc.killed = true;
    fakeProc.emit("exit", 1, null);

    // Retry kicks in: proc2 spawns and sends ping (id=3)
    await new Promise((r) => setImmediate(r));
    fakeProc.respond({ jsonrpc: "2.0", id: 3, result: { pong: true } });
    await new Promise((r) => setImmediate(r));

    // proc2 also exits before convert response → retry fails → original error propagated
    fakeProc.killed = true;
    fakeProc.emit("exit", 2, null);

    await expect(convertPromise).rejects.toThrow(/exited/i);
  });

  it("retries convert once when worker exits mid-conversion", async () => {
    const convertPromise = bridge.convert("/tmp/retry.pdf");

    await new Promise((r) => setImmediate(r));

    // Save reference to first process before retry replaces it
    const proc1 = fakeProc;

    // Respond to ping (id=1) on first process
    proc1.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // Simulate worker exit before convert response arrives
    proc1.killed = true;
    proc1.emit("exit", 1, null);

    // Let microtasks flush: catch block runs, retry starts, second process spawned, ping sent (id=3)
    await new Promise((r) => setImmediate(r));

    // fakeProc is now the second (retry) process; respond to its ping
    fakeProc.respond({ jsonrpc: "2.0", id: 3, result: { pong: true } });

    // Let microtasks flush: ping resolves, convert retry sent (id=4)
    await new Promise((r) => setImmediate(r));

    // Respond to the retried convert request
    fakeProc.respond({ jsonrpc: "2.0", id: 4, result: { markdown: "# Retry", title: "retry.pdf" } });

    const result = await convertPromise;
    expect(result.title).toBe("retry.pdf");
    expect(result.markdown).toBe("# Retry");
    // A second process must have been spawned for the retry
    expect(fakeProc).not.toBe(proc1);
  });

  it("propagates original error when retry also fails", async () => {
    const convertPromise = bridge.convert("/tmp/fail-twice.pdf");

    await new Promise((r) => setImmediate(r));

    const proc1 = fakeProc;

    // Respond to ping on first process
    proc1.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // First process exits mid-convert
    proc1.killed = true;
    proc1.emit("exit", 1, null);

    await new Promise((r) => setImmediate(r));

    // Respond to ping on second process (id=3)
    fakeProc.respond({ jsonrpc: "2.0", id: 3, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // Second process also exits before responding to convert (id=4)
    const proc2 = fakeProc;
    proc2.killed = true;
    proc2.emit("exit", 2, null);

    await expect(convertPromise).rejects.toThrow(/Python worker exited.*code=1/i);
  });

  // ---------------------------------------------------------------------------
  // checkDependencies()
  // ---------------------------------------------------------------------------

  describe("checkDependencies", () => {
    beforeEach(() => {
      spawnSyncMock.mockReset();
    });

    it("returns ok=true when all packages import successfully", () => {
      spawnSyncMock.mockReturnValue({ status: 0, stderr: "", stdout: "", error: undefined });
      const result = bridge.checkDependencies();
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.spawnError).toBeUndefined();
    });

    it("returns missing package when stderr contains ModuleNotFoundError", () => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stderr: "ModuleNotFoundError: No module named 'markitdown'",
        stdout: "",
        error: undefined,
      });
      const result = bridge.checkDependencies();
      expect(result.ok).toBe(false);
      expect(result.missing).toContain("markitdown");
      expect(result.spawnError).toBeUndefined();
    });

    it("returns missing package when stderr contains ImportError", () => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stderr: "ImportError: cannot import name 'markitdown'",
        stdout: "",
        error: undefined,
      });
      const result = bridge.checkDependencies();
      expect(result.ok).toBe(false);
      expect(result.missing).toContain("markitdown");
      expect(result.spawnError).toBeUndefined();
    });

    it("returns spawnError when Python binary is not found", () => {
      const spawnErr = new Error("spawnSync python3 ENOENT");
      spawnSyncMock.mockReturnValue({ status: null, stderr: "", stdout: "", error: spawnErr });
      const result = bridge.checkDependencies();
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([]);
      expect(result.spawnError).toBe(spawnErr);
    });

    it("returns spawnError for non-zero exit without ImportError (e.g. permissions)", () => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stderr: "PermissionError: [Errno 13] Permission denied",
        stdout: "",
        error: undefined,
      });
      const result = bridge.checkDependencies();
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([]);
      expect(result.spawnError).toBeInstanceOf(Error);
      expect(result.spawnError?.message).toMatch(/status=1/);
    });
  });

  it("shutdown sends shutdown RPC then kills process", async () => {
    // First establish connection via convert
    const convertPromise = bridge.convert("/tmp/test.pdf");

    await new Promise((r) => setImmediate(r));
    fakeProc.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });
    await new Promise((r) => setImmediate(r));
    fakeProc.respond({ jsonrpc: "2.0", id: 2, result: { markdown: "x", title: "y" } });
    await convertPromise;

    // Now shutdown
    const shutdownPromise = bridge.shutdown();
    await new Promise((r) => setImmediate(r));

    // Respond to shutdown RPC
    fakeProc.respond({ jsonrpc: "2.0", id: 3, result: { ok: true } });

    await shutdownPromise;
    expect(bridge.isRunning).toBe(false);
  });
});
