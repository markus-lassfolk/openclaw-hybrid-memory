import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_DRAIN_MS,
  RECALL_DRAIN_MS,
  TEARDOWN_SOFT_WAIT_MS,
  awaitReloadTeardownBeforeOpen,
  blockReloadTeardownBeforeOpen,
  clearTeardownTrackingForGeneration,
  drainOldBootstrap,
  drainOldRecall,
  isTeardownDrainedForGeneration,
  listTeardownPromisesForGeneration,
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

  // ----- rapid hot-reload guard (regression for closed-DB reuse after vault-registry teardown) -----

  it("isTeardownDrainedForGeneration tracks per-generation drain state (rapid hot-reload guard)", async () => {
    expect(isTeardownDrainedForGeneration(-1)).toBe(true);
    let resolveG1: () => void = () => {};
    const g1Done = new Promise<void>((resolve) => {
      resolveG1 = resolve;
    });
    let ranG1 = false;
    schedulePluginTeardown(
      async () => {
        await g1Done;
        ranG1 = true;
      },
      { donorGeneration: 1 },
    );

    // Generation 1 teardown is still pending.
    expect(isTeardownDrainedForGeneration(1)).toBe(false);
    // Generation 2 (a newer, unrelated generation) is also not drained yet — its entry is
    // only created once it schedules teardown; until then it reports drained.
    expect(isTeardownDrainedForGeneration(2)).toBe(true);

    resolveG1();
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(ranG1).toBe(true);
    expect(isTeardownDrainedForGeneration(1)).toBe(true);
  });

  it("listTeardownPromisesForGeneration returns only the donor generation's teardowns", async () => {
    let resolveG1: () => void = () => {};
    const g1Done = new Promise<void>((resolve) => {
      resolveG1 = resolve;
    });
    schedulePluginTeardown(
      async () => {
        await g1Done;
      },
      { donorGeneration: 1 },
    );
    schedulePluginTeardown(
      async () => {
        /* already-drained teardown */
      },
      { donorGeneration: 2 },
    );

    const g1Promises = listTeardownPromisesForGeneration(1);
    expect(g1Promises).toHaveLength(1);
    const g2Promises = listTeardownPromisesForGeneration(2);
    expect(g2Promises).toHaveLength(1);
    const allPromises = listTeardownPromisesForGeneration(-1);
    expect(allPromises).toHaveLength(2);

    resolveG1();
    await Promise.all([...g1Promises, ...g2Promises]);
  });

  it("clearTeardownTrackingForGeneration drops only the target generation's entries", async () => {
    schedulePluginTeardown(async () => {}, { donorGeneration: 5 });
    schedulePluginTeardown(async () => {}, { donorGeneration: 6 });
    schedulePluginTeardown(async () => {}, { donorGeneration: 6 });

    expect(listTeardownPromisesForGeneration(5)).toHaveLength(1);
    expect(listTeardownPromisesForGeneration(6)).toHaveLength(2);

    clearTeardownTrackingForGeneration(5);
    expect(listTeardownPromisesForGeneration(5)).toHaveLength(0);
    expect(listTeardownPromisesForGeneration(6)).toHaveLength(2);

    clearTeardownTrackingForGeneration(6);
    expect(listTeardownPromisesForGeneration(6)).toHaveLength(0);

    // Drain anything still pending so afterEach is clean.
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
  });

  it("schedulePluginTeardown resolves the entry's done promise even on teardown error", async () => {
    schedulePluginTeardown(
      async () => {
        throw new Error("synthetic teardown failure");
      },
      { donorGeneration: 7 },
    );
    const promises = listTeardownPromisesForGeneration(7);
    expect(promises).toHaveLength(1);
    // The promise must resolve (not reject) so awaiters can move on. Errors are captured
    // by capturePluginError inside schedulePluginTeardown; per-entry done promise stays clean.
    await expect(promises[0]).resolves.toBeUndefined();
    clearTeardownTrackingForGeneration(7);
  });

  it("TEARDOWN_SOFT_WAIT_MS is shorter than TEARDOWN_WAIT_MS and positive", () => {
    expect(TEARDOWN_SOFT_WAIT_MS).toBeGreaterThan(0);
    expect(TEARDOWN_SOFT_WAIT_MS).toBeLessThanOrEqual(TEARDOWN_WAIT_MS);
  });

  it("rapid re-register overlap-queues teardowns; donor-generation drain detection tracks the prior generation only", async () => {
    let resolveG1: () => void = () => {};
    const g1Done = new Promise<void>((resolve) => {
      resolveG1 = resolve;
    });
    schedulePluginTeardown(
      async () => {
        await g1Done;
      },
      { donorGeneration: 1 },
    );

    // Generation 2 schedules its own (immediate) teardown BEFORE generation 1's teardown completes.
    schedulePluginTeardown(async () => {}, { donorGeneration: 2 });

    // At this moment, gen 1 is pending (g1Done hasn't resolved), gen 2's teardown is queued.
    expect(isTeardownDrainedForGeneration(1)).toBe(false);

    // Release gen 1; both will complete shortly after.
    resolveG1();
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);

    // Both generations are now drained (entries auto-removed after done resolves).
    expect(isTeardownDrainedForGeneration(1)).toBe(true);
    expect(isTeardownDrainedForGeneration(2)).toBe(true);
  });
});
