import { describe, expect, it, vi } from "vitest";
import { runCaptureStoreWithDedupWindow } from "../services/capture-dedup.js";

describe("runCaptureStoreWithDedupWindow", () => {
  it("stores without a transaction when factsDb has no getRawDb()", () => {
    const storeWithResult = vi.fn().mockReturnValue({
      skipped: false,
      entry: { id: "fact-1" },
    });
    const result = runCaptureStoreWithDedupWindow({}, 30, { text: "hello", scope: "global", scopeTarget: null }, () =>
      storeWithResult({ text: "hello" }),
    );

    expect(result.skipped).toBe(false);
    expect(storeWithResult).toHaveBeenCalledOnce();
  });
});
