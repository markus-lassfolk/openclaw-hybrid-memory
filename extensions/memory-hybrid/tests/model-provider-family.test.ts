import { describe, expect, it } from "vitest";
import { inferModelProviderPrefix } from "../utils/model-provider-family.js";

describe("inferModelProviderPrefix", () => {
	it("returns lowercased prefix before first slash", () => {
		expect(inferModelProviderPrefix("azure-foundry/gpt-5.4")).toBe(
			"azure-foundry",
		);
		expect(inferModelProviderPrefix("Google/gemini-2.5-flash")).toBe("google");
		expect(inferModelProviderPrefix("minimax/MiniMax-M2")).toBe("minimax");
	});

	it("returns full string lowercased when there is no slash", () => {
		expect(inferModelProviderPrefix("gemini-2.0-flash")).toBe(
			"gemini-2.0-flash",
		);
	});

	it("trims whitespace", () => {
		expect(inferModelProviderPrefix("  openai/gpt-4.1-mini  ")).toBe("openai");
	});

	it("returns empty for empty input", () => {
		expect(inferModelProviderPrefix("")).toBe("");
		expect(inferModelProviderPrefix("   ")).toBe("");
	});
});
