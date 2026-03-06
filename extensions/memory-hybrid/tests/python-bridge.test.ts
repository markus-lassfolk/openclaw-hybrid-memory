/**
 * Python Bridge tests.
 *
 * Uses a mock subprocess rather than real Python to avoid requiring Python or
 * markitdown to be installed in the test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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
    this.stdout.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
  }
}

let fakeProc: FakeProcess;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    fakeProc = new FakeProcess();
    return fakeProc;
  }),
}));

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

  it("rejects all pending when process exits unexpectedly", async () => {
    const convertPromise = bridge.convert("/tmp/test.pdf");

    await new Promise((r) => setImmediate(r));

    // Respond to ping so we get past ensureStarted
    fakeProc.respond({ jsonrpc: "2.0", id: 1, result: { pong: true } });

    await new Promise((r) => setImmediate(r));

    // Simulate unexpected process exit before convert response
    fakeProc.killed = true;
    fakeProc.emit("exit", 1, null);

    await expect(convertPromise).rejects.toThrow(/exited/i);
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
