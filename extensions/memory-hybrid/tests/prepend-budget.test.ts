import { describe, expect, it } from "vitest";
import {
  applyPrependBudget,
  createPrependBudgetRef,
  getRemainingPrependTokens,
  initPrependBudget,
  trimPrependToRemainingBudget,
} from "../services/prepend-budget.js";

describe("prepend budget", () => {
  it("resets remaining tokens on init", () => {
    const ref = createPrependBudgetRef();
    initPrependBudget(ref, 200, "session-a");
    expect(getRemainingPrependTokens(ref)).toBe(200);

    initPrependBudget(ref, 120, "session-b");
    expect(ref.value?.sessionKey).toBe("session-b");
    expect(getRemainingPrependTokens(ref)).toBe(120);
  });

  it("applyPrependBudget trims and consumes across hooks", () => {
    const ref = createPrependBudgetRef();
    initPrependBudget(ref, 30, "s1");

    const first = applyPrependBudget(ref, "a".repeat(80));
    expect(first).toBeTruthy();
    expect(getRemainingPrependTokens(ref)).toBeLessThan(30);

    const second = applyPrependBudget(ref, "b".repeat(200));
    expect(second).toBeTruthy();
    expect(getRemainingPrependTokens(ref)).toBe(0);

    const third = applyPrependBudget(ref, "c".repeat(40));
    expect(third).toBeUndefined();
  });

  it("trimPrependToRemainingBudget passes through when ref is unset", () => {
    const { text, chargedTokens } = trimPrependToRemainingBudget(undefined, "hello world");
    expect(text).toBe("hello world");
    expect(chargedTokens).toBeGreaterThan(0);
  });
});
