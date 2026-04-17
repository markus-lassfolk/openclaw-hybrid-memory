/**
 * Tests for contradiction detection (Issue #157).
 *
 * Covers:
 *   - Write-time detection: same entity+key+different value → contradiction recorded
 *   - Old fact confidence reduced by 0.2 (floor at 0.1)
 *   - CONTRADICTS link created between facts
 *   - No contradiction when same entity+key+same value (reinforcement)
 *   - No contradiction when entity or key differ
 *   - No contradiction when entity/key/value are null
 *   - Contradicted facts marked in retrieval output (isContradicted)
 *   - resolveContradictions() auto-supersedes obvious cases
 *   - resolveContradictions() returns ambiguous cases
 *   - Multiple contradictions for same entity handled correctly
 *   - Confidence floor: never goes below 0.1 after multiple contradictions
 *   - resolveContradiction() updates the record
 *   - getContradictions() filters by factId
 *   - contradictionsCount() returns correct count
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
	tmpDir = mkdtempSync(join(tmpdir(), "contradiction-test-"));
	db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
	db.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: store a simple fact
// ---------------------------------------------------------------------------
function storeFact(
	entity: string | null,
	key: string | null,
	value: string | null,
	text: string,
	confidence = 1.0,
) {
	return db.store({
		text,
		category: "fact",
		importance: 0.7,
		entity,
		key,
		value,
		source: "conversation",
		confidence,
	});
}

// ---------------------------------------------------------------------------
// 1. Same entity+key+different value → contradiction detected
// ---------------------------------------------------------------------------
describe("detectContradictions: same entity+key, different value", () => {
	it("detects contradiction and creates record", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		expect(contradictions).toHaveLength(1);
		expect(contradictions[0].oldFactId).toBe(old.id);
		expect(contradictions[0].contradictionId).toBeDefined();
	});

	it("creates a record in the contradictions table", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		const records = db.getContradictions(old.id);
		expect(records).toHaveLength(1);
		expect(records[0].id).toBe(contradictionId);
		expect(records[0].factIdNew).toBe(newFact.id);
		expect(records[0].factIdOld).toBe(old.id);
		expect(records[0].resolved).toBe(false);
		expect(records[0].resolution).toBeNull();
	});

	it("creates a CONTRADICTS link from new to old", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		const outgoing = db.getLinksFrom(newFact.id);
		const contradicts = outgoing.filter((l) => l.linkType === "CONTRADICTS");
		expect(contradicts).toHaveLength(1);
		expect(contradicts[0].targetFactId).toBe(old.id);
	});
});

// ---------------------------------------------------------------------------
// 2. Old fact confidence reduced by 0.2 (floor at 0.1)
// ---------------------------------------------------------------------------
describe("detectContradictions: confidence reduction", () => {
	it("reduces old fact confidence by 0.2", () => {
		const old = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			1.0,
		);
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		const afterOld = db.getById(old.id);
		expect(afterOld).not.toBeNull();
		expect(afterOld?.confidence).toBeCloseTo(0.8, 5);
	});

	it("does not reduce below the floor of 0.1", () => {
		const old = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			0.2,
		);
		const new1 = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);
		db.detectContradictions(new1.id, "user", "theme", "light");

		// Confidence should now be 0.1 (floor), not 0.0
		const afterFirst = db.getById(old.id);
		expect(afterFirst?.confidence).toBeCloseTo(0.1, 5);

		// Store another contradicting fact — confidence must stay at 0.1
		const new2 = storeFact(
			"user",
			"theme",
			"solarized",
			"User switched to solarized",
		);
		db.detectContradictions(new2.id, "user", "theme", "solarized");

		const afterSecond = db.getById(old.id);
		expect(afterSecond?.confidence).toBeCloseTo(0.1, 5);
	});
});

// ---------------------------------------------------------------------------
// 3. Same entity+key+same value → NO contradiction (reinforcement)
// ---------------------------------------------------------------------------
describe("detectContradictions: same value is NOT a contradiction", () => {
	it("does not detect contradiction when values match (case-insensitive)", () => {
		storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"dark",
			"User still uses dark mode",
		);

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"dark",
		);
		expect(contradictions).toHaveLength(0);
	});

	it("case-insensitive comparison: 'Dark' vs 'dark' is same value", () => {
		storeFact("user", "theme", "Dark", "User prefers Dark mode");
		const newFact = storeFact("user", "theme", "dark", "User uses dark mode");

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"dark",
		);
		expect(contradictions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 4. Different entity → no contradiction
// ---------------------------------------------------------------------------
describe("detectContradictions: different entity", () => {
	it("does not flag contradiction when entities differ", () => {
		storeFact("alice", "theme", "dark", "Alice prefers dark mode");
		const newFact = storeFact(
			"bob",
			"theme",
			"light",
			"Bob prefers light mode",
		);

		const contradictions = db.detectContradictions(
			newFact.id,
			"bob",
			"theme",
			"light",
		);
		expect(contradictions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 5. Null entity/key/value → no contradiction
// ---------------------------------------------------------------------------
describe("detectContradictions: null fields skip detection", () => {
	it("skips detection when entity is null", () => {
		storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			null,
			"theme",
			"light",
			"Someone prefers light mode",
		);

		const contradictions = db.detectContradictions(
			newFact.id,
			null,
			"theme",
			"light",
		);
		expect(contradictions).toHaveLength(0);
	});

	it("skips detection when key is null", () => {
		storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact("user", null, "light", "User prefers light");

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			null,
			"light",
		);
		expect(contradictions).toHaveLength(0);
	});

	it("skips detection when value is null", () => {
		storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact("user", "theme", null, "User theme unknown");

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			null,
		);
		expect(contradictions).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 6. isContradicted() — retrieval marking
// ---------------------------------------------------------------------------
describe("isContradicted", () => {
	it("returns true for both facts involved in a contradiction (bidirectional)", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		// Both sides of a contradiction are now marked (bidirectional CONTRADICTS links)
		expect(db.isContradicted(old.id)).toBe(true);
		expect(db.isContradicted(newFact.id)).toBe(true);
	});

	it("returns false for a fact with no contradictions", () => {
		const fact = storeFact("user", "theme", "dark", "User prefers dark mode");
		expect(db.isContradicted(fact.id)).toBe(false);
	});

	it("returns false after contradiction is resolved", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		db.resolveContradiction(contradictionId, "superseded");
		expect(db.isContradicted(old.id)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. resolveContradictions() auto-supersedes obvious cases
// ---------------------------------------------------------------------------
describe("resolveContradictions", () => {
	it("auto-supersedes when new fact is newer, higher confidence, from conversation", () => {
		const old = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			0.5,
		);
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
			1.0,
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		const result = db.resolveContradictions();
		expect(result.autoResolved).toHaveLength(1);
		expect(result.autoResolved[0].factIdNew).toBe(newFact.id);
		expect(result.autoResolved[0].factIdOld).toBe(old.id);
		expect(result.ambiguous).toHaveLength(0);
	});

	it("returns ambiguous when new fact does not have higher confidence", () => {
		const _old = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			1.0,
		);
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
			0.5,
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		const result = db.resolveContradictions();
		expect(result.autoResolved).toHaveLength(0);
		expect(result.ambiguous).toHaveLength(1);
		expect(result.ambiguous[0].factIdNew).toBe(newFact.id);
	});

	it("does not re-process already-resolved contradictions", () => {
		const old = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			0.5,
		);
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
			1.0,
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		// Manually resolve first
		db.resolveContradiction(contradictionId, "kept");

		// Now run batch resolution — should find nothing
		const result = db.resolveContradictions();
		expect(result.autoResolved).toHaveLength(0);
		expect(result.ambiguous).toHaveLength(0);

		void old; // suppress unused warning
	});
});

// ---------------------------------------------------------------------------
// 8. Multiple contradictions for same entity handled correctly
// ---------------------------------------------------------------------------
describe("detectContradictions: multiple conflicts", () => {
	it("detects multiple conflicting facts for the same entity+key", () => {
		const old1 = storeFact("user", "theme", "dark", "User prefers dark mode");
		const old2 = storeFact("user", "theme", "solarized", "User uses solarized");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User now prefers light mode",
		);

		const contradictions = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		const oldIds = contradictions.map((c) => c.oldFactId);
		expect(oldIds).toContain(old1.id);
		expect(oldIds).toContain(old2.id);
		expect(contradictions).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 9. resolveContradiction() updates the record
// ---------------------------------------------------------------------------
describe("resolveContradiction", () => {
	it("marks the contradiction as resolved with the given strategy", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);

		const success = db.resolveContradiction(contradictionId, "superseded");
		expect(success).toBe(true);

		const records = db.getContradictions(old.id);
		const record = records.find((r) => r.id === contradictionId);
		expect(record).toBeDefined();
		expect(record?.resolved).toBe(true);
		expect(record?.resolution).toBe("superseded");
	});

	it("returns false when the record does not exist", () => {
		const success = db.resolveContradiction("non-existent-id", "kept");
		expect(success).toBe(false);
	});

	it("returns false when called again after already resolved", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);
		db.resolveContradiction(contradictionId, "superseded");
		const secondCall = db.resolveContradiction(contradictionId, "kept");
		expect(secondCall).toBe(false);

		void old;
	});
});

// ---------------------------------------------------------------------------
// 10. getContradictions() — filtering behaviour
// ---------------------------------------------------------------------------
describe("getContradictions", () => {
	it("returns all unresolved contradictions when no factId given", () => {
		const old1 = storeFact("user", "theme", "dark", "User prefers dark mode");
		const new1 = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);
		const old2 = storeFact("project", "lang", "ts", "Project uses TypeScript");
		const new2 = storeFact("project", "lang", "js", "Project switched to JS");

		db.detectContradictions(new1.id, "user", "theme", "light");
		db.detectContradictions(new2.id, "project", "lang", "js");

		const all = db.getContradictions();
		expect(all).toHaveLength(2);

		void old1;
		void old2;
	});

	it("filters by factId (as new or old)", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		const byOld = db.getContradictions(old.id);
		expect(byOld).toHaveLength(1);
		expect(byOld[0].factIdOld).toBe(old.id);

		const byNew = db.getContradictions(newFact.id);
		expect(byNew).toHaveLength(1);
		expect(byNew[0].factIdNew).toBe(newFact.id);
	});
});

// ---------------------------------------------------------------------------
// 11. contradictionsCount()
// ---------------------------------------------------------------------------
describe("contradictionsCount", () => {
	it("returns 0 when no contradictions exist", () => {
		expect(db.contradictionsCount()).toBe(0);
	});

	it("returns the count of unresolved contradictions", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		db.detectContradictions(newFact.id, "user", "theme", "light");

		expect(db.contradictionsCount()).toBe(1);

		void old;
	});

	it("excludes resolved contradictions from count", () => {
		const old = storeFact("user", "theme", "dark", "User prefers dark mode");
		const newFact = storeFact(
			"user",
			"theme",
			"light",
			"User switched to light mode",
		);

		const [{ contradictionId }] = db.detectContradictions(
			newFact.id,
			"user",
			"theme",
			"light",
		);
		db.resolveContradiction(contradictionId, "superseded");

		expect(db.contradictionsCount()).toBe(0);

		void old;
	});
});

// ---------------------------------------------------------------------------
// 12. updateConfidence() — floor behaviour
// ---------------------------------------------------------------------------
describe("updateConfidence", () => {
	it("reduces confidence by delta and floors at 0.1", () => {
		const fact = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			0.15,
		);
		const updated = db.updateConfidence(fact.id, -0.2);
		expect(updated).toBeCloseTo(0.1, 5);
	});

	it("returns null for non-existent fact id", () => {
		const result = db.updateConfidence("non-existent-id", -0.2);
		expect(result).toBeNull();
	});

	it("caps confidence at 1.0 for positive delta", () => {
		const fact = storeFact(
			"user",
			"theme",
			"dark",
			"User prefers dark mode",
			0.9,
		);
		const updated = db.updateConfidence(fact.id, 0.5);
		expect(updated).toBeCloseTo(1.0, 5);
	});
});
