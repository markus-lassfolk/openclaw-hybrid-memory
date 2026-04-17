import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ARCHITECTURE_CENTER,
	allArchitectureOwnershipPaths,
} from "../src/architecture-center.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
let architectureCenterDoc = "";

function normalizeMarkdown(text: string): string {
	return text
		.replaceAll("`", "")
		.replaceAll("**", "")
		.replace(/\r/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

describe("architecture center contract", () => {
	beforeAll(() => {
		const docPath = resolve(repoRoot, "docs/ARCHITECTURE-CENTER.md");
		if (!existsSync(docPath)) throw new Error("Doc not found");
		architectureCenterDoc = readFileSync(docPath, "utf8");
	});
	it("keeps core runtime and adjacent ownership disjoint", () => {
		const corePaths = new Set(
			ARCHITECTURE_CENTER.coreRuntime.flatMap((area) => area.ownership),
		);
		const adjacentPaths = new Set(
			ARCHITECTURE_CENTER.adjacentSubsystems.flatMap((area) => area.ownership),
		);

		expect(corePaths.size).toBe(
			ARCHITECTURE_CENTER.coreRuntime.flatMap((area) => area.ownership).length,
		);
		expect(adjacentPaths.size).toBe(
			ARCHITECTURE_CENTER.adjacentSubsystems.flatMap((area) => area.ownership)
				.length,
		);
		expect([...corePaths].filter((path) => adjacentPaths.has(path))).toEqual(
			[],
		);
	});

	it("points only at files and directories that exist in the repo", () => {
		for (const ownershipPath of allArchitectureOwnershipPaths()) {
			expect(existsSync(resolve(repoRoot, ownershipPath))).toBe(true);
		}
	});

	it("documents the canonical decision, boundaries, heuristics, and guardrails", () => {
		const normalizedDoc = normalizeMarkdown(architectureCenterDoc);

		expect(normalizedDoc).toContain(
			"Architecture Center: Core Runtime vs Adjacent Subsystems",
		);
		expect(normalizedDoc).toContain("## Classification Heuristic");

		for (const decisionPoint of ARCHITECTURE_CENTER.decision) {
			expect(normalizedDoc).toContain(decisionPoint);
		}

		for (const area of [
			...ARCHITECTURE_CENTER.coreRuntime,
			...ARCHITECTURE_CENTER.adjacentSubsystems,
		]) {
			expect(normalizedDoc).toContain(area.name);
			expect(normalizedDoc).toContain(area.rationale);
			for (const ownershipPath of area.ownership) {
				expect(normalizedDoc).toContain(ownershipPath);
			}
		}

		for (const rule of ARCHITECTURE_CENTER.classificationHeuristics) {
			expect(normalizedDoc).toContain(rule.prompt);
			expect(normalizedDoc).toContain(
				rule.classification === "core runtime"
					? "Core runtime"
					: "Adjacent subsystem",
			);
		}

		for (const constraint of ARCHITECTURE_CENTER.constraints) {
			expect(normalizedDoc).toContain(constraint);
		}

		for (const guardrail of ARCHITECTURE_CENTER.refactorGuardrails) {
			expect(normalizedDoc).toContain(guardrail);
		}
	});
});
