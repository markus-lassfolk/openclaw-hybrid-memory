import { describe, it, expect, vi, beforeEach } from "vitest";
import { withErrorTracking, withErrorTrackingAsync } from "../utils/error-tracking.js";
import { capturePluginError } from "../services/error-reporter.js";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

describe("Error Tracking Utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("withErrorTracking", () => {
    it("returns result and does not call capturePluginError on success", () => {
      const fn = () => "success";
      const wrapped = withErrorTracking(fn, { operation: "test" });

      expect(wrapped()).toBe("success");
      expect(capturePluginError).not.toHaveBeenCalled();
    });

    it("catches sync error, calls capturePluginError, and rethrows", () => {
      const error = new Error("sync error");
      const fn = () => {
        throw error;
      };
      const context = { operation: "test", subsystem: "cli" };
      const wrapped = withErrorTracking(fn, context);

      expect(() => wrapped()).toThrow(error);
      expect(capturePluginError).toHaveBeenCalledWith(error, context);
    });
  });

  describe("withErrorTrackingAsync", () => {
    it("returns result and does not call capturePluginError on success", async () => {
      const fn = async () => "success";
      const wrapped = withErrorTrackingAsync(fn, { operation: "test" });

      await expect(wrapped()).resolves.toBe("success");
      expect(capturePluginError).not.toHaveBeenCalled();
    });

    it("catches async error, calls capturePluginError, and rethrows", async () => {
      const error = new Error("async error");
      const fn = async () => {
        throw error;
      };
      const context = { operation: "test", subsystem: "cli" };
      const wrapped = withErrorTrackingAsync(fn, context);

      await expect(wrapped()).rejects.toThrow(error);
      expect(capturePluginError).toHaveBeenCalledWith(error, context);
    });
  });
});
