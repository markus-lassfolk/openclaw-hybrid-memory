/**
 * Tests for the SerendipityStore backend (Issue #2119): CRUD, transitions,
 * dedup, TTL/backlog, links, and scoped engagement levels.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SerendipityStore, serendipityDedupHash } from "../backends/serendipity-store.js";
import type { CreateSerendipityFindingInput } from "../types/serendipity-types.js";

let tmpDir: string;
let store: SerendipityStore;

function base(overrides: Partial<CreateSerendipityFindingInput> = {}): CreateSerendipityFindingInput {
  return {
    title: "apache-arrow missing from deps",
    description: "package.json omits apache-arrow though lancedb needs it",
    findingType: "packaging_defect",
    riskLevel: "low",
    reversibility: "easy",
    adjacency: "direct",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-store-test-"));
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SerendipityStore — CRUD", () => {
  it("creates and reads a finding with defaults", () => {
    const f = store.create(base());
    expect(f.id).toBeTruthy();
    expect(f.status).toBe("observed");
    expect(f.findingType).toBe("packaging_defect");
    expect(f.confidence).toBe(0.5);
    expect(store.get(f.id)?.title).toBe(f.title);
  });

  it("resolves by short id prefix", () => {
    const f = store.create(base());
    expect(store.resolve(f.id.slice(0, 8))?.id).toBe(f.id);
  });

  it("applies a TTL when defaultTtlDays is provided", () => {
    const f = store.create(base(), { defaultTtlDays: 30 });
    expect(f.expiresAt).toBeTruthy();
    const noTtl = store.create(base({ title: "no ttl" }), { defaultTtlDays: 0 });
    expect(noTtl.expiresAt).toBeNull();
  });
});

describe("SerendipityStore — transitions", () => {
  it("allows a valid transition and rejects an invalid one", () => {
    const f = store.create(base());
    const deferred = store.transition(f.id, "deferred", { actionTaken: "later" });
    expect(deferred.status).toBe("deferred");
    const fixed = store.transition(f.id, "fixed");
    expect(fixed.status).toBe("fixed");
    // fixed is terminal
    expect(() => store.transition(f.id, "observed")).toThrow(/Invalid transition/);
  });
});

describe("SerendipityStore — dedup", () => {
  it("computes a stable dedup hash and finds duplicates within the window", () => {
    const input = base();
    const f = store.create(input);
    const hash = serendipityDedupHash({
      repo: input.repo,
      entity: input.entity,
      findingType: input.findingType,
      title: input.title,
    });
    expect(store.findByDedupHash(hash, 30)?.id).toBe(f.id);
  });

  it("merges evidence and bumps confidence", () => {
    const f = store.create(base({ evidence: ["a"], confidence: 0.5 }));
    const merged = store.mergeEvidence(f.id, ["b", "a"], 0.1);
    expect(merged.evidence.sort()).toEqual(["a", "b"]);
    expect(merged.confidence).toBeCloseTo(0.6, 5);
  });
});

describe("SerendipityStore — TTL / backlog", () => {
  it("excludes expired findings from listActionableDeferred and archives them", () => {
    const f = store.create(base({ suggestedAction: "fix_now" }));
    // Force it past its TTL.
    store.update(f.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(store.listActionableDeferred({ level: 4 })).toHaveLength(0);
    expect(store.archiveExpired()).toBe(1);
    expect(store.get(f.id)).toBeNull();
  });

  it("ranks backlog by urgency + leverage", () => {
    store.create(
      base({ title: "low", suggestedAction: "fix_now", riskLevel: "low", estimatedHumanLoadReduction: "none" }),
    );
    const high = store.create(
      base({ title: "high", suggestedAction: "fix_now", riskLevel: "high", estimatedHumanLoadReduction: "large" }),
    );
    const ranked = store.listActionableDeferred({ level: 4 });
    expect(ranked[0]?.id).toBe(high.id);
  });

  it("gates backlog eligibility by level", () => {
    const safety = store.create(base({ title: "safety", findingType: "unsafe_default", suggestedAction: "fix_now" }));
    const broad = store.create(
      base({ title: "broad", findingType: "low_risk_cleanup", adjacency: "broad", suggestedAction: "fix_now" }),
    );
    // Level 0: only safety types.
    const lvl0 = store.listActionableDeferred({ level: 0 });
    expect(lvl0.map((f) => f.id)).toEqual([safety.id]);
    // Level 2: excludes broad/unrelated.
    const lvl2 = store.listActionableDeferred({ level: 2 }).map((f) => f.id);
    expect(lvl2).toContain(safety.id);
    expect(lvl2).not.toContain(broad.id);
    // Level 4: everything.
    expect(store.listActionableDeferred({ level: 4 })).toHaveLength(2);
  });

  it("only surfaces actionable suggested actions", () => {
    store.create(base({ title: "remember-only", suggestedAction: "remember" }));
    expect(store.listActionableDeferred({ level: 4 })).toHaveLength(0);
  });
});

describe("SerendipityStore — links", () => {
  it("appends related records without duplicates", () => {
    const f = store.create(base());
    store.linkRecord(f.id, "issue", "issue-1");
    store.linkRecord(f.id, "issue", "issue-1");
    store.linkRecord(f.id, "fact", "fact-1");
    const reloaded = store.get(f.id);
    expect(reloaded?.relatedIssues).toEqual(["issue-1"]);
    expect(reloaded?.relatedFacts).toEqual(["fact-1"]);
  });
});

describe("SerendipityStore — scoped levels", () => {
  it("resolves the most specific scope, honoring disabled and the config default", () => {
    expect(store.resolveLevel({ userId: "u1" }, 2.5)).toBe(2.5); // no prefs → default
    store.setLevel("user", "u1", 3);
    store.setLevel("agent", "a1", 1);
    // agent beats user in precedence
    expect(store.resolveLevel({ userId: "u1", agentId: "a1" }, 2.5)).toBe(1);
    // user-only
    expect(store.resolveLevel({ userId: "u1" }, 2.5)).toBe(3);
    // disabled pref → 0
    store.setLevel("session", "s1", 4, false);
    expect(store.resolveLevel({ userId: "u1", sessionId: "s1" }, 2.5)).toBe(0);
    // global fallback
    store.setLevel("global", null, 1.5);
    expect(store.resolveLevel({ repo: "unknown" }, 2.5)).toBe(1.5);
  });

  it("clamps levels to 0–4", () => {
    expect(store.setLevel("user", "hi", 9).level).toBe(4);
    expect(store.setLevel("user", "lo", -3).level).toBe(0);
  });
});
