/**
 * Tests for issue #30 — auto-classifier batch-run lease/lock guard.
 *
 * Verifies that:
 *   1. runAutoClassify skips (no LLM call) when the lock is already held.
 *   2. runAutoClassify releases the lock after a successful run.
 *   3. runClassifyForCli (non-dry-run) skips when the lock is already held.
 *   4. runClassifyForCli releases the lock after a successful run.
 *   5. runClassifyForCli with dryRun=true ignores the lock (runs regardless).
 *   6. A concurrent runAutoClassify and runClassifyForCli mutually exclude (shared lock name).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { runAutoClassify, runClassifyForCli } from "../services/auto-classifier.js";
import { acquireStepLock, releaseStepLock } from "../services/cron-guard.js";

const { FactsDB } = _testing;

const LOCK_NAME = "auto-classify-batch";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-lock-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

function makeMockOpenai(): { openai: unknown; callCount: () => number } {
  let calls = 0;
  const openai = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return { choices: [{ message: { content: '["fact"]' } }] };
        },
      },
    },
  };
  return { openai, callCount: () => calls };
}

const noop = { info: () => {}, warn: () => {} };

describe("auto-classifier lease/lock guard (#30)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    factsDb?.close();
    releaseStepLock(LOCK_NAME, tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runAutoClassify skips without calling the LLM when the lock is already held", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai, callCount } = makeMockOpenai();

    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
    try {
      const result = await runAutoClassify(factsDb, openai as never, { model: "test-model", batchSize: 20 }, noop, {
        openclawDir: tmpDir,
      });
      expect(result.reclassified).toBe(0);
      expect(callCount()).toBe(0);
    } finally {
      releaseStepLock(LOCK_NAME, tmpDir);
    }
  });

  it("runAutoClassify releases the lock after a successful run", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai } = makeMockOpenai();

    await runAutoClassify(factsDb, openai as never, { model: "test-model", batchSize: 20 }, noop, {
      openclawDir: tmpDir,
    });

    // If the lock were still held, this acquire would fail.
    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
  });

  it("runClassifyForCli (non-dry-run) skips without calling the LLM when the lock is already held", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai, callCount } = makeMockOpenai();

    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
    try {
      const result = await runClassifyForCli(
        factsDb,
        openai as never,
        { model: "test-model", batchSize: 20 },
        { dryRun: false, limit: 100, openclawDir: tmpDir },
        join(tmpDir, "discovered-categories.json"),
        noop,
      );
      expect(result.reclassified).toBe(0);
      expect(callCount()).toBe(0);
    } finally {
      releaseStepLock(LOCK_NAME, tmpDir);
    }
  });

  it("runClassifyForCli (non-dry-run) releases the lock after a successful run", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai } = makeMockOpenai();

    await runClassifyForCli(
      factsDb,
      openai as never,
      { model: "test-model", batchSize: 20 },
      { dryRun: false, limit: 100, openclawDir: tmpDir },
      join(tmpDir, "discovered-categories.json"),
      noop,
    );

    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
  });

  it("runClassifyForCli with dryRun=true ignores the lock and still classifies", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai, callCount } = makeMockOpenai();

    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
    try {
      const result = await runClassifyForCli(
        factsDb,
        openai as never,
        { model: "test-model", batchSize: 20 },
        { dryRun: true, limit: 100, openclawDir: tmpDir },
        join(tmpDir, "discovered-categories.json"),
        noop,
      );
      // Dry run doesn't mutate factsDb, so it doesn't need the lock — it should proceed and
      // call the LLM even though the lock is held by someone else.
      expect(callCount()).toBeGreaterThan(0);
      expect(result.total).toBe(5);
    } finally {
      releaseStepLock(LOCK_NAME, tmpDir);
    }
  });

  it("runClassifyForCli and runAutoClassify share the same lock name (mutual exclusion across entry points)", async () => {
    factsDb = makeFactsDb(tmpDir, 5);
    const { openai, callCount } = makeMockOpenai();

    // Simulate runClassifyForCli's real-run lock still being held (e.g. mid-batch) by acquiring
    // it directly, then confirm runAutoClassify — the other entry point — observes the same lock.
    expect(acquireStepLock(LOCK_NAME, tmpDir)).toBe(true);
    try {
      const result = await runAutoClassify(factsDb, openai as never, { model: "test-model", batchSize: 20 }, noop, {
        openclawDir: tmpDir,
      });
      expect(result.reclassified).toBe(0);
      expect(callCount()).toBe(0);
    } finally {
      releaseStepLock(LOCK_NAME, tmpDir);
    }
  });
});
