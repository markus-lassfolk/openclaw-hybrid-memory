import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomStore } from "../backends/loom-store.js";
import { buildLoomBrief, renderLoomBriefMarkdown } from "../services/loom-brief.js";

let tmpDir: string;
let loomStore: LoomStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loom-brief-test-"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildLoomBrief", () => {
  it("empty scope on an empty store returns a bounded, non-throwing brief", () => {
    const brief = buildLoomBrief({ loomStore }, { scope: "" });
    expect(brief.scopeInterpretation).toContain("workspace-wide");
    expect(brief.nextActions.length).toBeGreaterThan(0);
    expect(brief.truncated).toBe(false);
  });

  it("broad scope (no matching tokens) still returns workspace-wide results", () => {
    loomStore.assertClaim({ entity: "Doris", predicate: "m365_identity", value: "doris@lassfolk.net" });
    const brief = buildLoomBrief({ loomStore }, { scope: "   " });
    expect(brief.scopeInterpretation).toContain("workspace-wide");
  });

  it("includes a stale belief under staleOrUnverifiedBeliefs", () => {
    const claim = loomStore.assertClaim({ entity: "Doris", predicate: "m365_identity", value: "doris@lassfolk.net" });
    loomStore.verifyClaim(claim.id, { at: "2020-01-01T00:00:00.000Z" });
    loomStore.sweepStaleClaims(1, "2020-06-01T00:00:00.000Z");
    const brief = buildLoomBrief({ loomStore }, { scope: "Doris" });
    expect(brief.staleOrUnverifiedBeliefs.some((b) => b.claimId === claim.id)).toBe(true);
  });

  it("includes a contradiction under contradictions with a next action to resolve it", () => {
    const a = loomStore.assertClaim({ entity: "Doris", predicate: "state", value: "up" });
    const b = loomStore.assertClaim({ entity: "Doris", predicate: "state", value: "down" });
    loomStore.contradictClaim(a.id, b.id);
    const brief = buildLoomBrief({ loomStore }, { scope: "Doris" });
    expect(brief.contradictions.length).toBe(2);
    expect(brief.nextActions.some((a2) => a2.includes("contradicted"))).toBe(true);
  });

  it("includes a drift warning and a matching next action", () => {
    loomStore.createDriftFinding({ driftType: "deprecated_command", oldText: "old-doris-cmd", severity: "high" });
    const brief = buildLoomBrief({ loomStore }, { scope: "" });
    expect(brief.driftWarnings.length).toBe(1);
    expect(brief.driftWarnings[0]?.text).toContain("old-doris-cmd");
    expect(brief.nextActions.some((a) => a.includes("drift warning"))).toBe(true);
  });

  it("includes an open loop and surfaces a required live check with suggested commands", () => {
    loomStore.createOpenLoop({ title: "Verify Doris M365 auth", loopType: "needs_verification", scope: "Doris" });
    loomStore.assertClaim({
      entity: "Doris",
      predicate: "m365_identity",
      value: "doris@lassfolk.net",
      liveCheckRequired: true,
      suggestedChecks: [{ kind: "command", text: "m365-agent-cli whoami" }],
    });
    const brief = buildLoomBrief({ loomStore }, { scope: "Doris" });
    expect(brief.openLoops.length).toBe(1);
    expect(brief.mustLiveCheck[0]?.suggestedChecks).toContain("m365-agent-cli whoami");
    expect(brief.nextActions.some((a) => a.includes("Verify live state"))).toBe(true);
  });

  it("labels every belief/evidence/live-check/recommendation item distinctly", () => {
    const claim = loomStore.assertClaim({ entity: "Z", predicate: "k", value: "v" });
    loomStore.verifyClaim(claim.id);
    const brief = buildLoomBrief({ loomStore }, { scope: "Z" });
    expect(brief.verifiedBeliefs[0]?.label).toBe("evidence");
  });

  it("truncates when maxChars is very small, and renders valid markdown either way", () => {
    for (let i = 0; i < 20; i++) {
      loomStore.assertClaim({ entity: "Doris", predicate: `k${i}`, value: `v${i}` });
      loomStore.createOpenLoop({ title: `loop ${i}`, loopType: "watch_condition", scope: "Doris" });
    }
    const brief = buildLoomBrief({ loomStore }, { scope: "Doris", maxChars: 300 });
    expect(brief.truncated).toBe(true);
    const md = renderLoomBriefMarkdown(brief);
    expect(md).toContain("Loom brief");
  });
});
