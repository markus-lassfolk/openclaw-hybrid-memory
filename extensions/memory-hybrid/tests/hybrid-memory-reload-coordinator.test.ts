import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DRAIN_MS,
  RECALL_DRAIN_MS,
  awaitReloadTeardownBeforeOpen,
  drainOldBootstrap,
  drainOldRecall,
  resetReloadTeardownChainForTests,
  schedulePluginTeardown,
} from "../setup/hybrid-memory-reload-coordinator.js";

describe("hybrid-memory-reload-coordinator", () => {
  afterEach(() => {
    resetReloadTeardownChainForTests();
    vi.useRealTimers();
  });

  it("drainOldBootstrap resolves when bootstrap finishes quickly", async () => {
    let closed = false;
    const bootstrap = Promise.resolve().then(() => {
      closed = true;
    });
    await drainOldBootstrap(bootstrap);
    expect(closed).toBe(true);
  });

  it("drainOldBootstrap does not wait longer than BOOTSTRAP_DRAIN_MS", async () => {
    vi.useFakeTimers();
    const bootstrap = new Promise<void>(() => {
      /* never settles */
    });
    const drain = drainOldBootstrap(bootstrap);
    await vi.advanceTimersByTimeAsync(BOOTSTRAP_DRAIN_MS);
    await drain;
  });

  it("awaitReloadTeardownBeforeOpen returns true when teardown chain is idle", async () => {
    expect(await awaitReloadTeardownBeforeOpen()).toBe(true);
  });

  it("awaitReloadTeardownBeforeOpen returns false while scheduled teardown is pending, then true after completion", async () => {
    let ran = false;
    schedulePluginTeardown(async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(await awaitReloadTeardownBeforeOpen(0)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await awaitReloadTeardownBeforeOpen()).toBe(true);
    expect(ran).toBe(true);
  });

  it("drainOldRecall is a no-op when recallInFlightRef is zero", async () => {
    await drainOldRecall({ value: 0 });
  });

  it("drainOldRecall does not wait longer than RECALL_DRAIN_MS", async () => {
    vi.useFakeTimers();
    const ref = { value: 1 };
    const drain = drainOldRecall(ref);
    await vi.advanceTimersByTimeAsync(RECALL_DRAIN_MS);
    await drain;
    expect(ref.value).toBe(1);
  });
});
