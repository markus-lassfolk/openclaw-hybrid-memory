/**
 * Regression test (loop iteration 34): raceWithAbortSignal's cleanup `.finally()` call created
 * a second, orphaned promise derived from the raced `promise` — a promise the caller's own
 * `await`/`.catch()` never sees or handles. Whenever the raced promise rejected (with or without
 * the AbortSignal ever firing), that orphaned promise became a genuine unhandled rejection,
 * which crashes the process under Node's default `--unhandled-rejections=throw` behavior — turning
 * an intentionally-non-fatal "swallow this failure" call site (e.g. stage-recall's embed() calls,
 * wrapped in try/catch) into a full process crash regardless of that try/catch.
 */
import { describe, expect, it } from "vitest";
import { raceWithAbortSignal } from "../utils/signal-race.js";

describe("raceWithAbortSignal (loop iteration 34 regression)", () => {
  it("does not produce an unhandled promise rejection when the raced promise rejects", async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const controller = new AbortController();
      const rejecting = new Promise<number>((_, reject) => {
        setTimeout(() => reject(new Error("boom")), 5);
      });

      await expect(raceWithAbortSignal(rejecting, controller.signal, -1)).rejects.toThrow("boom");

      // Give any unhandled-rejection detection a chance to fire before asserting on it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("raceWithAbortSignal — resolves fallback on abort even when the raced promise never settles (loop iteration 87 regression)", () => {
  it("resolves the fallback promptly on abort when the raced promise hangs forever", async () => {
    const controller = new AbortController();
    // A promise that never resolves or rejects — simulates a genuinely stuck call (e.g. a hung
    // embedding request), which is exactly the scenario the stage-timeout abort exists to bound.
    const hanging = new Promise<number>(() => {});

    const racePromise = raceWithAbortSignal(hanging, controller.signal, -1);
    setTimeout(() => controller.abort(), 20);

    const result = await Promise.race([
      racePromise,
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    expect(result).toBe(-1);
  });

  it("still lets the raced promise's own resolution win when it settles before abort", async () => {
    const controller = new AbortController();
    const resolving = new Promise<number>((resolve) => setTimeout(() => resolve(42), 5));

    const result = await raceWithAbortSignal(resolving, controller.signal, -1);

    expect(result).toBe(42);
  });
});
