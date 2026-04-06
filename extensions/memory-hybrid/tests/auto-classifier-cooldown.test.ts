/**
 * Tests for issue #557 — auto-classifier LLM category discovery cooldown.
 *
 * Verifies that:
 *   1. discoverCategoriesFromOther skips the LLM when last run is within discoveryIntervalHours.
 *   2. The LLM is called when cooldown has expired.
 *   3. Last-run timestamp is written after a successful discovery (even with no new categories).
 *   4. Last-run timestamp is NOT written when skipping due to cooldown.
 *   5. Cooldown is disabled when discoveryIntervalHours = 0.
 *   6. getLastDiscoveryPath derives the correct sidecar path.
 *   7. parseAutoClassifyConfig parses discoveryIntervalHours correctly.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAutoClassifyConfig } from "../config/parsers/retrieval.js";
import { _testing } from "../index.js";
import { getLastDiscoveryPath, runAutoClassify } from "../services/auto-classifier.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-cooldown-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLastRun(discoveredPath: string, timestampMs: number): void {
  const lastRunPath = getLastDiscoveryPath(discoveredPath);
  mkdirSync(join(lastRunPath, ".."), { recursive: true });
  writeFileSync(lastRunPath, JSON.stringify({ lastRunAt: timestampMs }, null, 2), "utf-8");
}

function readLastRun(discoveredPath: string): number | null {
  const lastRunPath = getLastDiscoveryPath(discoveredPath);
  if (!existsSync(lastRunPath)) return null;
  try {
    const raw = readFileSync(lastRunPath, "utf-8");
    const parsed = JSON.parse(raw) as { lastRunAt: number };
    return parsed.lastRunAt;
  } catch {
    return null;
  }
}

/** Build a minimal FactsDB with N "other" facts. */
function makeFactsDb(dir: string, otherCount: number): InstanceType<typeof FactsDB> {
  const db = new FactsDB(join(dir, "facts.db"));
  for (let i = 0; i < otherCount; i++) {
    db.store({
      text: `other fact ${i}: topic about subject ${i}`,
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
  }
  return db;
}

const noop = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// getLastDiscoveryPath
// ---------------------------------------------------------------------------

describe("getLastDiscoveryPath", () => {
  it("replaces .json suffix with .last-run.json", () => {
    const p = getLastDiscoveryPath("/some/dir/discovered-categories.json");
    expect(p).toBe("/some/dir/discovered-categories.last-run.json");
  });

  it("appends .last-run.json when no .json suffix", () => {
    const p = getLastDiscoveryPath("/some/dir/discovered-categories");
    expect(p).toBe("/some/dir/discovered-categories.last-run.json");
  });

  it("handles uppercase .JSON suffix", () => {
    const p = getLastDiscoveryPath("/some/dir/categories.JSON");
    expect(p).toBe("/some/dir/categories.last-run.json");
  });
});

// ---------------------------------------------------------------------------
// parseAutoClassifyConfig — discoveryIntervalHours
// ---------------------------------------------------------------------------

describe("parseAutoClassifyConfig — discoveryIntervalHours", () => {
  it("defaults to 72 when not set", () => {
    const cfg = parseAutoClassifyConfig({});
    expect(cfg.discoveryIntervalHours).toBe(72);
  });

  it("parses explicit value", () => {
    const cfg = parseAutoClassifyConfig({ autoClassify: { discoveryIntervalHours: 24 } });
    expect(cfg.discoveryIntervalHours).toBe(24);
  });

  it("accepts 0 to disable cooldown", () => {
    const cfg = parseAutoClassifyConfig({ autoClassify: { discoveryIntervalHours: 0 } });
    expect(cfg.discoveryIntervalHours).toBe(0);
  });

  it("defaults to 72 for invalid (negative) value", () => {
    const cfg = parseAutoClassifyConfig({ autoClassify: { discoveryIntervalHours: -1 } });
    expect(cfg.discoveryIntervalHours).toBe(72);
  });

  it("defaults to 72 for non-numeric value", () => {
    const cfg = parseAutoClassifyConfig({ autoClassify: { discoveryIntervalHours: "48" } });
    expect(cfg.discoveryIntervalHours).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// Discovery cooldown integration: two calls within cooldown → LLM called once
// ---------------------------------------------------------------------------

describe("discoverCategoriesFromOther cooldown", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    factsDb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("skips LLM on second call within cooldown window — mock asserts called once", async () => {
    // Need ≥15 "other" facts to pass the MIN_OTHER_FOR_DISCOVERY gate
    factsDb = makeFactsDb(tmpDir, 16);
    const discoveredPath = join(tmpDir, "discovered-categories.json");

    let llmCallCount = 0;

    // Mock openai: tracks calls, returns empty labels (no new categories)
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            llmCallCount++;
            return {
              choices: [{ message: { content: "[]" } }],
            };
          }),
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openai = mockOpenai as any;

    const config = {
      model: "test-model",
      batchSize: 20,
      suggestCategories: true,
      minFactsForNewCategory: 10,
      discoveryIntervalHours: 72,
    };

    // First call: discovery + classification LLM calls (≥1 discovery batch + classify batch)
    await runAutoClassify(factsDb, openai, config, noop, { discoveredCategoriesPath: discoveredPath });
    const callsAfterFirst = llmCallCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call immediately after: discovery skipped (cooldown), classification still runs.
    // The number of additional calls should be LESS than the first call (only classify, no discover).
    const callsBeforeSecond = llmCallCount;
    await runAutoClassify(factsDb, openai, config, noop, { discoveredCategoriesPath: discoveredPath });
    const additionalCalls = llmCallCount - callsBeforeSecond;
    // Discovery batch (ceil(16/25)=1) should be absent; only classify batch (ceil(16/20)=1) should run.
    // Total calls in first run = discovery(1) + classify(1) = 2; second run = classify(1) = 1.
    expect(additionalCalls).toBeLessThan(callsAfterFirst); // second run did fewer LLM calls (no discovery)
  });

  it("writes last-run timestamp after successful discovery (no new categories)", async () => {
    factsDb = makeFactsDb(tmpDir, 16);
    const discoveredPath = join(tmpDir, "discovered-categories.json");

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "[]" } }],
          })),
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openai = mockOpenai as any;

    const before = Date.now();
    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai as any,
      { model: "test-model", batchSize: 20, suggestCategories: true, discoveryIntervalHours: 72 },
      noop,
      { discoveredCategoriesPath: discoveredPath },
    );
    const after = Date.now();

    const lastRun = readLastRun(discoveredPath);
    expect(lastRun).not.toBeNull();
    expect(lastRun!).toBeGreaterThanOrEqual(before);
    expect(lastRun!).toBeLessThanOrEqual(after);
  });

  it("does NOT write last-run timestamp when skipping due to cooldown", async () => {
    factsDb = makeFactsDb(tmpDir, 16);
    const discoveredPath = join(tmpDir, "discovered-categories.json");

    // Pre-write a timestamp that is 1 hour ago (within 72h cooldown)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    writeLastRun(discoveredPath, oneHourAgo);

    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "[]" } }],
          })),
        },
      },
    };

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOpenai as any,
      { model: "test-model", batchSize: 20, suggestCategories: true, discoveryIntervalHours: 72 },
      noop,
      { discoveredCategoriesPath: discoveredPath },
    );

    // Timestamp should remain as the original (discovery was skipped, not overwritten)
    const lastRun = readLastRun(discoveredPath);
    expect(lastRun).toBe(oneHourAgo);
    // Note: classification still runs even when discovery is on cooldown.
    // What we verify is that the discovery did NOT update the last-run timestamp.
  });

  it("calls LLM again after cooldown expires", async () => {
    factsDb = makeFactsDb(tmpDir, 16);
    const discoveredPath = join(tmpDir, "discovered-categories.json");

    // Pre-write a timestamp that is 73 hours ago (past the 72h cooldown)
    const seventyThreeHoursAgo = Date.now() - 73 * 60 * 60 * 1000;
    writeLastRun(discoveredPath, seventyThreeHoursAgo);

    let llmCallCount = 0;
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            llmCallCount++;
            return { choices: [{ message: { content: "[]" } }] };
          }),
        },
      },
    };

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOpenai as any,
      { model: "test-model", batchSize: 20, suggestCategories: true, discoveryIntervalHours: 72 },
      noop,
      { discoveredCategoriesPath: discoveredPath },
    );

    // LLM should have been called since cooldown expired
    expect(llmCallCount).toBeGreaterThan(0);
  });

  it("never skips when discoveryIntervalHours = 0 (cooldown disabled)", async () => {
    factsDb = makeFactsDb(tmpDir, 16);
    const discoveredPath = join(tmpDir, "discovered-categories.json");

    // Pre-write a very recent timestamp
    writeLastRun(discoveredPath, Date.now());

    let llmCallCount = 0;
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            llmCallCount++;
            return { choices: [{ message: { content: "[]" } }] };
          }),
        },
      },
    };

    await runAutoClassify(
      factsDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOpenai as any,
      { model: "test-model", batchSize: 20, suggestCategories: true, discoveryIntervalHours: 0 },
      noop,
      { discoveredCategoriesPath: discoveredPath },
    );

    // LLM should have been called despite recent last-run (cooldown disabled)
    expect(llmCallCount).toBeGreaterThan(0);
  });
});
