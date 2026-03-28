import { afterEach, describe, expect, it, vi } from "vitest";
import { initPluginLogger, pluginLogger, resetPluginLogger, restoreDefaultLogger } from "../utils/logger.js";

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
});
