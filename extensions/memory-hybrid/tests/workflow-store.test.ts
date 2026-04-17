/**
 * Tests for WorkflowStore, helper utilities, and WorkflowTracker (Issue #209).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const {
	WorkflowStore,
	WorkflowTracker,
	sequenceDistance,
	sequenceSimilarity,
	extractGoalKeywords,
	hashToolSequence,
} = _testing;

let tmpDir: string;
let store: InstanceType<typeof WorkflowStore>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "workflow-store-test-"));
	store = new WorkflowStore(join(tmpDir, "workflow-traces.db"));
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sequenceDistance
// ---------------------------------------------------------------------------

describe("sequenceDistance", () => {
	it("returns 0 for identical sequences", () => {
		expect(sequenceDistance(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
	});

	it("returns max length for completely different sequences", () => {
		expect(sequenceDistance(["a", "b"], ["c", "d"])).toBe(2);
	});

	it("handles empty sequences", () => {
		expect(sequenceDistance([], [])).toBe(0);
		expect(sequenceDistance(["a"], [])).toBe(1);
		expect(sequenceDistance([], ["a"])).toBe(1);
	});

	it("handles one substitution", () => {
		expect(sequenceDistance(["a", "b", "c"], ["a", "X", "c"])).toBe(1);
	});

	it("handles insertion", () => {
		expect(sequenceDistance(["a", "c"], ["a", "b", "c"])).toBe(1);
	});

	it("handles deletion", () => {
		expect(sequenceDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// sequenceSimilarity
// ---------------------------------------------------------------------------

describe("sequenceSimilarity", () => {
	it("returns 1 for identical sequences", () => {
		expect(sequenceSimilarity(["a", "b"], ["a", "b"])).toBe(1);
	});

	it("returns 1 for two empty sequences", () => {
		expect(sequenceSimilarity([], [])).toBe(1);
	});

	it("returns 0 for completely different sequences of same length", () => {
		expect(sequenceSimilarity(["a", "b"], ["c", "d"])).toBe(0);
	});

	it("returns a value between 0 and 1 for partial match", () => {
		const sim = sequenceSimilarity(["a", "b", "c"], ["a", "b", "X"]);
		expect(sim).toBeGreaterThan(0);
		expect(sim).toBeLessThan(1);
	});
});

// ---------------------------------------------------------------------------
// extractGoalKeywords
// ---------------------------------------------------------------------------

describe("extractGoalKeywords", () => {
	it("removes stop words and short tokens", () => {
		const kw = extractGoalKeywords("Search the web for the latest news");
		expect(kw).not.toContain("the");
		expect(kw).not.toContain("for");
		expect(kw).not.toContain("a");
	});

	it("lowercases all keywords", () => {
		const kw = extractGoalKeywords("Deploy Application Server");
		kw.forEach((k) => expect(k).toBe(k.toLowerCase()));
	});

	it("returns at most 10 keywords", () => {
		const long =
			"one two three four five six seven eight nine ten eleven twelve";
		expect(extractGoalKeywords(long).length).toBeLessThanOrEqual(10);
	});

	it("handles an empty string", () => {
		expect(extractGoalKeywords("")).toEqual([]);
	});

	it("strips punctuation", () => {
		const kw = extractGoalKeywords("deploy: server, restart!");
		kw.forEach((k) => expect(k).not.toMatch(/[^a-z0-9\-_]/));
	});
});

// ---------------------------------------------------------------------------
// hashToolSequence
// ---------------------------------------------------------------------------

describe("hashToolSequence", () => {
	it("returns a 16-char hex string", () => {
		const h = hashToolSequence(["exec", "read", "write"]);
		expect(h).toHaveLength(16);
		expect(h).toMatch(/^[0-9a-f]+$/);
	});

	it("is deterministic", () => {
		const seq = ["exec", "read", "write"];
		expect(hashToolSequence(seq)).toBe(hashToolSequence(seq));
	});

	it("differs for different sequences", () => {
		expect(hashToolSequence(["a", "b"])).not.toBe(hashToolSequence(["b", "a"]));
	});

	it("handles empty sequence", () => {
		expect(hashToolSequence([])).toHaveLength(16);
	});
});

// ---------------------------------------------------------------------------
// WorkflowStore — CRUD
// ---------------------------------------------------------------------------

describe("WorkflowStore.record", () => {
	it("records a trace and returns it with an id", () => {
		const trace = store.record({
			goal: "Search for files and summarise",
			toolSequence: ["exec", "read", "memory_store"],
			outcome: "success",
			durationMs: 1200,
			sessionId: "sess-001",
		});

		expect(trace.id).toBeDefined();
		expect(trace.goal).toBe("Search for files and summarise");
		expect(trace.toolSequence).toEqual(["exec", "read", "memory_store"]);
		expect(trace.outcome).toBe("success");
		expect(trace.durationMs).toBe(1200);
		expect(trace.sessionId).toBe("sess-001");
		expect(trace.toolCount).toBe(3);
		expect(trace.argsHash).toBeDefined();
		expect(trace.goalKeywords.length).toBeGreaterThan(0);
		expect(trace.createdAt).toBeDefined();
	});

	it("accepts explicit goalKeywords", () => {
		const trace = store.record({
			goal: "deploy app",
			goalKeywords: ["deploy", "app"],
			toolSequence: ["exec"],
			outcome: "failure",
		});
		expect(trace.goalKeywords).toEqual(["deploy", "app"]);
	});

	it("defaults outcome to unknown", () => {
		const trace = store.record({ goal: "run script", toolSequence: ["exec"] });
		expect(trace.outcome).toBe("unknown");
	});

	it("defaults durationMs to 0", () => {
		const trace = store.record({ goal: "quick task", toolSequence: ["read"] });
		expect(trace.durationMs).toBe(0);
	});
});

describe("WorkflowStore.getById", () => {
	it("returns null for unknown id", () => {
		expect(store.getById("nonexistent-id")).toBeNull();
	});

	it("returns the recorded trace", () => {
		const t = store.record({
			goal: "test goal",
			toolSequence: ["exec", "read"],
		});
		const fetched = store.getById(t.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.id).toBe(t.id);
		expect(fetched?.goal).toBe("test goal");
	});
});

describe("WorkflowStore.list", () => {
	beforeEach(() => {
		store.record({
			goal: "deploy server",
			toolSequence: ["exec", "exec"],
			outcome: "success",
			sessionId: "s1",
		});
		store.record({
			goal: "read config file",
			toolSequence: ["read"],
			outcome: "failure",
			sessionId: "s2",
		});
		store.record({
			goal: "write summary",
			toolSequence: ["write", "memory_store"],
			outcome: "unknown",
			sessionId: "s1",
		});
	});

	it("lists all traces", () => {
		expect(store.list().length).toBe(3);
	});

	it("filters by outcome", () => {
		const ok = store.list({ outcome: "success" });
		expect(ok.length).toBe(1);
		expect(ok[0].outcome).toBe("success");
	});

	it("filters by sessionId", () => {
		const s1 = store.list({ sessionId: "s1" });
		expect(s1.length).toBe(2);
	});

	it("filters by minToolCount", () => {
		const multi = store.list({ minToolCount: 2 });
		expect(multi.every((t) => t.toolCount >= 2)).toBe(true);
	});

	it("filters by maxToolCount", () => {
		const single = store.list({ maxToolCount: 1 });
		expect(single.every((t) => t.toolCount <= 1)).toBe(true);
	});

	it("respects limit", () => {
		expect(store.list({ limit: 2 }).length).toBe(2);
	});

	it("filters by goal keywords", () => {
		const results = store.list({ goal: "deploy" });
		expect(results.some((t) => t.goal.includes("deploy"))).toBe(true);
	});
});

describe("WorkflowStore.getByGoal", () => {
	beforeEach(() => {
		store.record({
			goal: "deploy the application to production",
			toolSequence: ["exec"],
			goalKeywords: ["deploy", "application", "production"],
		});
		store.record({
			goal: "read config file contents",
			toolSequence: ["read"],
			goalKeywords: ["read", "config", "file"],
		});
	});

	it("finds traces matching keywords", () => {
		const results = store.getByGoal(["deploy", "production"]);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].goalKeywords).toContain("deploy");
	});

	it("returns empty array for unmatched keywords", () => {
		expect(store.getByGoal(["unknownxyz123"])).toEqual([]);
	});

	it("returns empty array for empty keywords", () => {
		expect(store.getByGoal([])).toEqual([]);
	});
});

describe("WorkflowStore.getSuccessRate", () => {
	beforeEach(() => {
		// 2 success, 1 failure for ["exec", "read"] sequence
		store.record({
			goal: "g1",
			toolSequence: ["exec", "read"],
			outcome: "success",
		});
		store.record({
			goal: "g2",
			toolSequence: ["exec", "read"],
			outcome: "success",
		});
		store.record({
			goal: "g3",
			toolSequence: ["exec", "read"],
			outcome: "failure",
		});
	});

	it("returns ~0.67 success rate for 2/3 successes", () => {
		const rate = store.getSuccessRate(["exec", "read"]);
		expect(rate).toBeCloseTo(2 / 3, 1);
	});

	it("returns 0 for unknown sequence", () => {
		expect(store.getSuccessRate(["magic_tool_xyz"])).toBe(0);
	});
});

describe("WorkflowStore.getPatterns", () => {
	beforeEach(() => {
		store.record({
			goal: "deploy app",
			toolSequence: ["exec", "exec", "read"],
			outcome: "success",
			durationMs: 1000,
		});
		store.record({
			goal: "also deploy app",
			toolSequence: ["exec", "exec", "read"],
			outcome: "success",
			durationMs: 2000,
		});
		store.record({
			goal: "read file",
			toolSequence: ["read"],
			outcome: "failure",
			durationMs: 100,
		});
	});

	it("groups similar sequences into patterns", () => {
		const patterns = store.getPatterns();
		// Should have 2 clusters: ["exec","exec","read"] and ["read"]
		expect(patterns.length).toBeGreaterThanOrEqual(1);
	});

	it("computes correct success rate", () => {
		const patterns = store.getPatterns();
		const execPattern = patterns.find((p) => p.toolSequence.includes("exec"));
		expect(execPattern).toBeDefined();
		expect(execPattern?.successRate).toBe(1);
	});

	it("computes avgDurationMs", () => {
		const patterns = store.getPatterns();
		const execPattern = patterns.find((p) => p.toolSequence.includes("exec"));
		expect(execPattern?.avgDurationMs).toBe(1500);
	});

	it("filters by minSuccessRate", () => {
		const patterns = store.getPatterns({ minSuccessRate: 0.9 });
		patterns.forEach((p) => expect(p.successRate).toBeGreaterThanOrEqual(0.9));
	});

	it("respects limit", () => {
		const patterns = store.getPatterns({ limit: 1 });
		expect(patterns.length).toBeLessThanOrEqual(1);
	});

	it("reopens and returns results when native DB handle was unexpectedly closed", () => {
		const db = (store as any).db as import("node:sqlite").DatabaseSync;
		db.close();

		expect(() => store.getPatterns()).not.toThrow();
		const patterns = store.getPatterns();
		expect(Array.isArray(patterns)).toBe(true);
	});
});

describe("WorkflowStore.prune", () => {
	it("prunes traces older than N days", () => {
		// Insert a trace, then manually backdate it via raw SQL
		const trace = store.record({ goal: "old task", toolSequence: ["exec"] });

		// Backdate to 100 days ago via direct DB manipulation using private access
		const db = (store as any).db as import("node:sqlite").DatabaseSync;
		const oldDate = new Date(
			Date.now() - 100 * 24 * 60 * 60 * 1000,
		).toISOString();
		db.prepare("UPDATE workflow_traces SET created_at = ? WHERE id = ?").run(
			oldDate,
			trace.id,
		);

		const pruned = store.prune(30);
		expect(pruned).toBe(1);
		expect(store.count()).toBe(0);
	});

	it("does not prune recent traces", () => {
		store.record({ goal: "fresh task", toolSequence: ["read"] });
		const pruned = store.prune(30);
		expect(pruned).toBe(0);
		expect(store.count()).toBe(1);
	});
});

describe("WorkflowStore.count", () => {
	it("returns 0 when empty", () => {
		expect(store.count()).toBe(0);
	});

	it("increments on each record", () => {
		store.record({ goal: "g1", toolSequence: ["a"] });
		store.record({ goal: "g2", toolSequence: ["b"] });
		expect(store.count()).toBe(2);
	});
});

describe("WorkflowStore.close / isOpen", () => {
	it("isOpen returns true before close", () => {
		expect(store.isOpen()).toBe(true);
	});

	it("isOpen returns false after close", () => {
		store.close();
		expect(store.isOpen()).toBe(false);
		// Recreate for afterEach cleanup
		store = new WorkflowStore(join(tmpDir, "workflow-traces-2.db"));
	});

	it("double-close does not throw", () => {
		store.close();
		expect(() => store.close()).not.toThrow();
		store = new WorkflowStore(join(tmpDir, "workflow-traces-3.db"));
	});
});

// ---------------------------------------------------------------------------
// WorkflowTracker
// ---------------------------------------------------------------------------

describe("WorkflowTracker", () => {
	const cfg = { enabled: true, maxTracesPerDay: 100, retentionDays: 90 };
	let tracker: InstanceType<typeof WorkflowTracker>;

	beforeEach(() => {
		// Each test gets a fresh tracker instance — no shared module-global state
		tracker = new WorkflowTracker(store, cfg);
	});

	it("buffers tool calls per session", () => {
		tracker.push("sess-a", "exec");
		tracker.push("sess-a", "read");
		expect(tracker.getBuffer("sess-a")).toEqual(["exec", "read"]);
	});

	it("isolates buffers per session", () => {
		tracker.push("sess-a", "exec");
		tracker.push("sess-b", "write");
		expect(tracker.getBuffer("sess-a")).toEqual(["exec"]);
		expect(tracker.getBuffer("sess-b")).toEqual(["write"]);
	});

	it("flush persists trace and clears buffer", () => {
		tracker.push("sess-flush", "exec");
		tracker.push("sess-flush", "read");
		const id = tracker.flush("sess-flush", "deploy app", "success");

		expect(id).toBeDefined();
		expect(id).not.toBeNull();
		expect(tracker.getBuffer("sess-flush")).toEqual([]);

		const saved = store.getById(id!);
		expect(saved).not.toBeNull();
		expect(saved?.outcome).toBe("success");
		expect(saved?.toolSequence).toEqual(["exec", "read"]);
	});

	it("flush returns null for empty buffer (no prior push)", () => {
		const id = tracker.flush("empty-sess", "some goal");
		expect(id).toBeNull();
		expect(store.count()).toBe(0);
	});

	it("flush with outcome=failure records a failed trace", () => {
		tracker.push("fail-sess", "exec");
		const id = tracker.flush("fail-sess", "broken task", "failure");
		expect(id).not.toBeNull();
		const saved = store.getById(id!);
		expect(saved).not.toBeNull();
		expect(saved?.outcome).toBe("failure");
	});

	it("discard removes buffer without saving", () => {
		tracker.push("disc-sess", "exec");
		tracker.discard("disc-sess");
		expect(tracker.getBuffer("disc-sess")).toEqual([]);
		expect(store.count()).toBe(0);
	});

	it("discard then flush returns null", () => {
		tracker.push("disc-then-flush", "exec");
		tracker.discard("disc-then-flush");
		const id = tracker.flush("disc-then-flush", "some goal");
		expect(id).toBeNull();
		expect(store.count()).toBe(0);
	});

	it("no-ops when disabled", () => {
		const disabledTracker = new WorkflowTracker(store, {
			...cfg,
			enabled: false,
		});
		disabledTracker.push("sess", "exec");
		expect(disabledTracker.getBuffer("sess")).toEqual([]);
		const id = disabledTracker.flush("sess", "goal");
		expect(id).toBeNull();
	});

	it("rate limit boundary: exactly maxPerDay calls allowed, maxPerDay+1 rejected", () => {
		const strictCfg = { enabled: true, maxTracesPerDay: 2, retentionDays: 90 };
		const t = new WorkflowTracker(store, strictCfg);

		t.push("s1", "exec");
		const id1 = t.flush("s1", "g1", "success");
		expect(id1).not.toBeNull(); // 1st — allowed

		t.push("s2", "read");
		const id2 = t.flush("s2", "g2", "success");
		expect(id2).not.toBeNull(); // 2nd — allowed (boundary)

		t.push("s3", "write");
		const id3 = t.flush("s3", "g3", "success");
		expect(id3).toBeNull(); // 3rd — rejected

		expect(store.count()).toBe(2);
	});

	it("day rollover resets the rate limit counter (separate instances)", () => {
		const strictCfg = { enabled: true, maxTracesPerDay: 1, retentionDays: 90 };

		// Day 1 instance
		const day1 = new Date("2025-01-01T12:00:00Z");
		const t1 = new WorkflowTracker(store, strictCfg, () => day1);

		t1.push("s1", "exec");
		const id1 = t1.flush("s1", "g1", "success");
		expect(id1).not.toBeNull(); // day 1, 1st — allowed

		t1.push("s2", "exec");
		const id2 = t1.flush("s2", "g2", "success");
		expect(id2).toBeNull(); // day 1, 2nd — rejected

		// Day 2 — fresh instance (simulates new process / test isolation)
		const day2 = new Date("2025-01-02T12:00:00Z");
		const t2 = new WorkflowTracker(store, strictCfg, () => day2);

		t2.push("s3", "exec");
		const id3 = t2.flush("s3", "g3", "success");
		expect(id3).not.toBeNull(); // day 2, fresh counter — allowed

		expect(store.count()).toBe(2);
	});

	it("day rollover within same instance resets counter", () => {
		const strictCfg = { enabled: true, maxTracesPerDay: 1, retentionDays: 90 };

		let currentTime = new Date("2025-06-15T23:59:00Z");
		const clock = () => currentTime;
		const t = new WorkflowTracker(store, strictCfg, clock);

		t.push("s1", "exec");
		const id1 = t.flush("s1", "g1", "success");
		expect(id1).not.toBeNull(); // day 1, allowed

		// Advance clock past midnight
		currentTime = new Date("2025-06-16T00:01:00Z");

		t.push("s2", "exec");
		const id2 = t.flush("s2", "g2", "success");
		expect(id2).not.toBeNull(); // day 2, counter reset — allowed

		expect(store.count()).toBe(2);
	});

	it("prune delegates to store.prune", () => {
		tracker.push("s", "exec");
		tracker.flush("s", "old goal", "success");

		// Backdate via DB
		const db = (store as any).db as import("node:sqlite").DatabaseSync;
		const oldDate = new Date(
			Date.now() - 100 * 24 * 60 * 60 * 1000,
		).toISOString();
		db.prepare("UPDATE workflow_traces SET created_at = ?").run(oldDate);

		const pruned = tracker.prune();
		expect(pruned).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("parseWorkflowTrackingConfig", () => {
	const BASE_CFG = {
		embedding: {
			provider: "openai",
			apiKey: "sk-test-key-12345678",
			model: "text-embedding-3-small",
		},
	};

	it("parses workflowTracking config from HybridMemoryConfig raw object", async () => {
		const { hybridConfigSchema } = await import("../config.js");
		const cfg = hybridConfigSchema.parse({
			...BASE_CFG,
			workflowTracking: {
				enabled: true,
				maxTracesPerDay: 200,
				retentionDays: 30,
				goalExtractionModel: "google/gemini-2.0-flash",
			},
		});
		expect(cfg.workflowTracking.enabled).toBe(true);
		expect(cfg.workflowTracking.maxTracesPerDay).toBe(200);
		expect(cfg.workflowTracking.retentionDays).toBe(30);
		expect(cfg.workflowTracking.goalExtractionModel).toBe(
			"google/gemini-2.0-flash",
		);
	});

	it("defaults to disabled with sensible values when omitted", async () => {
		const { hybridConfigSchema } = await import("../config.js");
		const cfg = hybridConfigSchema.parse({ ...BASE_CFG, mode: "minimal" });
		expect(cfg.workflowTracking.enabled).toBe(false);
		expect(cfg.workflowTracking.maxTracesPerDay).toBe(100);
		expect(cfg.workflowTracking.retentionDays).toBe(90);
		expect(cfg.workflowTracking.goalExtractionModel).toBeUndefined();
	});
});
