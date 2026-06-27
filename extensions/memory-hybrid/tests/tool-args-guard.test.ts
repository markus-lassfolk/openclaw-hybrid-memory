import { describe, expect, it } from "vitest";
import {
  guardAgainstWrapperArgsDropped,
  toolArgsCompletelyEmpty,
  wrapperArgsDroppedToolResult,
} from "../services/tool-args-guard.js";

describe("tool-args-guard", () => {
  it("detects completely empty args", () => {
    expect(toolArgsCompletelyEmpty({})).toBe(true);
    expect(toolArgsCompletelyEmpty(null)).toBe(true);
    expect(toolArgsCompletelyEmpty(undefined)).toBe(true);
    expect(toolArgsCompletelyEmpty({ query: "x" })).toBe(false);
  });

  it("returns wrapper_args_dropped result with upstream reference", () => {
    const result = wrapperArgsDroppedToolResult("memory_recall", {});
    expect(result.details.error).toBe("wrapper_args_dropped");
    expect(result.details.tool).toBe("memory_recall");
    expect(result.content[0].text).toContain("#96115");
  });

  it("guard returns null when args are present", () => {
    expect(guardAgainstWrapperArgsDropped("memory_recall", { query: "deploy" })).toBeNull();
  });

  it("guard returns null for bare {} (model omission, not wrapper loss)", () => {
    expect(guardAgainstWrapperArgsDropped("memory_recall", {})).toBeNull();
    expect(guardAgainstWrapperArgsDropped("memory_store", {})).toBeNull();
  });

  it("guard detects wrapper-only metadata at entry (not just empty {})", () => {
    const result = guardAgainstWrapperArgsDropped("memory_store", { toolName: "memory_store", input: {} });
    expect(result?.details.error).toBe("wrapper_args_dropped");
  });
});
