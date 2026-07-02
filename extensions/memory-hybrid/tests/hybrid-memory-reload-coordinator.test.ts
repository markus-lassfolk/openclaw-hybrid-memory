import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DRAIN_MS,
  RECALL_DRAIN_MS,
  awaitReloadTeardownBeforeOpen,
  blockReloadTeardownBeforeOpen,
  drainOldBootstrap,
  drainOldRecall,
  resetReloadTeardownChainForTests,
  schedulePluginTeardown,
  TEARDOWN_WAIT_MS,
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

  it("blockReloadTeardownBeforeOpen returns true when teardown chain is idle", () => {
    expect(blockReloadTeardownBeforeOpen()).toBe(true);
  });

  it("blockReloadTeardownBeforeOpen returns true once async teardown has drained", async () => {
    let ran = false;
    schedulePluginTeardown(async () => {
      await Promise.resolve();
      ran = true;
    });
    // Use async wait to cover pending-teardown semantics. Do not call blockReload while
    // teardown is pending: sync Atomics.wait loops are not interruptible by vitest timeouts.
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(ran).toBe(true);
    expect(blockReloadTeardownBeforeOpen()).toBe(true);
  });

  it("awaitReloadTeardownBeforeOpen returns true when teardown chain is idle", async () => {
    expect(await awaitReloadTeardownBeforeOpen()).toBe(true);
  });

  it("awaitReloadTeardownBeforeOpen waits for scheduled teardown within TEARDOWN_WAIT_MS", async () => {
    let ran = false;
    schedulePluginTeardown(async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(ran).toBe(true);
    expect(await awaitReloadTeardownBeforeOpen()).toBe(true);
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

  it("TEARDOWN_WAIT_MS covers a chained vault-registry teardown ahead of the full-database teardown (#87)", async () => {
    vi.useFakeTimers();
    let vaultClosed = false;
    let dbClosed = false;
    // Mirrors register-plugin.ts: when old.vaultRegistry exists, its teardown (drainOldRecall) is
    // scheduled first and chains sequentially ahead of the full-database teardown
    // (drainOldBootstrap + drainOldRecall) via the shared reloadTeardownChain.
    schedulePluginTeardown(async () => {
      await drainOldRecall({ value: 1 });
      vaultClosed = true;
    });
    schedulePluginTeardown(async () => {
      await drainOldBootstrap(
        new Promise<void>(() => {
          /* never settles, worst case */
        }),
      );
      await drainOldRecall({ value: 1 });
      dbClosed = true;
    });

    const waitPromise = awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS);
    await vi.advanceTimersByTimeAsync(TEARDOWN_WAIT_MS);
    expect(await waitPromise).toBe(true);
    expect(vaultClosed).toBe(true);
    expect(dbClosed).toBe(true);
  });
});
