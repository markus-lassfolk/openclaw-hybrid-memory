import { afterEach, describe, expect, it, vi } from "vitest";
import { isHybridMemJsonCliInvocation } from "../index.js";
import { createJsonCliStderrLogger, pluginLogger, restoreDefaultLogger, initPluginLogger } from "../utils/logger.js";

describe("JSON CLI stdout hygiene (#1234)", () => {
  afterEach(() => {
    restoreDefaultLogger();
    vi.restoreAllMocks();
  });

  it("detects hybrid-mem JSON invocations before command parsing", () => {
    expect(isHybridMemJsonCliInvocation(["openclaw", "hybrid-mem", "config", "--json"])).toBe(true);
    expect(isHybridMemJsonCliInvocation(["openclaw", "hybrid-mem", "config", "--format", "json"])).toBe(true);
    expect(isHybridMemJsonCliInvocation(["openclaw", "hybrid-mem", "config", "--format=json"])).toBe(true);
    expect(isHybridMemJsonCliInvocation(["openclaw", "hybrid-mem", "config", "--format", "text"])).toBe(false);
    expect(isHybridMemJsonCliInvocation(["openclaw", "hybrid-mem", "store", "--", "--json"])).toBe(false);
  });

  it("routes plugin telemetry to stderr and keeps stdout untouched for JSON CLI mode", () => {
    const stdoutInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const jsonLogger = createJsonCliStderrLogger();
    initPluginLogger(jsonLogger);
    jsonLogger.warn("memory-hybrid: direct api.logger warning");
    pluginLogger.info("memory-hybrid: registered");
    pluginLogger.warn("memory-hybrid: credentials vault enabled plaintext");
    pluginLogger.debug("memory-hybrid: debug line");

    expect(stdoutInfo).not.toHaveBeenCalled();
    expect(stdoutLog).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("memory-hybrid: direct api.logger warning");
    expect(stderr).toHaveBeenCalledWith("memory-hybrid: registered");
    expect(stderr).toHaveBeenCalledWith("memory-hybrid: credentials vault enabled plaintext");
    expect(stderr).toHaveBeenCalledWith("memory-hybrid: debug line");
  });
});
