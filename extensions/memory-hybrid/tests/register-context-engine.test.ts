import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturePluginErrorMock } = vi.hoisted(() => ({
  capturePluginErrorMock: vi.fn(),
}));

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return {
    ...actual,
    capturePluginError: capturePluginErrorMock,
  };
});

import { registerContextEngineBestEffort } from "../setup/register-context-engine.js";

describe("registerContextEngineBestEffort", () => {
  beforeEach(() => {
    capturePluginErrorMock.mockClear();
  });

  function makeRuntime() {
    return {
      factsDb: {} as unknown,
      vectorDb: {} as unknown,
      wal: null,
      embeddings: {} as unknown,
      cfg: {} as unknown,
    } as Parameters<typeof registerContextEngineBestEffort>[0]["runtime"];
  }

  it("registers context engine when loader succeeds", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();
    const registerHybridContextEngine = vi.fn();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      loadContextEngine: async () => ({ registerHybridContextEngine }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registerHybridContextEngine).toHaveBeenCalledWith({
      factsDb: runtime.factsDb,
      vectorDb: runtime.vectorDb,
      wal: runtime.wal,
      embeddings: runtime.embeddings,
      cfg: runtime.cfg,
      logger,
      pluginVersion: "2026.5.0",
    });
    expect(capturePluginErrorMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports and warns when loader rejects", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      loadContextEngine: async () => {
        throw new Error("loader failed");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturePluginErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "registration",
      operation: "plugin-register:context-engine",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ContextEngine registration skipped"));
  });

  it("reports and warns when registrar throws", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      loadContextEngine: async () => ({
        registerHybridContextEngine: () => {
          throw new Error("registrar failed");
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturePluginErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "registration",
      operation: "plugin-register:context-engine",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ContextEngine registration skipped"));
  });

  it("reports and warns when registrar returns a rejected promise", async () => {
    const logger = { warn: vi.fn() };
    const runtime = makeRuntime();

    registerContextEngineBestEffort({
      runtime,
      logger,
      pluginVersion: "2026.5.0",
      loadContextEngine: async () => ({
        registerHybridContextEngine: async () => {
          throw new Error("registrar rejected");
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturePluginErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "registration",
      operation: "plugin-register:context-engine",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ContextEngine registration skipped"));
  });
});
