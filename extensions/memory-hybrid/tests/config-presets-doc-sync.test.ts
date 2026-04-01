/**
 * Guardrail: keep `docs/CONFIGURATION-MODES.md` aligned with:
 * - `PRESET_OVERRIDES` in `config/utils.ts`
 * - Phase 1 migration in `config/parsers/index.ts` (`PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS`, queryExpansion, credentials.autoDetect, graph.strengthenOnRecall)
 *
 * When you change presets or Phase 1, update the doc and extend these tests.
 */
import { describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import type { ConfigMode } from "../config.js";
import { PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS } from "../config/parsers/index.js";
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
    expect(p.autoClassify).toEqual({ enabled: false, suggestCategories: false });
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
  });

  it("minimal: graph/procedures on, reflection off, entity lookup off, authFailure on", () => {
    const p = PRESET_OVERRIDES.minimal;
    expect(p.reflection).toEqual({ enabled: false });
    expect(p.graph).toMatchObject({ enabled: true, autoLink: false, useInRecall: true });
    expect(p.procedures).toMatchObject({ enabled: true });
    const ar = p.autoRecall as Record<string, unknown>;
    expect((ar.entityLookup as { enabled: boolean }).enabled).toBe(false);
    expect((ar.authFailure as { enabled: boolean }).enabled).toBe(true);
    expect(ar.interactiveEnrichment).toBe("fast");
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
});

describe("parseConfig effective config — Phase 1 + presets (CONFIGURATION-MODES.md)", () => {
  it("forces queryExpansion off and Phase-1 keys off for every mode", () => {
    const modes: ConfigMode[] = ["local", "minimal", "enhanced", "complete"];
    for (const mode of modes) {
      const r = parseMode(mode);
      expect(r.queryExpansion.enabled, `mode=${mode}`).toBe(false);
      for (const key of PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS) {
        const section = r[key as keyof typeof r] as { enabled?: boolean } | undefined;
        expect(section?.enabled, `${mode}.${key}.enabled`).toBe(false);
      }
      expect(r.graph?.strengthenOnRecall, `mode=${mode}`).toBe(false);
    }
  });

  it("credentials.autoDetect forced false after Phase 1 (enhanced with vault)", () => {
    const r = hybridConfigSchema.parse({
      ...validEmbedding,
      mode: "enhanced",
      credentials: { encryptionKey: "env:OPENCLAW_CRED_KEY" },
    });
    expect(r.credentials?.autoDetect).toBe(false);
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
    expect(r.ingest?.paths).toEqual(["skills/**/*.md", "TOOLS.md", "AGENTS.md"]);
    expect(r.verbosity).toBe("verbose");
  });
});
