import { describe, expect, it } from "vitest";
import { getMemoryTriggers } from "../services/auto-capture.js";
import { isHighPriorityCapture, shouldCapture } from "../services/capture-utils.js";
import { detectUserStoreDirective } from "../services/directive-extract.js";
import { formatDirectiveStoreNudgeBlock } from "../services/directive-store-nudge.js";
import { guardAgainstWrapperArgsDropped } from "../services/tool-args-guard.js";

describe("detectUserStoreDirective", () => {
  it("detects explicit remember requests", () => {
    const result = detectUserStoreDirective("Please remember that I prefer tabs over spaces for this project.");
    expect(result).not.toBeNull();
    expect(result!.storeText.length).toBeGreaterThan(10);
    expect(result!.importance).toBeGreaterThanOrEqual(0.85);
  });

  it("detects correction signals", () => {
    const result = detectUserStoreDirective("That's wrong — never use force push to main on this repo.");
    expect(result).not.toBeNull();
    expect(result!.memoryCategory).toBe("rule");
    expect(result!.importance).toBeGreaterThanOrEqual(0.85);
  });

  it("skips heartbeat and short messages", () => {
    expect(detectUserStoreDirective("heartbeat ok")).toBeNull();
    expect(detectUserStoreDirective("ok thanks")).toBeNull();
  });
});

describe("formatDirectiveStoreNudgeBlock", () => {
  it("includes memory_store action and anti-retry guidance", () => {
    const block = formatDirectiveStoreNudgeBlock({
      categories: ["correction"],
      storeText: "Never force push to main",
      memoryCategory: "rule",
      importance: 0.9,
    });
    expect(block).toContain("<memory-store-nudge>");
    expect(block).toContain("memory_store");
    expect(block).toContain("do NOT retry");
  });
});

describe("tool-args-guard wrapper metadata", () => {
  it("detects wrapper-only params for memory_recall at entry", () => {
    const result = guardAgainstWrapperArgsDropped("memory_recall", { id: "toolu_123", command: "memory_recall" });
    expect(result?.details.error).toBe("wrapper_args_dropped");
  });

  it("detects wrapper-only params for goal_register at entry", () => {
    const result = guardAgainstWrapperArgsDropped("goal_register", { toolName: "goal_register", args: {} });
    expect(result?.details.error).toBe("wrapper_args_dropped");
  });

  it("does not flag valid memory_store params", () => {
    expect(guardAgainstWrapperArgsDropped("memory_store", { text: "User prefers dark mode" })).toBeNull();
  });
});

describe("shouldCapture correction/directive signals", () => {
  const triggers = getMemoryTriggers();
  const maxChars = 5000;

  it("captures correction messages even without standard memory triggers", () => {
    const text = "That's wrong — you should always run tests before committing on this repo.";
    expect(shouldCapture(text, maxChars, triggers)).toBe(true);
    expect(isHighPriorityCapture(text)).toBe(true);
  });
});
