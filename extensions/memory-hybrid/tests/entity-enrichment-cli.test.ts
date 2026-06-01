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
        retryAfterMs: 17_000,
      },
    });
    const pacingEvents: Array<{ reason: string; delayMs: number }> = [];

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
});
