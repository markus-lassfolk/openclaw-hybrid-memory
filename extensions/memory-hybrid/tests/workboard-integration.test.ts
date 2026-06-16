import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api/plugin-runtime.js";
import { createTimers } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig } from "../config.js";
import { armWorkboardIntegration } from "../setup/workboard-integration.js";

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
});
