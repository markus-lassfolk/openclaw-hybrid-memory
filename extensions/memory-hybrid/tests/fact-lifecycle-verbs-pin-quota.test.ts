/**
 * Regression test (#2067-followup sweep) for services/fact-lifecycle-verbs.ts's countPinnedFacts:
 *
 * The scope filter used an exclusive if/else-if chain (session, else user, else agent, else
 * global -- pick exactly one tier), matching the semantics used for *writing* a new fact into a
 * single scope tier. But countPinnedFacts is a *read/visibility* count used for pin-quota
 * enforcement, and buildToolScopeFilter() routinely sets both userId and agentId at once for a
 * non-orchestrator agent -- the old code only ever counted the first matching tier (user), so an
 * agent could pin far more than DEFAULT_PIN_QUOTA total facts by spreading pins across scope
 * tiers (agent/global/user), each counted in isolation. Fixed to reuse the same OR-based,
 * all-dimensions-inclusive visibility clause every other read path (getById/search) uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { checkPinQuota, countPinnedFacts, pinFact } from "../services/fact-lifecycle-verbs.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-pin-quota-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeAndPin(overrides: Partial<Parameters<FactsDB["store"]>[0]>) {
  const fact = db.store({
    text: "pinned fact",
    entity: null,
    key: null,
    value: null,
    category: "other",
    importance: 0.5,
    source: "test",
    ...overrides,
  });
  pinFact(db, fact.id, "test pin");
  return fact;
}

describe("countPinnedFacts scope visibility (#2067-followup)", () => {
  it("counts pinned facts across every scope tier visible to a filter with both userId and agentId set, not just the first matching tier", () => {
    storeAndPin({ scope: "user", scopeTarget: "alice" });
    storeAndPin({ scope: "agent", scopeTarget: "worker-1" });
    storeAndPin({ scope: "global" });
    // Not visible to this caller: a different user's pinned fact.
    storeAndPin({ scope: "user", scopeTarget: "bob" });

    // A non-orchestrator agent's scope filter commonly carries both userId and agentId.
    const count = countPinnedFacts(db, { userId: "alice", agentId: "worker-1" });

    expect(count).toBe(3);
  });

  it("checkPinQuota reflects the same all-tiers count, so quota cannot be bypassed by spreading pins across tiers", () => {
    for (let i = 0; i < 4; i++) storeAndPin({ scope: "user", scopeTarget: "alice", text: `user pin ${i}` });
    for (let i = 0; i < 4; i++) storeAndPin({ scope: "agent", scopeTarget: "worker-1", text: `agent pin ${i}` });
    for (let i = 0; i < 4; i++) storeAndPin({ scope: "global", text: `global pin ${i}` });

    const result = checkPinQuota(db, 10, { userId: "alice", agentId: "worker-1" });

    expect(result.current).toBe(12);
    expect(result.allowed).toBe(false);
  });

  it("session-scoped pins are counted alongside user/agent/global when sessionId is also present", () => {
    storeAndPin({ scope: "session", scopeTarget: "sess-1" });
    storeAndPin({ scope: "user", scopeTarget: "alice" });

    const count = countPinnedFacts(db, { userId: "alice", sessionId: "sess-1" });

    expect(count).toBe(2);
  });

  it("omitting scopeFilter entirely counts every pinned fact regardless of scope, unchanged from before", () => {
    storeAndPin({ scope: "global" });
    storeAndPin({ scope: "user", scopeTarget: "alice" });

    expect(countPinnedFacts(db)).toBe(2);
  });
});
