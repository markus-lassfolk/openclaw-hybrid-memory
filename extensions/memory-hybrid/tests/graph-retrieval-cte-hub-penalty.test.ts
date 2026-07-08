// @ts-nocheck
/**
 * Regression test (loop iteration 69): expandGraph's CTE-backed path (factsDb.expandGraphWithCTE,
 * the real production path used whenever FactsDB is available) never applied hubScorePenalty
 * (#1192) — it only ever hard-skipped links through a high-degree hub node, exactly the same as
 * the legacy default, even when a caller explicitly configured attenuation instead. The iterative
 * BFS fallback (used only when expandGraphWithCTE is absent, e.g. custom/mock lookups) already
 * supported penalty mode correctly. Both shipped "enhanced"/"complete" retrieval presets document
 * attenuation as the behavior, but in production (real FactsDB, so the CTE path is always taken)
 * they silently got hard-skip instead.
 */

import { describe, expect, it } from "vitest";
import { expandGraph } from "../services/graph-retrieval.js";
import type { MemoryEntry } from "../types/memory.js";

function makeEntry(id: string): MemoryEntry {
  return {
    id,
    text: `Text for ${id}`,
    category: "fact",
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1_700_000_000,
    sourceDate: null,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1_700_000_000,
    confidence: 1.0,
    summary: null,
    tags: null,
    recallCount: 0,
    lastAccessed: null,
    supersededAt: null,
    supersededBy: null,
    supersedesId: null,
    validFrom: null,
    validUntil: null,
    tier: "warm",
    scope: "global",
    scopeTarget: null,
    procedureType: null,
    successCount: 0,
    lastValidated: null,
    sourceSessions: null,
    reinforcedCount: 0,
    lastReinforcedAt: null,
    reinforcedQuotes: null,
  };
}

/**
 * Seed S --RELATED_TO--> H (a hub with 3 outgoing links, exceeding a hubDegreeCap of 2)
 * H --RELATED_TO--> A (the 2-hop node reached through the hub)
 * H --RELATED_TO--> B, H --RELATED_TO--> C (the hub's other links, making H's out-degree 3)
 *
 * expandGraphWithCTE is a stub that always returns S/H/A rows regardless of hubDegreeCap — mirrors
 * the real production behavior after the fix: the SQL-level cap is disabled in penalty mode, and
 * ctePathMatchesHubGuards (JS-side) is the sole enforcement point, exactly like iterative BFS.
 */
function buildHubMockDb() {
  const entries = new Map<string, MemoryEntry>([
    ["S", makeEntry("S")],
    ["H", makeEntry("H")],
    ["A", makeEntry("A")],
    // B and C must exist too — filterLinksByEndpointScope drops any link whose target fact
    // can't be found, which would otherwise undercount H's out-degree below the hub threshold.
    ["B", makeEntry("B")],
    ["C", makeEntry("C")],
  ]);

  // h-a (→A, the hop under test) is deliberately the WEAKEST of H's 3 links: hard-skip mode
  // keeps only the top-`hubDegreeCap` links by strength, so h-a is the one trimmed away — proving
  // the "dropped under hard-skip" test actually exercises the hub guard, not just an unrelated gap.
  const linksFromH = [
    { id: "h-a", targetFactId: "A", linkType: "RELATED_TO", strength: 0.3 },
    { id: "h-b", targetFactId: "B", linkType: "RELATED_TO", strength: 0.9 },
    { id: "h-c", targetFactId: "C", linkType: "RELATED_TO", strength: 0.8 },
  ];
  const linksFromS = [{ id: "s-h", targetFactId: "H", linkType: "RELATED_TO", strength: 0.9 }];

  return {
    getById: (id: string) => entries.get(id) ?? null,
    getByIds: (ids: string[]) => {
      const m = new Map<string, MemoryEntry>();
      for (const id of ids) {
        const e = entries.get(id);
        if (e) m.set(id, e);
      }
      return m;
    },
    getLinksFrom: (id: string) => (id === "S" ? linksFromS : id === "H" ? linksFromH : []),
    getLinksTo: () => [],
    expandGraphWithCTE: () => [
      { factId: "S", seedId: "S", hopCount: 0, path: "[]" },
      {
        factId: "H",
        seedId: "S",
        hopCount: 1,
        path: JSON.stringify([{ fromFactId: "S", toFactId: "H", linkType: "RELATED_TO", strength: 0.9 }]),
      },
      {
        factId: "A",
        seedId: "S",
        hopCount: 2,
        path: JSON.stringify([
          { fromFactId: "S", toFactId: "H", linkType: "RELATED_TO", strength: 0.9 },
          { fromFactId: "H", toFactId: "A", linkType: "RELATED_TO", strength: 0.3 },
        ]),
      },
    ],
  };
}

describe("expandGraph CTE-path hub penalty (loop iteration 69 regression)", () => {
  const seedResults = [{ factId: "S", score: 1.0, entry: makeEntry("S") }];

  it("attenuates (does not drop) a hub hop's score when hubScorePenalty is set", () => {
    const db = buildHubMockDb();
    const { results } = expandGraph(db, seedResults, {
      maxDepth: 2,
      hubDegreeCap: 2,
      hubScorePenalty: 0.5,
    });

    const nodeA = results.find((r) => r.factId === "A");
    expect(nodeA).toBeDefined();
    // hop2 decay (0.5) * hub attenuation (1 - 0.5 = 0.5) = 0.25
    expect(nodeA?.score).toBeCloseTo(0.25, 5);
  });

  it("drops the hub hop entirely when hubScorePenalty is not set (legacy hard-skip)", () => {
    const db = buildHubMockDb();
    const { results } = expandGraph(db, seedResults, {
      maxDepth: 2,
      hubDegreeCap: 2,
      hubScorePenalty: null,
    });

    const nodeA = results.find((r) => r.factId === "A");
    expect(nodeA).toBeUndefined();
  });

  it("does not attenuate when hubDegreeCap is disabled (no hub in play)", () => {
    const db = buildHubMockDb();
    const { results } = expandGraph(db, seedResults, {
      maxDepth: 2,
      hubDegreeCap: null,
      hubScorePenalty: 0.5,
    });

    const nodeA = results.find((r) => r.factId === "A");
    expect(nodeA).toBeDefined();
    expect(nodeA?.score).toBeCloseTo(0.5, 5);
  });
});
