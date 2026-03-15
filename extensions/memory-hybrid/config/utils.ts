import type { ConfigMode, VerbosityLevel } from "./types/index.js";

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
    /** FTS-only recall and capture: no embedding/vector/LLM calls; local SQLite + files only. */
    retrieval: { strategies: ["fts5"] },
  },
  normal: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: false }, authFailure: { enabled: true } },
    autoClassify: { enabled: true, suggestCategories: true },
    store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    graph: { enabled: true, autoLink: false, useInRecall: true, strengthenOnRecall: false },
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
    graph: { enabled: true, autoLink: true, useInRecall: true, strengthenOnRecall: false },
    procedures: { enabled: true, requireApprovalForPromote: true },
    reflection: { enabled: true },
    wal: { enabled: true },
    languageKeywords: { autoBuild: true },
    personaProposals: { enabled: false },
    memoryTiering: { enabled: true, compactionOnSessionEnd: true },
    selfCorrection: {
      semanticDedup: true,
      applyToolsByDefault: true,
      autoRewriteTools: false,
      analyzeViaSpawn: false,
    },
    distill: { extractDirectives: true, extractReinforcement: true, extractionModelTier: "default" },
    frustrationDetection: { enabled: false },
    nightlyCycle: { enabled: false },
    passiveObserver: { enabled: false },
    extraction: { extractionPasses: true },
    workflowTracking: { enabled: false },
    selfExtension: { enabled: false },
    crystallization: { enabled: false },
    verification: { enabled: false },
    provenance: { enabled: false },
    aliases: { enabled: false },
    memoryToSkills: { enabled: false },
    crossAgentLearning: { enabled: false },
    reranking: { enabled: false },
    contextualVariants: { enabled: false },
    documents: { enabled: false },
    verbosity: "normal",
  },
  full: {
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: true }, authFailure: { enabled: true } },
    autoClassify: { enabled: true, suggestCategories: true },
    credentials: { autoDetect: true, autoCapture: { toolCalls: true } },
    store: { fuzzyDedupe: true, classifyBeforeWrite: true },
    graph: { enabled: true, autoLink: true, useInRecall: true, strengthenOnRecall: false },
    procedures: { enabled: true, requireApprovalForPromote: true },
    reflection: { enabled: true },
    wal: { enabled: true },
    languageKeywords: { autoBuild: true },
    personaProposals: { enabled: false },
    memoryTiering: { enabled: true, compactionOnSessionEnd: true },
    selfCorrection: {
      semanticDedup: true,
      applyToolsByDefault: true,
      autoRewriteTools: false,
      analyzeViaSpawn: false,
    },
    // queryExpansion not set in preset — defaults to disabled; set explicitly to enable (Phase 1).
    ingest: { paths: ["skills/**/*.md", "TOOLS.md", "AGENTS.md"] },
    distill: { extractDirectives: true, extractReinforcement: true, extractionModelTier: "default" },
    frustrationDetection: { enabled: false },
    nightlyCycle: { enabled: false },
    passiveObserver: { enabled: false },
    extraction: { extractionPasses: true },
    workflowTracking: { enabled: false },
    selfExtension: { enabled: false },
    crystallization: { enabled: false },
    verification: { enabled: false },
    provenance: { enabled: false },
    aliases: { enabled: false },
    memoryToSkills: { enabled: false },
    crossAgentLearning: { enabled: false },
    reranking: { enabled: false },
    contextualVariants: { enabled: false },
    documents: { enabled: false },
    verbosity: "verbose",
  },
};

/**
 * Check if verbosity level is in "compact mode" (quiet or silent).
 * Compact mode suppresses verbose output and only shows essential information.
 * Use this helper instead of inline checks to ensure consistent behavior across the codebase.
 */
export function isCompactVerbosity(verbosity: VerbosityLevel | undefined): boolean {
  return verbosity === "quiet" || verbosity === "silent";
}
