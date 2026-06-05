import { describe, expect, it, vi } from "vitest";
import { integrationVerbose, traceIntegration } from "../utils/integration-trace.js";
import { pluginLogger } from "../utils/logger.js";

describe("integrationVerbose", () => {
  it("is true only for verbose verbosity", () => {
    expect(integrationVerbose("verbose")).toBe(true);
    expect(integrationVerbose("normal")).toBe(false);
    expect(integrationVerbose(undefined)).toBe(false);
  });
});

describe("traceIntegration", () => {
  it("emits debug logs only when verbose flag is set", () => {
    const debug = vi.spyOn(pluginLogger, "debug").mockImplementation(() => {});

    traceIntegration(false, "hidden");
    traceIntegration(true, "visible");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("memory-hybrid: visible");

    debug.mockRestore();
  });
});
