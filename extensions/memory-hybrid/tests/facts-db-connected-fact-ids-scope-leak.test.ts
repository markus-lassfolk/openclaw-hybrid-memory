// @ts-nocheck
/**
 * Regression test (#2067-followup) for backends/facts-db/links.ts's getConnectedFactIds():
 *
 * The BFS had no scope awareness at all -- it only excluded superseded facts from the
 * `JOIN facts f` used to walk each hop. A hidden (out-of-scope) fact could still serve as a
 * stepping-stone: visible A -> hidden B -> visible C traversed straight through B to reach C,
 * and the caller (tools/memory/register-recall-tools.ts's legacy graph-traversal branch of
 * memory_recall) only scope-checked the FINAL result ids via getById(), never the intermediate
 * hop -- so C came back in recall results even though no edge on the path was ever visible,
 * indirectly confirming hidden B exists and links the caller's own fact to it. Fixed by threading
 * an optional scopeFilter through to the same `JOIN facts f` clause (via
 * scopeFilterClauseForAlias), so a hidden fact is excluded from traversal entirely, not just from
 * the final result set -- mirroring the fix already applied to expandGraphWithCTE and the
 * JS-side scopedConnectedFactIds() helpers in routes/graphql-resolvers.ts and tools/graph-tools.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "connected-fact-ids-scope-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getConnectedFactIds scope leak (#2067-followup)", () => {
  it("does not traverse through a hidden intermediate fact to reach a fact beyond it", () => {
    const visibleA = factsDb.store({
      text: "Tenant A: root fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });
    const hiddenB = factsDb.store({
      text: "Tenant B: private intermediate fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantB",
    });
    const visibleC = factsDb.store({
      text: "Global: leaf fact only reachable via the hidden intermediate",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });

    factsDb.createLink(visibleA.id, hiddenB.id, "RELATED_TO", 1);
    factsDb.createLink(hiddenB.id, visibleC.id, "RELATED_TO", 1);

    const scopedIds = factsDb.getConnectedFactIds([visibleA.id], 3, { scopeFilter: { agentId: "tenantA" } }).sort();

    // The hidden fact must never be traversed through -- both B and the only-reachable-via-B
    // fact C must be absent, leaving just the seed.
    expect(scopedIds).toEqual([visibleA.id]);
    expect(scopedIds).not.toContain(hiddenB.id);
    expect(scopedIds).not.toContain(visibleC.id);
  });

  it("still traverses through a globally-visible intermediate fact", () => {
    const visibleA = factsDb.store({
      text: "Tenant A: root fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });
    const globalB = factsDb.store({
      text: "Global: shared intermediate fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });
    const visibleC = factsDb.store({
      text: "Global: leaf fact reachable via the shared intermediate",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });

    factsDb.createLink(visibleA.id, globalB.id, "RELATED_TO", 1);
    factsDb.createLink(globalB.id, visibleC.id, "RELATED_TO", 1);

    const scopedIds = factsDb.getConnectedFactIds([visibleA.id], 3, { scopeFilter: { agentId: "tenantA" } }).sort();

    expect(scopedIds).toEqual([globalB.id, visibleA.id, visibleC.id].sort());
  });

  it("with no scopeFilter, behaves as before (unscoped traversal)", () => {
    const a = factsDb.store({
      text: "A",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantA",
    });
    const b = factsDb.store({
      text: "B",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "agent",
      scopeTarget: "tenantB",
    });

    factsDb.createLink(a.id, b.id, "RELATED_TO", 1);

    const ids = factsDb.getConnectedFactIds([a.id], 3).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});
