import type { ConfigMode } from "./types/index.js";

/** Default categories — can be extended via config.categories */
export const DEFAULT_MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "pattern",
  "rule",
  "other",
] as const;

/** Runtime categories: starts as defaults, extended by config */
let _runtimeCategories: string[] = [...DEFAULT_MEMORY_CATEGORIES];

export function getMemoryCategories(): readonly string[] {
  return _runtimeCategories;
}

export function setMemoryCategories(categories: string[]): void {
  // Always include defaults + any custom ones, deduplicated
  const merged = new Set([...DEFAULT_MEMORY_CATEGORIES, ...categories]);
  _runtimeCategories = [...merged];
}

export function isValidCategory(cat: string): boolean {
  return _runtimeCategories.includes(cat);
}

/** Preset overrides per mode. Merged under user config so user keys win. See CONFIGURATION-MODES.md. */
export const PRESET_OVERRIDES: Record<ConfigMode, Record<string, unknown>> = {
  essential: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: false }, authFailure: { enabled: false } },
    autoClassify: { enabled: false, suggestCategories: false },
    store: { fuzzyDedupe: true, classifyBeforeWrite: false },
    graph: { enabled: false },
    procedures: { enabled: false },
    reflection: { enabled: false },
    wal: { enabled: true },
    languageKeywords: { autoBuild: false },
    personaProposals: { enabled: false },
    memoryTiering: { enabled: false },
    distill: { extractDirectives: true, extractReinforcement: false },
    verbosity: "quiet",
  },
  normal: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: false }, authFailure: { enabled: true } },
    autoClassify: { enabled: true, suggestCategories: true },
    store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    graph: { enabled: true, autoLink: false, useInRecall: true },
    procedures: { enabled: true, requireApprovalForPromote: true },
    reflection: { enabled: false },
    wal: { enabled: true },
    languageKeywords: { autoBuild: true },
    personaProposals: { enabled: false },
    memoryTiering: { enabled: true, compactionOnSessionEnd: true },
    distill: { extractDirectives: true, extractReinforcement: true },
    verbosity: "normal",
  },
  expert: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: true }, authFailure: { enabled: true } },
    autoClassify: { enabled: true, suggestCategories: true },
    credentials: { autoDetect: true, autoCapture: { toolCalls: true } },
    store: { fuzzyDedupe: true, classifyBeforeWrite: true },
    graph: { enabled: true, autoLink: true, useInRecall: true },
    procedures: { enabled: true, requireApprovalForPromote: true },
    reflection: { enabled: true },
    wal: { enabled: true },
    languageKeywords: { autoBuild: true },
    personaProposals: { enabled: true },
    memoryTiering: { enabled: true, compactionOnSessionEnd: true },
    selfCorrection: {
      semanticDedup: true,
      applyToolsByDefault: true,
      autoRewriteTools: false,
      analyzeViaSpawn: false,
    },
    distill: { extractDirectives: true, extractReinforcement: true, extractionModelTier: "default" },
    nightlyCycle: { enabled: true },
    passiveObserver: { enabled: true },
    extraction: { extractionPasses: true },
    workflowTracking: { enabled: true },
    selfExtension: { enabled: true },
    crystallization: { enabled: true },
    verification: { enabled: true },
    provenance: { enabled: true },
    aliases: { enabled: true },
    memoryToSkills: { enabled: false },
    crossAgentLearning: { enabled: true },
    reranking: { enabled: true },
    contextualVariants: { enabled: true },
    verbosity: "normal",
  },
  full: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: true }, authFailure: { enabled: true } },
    autoClassify: { enabled: true, suggestCategories: true },
    credentials: { autoDetect: true, autoCapture: { toolCalls: true } },
    store: { fuzzyDedupe: true, classifyBeforeWrite: true },
    graph: { enabled: true, autoLink: true, useInRecall: true },
    procedures: { enabled: true, requireApprovalForPromote: true },
    reflection: { enabled: true },
    wal: { enabled: true },
    languageKeywords: { autoBuild: true },
    personaProposals: { enabled: true },
    memoryTiering: { enabled: true, compactionOnSessionEnd: true },
    selfCorrection: {
      semanticDedup: true,
      applyToolsByDefault: true,
      autoRewriteTools: false,
      analyzeViaSpawn: false,
    },
    // NOTE: Presets should NOT hardcode specific models (e.g., hydeModel).
    // Model selection is handled dynamically via the tiered fallback system (nano/default/heavy)
    // based on which providers/API keys are available. Hardcoding breaks users without that provider.
    queryExpansion: { enabled: true },
    ingest: { paths: ["skills/**/*.md", "TOOLS.md", "AGENTS.md"] },
    distill: { extractDirectives: true, extractReinforcement: true, extractionModelTier: "default" },
    nightlyCycle: { enabled: true },
    passiveObserver: { enabled: true },
    extraction: { extractionPasses: true },
    workflowTracking: { enabled: true },
    selfExtension: { enabled: true },
    crystallization: { enabled: true },
    verification: { enabled: true },
    provenance: { enabled: true },
    aliases: { enabled: true },
    memoryToSkills: { enabled: false },
    crossAgentLearning: { enabled: true },
    reranking: { enabled: true },
    contextualVariants: { enabled: true },
    documents: { enabled: true },
    verbosity: "verbose",
  },
};
