import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { IssueStore } = _testing;

let tmpDir: string;
let store: InstanceType<typeof IssueStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-store-test-"));
  store = new IssueStore(join(tmpDir, "issues.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("IssueStore.create", () => {
  it("creates an issue with required fields and assigns an id", () => {
    const issue = store.create({
      title: "API returns 500 on login",
      symptoms: ["HTTP 500 on POST /login", "JWT validation fails"],
    });
    expect(issue.id).toBeDefined();
    expect(issue.id.length).toBeGreaterThan(0);
    expect(issue.title).toBe("API returns 500 on login");
    expect(issue.symptoms).toEqual(["HTTP 500 on POST /login", "JWT validation fails"]);
    expect(issue.status).toBe("open");
    expect(issue.severity).toBe("medium");
    expect(issue.relatedFacts).toEqual([]);
    expect(issue.tags).toEqual([]);
    expect(issue.detectedAt).toBeDefined();
    expect(issue.createdAt).toBeDefined();
    expect(issue.updatedAt).toBeDefined();
  });

  it("creates an issue with high severity", () => {
    const issue = store.create({
      title: "Database connection pool exhausted",
      symptoms: ["All DB connections timeout"],
      severity: "high",
    });
    expect(issue.severity).toBe("high");
    expect(issue.status).toBe("open");
  });

  it("creates an issue with critical severity and tags", () => {
    const issue = store.create({
      title: "Production outage",
      symptoms: ["Service unreachable", "Health check fails"],
      severity: "critical",
      tags: ["production", "outage"],
    });
    expect(issue.severity).toBe("critical");
    expect(issue.tags).toEqual(["production", "outage"]);
  });

  it("creates an issue with low severity", () => {
    const issue = store.create({
      title: "Logging format inconsistency",
      symptoms: ["Timestamps off by 1 hour"],
      severity: "low",
    });
    expect(issue.severity).toBe("low");
  });

  it("creates an issue with metadata", () => {
    const issue = store.create({
      title: "Memory leak in worker",
      symptoms: ["RSS grows unbounded"],
      metadata: { service: "worker", region: "us-east-1" },
    });
    expect(issue.metadata).toEqual({ service: "worker", region: "us-east-1" });
  });

  it("creates an issue with empty symptoms array", () => {
    const issue = store.create({
      title: "Unknown issue",
      symptoms: [],
    });
    expect(issue.symptoms).toEqual([]);
    expect(issue.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe("IssueStore.get", () => {
  it("retrieves an issue by id", () => {
    const created = store.create({ title: "Auth fails", symptoms: ["401 error"] });
    const fetched = store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe("Auth fails");
  });

  it("returns null for unknown id", () => {
    const result = store.get("nonexistent-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("IssueStore.update", () => {
  it("updates rootCause and fix fields", () => {
    const issue = store.create({ title: "Slow queries", symptoms: ["p99 > 2s"] });
    const updated = store.update(issue.id, {
      rootCause: "Missing index on orders.user_id",
      fix: "Added index: CREATE INDEX ...",
    });
    expect(updated.rootCause).toBe("Missing index on orders.user_id");
    expect(updated.fix).toBe("Added index: CREATE INDEX ...");
    expect(updated.updatedAt).toBeDefined();
  });

  it("updates symptoms", () => {
    const issue = store.create({ title: "Flaky test", symptoms: ["Fails 30% of time"] });
    const updated = store.update(issue.id, {
      symptoms: ["Fails 30% of time", "Race condition in teardown"],
    });
    expect(updated.symptoms).toHaveLength(2);
    expect(updated.symptoms).toContain("Race condition in teardown");
  });

  it("updates rollback information", () => {
    const issue = store.create({ title: "Deployment broke auth", symptoms: ["403 on all endpoints"] });
    const updated = store.update(issue.id, { rollback: "git revert HEAD && deploy" });
    expect(updated.rollback).toBe("git revert HEAD && deploy");
  });

  it("throws when updating nonexistent issue", () => {
    expect(() => store.update("fake-id", { rootCause: "test" })).toThrow("Issue not found");
  });
});

// ---------------------------------------------------------------------------
// State transitions — valid
// ---------------------------------------------------------------------------

describe("IssueStore.transition — valid transitions", () => {
  it("transitions open → diagnosed", () => {
    const issue = store.create({ title: "CPU spike", symptoms: ["100% CPU"] });
    const t = store.transition(issue.id, "diagnosed", { rootCause: "Infinite loop in scheduler" });
    expect(t.status).toBe("diagnosed");
    expect(t.rootCause).toBe("Infinite loop in scheduler");
  });

  it("transitions diagnosed → fix-attempted", () => {
    const issue = store.create({ title: "OOM crash", symptoms: ["Heap OOM"] });
    store.transition(issue.id, "diagnosed");
    const t = store.transition(issue.id, "fix-attempted", { fix: "Increased heap limit" });
    expect(t.status).toBe("fix-attempted");
    expect(t.fix).toBe("Increased heap limit");
  });

  it("transitions fix-attempted → resolved with auto resolvedAt", () => {
    const issue = store.create({ title: "Broken deploy", symptoms: ["App crashes on start"] });
    store.transition(issue.id, "fix-attempted");
    const t = store.transition(issue.id, "resolved");
    expect(t.status).toBe("resolved");
    expect(t.resolvedAt).toBeDefined();
    expect(typeof t.resolvedAt).toBe("string");
  });

  it("transitions resolved → verified with auto verifiedAt", () => {
    const issue = store.create({ title: "Race condition", symptoms: ["Intermittent failure"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    const t = store.transition(issue.id, "verified");
    expect(t.status).toBe("verified");
    expect(t.verifiedAt).toBeDefined();
  });

  it("full lifecycle: open → diagnosed → fix-attempted → resolved → verified", () => {
    const issue = store.create({ title: "E2E lifecycle test", symptoms: ["symptom A"] });
    expect(issue.status).toBe("open");
    const d = store.transition(issue.id, "diagnosed", { rootCause: "Root cause found" });
    expect(d.status).toBe("diagnosed");
    const fa = store.transition(issue.id, "fix-attempted", { fix: "Applied patch" });
    expect(fa.status).toBe("fix-attempted");
    const r = store.transition(issue.id, "resolved");
    expect(r.status).toBe("resolved");
    expect(r.resolvedAt).toBeDefined();
    const v = store.transition(issue.id, "verified");
    expect(v.status).toBe("verified");
    expect(v.verifiedAt).toBeDefined();
  });

  it("transitions open → wont-fix", () => {
    const issue = store.create({ title: "Edge case", symptoms: ["Rare scenario"] });
    const t = store.transition(issue.id, "wont-fix");
    expect(t.status).toBe("wont-fix");
  });

  it("transitions wont-fix → open (reopen)", () => {
    const issue = store.create({ title: "Deferred bug", symptoms: ["Minor glitch"] });
    store.transition(issue.id, "wont-fix");
    const t = store.transition(issue.id, "open");
    expect(t.status).toBe("open");
  });

  it("transitions fix-attempted → open (regression)", () => {
    const issue = store.create({ title: "Regression test", symptoms: ["Bug came back"] });
    store.transition(issue.id, "fix-attempted");
    const t = store.transition(issue.id, "open");
    expect(t.status).toBe("open");
  });

  it("transitions resolved → open (regression after resolution)", () => {
    const issue = store.create({ title: "Regression from resolved", symptoms: ["symptom"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    const t = store.transition(issue.id, "open");
    expect(t.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// State transitions — invalid
// ---------------------------------------------------------------------------

describe("IssueStore.transition — invalid transitions", () => {
  it("throws on verified → diagnosed (terminal state)", () => {
    const issue = store.create({ title: "Terminal test", symptoms: ["s"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    store.transition(issue.id, "verified");
    expect(() => store.transition(issue.id, "diagnosed")).toThrow("Invalid transition");
  });

  it("throws on verified → open", () => {
    const issue = store.create({ title: "Already verified", symptoms: ["s"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    store.transition(issue.id, "verified");
    expect(() => store.transition(issue.id, "open")).toThrow("Invalid transition");
  });

  it("throws on open → verified (skip steps)", () => {
    const issue = store.create({ title: "Skip test", symptoms: ["s"] });
    expect(() => store.transition(issue.id, "verified")).toThrow("Invalid transition");
  });

  it("throws on open → resolved (skip steps)", () => {
    const issue = store.create({ title: "Skip test 2", symptoms: ["s"] });
    expect(() => store.transition(issue.id, "resolved")).toThrow("Invalid transition");
  });

  it("throws on diagnosed → resolved (skip fix-attempted)", () => {
    const issue = store.create({ title: "Skip fix", symptoms: ["s"] });
    store.transition(issue.id, "diagnosed");
    expect(() => store.transition(issue.id, "resolved")).toThrow("Invalid transition");
  });

  it("throws transition on nonexistent id", () => {
    expect(() => store.transition("fake-id", "diagnosed")).toThrow("Issue not found");
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("IssueStore.list", () => {
  it("lists all issues when no filter", () => {
    store.create({ title: "Issue A", symptoms: ["s1"] });
    store.create({ title: "Issue B", symptoms: ["s2"] });
    store.create({ title: "Issue C", symptoms: ["s3"] });
    const all = store.list();
    expect(all).toHaveLength(3);
  });

  it("filters by status", () => {
    const a = store.create({ title: "A", symptoms: ["s"] });
    store.create({ title: "B", symptoms: ["s"] });
    store.transition(a.id, "diagnosed");
    const diagnosed = store.list({ status: ["diagnosed"] });
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0].title).toBe("A");
  });

  it("filters by multiple statuses", () => {
    const a = store.create({ title: "A", symptoms: ["s"] });
    const b = store.create({ title: "B", symptoms: ["s"] });
    store.transition(a.id, "diagnosed");
    store.transition(b.id, "fix-attempted");
    const results = store.list({ status: ["diagnosed", "fix-attempted"] });
    expect(results).toHaveLength(2);
  });

  it("filters by severity", () => {
    store.create({ title: "Low issue", symptoms: ["s"], severity: "low" });
    store.create({ title: "Critical issue", symptoms: ["s"], severity: "critical" });
    const critical = store.list({ severity: ["critical"] });
    expect(critical).toHaveLength(1);
    expect(critical[0].title).toBe("Critical issue");
  });

  it("filters by tags", () => {
    store.create({ title: "Tagged A", symptoms: ["s"], tags: ["api", "prod"] });
    store.create({ title: "Tagged B", symptoms: ["s"], tags: ["db"] });
    store.create({ title: "No tags", symptoms: ["s"] });
    const apiIssues = store.list({ tags: ["api"] });
    expect(apiIssues).toHaveLength(1);
    expect(apiIssues[0].title).toBe("Tagged A");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.create({ title: `Issue ${i}`, symptoms: ["s"] });
    }
    const limited = store.list({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("returns empty array when no match", () => {
    store.create({ title: "Open issue", symptoms: ["s"] });
    const result = store.list({ status: ["verified"] });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("IssueStore.search", () => {
  it("finds issues by title keyword", () => {
    store.create({ title: "Database connection timeout", symptoms: ["p99 latency"] });
    store.create({ title: "Memory leak", symptoms: ["RSS grows"] });
    const results = store.search("database");
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Database");
  });

  it("finds issues by symptom keyword", () => {
    store.create({ title: "Unknown error", symptoms: ["JWT signature invalid", "401 response"] });
    store.create({ title: "Slow response", symptoms: ["p99 > 5s"] });
    const results = store.search("JWT");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Unknown error");
  });

  it("returns empty array when no match", () => {
    store.create({ title: "Unrelated", symptoms: ["something else"] });
    const results = store.search("xyznotfound");
    expect(results).toHaveLength(0);
  });

  it("search is case-insensitive (LIKE)", () => {
    store.create({ title: "Redis connection refused", symptoms: ["ECONNREFUSED 127.0.0.1:6379"] });
    const results = store.search("redis");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// linkFact
// ---------------------------------------------------------------------------

describe("IssueStore.linkFact", () => {
  it("links a fact to an issue", () => {
    const issue = store.create({ title: "Auth bug", symptoms: ["401 on login"] });
    store.linkFact(issue.id, "fact-uuid-001");
    const updated = store.get(issue.id)!;
    expect(updated.relatedFacts).toContain("fact-uuid-001");
  });

  it("links multiple facts", () => {
    const issue = store.create({ title: "Multi-fact", symptoms: ["s"] });
    store.linkFact(issue.id, "fact-001");
    store.linkFact(issue.id, "fact-002");
    store.linkFact(issue.id, "fact-003");
    const updated = store.get(issue.id)!;
    expect(updated.relatedFacts).toHaveLength(3);
  });

  it("does not duplicate linked fact ids", () => {
    const issue = store.create({ title: "Dedup test", symptoms: ["s"] });
    store.linkFact(issue.id, "fact-001");
    store.linkFact(issue.id, "fact-001"); // duplicate
    const updated = store.get(issue.id)!;
    expect(updated.relatedFacts).toHaveLength(1);
  });

  it("throws when linking to nonexistent issue", () => {
    expect(() => store.linkFact("nonexistent", "fact-001")).toThrow("Issue not found");
  });
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

describe("IssueStore.archive", () => {
  it("archives verified issues older than N days", () => {
    const issue = store.create({ title: "Old verified", symptoms: ["s"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    store.transition(issue.id, "verified");

    // Use -1 days: cutoff = 1 day in the future — archives everything updated before then
    const archived = store.archive(-1);
    expect(archived).toBeGreaterThanOrEqual(1);

    const remaining = store.list({ status: ["verified"] });
    expect(remaining).toHaveLength(0);
  });

  it("archives wont-fix issues older than N days", () => {
    const issue = store.create({ title: "Wont fix old", symptoms: ["s"] });
    store.transition(issue.id, "wont-fix");

    // Use -1 days: cutoff = 1 day in the future — archives everything updated before then
    const archived = store.archive(-1);
    expect(archived).toBeGreaterThanOrEqual(1);
  });

  it("does not archive open issues", () => {
    store.create({ title: "Open issue", symptoms: ["s"] });
    const archived = store.archive(0);
    expect(archived).toBe(0);
    const remaining = store.list({ status: ["open"] });
    expect(remaining).toHaveLength(1);
  });

  it("does not archive recently-updated verified issues when threshold is large", () => {
    const issue = store.create({ title: "Recent verified", symptoms: ["s"] });
    store.transition(issue.id, "fix-attempted");
    store.transition(issue.id, "resolved");
    store.transition(issue.id, "verified");

    // 365-day threshold — should not archive a just-updated issue
    const archived = store.archive(365);
    expect(archived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isOpen / close
// ---------------------------------------------------------------------------

describe("IssueStore lifecycle", () => {
  it("isOpen returns true before close", () => {
    expect(store.isOpen()).toBe(true);
  });

  it("isOpen returns false after close", () => {
    store.close();
    expect(store.isOpen()).toBe(false);
  });

  it("double-close does not throw", () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("list returns empty array after close", () => {
    store.create({ title: "Closed store list", symptoms: ["s"] });

    store.close();

    expect(store.list()).toEqual([]);
  });

  it("search returns empty array after close", () => {
    store.create({ title: "Closed store search", symptoms: ["s"] });

    store.close();

    expect(store.search("Closed")).toEqual([]);
  });

  it("get returns null after close", () => {
    const issue = store.create({ title: "Closed store get", symptoms: ["s"] });

    store.close();

    expect(store.get(issue.id)).toBeNull();
  });

  it("archive returns 0 after close", () => {
    const issue = store.create({ title: "Closed store archive", symptoms: ["s"] });
    store.transition(issue.id, "wont-fix");

    store.close();

    expect(store.archive(-1)).toBe(0);
  });

  it("create throws a clear error after close", () => {
    store.close();

    expect(() => store.create({ title: "Closed store create", symptoms: ["s"] })).toThrow(
      "IssueStore.create called after close()",
    );
  });
});
