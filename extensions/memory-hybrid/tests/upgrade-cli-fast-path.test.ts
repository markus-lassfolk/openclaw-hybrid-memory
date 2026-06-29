import { describe, expect, it } from "vitest";

import { isHybridMemUpgradeOnlyInvocation } from "../index-upgrade-cli.js";

describe("isHybridMemUpgradeOnlyInvocation (#2000)", () => {
  it("detects hybrid-mem upgrade invocations", () => {
    expect(isHybridMemUpgradeOnlyInvocation(["node", "openclaw", "hybrid-mem", "upgrade"])).toBe(true);
    expect(isHybridMemUpgradeOnlyInvocation(["node", "openclaw", "hybrid-mem", "upgrade", "2026.6.291"])).toBe(true);
  });

  it("does not match other hybrid-mem commands", () => {
    expect(isHybridMemUpgradeOnlyInvocation(["node", "openclaw", "hybrid-mem", "verify"])).toBe(false);
    expect(isHybridMemUpgradeOnlyInvocation(["node", "openclaw", "hybrid-mem", "--help"])).toBe(false);
    expect(isHybridMemUpgradeOnlyInvocation(["node", "openclaw", "hybrid-mem", "upgrade", "--", "other"])).toBe(true);
  });
});
