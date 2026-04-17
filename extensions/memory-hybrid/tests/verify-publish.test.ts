import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("verify-publish", () => {
	it("enforces explicit native runtime dependency declarations", () => {
		const scriptPath = join(root, "scripts", "verify-publish.cjs");
		const content = readFileSync(scriptPath, "utf-8");
		expect(content).toContain("requiredRuntimeDeps");
		expect(content).toContain("optionalDependencies");
		expect(content).toContain("peerDependencies");
	});
});
