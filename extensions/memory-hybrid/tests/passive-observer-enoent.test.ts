/**
 * Tests for ENOENT handling in passive-observer (Issue #485).
 *
 * Verifies that session files pruned by session.maintenance are skipped
 * gracefully — no error counted, no GlitchTip report — rather than
 * crashing or inflating the error count.
 *
 * Uses vi.mock to intercept node:fs/promises so we can simulate ENOENT
 * without a real race condition.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs/promises BEFORE any import of passive-observer (vi.mock is
// hoisted, so this always runs first regardless of source order).
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
    open: vi.fn((...args: Parameters<typeof actual.open>) => actual.open(...args)),
  };
});

// Mock error reporter so we can assert capturePluginError is (not) called.
vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import * as chat from "../services/chat.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { capturePluginError } from "../services/error-reporter.js";
import { type PassiveObserverConfig, runPassiveObserver } from "../services/passive-observer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEnoent = () =>
  Object.assign(new Error("ENOENT: no such file or directory, open '/fake/path'"), { code: "ENOENT" });

const makeEperm = () =>
  Object.assign(new Error("EPERM: operation not permitted, open '/fake/path'"), { code: "EPERM" });

const makeConfig = (overrides: Partial<PassiveObserverConfig> = {}): PassiveObserverConfig => ({
  enabled: true,
  intervalMinutes: 15,
  maxCharsPerChunk: 8000,
  minImportance: 0.5,
  deduplicationThreshold: 0.92,
  ...overrides,
});

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

const makeFactsDb = () => ({
  getRecentFacts: vi.fn().mockReturnValue([]),
  store: vi.fn().mockReturnValue({ id: `fact-${randomUUID()}` }),
  detectContradictions: vi.fn(),
  setEmbeddingModel: vi.fn(),
  boostConfidence: vi.fn().mockReturnValue(false),
});

const makeVectorDb = () => ({
  store: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
});

const makeEmbeddings = () => ({
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  modelName: "mock-model",
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("passive-observer ENOENT handling (Issue #485)", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `po-enoent-test-${randomUUID()}`);
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // stat ENOENT: file pruned between readdirSync and stat
  // -------------------------------------------------------------------------

  it("stat ENOENT — skips file without incrementing errors", async () => {
    // Create a real file so readdirSync lists it
    const sessionFile = join(sessionsDir, "pruned-session.jsonl");
    writeFileSync(sessionFile, '{"message":{"role":"user","content":"hello"}}\n');

    // Make stat throw ENOENT for this specific file (simulates pruning)
    vi.mocked(stat).mockRejectedValueOnce(makeEnoent());

    const logger = makeLogger();
    const result = await runPassiveObserver(
      makeFactsDb() as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      logger,
    );

    expect(result.errors).toBe(0);
    expect(result.sessionsScanned).toBe(0); // stat failed, never counted
    expect(capturePluginError).not.toHaveBeenCalled();
    // Should log at info level, not warn
    expect(logger.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("pruned"))).toBe(true);
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("pruned"))).toBe(false);
  });

  it("stat ENOENT — other sessions in same dir are still processed", async () => {
    // Two session files: one will be pruned, one will work
    const prunedFile = join(sessionsDir, "aaaa-pruned.jsonl"); // sorts first
    const goodFile = join(sessionsDir, "zzzz-good.jsonl");
    const goodContent = '{"message":{"role":"user","content":"We use TypeScript"}}\n';

    writeFileSync(prunedFile, '{"message":{"role":"user","content":"deleted"}}\n');
    writeFileSync(goodFile, goodContent);

    // First stat call is the pruned file because runPassiveObserver sorts filePaths
    // alphabetically (via .sort()) — "aaaa-" < "zzzz-" is always stable.
    vi.mocked(stat).mockRejectedValueOnce(makeEnoent());
    // Second stat call (good file) → passthrough to real stat

    const chatSpy = vi
      .spyOn(chat, "chatCompleteWithRetry")
      .mockResolvedValue(
        JSON.stringify([{ text: "The team uses TypeScript everywhere", category: "fact", importance: 0.8 }]),
      );

    const factsDb = makeFactsDb();
    const result = await runPassiveObserver(
      factsDb as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      makeLogger(),
    );

    // Good file was processed despite pruned file failing
    expect(result.errors).toBe(0);
    expect(result.sessionsScanned).toBe(1); // only the good file was counted
    expect(result.factsStored).toBe(1);
    expect(capturePluginError).not.toHaveBeenCalled();

    chatSpy.mockRestore();
  });

  it("stat non-ENOENT error (EPERM) — is still counted as error and reported", async () => {
    const sessionFile = join(sessionsDir, "eperm-session.jsonl");
    writeFileSync(sessionFile, '{"message":{"role":"user","content":"hello"}}\n');

    vi.mocked(stat).mockRejectedValueOnce(makeEperm());

    const logger = makeLogger();
    const result = await runPassiveObserver(
      makeFactsDb() as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      logger,
    );

    expect(result.errors).toBe(1);
    expect(capturePluginError).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("failed to stat"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // open ENOENT: file pruned between stat and open
  // -------------------------------------------------------------------------

  it("open ENOENT — skips file without incrementing errors", async () => {
    const sessionFile = join(sessionsDir, "pruned-before-open.jsonl");
    writeFileSync(sessionFile, '{"message":{"role":"user","content":"hello world"}}\n');

    // stat succeeds (real file), open throws ENOENT (file deleted in between)
    vi.mocked(open).mockRejectedValueOnce(makeEnoent());

    const logger = makeLogger();
    const result = await runPassiveObserver(
      makeFactsDb() as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      logger,
    );

    expect(result.errors).toBe(0);
    // stat succeeded so the session was scanned (counted)
    expect(result.sessionsScanned).toBe(1);
    expect(capturePluginError).not.toHaveBeenCalled();
    // Info log, not warn
    expect(logger.info.mock.calls.some((c: unknown[]) => String(c[0]).includes("pruned between scan and read"))).toBe(
      true,
    );
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("failed to read"))).toBe(false);
  });

  it("open ENOENT — other sessions still processed after the pruned one", async () => {
    const prunedFile = join(sessionsDir, "aaaa-pruned.jsonl");
    const goodFile = join(sessionsDir, "zzzz-good.jsonl");

    writeFileSync(prunedFile, '{"message":{"role":"user","content":"deleted"}}\n');
    writeFileSync(goodFile, '{"message":{"role":"user","content":"The team uses Rust"}}\n');

    // First open call is the pruned file — runPassiveObserver sorts filePaths
    // alphabetically so "aaaa-" is always processed before "zzzz-".
    vi.mocked(open).mockRejectedValueOnce(makeEnoent());

    const chatSpy = vi
      .spyOn(chat, "chatCompleteWithRetry")
      .mockResolvedValue(
        JSON.stringify([{ text: "The team uses Rust for CLI tools", category: "fact", importance: 0.8 }]),
      );

    const factsDb = makeFactsDb();
    const result = await runPassiveObserver(
      factsDb as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      makeLogger(),
    );

    expect(result.errors).toBe(0);
    expect(result.sessionsScanned).toBe(2); // both stat-ed successfully
    expect(result.factsStored).toBe(1); // only good file produced a fact
    expect(capturePluginError).not.toHaveBeenCalled();

    chatSpy.mockRestore();
  });

  it("open non-ENOENT error (EPERM) — is still counted as error and reported", async () => {
    const sessionFile = join(sessionsDir, "eperm-open.jsonl");
    writeFileSync(sessionFile, '{"message":{"role":"user","content":"hello"}}\n');

    vi.mocked(open).mockRejectedValueOnce(makeEperm());

    const logger = makeLogger();
    const result = await runPassiveObserver(
      makeFactsDb() as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      logger,
    );

    expect(result.errors).toBe(1);
    expect(capturePluginError).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("failed to read"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Regression: multiple pruned files in one run — all skipped cleanly
  // -------------------------------------------------------------------------

  it("multiple pruned files — all skipped, zero errors total", async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(sessionsDir, `pruned-${i}.jsonl`), '{"message":{"role":"user","content":"x"}}\n');
    }

    // All three open calls fail with ENOENT
    vi.mocked(open)
      .mockRejectedValueOnce(makeEnoent())
      .mockRejectedValueOnce(makeEnoent())
      .mockRejectedValueOnce(makeEnoent());

    const result = await runPassiveObserver(
      makeFactsDb() as unknown as FactsDB,
      makeVectorDb() as unknown as VectorDB,
      makeEmbeddings() as unknown as EmbeddingProvider,
      {} as unknown as OpenAI,
      makeConfig({ sessionsDir }),
      ["fact"],
      { model: "test-model", dbDir: tmpDir },
      makeLogger(),
    );

    expect(result.errors).toBe(0);
    expect(result.sessionsScanned).toBe(3);
    expect(capturePluginError).not.toHaveBeenCalled();
  });
});
