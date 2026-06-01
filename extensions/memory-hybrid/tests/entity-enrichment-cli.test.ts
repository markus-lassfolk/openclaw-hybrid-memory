/**
 * CLI entity enrichment: graph gate, limit sanitization, tier priority, --all mode (#992, #1690 review).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import * as entityEnrichmentService from "../services/entity-enrichment.js";
import { runEntityEnrichmentForCli } from "../services/entity-enrichment-cli.js";

describe("runEntityEnrichmentForCli", () => {
  let dir: string;
  let db: FactsDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hybrid-entity-cli-"));
    mkdirSync(dir, { recursive: true });
    db = new FactsDB(join(dir, "facts.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedFacts(total: number, prefix: string): void {
    for (let i = 0; i < total; i++) {
      db.store({
        text: `${prefix} ${i} with enough length to force enrichment batching and adaptive pacing checks in CLI mode.`,
        entity: null,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }
  }

  it("returns skipped and does not call the LLM when graph.enabled is false", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: false },
    });
    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 10,
      dryRun: false,
    });
    expect(res.skipped).toBe(true);
    expect(res.pendingTotal).toBeTypeOf("number");
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("reports backlog/eta for bounded dry-run mode", async () => {
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `Bounded dry-run fact ${i} with enough length for queue planning and enrichment backlog tests.`,
        entity: null,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 2,
      dryRun: true,
    });

    expect(res.mode).toBe("bounded");
    expect(res.pending).toBe(2);
    expect(res.pendingTotal).toBe(5);
    expect(res.remainingTotal).toBe(5);
    expect(res.estimatedRunsRemaining).toBe(3);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("supports --all catch-up mode and processes full backlog even with small limit", async () => {
    for (let i = 0; i < 3; i++) {
      db.store({
        text: `All-mode fact ${i} with sufficient length to force LLM extraction path for enrichment queue checks.`,
        entity: null,
        key: null,
        value: null,
        category: "other",
        importance: 0.5,
        source: "test",
      });
    }

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 1,
      all: true,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
    });

    expect(res.mode).toBe("all");
    expect(res.effectiveLimit).toBe("all");
    expect(res.pending).toBe(3);
    expect(res.pendingTotal).toBe(3);
    expect(res.processed).toBe(3);
    expect(res.remainingTotal).toBe(0);
    expect(res.estimatedRunsRemaining).toBe(0);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("listFactIdsNeedingEntityEnrichment returns hot facts before cold facts", () => {
    const hot = db.store({
      text: "Hot fact with enough text to exceed the minimum length filter threshold here",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const cold = db.store({
      text: "Cold fact with enough text to exceed the minimum length filter threshold here",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db.setTier(cold.id, "cold");
    db.setTier(hot.id, "hot");
    const ids = db.listFactIdsNeedingEntityEnrichment(10, 24);
    const hotIdx = ids.indexOf(hot.id);
    const coldIdx = ids.indexOf(cold.id);
    expect(hotIdx).toBeGreaterThanOrEqual(0);
    expect(coldIdx).toBeGreaterThanOrEqual(0);
    expect(hotIdx).toBeLessThan(coldIdx);
  });

  it("ramps up adaptive throughput after consecutive successful batches", async () => {
    seedFacts(25, "Adaptive success fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    const pacingEvents: Array<{ reason: string; batchSize: number; delayMs: number }> = [];

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 25,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 5,
      batchDelayMs: 0,
      onAdaptivePacing: (state) => {
        pacingEvents.push({ reason: state.reason, batchSize: state.batchSize, delayMs: state.delayMs });
      },
    });

    expect(res.processed).toBe(25);
    expect(pacingEvents.some((event) => event.reason === "ramp-up" && event.batchSize > 5)).toBe(true);
  });

  it("backs off adaptive throughput on pressure/rate-limit signals", async () => {
    seedFacts(5, "Adaptive pressure fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockResolvedValue({
      mentions: [],
      detectedLang: "eng",
      quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
      rejectedMentions: [],
      pressureSignals: {
        failed: true,
        transientFailure: true,
        rateLimited: true,
        timeoutFailure: false,
        retryAfterMs: 250,
      },
    });
    const pacingEvents: Array<{ reason: string; previousBatchSize: number; batchSize: number }> = [];

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 5,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 20,
      batchDelayMs: 150,
      onAdaptivePacing: (state) => {
        pacingEvents.push({
          reason: state.reason,
          previousBatchSize: state.previousBatchSize,
          batchSize: state.batchSize,
        });
      },
    });

    expect(res.processed).toBe(5);
    expect(pacingEvents.some((event) => event.reason === "pressure" && event.batchSize < event.previousBatchSize)).toBe(
      true,
    );
  });

  it("honors Retry-After above adaptive max delay during pressure backoff", async () => {
    seedFacts(10, "Adaptive retry-after fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockResolvedValue({
      mentions: [],
      detectedLang: "eng",
      quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
      rejectedMentions: [],
      pressureSignals: {
        failed: true,
        transientFailure: true,
        rateLimited: true,
        timeoutFailure: false,
        retryAfterMs: 17_000,
      },
    });
    const pacingEvents: Array<{ reason: string; delayMs: number }> = [];
    const sleepSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler, delay) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 10,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 5,
      batchDelayMs: 150,
      onAdaptivePacing: (state) => {
        pacingEvents.push({ reason: state.reason, delayMs: state.delayMs });
      },
    });

    const pressureBackoff = pacingEvents.find((event) => event.reason === "pressure");
    expect(pressureBackoff?.delayMs).toBe(25_500);
    expect(sleepSpy.mock.calls.some(([handler, delay]) => typeof handler === "function" && delay === 25_500)).toBe(
      true,
    );
  });

  it("keeps adaptive pacing inside min/max bounds", async () => {
    seedFacts(1, "Adaptive bounds fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    const progressSnapshots: Array<{ batchSize?: number; delayMs?: number }> = [];

    await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 1,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 500,
      batchDelayMs: 9999,
      onProgress: (progress) => {
        progressSnapshots.push({
          batchSize: progress.effectiveBatchSize,
          delayMs: progress.effectiveDelayMs,
        });
      },
    });

    expect(progressSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of progressSnapshots) {
      expect(snapshot.batchSize).toBeGreaterThanOrEqual(5);
      expect(snapshot.batchSize).toBeLessThanOrEqual(100);
      expect(snapshot.delayMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.delayMs).toBeLessThanOrEqual(5000);
    }
  });

  it("preserves non-adaptive behavior when adaptive mode is disabled", async () => {
    seedFacts(3, "Static mode fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    const onAdaptivePacing = vi.fn();
    const progressSnapshots: Array<{ batchSize?: number; delayMs?: number }> = [];

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 3,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: false,
      batchSize: 30,
      batchDelayMs: 300,
      onAdaptivePacing,
      onProgress: (progress) => {
        progressSnapshots.push({
          batchSize: progress.effectiveBatchSize,
          delayMs: progress.effectiveDelayMs,
        });
      },
    });

    expect(res.processed).toBe(3);
    expect(onAdaptivePacing).not.toHaveBeenCalled();
    expect(
      progressSnapshots.every((snapshot) => snapshot.batchSize === undefined && snapshot.delayMs === undefined),
    ).toBe(true);
  });

  it("stops at time budget with preserved progress and adaptive summary", async () => {
    seedFacts(8, "Time budget fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const startMs = 1_700_000_000_000;
    let nowMs = startMs;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      nowMs += 400;
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: false,
          transientFailure: false,
          rateLimited: false,
          timeoutFailure: false,
        },
      };
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 8,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 4,
      batchDelayMs: 0,
      timeBudgetSec: 1,
      maxConcurrency: 1,
    });

    expect(res.stopReason).toBe("time_budget");
    expect(res.processed).toBeGreaterThan(0);
    expect(res.processed).toBeLessThan(8);
    expect(res.adaptiveSummary?.stopReason).toBe("time_budget");
    expect(res.adaptiveSummary?.nextRecommendedLimit).toBeGreaterThanOrEqual(8);
  });

  it("caps inter-batch adaptive sleep by remaining time budget", async () => {
    seedFacts(8, "Capped sleep fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    const startMs = 1_700_000_000_000;
    let nowMs = startMs;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      nowMs += 50;
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: false,
          transientFailure: false,
          rateLimited: false,
          timeoutFailure: false,
        },
      };
    });

    const sleepMs: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler, delay?: number) => {
      if (typeof delay === "number" && delay > 0) {
        sleepMs.push(delay);
        nowMs += delay;
      }
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 8,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 2,
      batchDelayMs: 10_000,
      timeBudgetSec: 1,
      maxConcurrency: 1,
    });

    expect(res.stopReason).toBe("time_budget");
    expect(sleepMs.length).toBeGreaterThan(0);
    expect(sleepMs.every((ms) => ms <= 1_000)).toBe(true);
  });

  it("runs bounded concurrent LLM extractions when adaptive and maxConcurrency > 1", async () => {
    seedFacts(6, "Concurrency fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: false,
          transientFailure: false,
          rateLimited: false,
          timeoutFailure: false,
        },
      };
    });

    vi.useFakeTimers();
    const runPromise = runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 6,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 6,
      batchDelayMs: 0,
      maxConcurrency: 3,
    });
    await vi.runAllTimersAsync();
    const res = await runPromise;
    vi.useRealTimers();

    expect(res.processed).toBe(6);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("does not stop a healthy parallel run solely because provider-budget slots are reserved", async () => {
    seedFacts(4, "Healthy parallel fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    let llmCalls = 0;
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      llmCalls++;
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: false,
          transientFailure: false,
          rateLimited: false,
          timeoutFailure: false,
        },
      };
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 4,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 4,
      batchDelayMs: 0,
      maxConcurrency: 3,
      providerPressureBudget: 1,
    });

    expect(res.stopReason).toBe("completed");
    expect(llmCalls).toBe(4);
    expect(res.processed).toBe(4);
  });

  it("stops parallel workers promptly when provider-pressure budget is reached", async () => {
    seedFacts(6, "Provider budget fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    let llmCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      llmCalls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: true,
          transientFailure: false,
          rateLimited: true,
          timeoutFailure: false,
        },
      };
    });

    vi.useFakeTimers();
    const runPromise = runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 6,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 6,
      batchDelayMs: 0,
      maxConcurrency: 3,
      providerPressureBudget: 1,
    });
    await vi.runAllTimersAsync();
    const res = await runPromise;
    vi.useRealTimers();

    expect(res.stopReason).toBe("provider_budget");
    expect(llmCalls).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(res.processed).toBe(1);
  });

  it("persists progress and emits actionable telemetry on timeout/stall pressure", async () => {
    seedFacts(4, "Timeout stall fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    let call = 0;
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          mentions: [
            {
              label: "PERSON",
              surfaceText: "Ada",
              normalizedSurface: "ada",
              startOffset: 0,
              endOffset: 3,
              confidence: 0.9,
            },
          ],
          detectedLang: "eng",
          quality: { mentions: 1, accepted: 1, rejected: 0, duplicates: 0, rejectReasons: {} },
          rejectedMentions: [],
          pressureSignals: {
            failed: false,
            transientFailure: false,
            rateLimited: false,
            timeoutFailure: false,
          },
        };
      }
      return {
        mentions: [],
        detectedLang: "eng",
        quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
        rejectedMentions: [],
        pressureSignals: {
          failed: true,
          transientFailure: true,
          rateLimited: false,
          timeoutFailure: true,
        },
      };
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 4,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 4,
      batchDelayMs: 0,
      providerPressureBudget: 2,
      maxConcurrency: 1,
    });

    expect(res.processed).toBeGreaterThanOrEqual(2);
    expect(res.factsEnriched).toBe(1);
    expect(res.llmFailures).toBeGreaterThanOrEqual(1);
    expect(res.stopReason).toBe("provider_budget");
    expect(res.telemetry?.timeouts).toBeGreaterThanOrEqual(1);
    expect(res.telemetry?.nextRecommendedTimeoutSec).toBeGreaterThan(0);
    expect(res.remainingTotal).toBeLessThan(4);
  });

  it("reports exhausted (not completed) when all facts were attempted but LLM failures remain", async () => {
    seedFacts(3, "Failed enrichment fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });

    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockResolvedValue({
      mentions: [],
      detectedLang: "eng",
      quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
      rejectedMentions: [],
      pressureSignals: {
        failed: true,
        transientFailure: false,
        rateLimited: false,
        timeoutFailure: true,
      },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 3,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 3,
      batchDelayMs: 0,
      maxConcurrency: 1,
    });

    expect(res.processed).toBe(3);
    expect(res.llmFailures).toBe(3);
    expect(res.stopReason).toBe("exhausted");
  });

  it("reports accurate backlog ETA in adaptive summary", async () => {
    seedFacts(9, "Backlog ETA fact");

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"mentions":[]}' } }],
          }),
        },
      },
    };
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      graph: { enabled: true },
    });
    vi.spyOn(entityEnrichmentService, "extractEntityMentionsWithLlm").mockResolvedValue({
      mentions: [],
      detectedLang: "eng",
      quality: { mentions: 0, accepted: 0, rejected: 0, duplicates: 0, rejectReasons: {} },
      rejectedMentions: [],
      pressureSignals: {
        failed: false,
        transientFailure: false,
        rateLimited: false,
        timeoutFailure: false,
      },
    });

    const res = await runEntityEnrichmentForCli(db, openai as never, cfg, {
      limit: 3,
      dryRun: false,
      model: "openai/gpt-4.1-nano",
      adaptiveCatchUp: true,
      batchSize: 3,
      batchDelayMs: 0,
      maxConcurrency: 1,
    });

    expect(res.processed).toBe(3);
    expect(res.remainingTotal).toBe(6);
    expect(res.estimatedRunsRemaining).toBe(2);
    expect(res.adaptiveSummary?.estimatedRunsRemaining).toBe(2);
    expect(res.telemetry?.estimatedRunsRemaining).toBe(2);
    expect(res.telemetry?.remaining).toBe(6);
  });
});
