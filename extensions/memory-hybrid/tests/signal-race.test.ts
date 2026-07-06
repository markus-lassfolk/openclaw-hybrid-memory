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
