import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initPluginLogger,
  isHybridMemQuiet,
  pluginLogger,
  resetPluginLogger,
  restoreDefaultLogger,
} from "../utils/logger.js";

describe("pluginLogger", () => {
  afterEach(() => {
    restoreDefaultLogger();
  });

  it("uses console fallback before initPluginLogger is called", () => {
    const infoSpy = vi.spyOn(console, "info");
    const warnSpy = vi.spyOn(console, "warn");
    const errorSpy = vi.spyOn(console, "error");
    const debugSpy = vi.spyOn(console, "debug");

    pluginLogger.info("info message");
    pluginLogger.warn("warn message");
    pluginLogger.error("error message");
    pluginLogger.debug("debug message");

    expect(infoSpy).toHaveBeenCalledWith("info message");
    expect(warnSpy).toHaveBeenCalledWith("warn message");
    expect(errorSpy).toHaveBeenCalledWith("error message");
    expect(debugSpy).toHaveBeenCalledWith("debug message");

    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("routes through api.logger after initPluginLogger is called", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    initPluginLogger(mockLogger);

    pluginLogger.info("hello info");
    pluginLogger.warn("hello warn");
    pluginLogger.error("hello error");
    pluginLogger.debug("hello debug");

    expect(mockLogger.info).toHaveBeenCalledWith("hello info");
    expect(mockLogger.warn).toHaveBeenCalledWith("hello warn");
    expect(mockLogger.error).toHaveBeenCalledWith("hello error");
    expect(mockLogger.debug).toHaveBeenCalledWith("hello debug");
  });

  it("handles optional debug method on api.logger (no debug provided)", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // no debug
    };

    initPluginLogger(mockLogger);

    // Should not throw even when debug is missing
    expect(() => pluginLogger.debug("debug msg")).not.toThrow();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("resets to no-op after resetPluginLogger", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    initPluginLogger(mockLogger);
    pluginLogger.warn("before reset");
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    resetPluginLogger();
    pluginLogger.warn("after reset — should be silent");
    expect(mockLogger.warn).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it("re-initializes after reset when called with a new api.logger", () => {
    const first = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const second = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    initPluginLogger(first);
    pluginLogger.info("first");
    expect(first.info).toHaveBeenCalledWith("first");

    resetPluginLogger();
    initPluginLogger(second);
    pluginLogger.info("second");
    expect(second.info).toHaveBeenCalledWith("second");
    expect(first.info).toHaveBeenCalledTimes(1); // not called again
  });

  it("useStderr routes to console.error without calling api.logger (issue #1230)", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    initPluginLogger(mockLogger, true);
    pluginLogger.info("x");
    expect(errSpy).toHaveBeenCalledWith("x");
    expect(mockLogger.info).not.toHaveBeenCalled();
    errSpy.mockRestore();
    restoreDefaultLogger();
  });
});

describe("isHybridMemQuiet / quiet mode (#2095)", () => {
  const savedQuiet = process.env.OPENCLAW_HYBRID_MEM_QUIET;

  afterEach(() => {
    if (savedQuiet === undefined) {
      delete process.env.OPENCLAW_HYBRID_MEM_QUIET;
    } else {
      process.env.OPENCLAW_HYBRID_MEM_QUIET = savedQuiet;
    }
    restoreDefaultLogger();
  });

  it("is false by default", () => {
    delete process.env.OPENCLAW_HYBRID_MEM_QUIET;
    expect(isHybridMemQuiet()).toBe(false);
  });

  it('is true only for the literal value "1"', () => {
    process.env.OPENCLAW_HYBRID_MEM_QUIET = "1";
    expect(isHybridMemQuiet()).toBe(true);

    process.env.OPENCLAW_HYBRID_MEM_QUIET = "true";
    expect(isHybridMemQuiet()).toBe(false);

    process.env.OPENCLAW_HYBRID_MEM_QUIET = "0";
    expect(isHybridMemQuiet()).toBe(false);
  });

  it("suppresses pluginLogger.info and .debug but not .warn/.error", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    initPluginLogger(mockLogger);
    process.env.OPENCLAW_HYBRID_MEM_QUIET = "1";

    pluginLogger.info("bootstrap noise");
    pluginLogger.debug("debug noise");
    pluginLogger.warn("real warning");
    pluginLogger.error("real error");

    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith("real warning");
    expect(mockLogger.error).toHaveBeenCalledWith("real error");
  });

  it("stops suppressing once the env var is cleared", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    initPluginLogger(mockLogger);

    process.env.OPENCLAW_HYBRID_MEM_QUIET = "1";
    pluginLogger.info("suppressed");
    expect(mockLogger.info).not.toHaveBeenCalled();

    delete process.env.OPENCLAW_HYBRID_MEM_QUIET;
    pluginLogger.info("visible again");
    expect(mockLogger.info).toHaveBeenCalledWith("visible again");
  });
});
