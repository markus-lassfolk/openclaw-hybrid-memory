import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api/plugin-runtime.js";
import { createTimers } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  WORKBOARD_STARTUP_DEFER_MS,
  WORKBOARD_STARTUP_PROBE_BACKOFF_MS,
  WORKBOARD_STARTUP_PROBE_MAX_ATTEMPTS,
  armWorkboardIntegration,
  markWorkboardGatewayColdStart,
  resetWorkboardGatewayColdStartForTests,
  resolveWorkboardDeferMs,
  scheduleWorkboardIntegrationAfterReregister,
  scheduleWorkboardStartupIntegration,
} from "../setup/workboard-integration.js";
import type { WorkboardAdapterContext } from "../services/workboard-adapter.js";

function minimalWorkboardCfg(): HybridMemoryConfig {
  return {
    workboard: {
      enabled: true,
      syncTasks: true,
      syncGoals: false,
      bidirectional: true,
      gatewayUrl: "http://127.0.0.1:18789",
      syncIntervalMinutes: 5,
      cardTag: "hybrid-memory",
      columns: {},
    },
    goalStewardship: { enabled: false },
  } as unknown as HybridMemoryConfig;
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("workboard-integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkboardGatewayColdStartForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("arms workboard sync interval when adapter is available", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 2,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValue(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();

    await armWorkboardIntegration({
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "test",
    });

    expect(isAvailable).toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(timers.workboardSync?.value).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("re-arms interval after prior timer was cleared (hot-reload simulation)", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValue(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();
    const ctx = {
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "startup",
    };

    await armWorkboardIntegration(ctx);
    const firstInterval = timers.workboardSync?.value;
    expect(firstInterval).not.toBeNull();

    if (timers.workboardSync?.value) {
      clearInterval(timers.workboardSync.value);
      timers.workboardSync.value = null;
    }

    await armWorkboardIntegration({ ...ctx, connectLabel: "re-register" });
    expect(timers.workboardSync?.value).not.toBeNull();
    expect(timers.workboardSync?.value).not.toBe(firstInterval);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-hybrid: Workboard adapter connected (re-register) — starting sync",
    );
  });

  it("retries startup probe before giving up (#1940)", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();

    const armPromise = armWorkboardIntegration({
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "startup",
    });

    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_PROBE_BACKOFF_MS);
    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_PROBE_BACKOFF_MS);
    await armPromise;

    expect(isAvailable).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(timers.workboardSync?.value).not.toBeNull();
  });

  it("defers startup arm until cold-start delay elapses (#1940)", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValue(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();
    const ctx = {
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "startup",
    };

    scheduleWorkboardStartupIntegration(ctx);
    expect(isAvailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_DEFER_MS - 1);
    expect(isAvailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(isAvailable).toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("re-register within cold-start defer window reschedules remaining defer (#1940)", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValue(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();
    const ctx = {
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "startup",
    };

    markWorkboardGatewayColdStart();
    scheduleWorkboardStartupIntegration(ctx);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(isAvailable).not.toHaveBeenCalled();

    scheduleWorkboardIntegrationAfterReregister({ ...ctx, connectLabel: "re-register" });
    expect(resolveWorkboardDeferMs()).toBe(WORKBOARD_STARTUP_DEFER_MS - 20_000);

    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_DEFER_MS - 20_000 - 1);
    expect(isAvailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(isAvailable).toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "memory-hybrid: Workboard adapter connected (re-register) — starting sync",
    );
  });

  it("re-register probe retries before giving up (#1940)", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();

    const armPromise = armWorkboardIntegration({
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      connectLabel: "re-register",
    });

    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_PROBE_BACKOFF_MS);
    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_PROBE_BACKOFF_MS);
    await armPromise;

    expect(isAvailable).toHaveBeenCalledTimes(WORKBOARD_STARTUP_PROBE_MAX_ATTEMPTS);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("aborts deferred startup arm when registration generation is superseded", async () => {
    const sync = vi.fn().mockResolvedValue({
      cardsCreated: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      pullChanges: 0,
      errors: [],
    });
    const isAvailable = vi.fn().mockResolvedValue(true);

    vi.spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter").mockReturnValue({
      isAvailable,
      sync,
    } as never);

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();
    let superseded = false;

    scheduleWorkboardStartupIntegration({
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg: minimalWorkboardCfg(),
      api: { logger } as never,
      timers,
      shouldAbort: () => superseded,
      connectLabel: "startup",
    });

    superseded = true;
    await vi.advanceTimersByTimeAsync(WORKBOARD_STARTUP_DEFER_MS);
    await Promise.resolve();

    expect(isAvailable).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("propagates listGoals() failures to the adapter instead of silently treating it as zero goals", async () => {
    const sync = vi.fn();
    const isAvailable = vi.fn().mockResolvedValue(false);
    const createWorkboardAdapterMock = vi
      .spyOn(await import("../services/workboard-adapter.js"), "createWorkboardAdapter")
      .mockReturnValue({ isAvailable, sync } as never);
    vi.spyOn(await import("../services/goal-registry.js"), "listGoals").mockRejectedValue(
      new Error("goals dir read failed"),
    );

    const timers = createTimers() as PluginRuntime["timers"];
    const logger = mockLogger();
    const cfg = minimalWorkboardCfg();
    cfg.workboard.syncGoals = true;
    cfg.goalStewardship = { enabled: true, goalsDir: "state/goals" } as never;

    await armWorkboardIntegration({
      factsDb: {} as never,
      vectorDb: {} as never,
      embeddings: {} as never,
      cfg,
      api: { logger } as never,
      timers,
      connectLabel: "test",
    });

    const ctx = createWorkboardAdapterMock.mock.calls[0]?.[0] as WorkboardAdapterContext;
    // A transient goals-directory read failure must propagate, not resolve to []  — resolving
    // to [] made workboard-adapter.ts's sync() treat every existing Workboard goal card as
    // stale and delete it, even though the underlying goal data was intact.
    await expect(Promise.resolve(ctx.loadGoals())).rejects.toThrow("goals dir read failed");
  });
});
