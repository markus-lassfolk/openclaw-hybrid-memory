import { describe, expect, it, vi } from "vitest";
import { withVerboseHeartbeat } from "../utils/maintenance-progress.js";

describe("withVerboseHeartbeat", () => {
  it("does not let heartbeat detail/log exceptions crash the wrapped task", async () => {
    vi.useFakeTimers();
    try {
      const promise = withVerboseHeartbeat({
        verbose: true,
        intervalMs: 10,
        prefix: "test",
        log: () => {
          throw new Error("log failed");
        },
        detail: () => {
          throw new Error("detail failed");
        },
        fn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return "ok";
        },
      });

      await vi.advanceTimersByTimeAsync(30);
      await expect(promise).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
