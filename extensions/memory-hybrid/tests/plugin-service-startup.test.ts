/**
 * Integration tests for createPluginService startup wiring.
 *
 * Verifies that the version check is actually invoked from the plugin's
 * start() handler — ensuring a refactor cannot silently remove the call
 * while the unit tests in version-check.test.ts stay green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginService, type PluginServiceContext } from "../setup/plugin-service.js";
import { MIN_OPENCLAW_VERSION } from "../utils/version-check.js";
import { _testing } from "../index.js";
import { hybridConfigSchema } from "../config.js";
import { capturePluginError, getErrorReporterMuteReason, setErrorReporterMuted } from "../services/error-reporter.js";

const { FactsDB, VectorDB } = _testing;

const EMBEDDING_DIM = 1536;

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function makeMockApi(version?: string) {
  return {
    logger: makeLogger(),
    context: { sessionId: "test-session", agentId: "test-agent" },
    version,
  };
}

function makeTimers() {
  return {
    pruneTimer: { value: null as ReturnType<typeof setInterval> | null },
    classifyTimer: { value: null as ReturnType<typeof setInterval> | null },
    classifyStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
    proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null },
    languageKeywordsTimer: { value: null as ReturnType<typeof setInterval> | null },
    languageKeywordsStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
    postUpgradeTimeout: { value: null as ReturnType<typeof setTimeout> | null },
    passiveObserverTimer: { value: null as ReturnType<typeof setInterval> | null },
    watchdogTimer: { value: null as ReturnType<typeof setInterval> | null },
  };
}

function clearTimers(timers: ReturnType<typeof makeTimers>) {
  if (timers.pruneTimer.value) {
    clearInterval(timers.pruneTimer.value);
    timers.pruneTimer.value = null;
  }
  if (timers.classifyTimer.value) {
    clearInterval(timers.classifyTimer.value);
    timers.classifyTimer.value = null;
  }
  if (timers.classifyStartupTimeout.value) {
    clearTimeout(timers.classifyStartupTimeout.value);
    timers.classifyStartupTimeout.value = null;
  }
  if (timers.proposalsPruneTimer.value) {
    clearInterval(timers.proposalsPruneTimer.value);
    timers.proposalsPruneTimer.value = null;
  }
  if (timers.languageKeywordsTimer.value) {
    clearInterval(timers.languageKeywordsTimer.value);
    timers.languageKeywordsTimer.value = null;
  }
  if (timers.languageKeywordsStartupTimeout.value) {
    clearTimeout(timers.languageKeywordsStartupTimeout.value);
    timers.languageKeywordsStartupTimeout.value = null;
  }
  if (timers.postUpgradeTimeout.value) {
    clearTimeout(timers.postUpgradeTimeout.value);
    timers.postUpgradeTimeout.value = null;
  }
  if (timers.passiveObserverTimer.value) {
    clearInterval(timers.passiveObserverTimer.value);
    timers.passiveObserverTimer.value = null;
  }
  if (timers.watchdogTimer.value) {
    clearInterval(timers.watchdogTimer.value);
    timers.watchdogTimer.value = null;
  }
}

function buildMinimalCtx(
  tmpDir: string,
  api: ReturnType<typeof makeMockApi>,
  timers: ReturnType<typeof makeTimers>,
  configOverrides: Record<string, unknown> = {},
): PluginServiceContext {
  const sqlitePath = join(tmpDir, "facts.db");
  const lancePath = join(tmpDir, "lancedb");
  const cfg = hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough-to-pass", model: "text-embedding-3-small" },
    sqlitePath,
    lanceDbPath: lancePath,
    errorReporting: { enabled: false, consent: false },
    autoClassify: { enabled: false },
    languageKeywords: { autoBuild: false, weeklyIntervalDays: 7 },
    passiveObserver: { enabled: false },
    ...configOverrides,
  });
  const factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false });
  const vectorDb = new VectorDB(lancePath, EMBEDDING_DIM, false);
  return {
    PLUGIN_ID: "memory-hybrid",
    factsDb,
    vectorDb,
    embeddings: {
      embed: vi.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
      embedBatch: vi.fn().mockResolvedValue([]),
      dimensions: EMBEDDING_DIM,
      modelName: "text-embedding-3-small",
      activeProvider: "openai",
    } as never,
    embeddingRegistry: null as never,
    credentialsDb: null,
    proposalsDb: null,
    wal: null,
    eventLog: null,
    cfg,
    openai: { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } } } as never,
    resolvedLancePath: lancePath,
    resolvedSqlitePath: sqlitePath,
    api: api as never,
    pythonBridge: null,
    provenanceService: null,
    timers,
  };
}

describe("createPluginService startup — version check wiring", () => {
  let tmpDir: string;
  let timers: ReturnType<typeof makeTimers>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-svc-startup-"));
    timers = makeTimers();
  });

  afterEach(() => {
    setErrorReporterMuted(false);
    vi.unstubAllGlobals();
    clearTimers(timers);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a version warning when api.version is undefined (old gateway)", async () => {
    const api = makeMockApi(undefined); // no version — simulates gateway < 2026.3.8
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    await createPluginService(ctx).start();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionWarn = warnCalls.find((msg) => msg.includes(MIN_OPENCLAW_VERSION));
    expect(versionWarn).toBeDefined();
    expect(versionWarn).toContain("undefined");
    // Clean up real DBs
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("emits a version warning when api.version is below the minimum", async () => {
    const api = makeMockApi("2026.3.2"); // below minimum
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    await createPluginService(ctx).start();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionWarn = warnCalls.find((msg) => msg.includes("2026.3.2"));
    expect(versionWarn).toBeDefined();
    expect(versionWarn).toContain(MIN_OPENCLAW_VERSION);
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("does not emit a version warning when api.version meets the minimum", async () => {
    const api = makeMockApi(MIN_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    await createPluginService(ctx).start();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionWarn = warnCalls.find((msg) => msg.includes(MIN_OPENCLAW_VERSION) && msg.includes("WARNING"));
    expect(versionWarn).toBeUndefined();
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("mutes telemetry and warns when the published plugin version is newer", async () => {
    const api = makeMockApi(MIN_OPENCLAW_VERSION);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (new URL(url).hostname === "registry.npmjs.org") {
        return new Response(JSON.stringify({ version: "2026.3.999" }), { status: 200 });
      }
      if (new URL(url).hostname === "api.github.com") {
        return new Response(JSON.stringify({ tag_name: "v2026.3.999" }), { status: 200 });
      }
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      errorReporting: { enabled: true, consent: true },
    });
    const service = createPluginService(ctx);
    await service.start();
    await service._getVersionCheckPromise();

    expect(getErrorReporterMuteReason()).toContain("outdated-plugin:2026.3.999");
    expect(capturePluginError(new Error("should stay local"), { operation: "startup-version-check" })).toBeUndefined();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(warnCalls.some((msg) => msg.includes("update available") && msg.includes("2026.3.999"))).toBe(true);

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });
});
