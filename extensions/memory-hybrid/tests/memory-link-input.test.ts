/**
 * Regression tests for #2139: memory_link's real parameters are sourceFact/targetFact/linkType,
 * but a caller using from/to/type reached factsDb.getById(undefined) and threw the opaque
 * "Provided value cannot be bound to SQLite parameter 1." resolveMemoryLinkInput now resolves the
 * common aliases and returns a structured, parameter-named error for anything it can't interpret.
 */
import { describe, expect, it } from "vitest";
import { resolveMemoryLinkInput } from "../services/memory-link-input.js";

describe("resolveMemoryLinkInput (#2139)", () => {
  const SRC = "b9cc40ed-1675-47af-93eb-97e9e33b847d";
  const TGT = "047efc02-b019-4236-8843-5cf4724e3db0";

  it("resolves the canonical parameter names", () => {
    const result = resolveMemoryLinkInput({ sourceFact: SRC, targetFact: TGT, linkType: "SUPERSEDES" });
    expect(result).toEqual({ ok: true, sourceFact: SRC, targetFact: TGT, linkType: "SUPERSEDES", strength: 1.0 });
  });

  it("accepts the from/to/type aliases the issue caller used, without a SQLite bind error", () => {
    const result = resolveMemoryLinkInput({
      from: SRC,
      to: TGT,
      type: "SUPERSEDES",
      why: "Current Doris runtime correction supersedes stale gateway fact.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceFact).toBe(SRC);
      expect(result.targetFact).toBe(TGT);
      expect(result.linkType).toBe("SUPERSEDES");
    }
  });

  it("upper-cases a lowercase link type", () => {
    const result = resolveMemoryLinkInput({ sourceFact: SRC, targetFact: TGT, linkType: "supersedes" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkType).toBe("SUPERSEDES");
  });

  it("returns a named error identifying the missing source (instead of binding undefined)", () => {
    const result = resolveMemoryLinkInput({ targetFact: TGT, linkType: "SUPERSEDES" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("sourceFact");
  });

  it("returns a named error identifying the missing target", () => {
    const result = resolveMemoryLinkInput({ sourceFact: SRC, linkType: "SUPERSEDES" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("targetFact");
  });

  it("rejects an unknown link type and lists the valid ones", () => {
    const result = resolveMemoryLinkInput({ from: SRC, to: TGT, type: "NOT_A_TYPE" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("linkType");
      expect(result.error).toContain("SUPERSEDES");
    }
  });

  it("validates strength range", () => {
    const ok = resolveMemoryLinkInput({ from: SRC, to: TGT, type: "RELATED_TO", strength: 0.5 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.strength).toBe(0.5);

    const bad = resolveMemoryLinkInput({ from: SRC, to: TGT, type: "RELATED_TO", strength: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("strength");
  });

  it("does not throw for non-string ids — returns a structured error", () => {
    expect(() => resolveMemoryLinkInput({ from: 42, to: TGT, type: "SUPERSEDES" })).not.toThrow();
    const result = resolveMemoryLinkInput({ from: 42, to: TGT, type: "SUPERSEDES" });
    expect(result.ok).toBe(false);
  });
});
