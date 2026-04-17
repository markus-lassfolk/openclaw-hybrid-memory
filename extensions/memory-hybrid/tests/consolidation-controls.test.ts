import { describe, expect, it } from "vitest";
import {
	applyConsolidationRetrievalControls,
	isConsolidatedDerivedFact,
} from "../utils/consolidation-controls.js";

describe("consolidation controls", () => {
	it("recognizes derived consolidation facts by source, key, or tag", () => {
		expect(isConsolidatedDerivedFact({ source: "consolidation" })).toBe(true);
		expect(isConsolidatedDerivedFact({ source: "dream-cycle" })).toBe(true);
		expect(isConsolidatedDerivedFact({ key: "consolidated" })).toBe(true);
		expect(isConsolidatedDerivedFact({ tags: ["topic", "consolidated"] })).toBe(
			true,
		);
		expect(
			isConsolidatedDerivedFact({ source: "conversation", tags: ["topic"] }),
		).toBe(false);
	});

	it("applies a retrieval penalty to derived consolidation facts", () => {
		expect(
			applyConsolidationRetrievalControls(1, { source: "consolidation" }),
		).toBeCloseTo(0.85, 5);
		expect(
			applyConsolidationRetrievalControls(1, { source: "conversation" }),
		).toBe(1);
	});
});
