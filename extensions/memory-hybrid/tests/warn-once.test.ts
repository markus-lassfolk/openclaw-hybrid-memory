import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWarnOnceForTests, resetWarnOnceForTestsByPrefix, warnOnce } from "../utils/warn-once.js";

describe("warnOnce", () => {
  afterEach(() => {
    resetWarnOnceForTests();
  });

  it("invokes emit on the first call for a key", () => {
    const emit = vi.fn();
    warnOnce("k1", emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does not invoke emit again for the same key", () => {
    const emit = vi.fn();
    warnOnce("k2", emit);
    warnOnce("k2", emit);
    warnOnce("k2", emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("treats distinct keys independently", () => {
    const emitA = vi.fn();
    const emitB = vi.fn();
    warnOnce("k3a", emitA);
    warnOnce("k3b", emitB);
    expect(emitA).toHaveBeenCalledTimes(1);
    expect(emitB).toHaveBeenCalledTimes(1);
  });

  it("resetWarnOnceForTests(key) re-arms a single key without affecting others", () => {
    const emit = vi.fn();
    const other = vi.fn();
    warnOnce("k4", emit);
    warnOnce("k5", other);
    resetWarnOnceForTests("k4");
    warnOnce("k4", emit);
    warnOnce("k5", other);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("resetWarnOnceForTests() with no key clears all keys", () => {
    const emit = vi.fn();
    warnOnce("k6", emit);
    resetWarnOnceForTests();
    warnOnce("k6", emit);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("resetWarnOnceForTestsByPrefix re-arms only keys matching the prefix (QA follow-up)", () => {
    const scoped1 = vi.fn();
    const scoped2 = vi.fn();
    const unrelated = vi.fn();
    warnOnce("scope:a", scoped1);
    warnOnce("scope:b", scoped2);
    warnOnce("other:c", unrelated);

    resetWarnOnceForTestsByPrefix("scope:");
    warnOnce("scope:a", scoped1);
    warnOnce("scope:b", scoped2);
    warnOnce("other:c", unrelated);

    expect(scoped1).toHaveBeenCalledTimes(2);
    expect(scoped2).toHaveBeenCalledTimes(2);
    expect(unrelated).toHaveBeenCalledTimes(1);
  });
});
