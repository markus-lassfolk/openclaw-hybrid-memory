import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DRAIN_MS,
  awaitReloadTeardownBeforeOpen,
  drainOldBootstrap,
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

  it("awaitReloadTeardownBeforeOpen returns true when teardown chain is idle", () => {
    expect(awaitReloadTeardownBeforeOpen()).toBe(true);
  });

  it("awaitReloadTeardownBeforeOpen returns true after scheduled teardown completes", async () => {
    let ran = false;
    schedulePluginTeardown(async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(awaitReloadTeardownBeforeOpen()).toBe(true);
    expect(ran).toBe(true);
  });
});
