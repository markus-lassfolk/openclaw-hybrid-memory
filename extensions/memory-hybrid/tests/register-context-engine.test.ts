import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturePluginErrorMock, registerHybridContextEngineMock, registerHybridContextEngineSyncMock } =
  vi.hoisted(() => ({
    capturePluginErrorMock: vi.fn(),
    registerHybridContextEngineMock: vi.fn(),
    registerHybridContextEngineSyncMock: vi.fn(),
  }));

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return {
    ...actual,
    capturePluginError: capturePluginErrorMock,
  };
});

vi.mock("../services/context-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/context-engine.js")>();
  return {
    ...actual,
    registerHybridContextEngine: registerHybridContextEngineMock,
    registerHybridContextEngineSync: registerHybridContextEngineSyncMock,
  };
});

import { registerContextEngineBestEffort } from "../setup/register-context-engine.js";

describe("registerContextEngineBestEffort", () => {
  beforeEach(() => {
    capturePluginErrorMock.mockClear();
    registerHybridContextEngineMock.mockClear();
    registerHybridContextEngineSyncMock.mockClear();
    registerHybridContextEngineMock.mockResolvedValue(true);
    registerHybridContextEngineSyncMock.mockReturnValue(true);
  });

  function makeRuntime() {
    return {
      factsDb: {} as unknown,
      vectorDb: {} as unknown,
      wal: null,
      embeddings: {} as unknown,
      cfg: {} as unknown,
      injectedFactIdsBySession: new Map(),
    } as Parameters<typeof registerContextEngineBestEffort>[0]["runtime"];
  }

  const expectedOpts = (runtime: ReturnType<typeof makeRuntime>, logger: { warn: ReturnType<typeof vi.fn> }) => ({
    factsDb: runtime.factsDb,
    vectorDb: runtime.vectorDb,
    wal: runtime.wal,
    embeddings: runtime.embeddings,
    cfg: runtime.cfg,
    injectedFactIdsBySession: runtime.injectedFactIdsBySession,
    logger,
    pluginVersion: "2026.5.0",
  });

  it("registers context engine synchronously when api hook is provided", () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();
    const registerContextEngine = vi.fn();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      registerContextEngine,
    });

    expect(registerHybridContextEngineSyncMock).toHaveBeenCalledWith({
      ...expectedOpts(runtime, logger),
      registerContextEngine,
    });
    expect(registerHybridContextEngineMock).not.toHaveBeenCalled();
    expect(capturePluginErrorMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports and warns when sync registrar throws", () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();
    const registerContextEngine = vi.fn();
    registerHybridContextEngineSyncMock.mockImplementation(() => {
      throw new Error("registrar failed");
    });

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      registerContextEngine,
    });

    expect(capturePluginErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "registration",
      operation: "plugin-register:context-engine",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ContextEngine registration skipped"));
  });

  it("falls back to async SDK registration when api hook is absent", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
    });

    await Promise.resolve();

    expect(registerHybridContextEngineSyncMock).not.toHaveBeenCalled();
    expect(registerHybridContextEngineMock).toHaveBeenCalledWith(expectedOpts(runtime, logger));
    expect(capturePluginErrorMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports and warns when async registrar rejects", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();
    registerHybridContextEngineMock.mockRejectedValue(new Error("sdk import failed"));

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(capturePluginErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "registration",
      operation: "plugin-register:context-engine",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ContextEngine registration skipped"));
  });
});
