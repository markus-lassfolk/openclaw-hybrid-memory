/**
 * Guardrail: keep `docs/CONFIGURATION-MODES.md` aligned with:
 * - `PRESET_OVERRIDES` in `config/utils.ts`
 * - Post-parse effective config from `hybridConfigSchema` (preset merge + user overrides; no forced migration)
 *
 * When you change presets, update the doc and extend these tests.
 */
import { describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import type { ConfigMode } from "../config.js";
import { PRESET_OVERRIDES } from "../config/utils.js";

const validEmbedding = {
	embedding: {
		apiKey: "sk-test-key-that-is-long-enough-to-pass",
		model: "text-embedding-3-small",
	},
};

function parseMode(mode: ConfigMode) {
	return hybridConfigSchema.parse({ ...validEmbedding, mode });
}

describe("PRESET_OVERRIDES (config/utils.ts) — invariants for CONFIGURATION-MODES.md", () => {
	it("local: FTS-only retrieval, quiet, core features off", () => {
		const p = PRESET_OVERRIDES.local;
		expect(p.retrieval).toEqual({ strategies: ["fts5"] });
		expect(p.autoClassify).toEqual({
			enabled: false,
			suggestCategories: false,
		});
		expect(p.graph).toEqual({ enabled: false });
		expect(p.procedures).toEqual({ enabled: false });
		expect(p.reflection).toEqual({ enabled: false });
		expect(p.memoryTiering).toEqual({ enabled: false });
		expect(p.verbosity).toBe("quiet");
		const ar = p.autoRecall as Record<string, unknown>;
		expect(ar.enabled).toBe(true);
		expect(ar.interactiveEnrichment).toBe("fast");
		expect((ar.entityLookup as { enabled: boolean }).enabled).toBe(false);
		expect((ar.authFailure as { enabled: boolean }).enabled).toBe(false);
		expect(p.credentials).toEqual({ enabled: true });
	});

	it("minimal: graph/procedures on, reflection off, entity lookup off, authFailure on", () => {
		const p = PRESET_OVERRIDES.minimal;
		expect(p.reflection).toEqual({ enabled: false });
		expect(p.graph).toMatchObject({
			enabled: true,
			autoLink: false,
			useInRecall: true,
		});
		expect(p.procedures).toMatchObject({ enabled: true });
		const ar = p.autoRecall as Record<string, unknown>;
		expect((ar.entityLookup as { enabled: boolean }).enabled).toBe(false);
		expect((ar.authFailure as { enabled: boolean }).enabled).toBe(true);
		expect(ar.interactiveEnrichment).toBe("fast");
		expect(p.credentials).toEqual({ enabled: true });
	});

	it("enhanced + complete: advanced opt-ins off in preset (opt-in via user config)", () => {
		for (const mode of ["enhanced", "complete"] as const) {
			const p = PRESET_OVERRIDES[mode];
			expect(p.workflowTracking).toEqual({ enabled: false });
			expect(p.nightlyCycle).toEqual({ enabled: false });
			expect(p.passiveObserver).toEqual({ enabled: false });
			expect(p.verification).toEqual({ enabled: false });
			expect(p.provenance).toEqual({ enabled: false });
			expect(p.documents).toEqual({ enabled: false });
			expect(p.aliases).toEqual({ enabled: false });
			expect(p.crossAgentLearning).toEqual({ enabled: false });
			expect(p.reranking).toEqual({ enabled: false });
			expect(p.contextualVariants).toEqual({ enabled: false });
			expect(p.selfExtension).toEqual({ enabled: false });
			expect(p.crystallization).toEqual({ enabled: false });
			expect(p.personaProposals).toEqual({ enabled: false });
			expect(p.frustrationDetection).toEqual({ enabled: false });
			const ar = p.autoRecall as Record<string, unknown>;
			expect((ar.entityLookup as { enabled: boolean }).enabled).toBe(true);
			expect(ar.interactiveEnrichment).toBe("fast");
		}
	});

	it("complete vs enhanced: verbosity differs", () => {
		expect(PRESET_OVERRIDES.enhanced.verbosity).toBe("normal");
		expect(PRESET_OVERRIDES.complete.verbosity).toBe("verbose");
	});

	it("enhanced + complete: credentials preset enables autoDetect", () => {
		expect(PRESET_OVERRIDES.enhanced.credentials).toMatchObject({
			autoDetect: true,
		});
		expect(PRESET_OVERRIDES.complete.credentials).toMatchObject({
			autoDetect: true,
		});
	});
});

describe("parseConfig effective config — presets (CONFIGURATION-MODES.md)", () => {
	it("preset defaults: queryExpansion off by default; graph.strengthenOnRecall false in minimal+ presets", () => {
		const modes: ConfigMode[] = ["local", "minimal", "enhanced", "complete"];
		for (const mode of modes) {
			const r = parseMode(mode);
			expect(r.queryExpansion.enabled, `mode=${mode}`).toBe(false);
			expect(r.graph?.strengthenOnRecall, `mode=${mode}`).toBe(false);
		}
	});

	it("local: FTS-only and autoClassify off after parse", () => {
		const r = parseMode("local");
		expect(r.retrieval.strategies).toEqual(["fts5"]);
		expect(r.autoClassify.enabled).toBe(false);
		expect(r.graph.enabled).toBe(false);
	});

	it("minimal: reflection off; procedures on", () => {
		const r = parseMode("minimal");
		expect(r.reflection.enabled).toBe(false);
		expect(r.procedures.enabled).toBe(true);
		expect(r.autoRecall.entityLookup.enabled).toBe(false);
	});

	it("complete: autoRecall.interactiveEnrichment fast; ingest paths", () => {
		const r = parseMode("complete");
		expect(r.autoRecall.interactiveEnrichment).toBe("fast");
		expect(r.ingest?.paths).toEqual([
			"skills/**/*.md",
			"TOOLS.md",
			"AGENTS.md",
		]);
		expect(r.verbosity).toBe("verbose");
	});
});
