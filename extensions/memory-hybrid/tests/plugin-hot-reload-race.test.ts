/**
 * Hot-reload race regression tests (#1550 / reload coordinator).
 * Simulates: register → in-flight recall → generation bump → permanentClose → pipeline merge.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import {
  getHybridMemoryRegistrationState,
  resetHybridMemoryRegistrationStateForTests,
} from "../setup/hybrid-memory-generation-state.js";
import {
  RECALL_DRAIN_MS,
  awaitReloadTeardownBeforeOpen,
  drainOldRecall,
  resetReloadTeardownChainForTests,
  schedulePluginTeardown,
  TEARDOWN_WAIT_MS,
} from "../setup/hybrid-memory-reload-coordinator.js";
import { runRecallPipelineQuery } from "../services/recall-pipeline.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { shouldSuppressStaleLifecycleError } from "../utils/registration-superseded.js";

describe("plugin hot-reload race", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-reload-race-"));
    resetHybridMemoryRegistrationStateForTests();
    resetReloadTeardownChainForTests();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    resetReloadTeardownChainForTests();
    vi.useRealTimers();
  });

  it("runRecallPipelineQuery returns [] without throwing when merge hits closed DB on superseded generation", async () => {
    const state = getHybridMemoryRegistrationState();
    state.registrationGenerationRef.value = 1;
    const ownerGeneration = 1;

    const factsDb = new FactsDB(join(tmpDir, "facts.db"));
    factsDb.store({
      text: "reload race fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const vectorDb = {
      search: vi.fn().mockResolvedValue([]),
    };
    const embeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    factsDb.permanentClose();
    state.registrationGenerationRef.value = 2;

    const logger = { warn: vi.fn(), debug: vi.fn() };
    const results = await runRecallPipelineQuery(
      "reload race",
      5,
      {
        factsDb,
        vectorDb: vectorDb as never,
        embeddings: embeddings as never,
        openai: {} as never,
        cfg: {
          queryExpansion: { enabled: false } as never,
          retrievalStrategies: ["fts5"],
          memoryTieringEnabled: false,
          rawCfg: {} as never,
        },
        recallOpts: {
          tierFilter: "all",
          scopeFilter: undefined,
          reinforcementBoost: 0,
          diversityWeight: 1,
        },
        minScore: 0,
        pendingLLMWarnings: createPendingLLMWarnings(),
        logger,
        registrationGeneration: ownerGeneration,
      },
      { value: false },
      { probeId: "test-reload-race", errorPrefix: "directive-" },
    );

    expect(results).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(
      shouldSuppressStaleLifecycleError(
        { registrationGeneration: ownerGeneration },
        new Error("The database connection is not open"),
      ),
    ).toBe(true);
  });

  it("drainOldRecall waits briefly for recallInFlightRef to reach zero", async () => {
    vi.useFakeTimers();
    const recallInFlightRef = { value: 2 };
    const drain = drainOldRecall(recallInFlightRef);
    setTimeout(() => {
      recallInFlightRef.value = 0;
    }, 500);
    await vi.advanceTimersByTimeAsync(RECALL_DRAIN_MS);
    await drain;
    expect(recallInFlightRef.value).toBe(0);
  });

  it("teardown chain runs close after drainOldRecall in schedulePluginTeardown", async () => {
    let closed = false;
    const recallInFlightRef = { value: 1 };
    schedulePluginTeardown(async () => {
      await drainOldRecall(recallInFlightRef);
      recallInFlightRef.value = 0;
      closed = true;
    });
    expect(await awaitReloadTeardownBeforeOpen(TEARDOWN_WAIT_MS)).toBe(true);
    expect(await awaitReloadTeardownBeforeOpen()).toBe(true);
    expect(closed).toBe(true);
  });
});
