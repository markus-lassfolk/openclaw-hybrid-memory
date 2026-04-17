/**
 * Tests for rich reinforcement context (#259):
 * - reinforceFact stores context columns in reinforcement_log
 * - getReinforcementEvents returns events with context
 * - FIFO eviction at maxEventsPerFact limit
 * - calculateDiversityScore scoring
 * - trackContext: false skips context storage
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "reinforcement-context-test-"));
	db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
	db.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function storeFact(text = "User prefers TypeScript") {
	return db.store({
		text,
		category: "preference",
		importance: 0.8,
		entity: "user",
		key: null,
		value: null,
		source: "test",
	});
}

describe("reinforceFact with context (#259)", () => {
	it("stores context columns when context is provided", () => {
		const fact = storeFact("User prefers TypeScript");
		db.reinforceFact(fact.id, "Great!", {
			querySnippet: "How do I set up TypeScript?",
			topic: "typescript",
			toolSequence: ["read", "write"],
			sessionFile: "2026-01-01-session.jsonl",
		});

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBe(1);
		const ev = events[0];
		expect(ev.factId).toBe(fact.id);
		expect(ev.signal).toBe("positive");
		expect(ev.querySnippet).toBe("How do I set up TypeScript?");
		expect(ev.topic).toBe("typescript");
		expect(ev.toolSequence).toEqual(["read", "write"]);
		expect(ev.sessionFile).toBe("2026-01-01-session.jsonl");
		expect(ev.occurredAt).toBeGreaterThan(0);
	});

	it("stores event with null context when no context provided", () => {
		const fact = storeFact();
		db.reinforceFact(fact.id, "Nice!");

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBe(1);
		expect(events[0].querySnippet).toBeNull();
		expect(events[0].topic).toBeNull();
		expect(events[0].toolSequence).toBeNull();
		expect(events[0].sessionFile).toBeNull();
	});

	it("accumulates multiple events for a fact", () => {
		const fact = storeFact();
		db.reinforceFact(fact.id, "Great!", { querySnippet: "query A" });
		db.reinforceFact(fact.id, "Perfect!", { querySnippet: "query B" });
		db.reinforceFact(fact.id, "Excellent!", { querySnippet: "query C" });

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBe(3);
	});

	it("returns only events for the requested factId", () => {
		const factA = storeFact("fact A");
		const factB = storeFact("fact B");
		db.reinforceFact(factA.id, "Good!", { querySnippet: "about A" });
		db.reinforceFact(factB.id, "Nice!", { querySnippet: "about B" });

		const eventsA = db.getReinforcementEvents(factA.id);
		const eventsB = db.getReinforcementEvents(factB.id);
		expect(eventsA.length).toBe(1);
		expect(eventsA[0].querySnippet).toBe("about A");
		expect(eventsB.length).toBe(1);
		expect(eventsB[0].querySnippet).toBe("about B");
	});
});

describe("FIFO eviction at maxEventsPerFact (#259)", () => {
	it("evicts oldest events when limit is reached", () => {
		const fact = storeFact();
		const maxEventsPerFact = 3;

		for (let i = 0; i < 5; i++) {
			db.reinforceFact(
				fact.id,
				`praise ${i}`,
				{ querySnippet: `query ${i}` },
				{ maxEventsPerFact },
			);
		}

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBeLessThanOrEqual(maxEventsPerFact);
		// Most recent events should remain (query 4, 3, 2)
		const snippets = events.map((e) => e.querySnippet);
		expect(snippets).toContain("query 4");
		expect(snippets).not.toContain("query 0");
		expect(snippets).not.toContain("query 1");
	});

	it("does not evict when under the limit", () => {
		const fact = storeFact();
		const maxEventsPerFact = 5;

		for (let i = 0; i < 3; i++) {
			db.reinforceFact(
				fact.id,
				`praise ${i}`,
				{ querySnippet: `query ${i}` },
				{ maxEventsPerFact },
			);
		}

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBe(3);
	});
});

describe("calculateDiversityScore (#259)", () => {
	it("returns 1.0 for a fact with no events", () => {
		const fact = storeFact();
		expect(db.calculateDiversityScore(fact.id)).toBe(1.0);
	});

	it("returns 1.0 when all query snippets are unique", () => {
		const fact = storeFact();
		db.reinforceFact(fact.id, "praise", {
			querySnippet: "how to set up typescript",
		});
		db.reinforceFact(fact.id, "praise", {
			querySnippet: "how to configure eslint",
		});
		db.reinforceFact(fact.id, "praise", { querySnippet: "what is a monorepo" });

		const score = db.calculateDiversityScore(fact.id);
		expect(score).toBe(1.0);
	});

	it("returns less than 1.0 when queries are repeated", () => {
		const fact = storeFact();
		db.reinforceFact(fact.id, "praise", {
			querySnippet: "how to set up typescript",
		});
		db.reinforceFact(fact.id, "praise", {
			querySnippet: "how to set up typescript",
		});
		db.reinforceFact(fact.id, "praise", {
			querySnippet: "different query here",
		});

		const score = db.calculateDiversityScore(fact.id);
		expect(score).toBeLessThan(1.0);
		// 2 unique out of 3 = 0.666...
		expect(score).toBeCloseTo(2 / 3, 1);
	});

	it("returns low score when all queries are the same", () => {
		const fact = storeFact();
		for (let i = 0; i < 4; i++) {
			db.reinforceFact(fact.id, "praise", {
				querySnippet: "same query every time",
			});
		}
		const score = db.calculateDiversityScore(fact.id);
		// 1 unique out of 4 = 0.25
		expect(score).toBeCloseTo(0.25, 2);
	});
});

describe("trackContext: false skips reinforcement_log entries (#259)", () => {
	it("does not create a log entry when trackContext is false", () => {
		const fact = storeFact();
		db.reinforceFact(
			fact.id,
			"praise",
			{ querySnippet: "some query" },
			{ trackContext: false },
		);

		const events = db.getReinforcementEvents(fact.id);
		expect(events.length).toBe(0);
	});

	it("still increments reinforced_count when trackContext is false", () => {
		const fact = storeFact();
		db.reinforceFact(
			fact.id,
			"praise",
			{ querySnippet: "some query" },
			{ trackContext: false },
		);

		const all = db.getAll({});
		const updated = all.find((f) => f.id === fact.id);
		expect(updated?.reinforcedCount).toBeGreaterThan(0);
		expect(db.getReinforcementEvents(fact.id).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// boostAmount override (#259)
// ---------------------------------------------------------------------------

describe("reinforceFact boostAmount override (#259)", () => {
	it("applies boostAmount to reinforced_count when provided", () => {
		const fact = storeFact("TypeScript is preferred");
		db.reinforceFact(fact.id, "great!", undefined, { boostAmount: 2 });

		const all = db.getAll({});
		const updated = all.find((f) => f.id === fact.id);
		expect(updated?.reinforcedCount).toBe(2);
	});

	it("defaults to increment of 1 when boostAmount is not provided", () => {
		const fact = storeFact("Default boost test");
		db.reinforceFact(fact.id, "nice!");

		const all = db.getAll({});
		const updated = all.find((f) => f.id === fact.id);
		expect(updated?.reinforcedCount).toBe(1);
	});

	it("accumulates boostAmount across multiple calls", () => {
		const fact = storeFact("Multi-boost test");
		db.reinforceFact(fact.id, "call 1", undefined, { boostAmount: 3 });
		db.reinforceFact(fact.id, "call 2", undefined, { boostAmount: 2 });

		const all = db.getAll({});
		const updated = all.find((f) => f.id === fact.id);
		expect(updated?.reinforcedCount).toBe(5);
	});
});
