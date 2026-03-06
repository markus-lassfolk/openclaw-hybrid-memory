/**
 * Python Bridge Service
 *
 * Manages a persistent Python subprocess that runs markitdown-worker.py.
 * Communication is via JSON-RPC 2.0 over stdin/stdout (one request per line).
 *
 * Lifecycle:
 *   - Lazily spawned on first convert() call
 *   - Auto-restarts on crash (up to MAX_RETRIES times)
 *   - Gracefully shut down via shutdown()
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX_RETRIES = 3;
const PING_TIMEOUT_MS = 5_000;
const SHUTDOWN_WAIT_MS = 2_000;

export interface ConvertResult {
  markdown: string;
  title: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PythonBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private restartCount = 0;
  private readonly pythonPath: string;
  private readonly workerPath: string;
  private starting = false;

  constructor(pythonPath = "python3") {
    this.pythonPath = pythonPath;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.workerPath = join(__dirname, "../scripts/markitdown-worker.py");
  }

  private spawnProcess(): void {
    this.proc = spawn(this.pythonPath, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (data: Buffer) => {
      // Only log if there are pending requests (otherwise noise during shutdown)
      if (this.pending.size > 0) {
        console.warn(`[python-bridge] stderr: ${data.toString().trim()}`);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      // Reject all pending requests
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`Python worker exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });

    this.proc.on("error", (err) => {
      this.proc = null;
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`Python worker error: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let resp: JsonRpcResponse;
    try {
      resp = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return; // Ignore malformed lines
    }
    if (resp.id == null) return;
    const req = this.pending.get(resp.id as number);
    if (!req) return;
    clearTimeout(req.timer);
    this.pending.delete(resp.id as number);
    if (resp.error) {
      req.reject(new Error(`Python RPC error ${resp.error.code}: ${resp.error.message}`));
    } else {
      req.resolve(resp.result);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    if (this.starting) {
      // Wait for spawn to complete
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!this.starting) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      // Verify process actually started
      if (!this.proc || this.proc.killed) {
        throw new Error("Python bridge failed to start");
      }
      return;
    }
    this.starting = true;
    try {
      this.spawnProcess();
      // Health check
      await this.ping();
      this.restartCount = 0;
      this.starting = false;
    } catch (err) {
      this.proc?.kill();
      this.proc = null;
      this.restartCount++;
      if (this.restartCount > MAX_RETRIES) {
        this.starting = false;
        throw new Error(`Python bridge failed to start after ${MAX_RETRIES} retries: ${err}`);
      }
      this.starting = false;
      return this.ensureStarted();
    }
  }

  private send<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Python RPC timeout after ${timeoutMs}ms (method=${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      this.proc!.stdin.write(msg + "\n");
    });
  }

  async ping(): Promise<void> {
    await this.send<{ pong: boolean }>("ping", {}, PING_TIMEOUT_MS);
  }

  async convert(filePath: string): Promise<ConvertResult> {
    await this.ensureStarted();
    const uri = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
    const result = await this.send<ConvertResult>("convert", { uri }, 60_000);
    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    try {
      await Promise.race([
        this.send<{ ok: boolean }>("shutdown", {}, SHUTDOWN_WAIT_MS),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
      ]);
    } catch {
      // Ignore errors during shutdown
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}
