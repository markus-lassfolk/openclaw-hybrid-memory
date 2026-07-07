/**
 * loop iteration 100 regression: recordOAuthFailure's load-mutate-save on statePath had no
 * cross-process synchronization, so two concurrent processes racing a read-modify-write could
 * lose one process's update. Verified with real OS-level concurrency (worker threads, each
 * importing the actual auth-failover.ts module via Node's native TypeScript stripping) rather
 * than a synchronous mock, since the race is inherently about genuinely concurrent execution.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

const AUTH_FAILOVER_MODULE_URL = new URL("../utils/auth-failover.ts", import.meta.url).href;

function runRecordOAuthFailureInWorker(statePath: string, provider: string, scheduleLength: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      import("${AUTH_FAILOVER_MODULE_URL}").then((mod) => {
        const schedule = Array.from({ length: ${scheduleLength} }, (_, i) => i + 1);
        mod.recordOAuthFailure(${JSON.stringify(provider)}, {
          statePath: ${JSON.stringify(statePath)},
          backoffScheduleMinutes: schedule,
        });
        require("node:worker_threads").parentPort.postMessage("done");
      }).catch((err) => {
        require("node:worker_threads").parentPort.postMessage("error: " + (err && err.message));
      });
      `,
      { eval: true, execArgv: ["--experimental-strip-types"] },
    );
    worker.on("message", (msg: string) => {
      worker.terminate().catch(() => {});
      if (msg.startsWith("error:")) reject(new Error(msg));
      else resolve();
    });
    worker.on("error", reject);
  });
}

describe("recordOAuthFailure concurrency (loop iteration 100 regression)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not lose updates when many worker threads record failures for the same provider concurrently", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "auth-failover-concurrency-"));
    const statePath = join(tmpDir, "auth-failover-state.json");
    const workerCount = 10;
    const scheduleLength = workerCount + 5;

    await Promise.all(
      Array.from({ length: workerCount }, () => runRecordOAuthFailureInWorker(statePath, "openai", scheduleLength)),
    );

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
      providers: Record<string, { level: number }>;
    };
    // Sequentially-consistent result: workerCount failures advance the level from -1 to
    // workerCount - 1 (0-indexed). A lost update under a race leaves the final level lower.
    expect(state.providers.openai?.level).toBe(workerCount - 1);
  }, 20_000);
});
