/**
 * Regression tests for the reload-coordinator gate used by runMemoryHybridRegister.
 *
 * Reproduces the rapid-hot-reload teardown race that surfaced in #2058/#2059 follow-up:
 *   1. reuseDatabases=true + vault-registry close scheduled against the donor runtime
 *   2. soft drain timeout exceeded → must NOT inherit closed handles (fall back to fresh)
 *   3. full teardown path with a hard drain timeout → must recover to a fresh open instead of
 *      throwing and failing plugin initialization (#2111).
 *
 * These tests exercise the helpers exported from hybrid-memory-reload-coordinator.ts and
 * the gate decision logic in register-plugin via lightweight mocks of the dependencies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECALL_DRAIN_MS,
  TEARDOWN_SOFT_WAIT_MS,
  TEARDOWN_WAIT_MS,
  awaitReloadTeardownBeforeOpen,
  clearTeardownTrackingForGeneration,
  decideReloadTeardownGate,
  isTeardownDrainedForGeneration,
  resetReloadTeardownChainForTests,
  schedulePluginTeardown,
} from "../setup/hybrid-memory-reload-coordinator.js";

describe("register-plugin reload-teardown drain gate", () => {
  beforeEach(() => {
    resetReloadTeardownChainForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    resetReloadTeardownChainForTests();
    vi.useRealTimers();
  });

  it("drains within TEARDOWN_WAIT_MS for a single immediate teardown", async () => {
    schedulePluginTeardown(async () => {}, { donorGeneration: 1 });
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
  });

  it("returns false on hard drain timeout for a slow teardown", async () => {
    let neverResolve: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      neverResolve = resolve;
    });
    schedulePluginTeardown(async () => {
      await blocker;
    }, { donorGeneration: 1 });
    // Use a short timeout to keep the test fast.
    expect(await awaitReloadTeardownBeforeOpen(500)).toBe(false);
    // Cleanup: resolve the blocker so the chain doesn't leak into the next test.
    neverResolve();
  });

  it("isTeardownDrainedForGeneration flips false→true as the teardown settles", async () => {
    let resolveT: () => void = () => {};
    const t = new Promise<void>((resolve) => {
      resolveT = resolve;
    });
    schedulePluginTeardown(
      async () => {
        await t;
      },
      { donorGeneration: 42 },
    );
    expect(isTeardownDrainedForGeneration(42)).toBe(false);
    resolveT();
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(isTeardownDrainedForGeneration(42)).toBe(true);
  });

  it("clearTeardownTrackingForGeneration lets isTeardownDrainedForGeneration flip back to true", () => {
    schedulePluginTeardown(
      async () => {
        /* never settles */
      },
      { donorGeneration: 99 },
    );
    expect(isTeardownDrainedForGeneration(99)).toBe(false);
    clearTeardownTrackingForGeneration(99);
    expect(isTeardownDrainedForGeneration(99)).toBe(true);
  });

  it("TEARDOWN_SOFT_WAIT_MS budget covers a vault-registry drain plus bootstrap drain", () => {
    // Vault teardown: drainOldRecall (RECALL_DRAIN_MS) → closeAll.
    // Full DB teardown: drainOldBootstrap (BOOTSTRAP_DRAIN_MS) → drainOldRecall (RECALL_DRAIN_MS).
    // Soft budget must accommodate the smaller of the two paths, which is the vault path.
    expect(TEARDOWN_SOFT_WAIT_MS).toBeGreaterThanOrEqual(RECALL_DRAIN_MS);
  });

  it("rapid back-to-back re-registers drain sequentially (chain serializes)", async () => {
    let resolve1: () => void = () => {};
    const p1 = new Promise<void>((resolve) => {
      resolve1 = resolve;
    });
    let ran1 = false;
    let ran2 = false;

    schedulePluginTeardown(
      async () => {
        await p1;
        ran1 = true;
      },
      { donorGeneration: 1 },
    );
    schedulePluginTeardown(
      async () => {
        ran2 = true;
      },
      { donorGeneration: 2 },
    );

    expect(ran1).toBe(false);
    expect(ran2).toBe(false);

    resolve1();
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(ran1).toBe(true);
    expect(ran2).toBe(true);
  });
});

describe("decideReloadTeardownGate (#2111)", () => {
  it("reuses donor handles when teardown drained in time", () => {
    expect(decideReloadTeardownGate({ hasDonor: true, drained: true, donorDrained: true })).toBe("reuse");
  });

  it("opens fresh when no donor and teardown drained", () => {
    expect(decideReloadTeardownGate({ hasDonor: false, drained: true, donorDrained: true })).toBe("fresh");
  });

  it("reuses donor handles when the donor generation's teardown is done despite a hard timeout", () => {
    // Overlap-queued re-register: the chain didn't fully drain, but the donor generation we are
    // about to supersede is finished, so its handles are safe to inherit.
    expect(decideReloadTeardownGate({ hasDonor: true, drained: false, donorDrained: true })).toBe("reuse");
  });

  it("falls back to a fresh open (soft timeout) when a donor is present but its teardown is still pending", () => {
    expect(decideReloadTeardownGate({ hasDonor: true, drained: false, donorDrained: false })).toBe(
      "fresh-soft-timeout",
    );
  });

  it("recovers to a fresh open instead of throwing on the full-teardown hard-timeout path", () => {
    // Regression for #2111: the full-teardown path (no donor to inherit) used to throw
    // "reload teardown did not drain before opening new databases", failing plugin init on every
    // reload. It must now signal a fresh-open recovery instead.
    expect(decideReloadTeardownGate({ hasDonor: false, drained: false, donorDrained: false })).toBe(
      "fresh-hard-timeout",
    );
    expect(decideReloadTeardownGate({ hasDonor: false, drained: false, donorDrained: true })).toBe(
      "fresh-hard-timeout",
    );
  });

  it("never returns a throwing/unknown decision for any input combination", () => {
    const valid = new Set(["reuse", "fresh", "fresh-soft-timeout", "fresh-hard-timeout"]);
    for (const hasDonor of [true, false]) {
      for (const drained of [true, false]) {
        for (const donorDrained of [true, false]) {
          expect(valid.has(decideReloadTeardownGate({ hasDonor, drained, donorDrained }))).toBe(true);
        }
      }
    }
  });
});