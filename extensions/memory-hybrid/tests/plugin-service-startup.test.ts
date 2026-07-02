// @ts-nocheck
/**
 * Integration tests for createPluginService startup wiring.
 *
 * Verifies that the version check is actually invoked from the plugin's
 * start() handler — ensuring a refactor cannot silently remove the call
 * while the unit tests in version-check.test.ts stay green.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { capturePluginError, getErrorReporterMuteReason, setErrorReporterMuted } from "../services/error-reporter.js";
import * as errorReporter from "../services/error-reporter.js";
import { type PluginServiceContext, createPluginService } from "../setup/plugin-service.js";
import { createDashboardServer } from "../routes/dashboard-server.js";
import { spawn } from "node:child_process";
import { MIN_OPENCLAW_VERSION, RECOMMENDED_OPENCLAW_VERSION } from "../utils/version-check.js";

vi.mock("../routes/dashboard-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/dashboard-server.js")>();
  return {
    ...actual,
    createDashboardServer: vi.fn(async (_ctx, port) => ({
      port: port === 0 ? 17700 : port,
      close: vi.fn(),
    })),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

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
    maintenanceTick: { value: null as ReturnType<typeof setInterval> | null },
    maintenanceStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
    shuttingDownRef: { value: false },
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
  if (timers.maintenanceTick.value) {
    clearInterval(timers.maintenanceTick.value);
    timers.maintenanceTick.value = null;
  }
  if (timers.maintenanceStartupTimeout.value) {
    clearTimeout(timers.maintenanceStartupTimeout.value);
    timers.maintenanceStartupTimeout.value = null;
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
    edictStore: { close: vi.fn() } as never,
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

  it("emits a recommended-tier info when api.version meets minimum only", async () => {
    const api = makeMockApi(MIN_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    await createPluginService(ctx).start();

    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionInfo = infoCalls.find((msg) => msg.includes(RECOMMENDED_OPENCLAW_VERSION));
    expect(versionInfo).toBeDefined();
    expect(versionInfo).toContain("Skill Workshop");

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionWarn = warnCalls.find((msg) => msg.includes("WARNING") && msg.includes(MIN_OPENCLAW_VERSION));
    expect(versionWarn).toBeUndefined();
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("does not emit version warnings or info when api.version meets recommended tier", async () => {
    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    await createPluginService(ctx).start();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionWarn = warnCalls.find((msg) => msg.includes(MIN_OPENCLAW_VERSION) && msg.includes("WARNING"));
    expect(versionWarn).toBeUndefined();

    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    const versionInfo = infoCalls.find((msg) => msg.includes(RECOMMENDED_OPENCLAW_VERSION));
    expect(versionInfo).toBeUndefined();
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("mutes telemetry and warns when the published plugin version is newer", async () => {
    const api = makeMockApi(MIN_OPENCLAW_VERSION);
    // Must stay numerically above package.json plugin version so the "outdated" path still fires after each release bump.
    const publishedNewer = "2099.1.1";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (new URL(url).hostname === "registry.npmjs.org") {
        return new Response(JSON.stringify({ version: publishedNewer }), { status: 200 });
      }
      if (new URL(url).hostname === "api.github.com") {
        return new Response(JSON.stringify({ tag_name: `v${publishedNewer}` }), { status: 200 });
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

    expect(getErrorReporterMuteReason()).toContain(`outdated-plugin:${publishedNewer}`);
    expect(capturePluginError(new Error("should stay local"), { operation: "startup-version-check" })).toBeUndefined();

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(warnCalls.some((msg) => msg.includes("update available") && msg.includes(publishedNewer))).toBe(true);

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });
});

describe("createPluginService startup — dashboard wiring (#1968)", () => {
  let tmpDir: string;
  let timers: ReturnType<typeof makeTimers>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-svc-dashboard-"));
    timers = makeTimers();
    vi.mocked(createDashboardServer).mockClear();
  });

  afterEach(() => {
    clearTimers(timers);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes embeddingRegistry to createDashboardServer without ReferenceError", async () => {
    const api = makeMockApi(MIN_OPENCLAW_VERSION);
    const registry = { kind: "registry" } as never;
    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      dashboard: { enabled: true, port: 0 },
    });
    ctx.embeddingRegistry = registry;

    await createPluginService(ctx).start();

    expect(createDashboardServer).toHaveBeenCalled();
    const dashboardCtx = vi.mocked(createDashboardServer).mock.calls[0]?.[0];
    expect(dashboardCtx?.embeddingRegistry).toBe(registry);

    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoCalls.some((msg) => msg.includes("dashboard started"))).toBe(true);

    const warnCalls = api.logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(warnCalls.some((msg) => msg.includes("embeddingRegistry is not defined"))).toBe(false);
    expect(warnCalls.some((msg) => msg.includes("dashboard server failed to start"))).toBe(false);

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("reports (instead of silently swallowing) a dashboardServer.close() failure during stop() (#61)", async () => {
    vi.mocked(createDashboardServer).mockResolvedValueOnce({
      port: 17701,
      close: vi.fn(() => {
        throw new Error("dashboard close boom");
      }),
    } as never);

    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      dashboard: { enabled: true, port: 0 },
      errorReporting: { enabled: false, consent: false },
    });
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);

    const service = createPluginService(ctx);
    await service.start();
    await service.stop();

    const dashboardCloseCalls = captureSpy.mock.calls.filter(
      ([, ctxArg]) => (ctxArg as { operation?: string })?.operation === "dashboard-close",
    );
    expect(dashboardCloseCalls.length).toBeGreaterThan(0);
    captureSpy.mockRestore();

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("closes the dashboard server immediately, and skips arming later timers, when stop() runs concurrently during startup (#88)", async () => {
    const closeMock = vi.fn();
    vi.mocked(createDashboardServer).mockImplementationOnce(async (_ctx, port) => {
      // Simulate a concurrent stop() completing while createDashboardServer() is still awaiting
      // startup — clearRuntimeTimers already ran by the time start() resumes, so anything armed
      // after this point would leak past shutdown instead of ever being cleared.
      timers.shuttingDownRef.value = true;
      return { port: port === 0 ? 17702 : port, close: closeMock };
    });

    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      dashboard: { enabled: true, port: 0 },
    });

    await createPluginService(ctx).start();

    expect(closeMock).toHaveBeenCalledTimes(1);
    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoCalls.some((msg) => msg.includes("dashboard started"))).toBe(false);
    expect(infoCalls.some((msg) => msg.includes("unified maintenance tick enabled"))).toBe(false);
    expect(infoCalls.some((msg) => msg.includes("task-queue-watchdog enabled"))).toBe(false);
    expect(timers.maintenanceStartupTimeout.value).toBeNull();
    expect(timers.maintenanceTick.value).toBeNull();
    expect(timers.watchdogTimer.value).toBeNull();

    timers.shuttingDownRef.value = false;
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });
});

describe("createPluginService stop() — resource cleanup (#57, #58)", () => {
  let tmpDir: string;
  let timers: ReturnType<typeof makeTimers>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-svc-stop-"));
    timers = makeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTimers(timers);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waits for an in-flight maintenance tick to finish before closing factsDb/vectorDb (#57)", async () => {
    vi.useFakeTimers();
    let releaseTick: (() => void) | undefined;
    const tickGate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const order: string[] = [];
    const maintenanceOrchestrator = await import("../services/maintenance-orchestrator.js");
    const runMaintenanceTiersSpy = vi
      .spyOn(maintenanceOrchestrator, "runMaintenanceTiers")
      .mockImplementation(async () => {
        order.push("tick-started");
        await tickGate;
        order.push("tick-resolved");
        return { exitCode: 0, summaryLine: "ok", steps: [] } as never;
      });
    // The watchdog interval fires at the exact same 5-minute mark as the maintenance startup
    // timeout below — neutralize it so stop()'s pre-existing watchdogRunPromise drain logic
    // can't accidentally make this test pass regardless of the maintenance-tick fix under test.
    const taskQueueWatchdog = await import("../services/task-queue-watchdog.js");
    const watchdogSpy = vi.spyOn(taskQueueWatchdog, "runTaskQueueWatchdog").mockResolvedValue(undefined as never);

    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      errorReporting: { enabled: false, consent: false },
    });
    // stop() now closes via permanentClose() (#86), not close() — see closeStorePermanently().
    const closeSpy = vi
      .spyOn(ctx.factsDb as InstanceType<typeof FactsDB>, "permanentClose")
      .mockImplementation(() => {
        order.push("db-closed");
      });

    const service = createPluginService(ctx);
    await service.start();

    // Fire the 5-minute maintenance startup timeout and let the tick reach the mocked await point.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(order).toEqual(["tick-started"]);

    const stopPromise = service.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).not.toContain("db-closed");

    releaseTick?.();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(order).toEqual(["tick-started", "tick-resolved", "db-closed"]);
    runMaintenanceTiersSpy.mockRestore();
    watchdogSpy.mockRestore();
    closeSpy.mockRestore();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("closes every configured SQLite-backed store, not just factsDb/vectorDb/credentialsDb (#58)", async () => {
    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    const closes = {
      eventLog: vi.fn(),
      narrativesDb: vi.fn(),
      issueStore: vi.fn(),
      workflowStore: vi.fn(),
      crystallizationStore: vi.fn(),
      toolProposalStore: vi.fn(),
      verificationStore: vi.fn(),
      eventBus: vi.fn(),
    };
    ctx.eventLog = { close: closes.eventLog } as never;
    ctx.narrativesDb = { close: closes.narrativesDb } as never;
    ctx.issueStore = { close: closes.issueStore } as never;
    ctx.workflowStore = { close: closes.workflowStore } as never;
    ctx.crystallizationStore = { close: closes.crystallizationStore } as never;
    ctx.toolProposalStore = { close: closes.toolProposalStore } as never;
    ctx.verificationStore = { close: closes.verificationStore } as never;
    ctx.eventBus = { close: closes.eventBus } as never;
    const edictCloseSpy = vi.spyOn(ctx.edictStore, "close");

    await createPluginService(ctx).stop();

    for (const [name, spy] of Object.entries(closes)) {
      expect(spy, `${name}.close() should have been called`).toHaveBeenCalledTimes(1);
    }
    expect(edictCloseSpy).toHaveBeenCalledTimes(1);

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("closes identityReflectionStore, personaStateStore, learningsDb, apitapStore, aliasDb, and vaultRegistry (#90)", async () => {
    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    const closes = {
      identityReflectionStore: vi.fn(),
      personaStateStore: vi.fn(),
      learningsDb: vi.fn(),
      apitapStore: vi.fn(),
      aliasDb: vi.fn(),
    };
    ctx.identityReflectionStore = { close: closes.identityReflectionStore } as never;
    ctx.personaStateStore = { close: closes.personaStateStore } as never;
    ctx.learningsDb = { close: closes.learningsDb } as never;
    ctx.apitapStore = { close: closes.apitapStore } as never;
    ctx.aliasDb = { close: closes.aliasDb } as never;
    const closeAllSpy = vi.fn();
    ctx.vaultRegistry = { closeAll: closeAllSpy } as never;

    await createPluginService(ctx).stop();

    for (const [name, spy] of Object.entries(closes)) {
      expect(spy, `${name}.close() should have been called`).toHaveBeenCalledTimes(1);
    }
    expect(closeAllSpy).toHaveBeenCalledTimes(1);

    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });

  it("permanently closes factsDb so a stale closure can't silently reopen it after stop() (#86)", async () => {
    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers);
    const factsDb = ctx.factsDb as InstanceType<typeof FactsDB>;

    await createPluginService(ctx).stop();

    // close() (the non-terminal variant) lets liveDb lazily reopen a new native handle on the
    // next access — exactly the #1550 duplicate-handle bug. permanentClose() must instead make
    // any post-shutdown access throw, proving stop() upgraded to the terminal variant.
    expect(() =>
      factsDb.store({
        text: "Should not be writable after permanentClose",
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      }),
    ).toThrow(/database connection is not open/i);

    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });
});

describe("createPluginService startup — post-upgrade pipeline shutdown guard (#89)", () => {
  let tmpDir: string;
  let timers: ReturnType<typeof makeTimers>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-svc-post-upgrade-"));
    timers = makeTimers();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTimers(timers);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops spawning post-upgrade CLI steps once a concurrent stop() flips shuttingDownRef mid-pipeline", async () => {
    let spawnCallCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCallCount += 1;
      const isFirstCall = spawnCallCount === 1;
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const child = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: (...a: unknown[]) => void) => {
          handlers[event] = cb;
        },
      };
      // Every mocked CLI step "completes" on the next microtask; simulate stop() having run
      // concurrently right after the first step finishes, before the pipeline spawns step two.
      queueMicrotask(() => {
        if (isFirstCall) timers.shuttingDownRef.value = true;
        handlers.close?.(0);
      });
      return child as never;
    });

    const api = makeMockApi(RECOMMENDED_OPENCLAW_VERSION);
    const ctx = buildMinimalCtx(tmpDir, api, timers, {
      reflection: { enabled: false },
    });

    vi.useFakeTimers();
    await createPluginService(ctx).start();
    // Bounded advance (not runAllTimersAsync): maintenanceTick/watchdogTimer are recurring
    // intervals armed unconditionally by start(), which would re-arm forever otherwise.
    await vi.advanceTimersByTimeAsync(20_000);

    // The pipeline has 3 steps with reflection disabled (build-languages is skipped when no
    // language keywords path is configured): self-correction-run, extract-procedures,
    // generate-auto-skills. Only the first should have been spawned before the abort was seen.
    expect(spawnCallCount).toBeLessThan(3);
    const spawnedArgs = vi.mocked(spawn).mock.calls.map((c) => c[1] as string[]);
    expect(spawnedArgs.some((args) => args.includes("generate-auto-skills"))).toBe(false);

    const versionFile = join(tmpDir, ".last-post-upgrade-version");
    expect(existsSync(versionFile)).toBe(false);

    const infoCalls = api.logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(infoCalls.some((msg) => msg.includes("post-upgrade pipeline aborted"))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes("post-upgrade pipeline done"))).toBe(false);

    timers.shuttingDownRef.value = false;
    vi.useRealTimers();
    (ctx.factsDb as InstanceType<typeof FactsDB>).close();
    (ctx.vectorDb as InstanceType<typeof VectorDB>).close();
  });
});
