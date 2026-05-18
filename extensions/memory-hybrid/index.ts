import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { FactsDB } from "./backends/facts-db.js";
import { VectorDB } from "./backends/vector-db.js";
import { WriteAheadLog } from "./backends/wal.js";
import { buildInstallDefaults, deepMerge } from "./cli/handlers.js";
import { hybridConfigSchema } from "./config/hybrid-schema.js";
import { Embeddings, safeEmbed } from "./services/embeddings.js";
import { buildFts5Query, rebuildFtsIndex, searchFts } from "./services/fts-search.js";
import { HOP_SCORE_DECAY, expandGraph, formatLinkPath } from "./services/graph-retrieval.js";
import { filterByScope, mergeResults } from "./services/merge-results.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  estimateTokenCount,
  packIntoBudget,
  runExplicitDeepRetrieval,
  serializeFactForContext,
} from "./services/retrieval-orchestrator.js";
import { RRF_K_DEFAULT, applyPostRrfAdjustments, fuseResults } from "./services/rrf-fusion.js";
import { versionInfo } from "./versionInfo.js";
export type {
  GraphExpandedResult,
  GraphExpansionStats,
  GraphFactLookup,
  GraphRetrievalOptions,
  LinkPathStep,
} from "./services/graph-retrieval.js";
export { DEFAULT_GRAPH_HUB_DEGREE_CAP, resolveGraphHubDegreeCap } from "./services/graph-retrieval.js";
export * from "./services/pending-autopilot/index.js";
export {
  PERSONA_APPLY_CONFIDENCE_THRESHOLD,
  PERSONA_PROPOSAL_TRIAGE_POLICY_VERSION,
  PERSONA_REJECT_CONFIDENCE_THRESHOLD,
  createPersonaProposalTriageAdapter,
  decidePersonaProposal,
  renderPersonaProposalTriageHumanSummary,
  runPersonaProposalTriage,
  stablePersonaProposalTriageJson,
  validatePersonaPolicy,
} from "./services/persona-proposal-triage.js";
export type {
  PersonaProposalDecisionView,
  PersonaProposalPendingItem,
  PersonaProposalReviewBundle,
  PersonaProposalRisk,
  PersonaProposalTriageOptions,
  PersonaProposalTriagePolicy,
  PersonaProposalTriageResult,
} from "./services/persona-proposal-triage.js";
import { findShortestPath, formatPath, resolveInput } from "./services/shortest-path.js";
export type { ShortestPathResult, PathStep, ShortestPathLookup } from "./services/shortest-path.js";
import {
  analyzeKnowledgeGaps,
  computeIsolationScore,
  computeRankScore,
  detectOrphans,
  detectSuggestedLinks,
  detectWeak,
} from "./services/knowledge-gaps.js";
export type {
  GapFact,
  SuggestedLink,
  KnowledgeGapReport,
  GapMode,
  GapFactsDB,
  GapVectorDB,
  GapEmbeddings,
} from "./services/knowledge-gaps.js";
import { detectClusters, generateClusterLabel } from "./services/topic-clusters.js";
export type {
  TopicCluster,
  ClusterDetectionResult,
  ClusterDetectionOptions,
  ClusterFactLookup,
} from "./services/topic-clusters.js";
import {
  detectCredentialPatterns,
  extractCredentialMatch,
  inferServiceFromText,
  isCredentialLike,
} from "./services/auto-capture.js";
import { normalizeSuggestedLabel } from "./services/auto-classifier.js";
import { parseClassificationResponse } from "./services/classification.js";
import { getRoot, isStructuredForConsolidation, runConsolidate, unionFind } from "./services/consolidation.js";
import { extractStructuredFields } from "./services/fact-extraction.js";
import {
  dotProductSimilarity,
  loadReflectionDedupeCorpusVectors,
  normalizeVector,
  parsePatternsFromReflectionResponse,
} from "./services/reflection.js";
import { AliasDB, generateAliases, searchAliasStrategy, storeAliases } from "./services/retrieval-aliases.js";
import { findSimilarByEmbedding } from "./services/vector-search.js";
import { PLUGIN_ID } from "./utils/constants.js";
import { parseSourceDate } from "./utils/dates.js";
import { calculateExpiry, classifyDecay } from "./utils/decay.js";
import { isHybridMemJsonInvocation } from "./utils/hybrid-mem-json-cli.js";

export { isHybridMemJsonInvocation };
import {
  extractTags,
  normalizeTextForDedupe,
  normalizedHash,
  parseTags,
  serializeTags,
  tagsContains,
} from "./utils/tags.js";
import {
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  truncateForStorage,
  truncateText,
} from "./utils/text.js";
import { CredentialsDB, decryptValue, deriveKey, encryptValue } from "./backends/credentials-db.js";
import { CrystallizationStore } from "./backends/crystallization-store.js";
import { EventBus, computeFingerprint } from "./backends/event-bus.js";
import { EventLog } from "./backends/event-log.js";
import { IssueStore } from "./backends/issue-store.js";
import { LearningsDB } from "./backends/learnings-db.js";
import { ProposalsDB } from "./backends/proposals-db.js";
import { ToolProposalStore } from "./backends/tool-proposal-store.js";
import {
  WorkflowStore,
  extractGoalKeywords,
  hashToolSequence,
  sequenceDistance,
  sequenceSimilarity,
} from "./backends/workflow-store.js";
import { CrystallizationProposer } from "./services/crystallization-proposer.js";
import { GapDetector, computeGapId, deriveToolNameFromSequence } from "./services/gap-detector.js";
import {
  computeEvidenceHash,
  computeLegacyEvidenceHash,
  computePatternId,
  detectCrystallizationCandidates,
  scorePattern,
} from "./services/pattern-detector.js";
import { ProvenanceService } from "./services/provenance.js";
import { crystallizeSkill, deriveSkillName, isExecOnlySequence } from "./services/skill-crystallizer.js";
import { SkillValidator, buildNonPlaceholderEmailPattern } from "./services/skill-validator.js";
import { ToolProposer } from "./services/tool-proposer.js";
import { VerificationError, VerificationStore, shouldAutoVerify } from "./services/verification-store.js";
import { WorkflowTracker } from "./services/workflow-tracker.js";

import { detectCategory, runMemoryHybridRegister } from "./setup/register-plugin.js";
import { isHybridMemHelpInvocation } from "./index-help.js";
export { isHybridMemHelpInvocation };

// Plugin Definition

const memoryHybridPlugin = {
  id: PLUGIN_ID,
  name: "Memory (Hybrid: SQLite + LanceDB)",
  description: "Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  kind: "memory" as const,
  configSchema: hybridConfigSchema,
  versionInfo,

  register(api: ClawdbotPluginApi) {
    runMemoryHybridRegister(api);
  },
};

// Export internal functions and classes for testing
export const _testing = {
  // Utility functions
  normalizeTextForDedupe,
  normalizedHash,
  truncateText,
  truncateForStorage,
  isHybridMemHelpInvocation,
  isHybridMemJsonInvocation,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
  parseSourceDate,
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  classifyDecay,
  calculateExpiry,
  extractStructuredFields,
  detectCategory,
  detectCredentialPatterns,
  extractCredentialMatch,
  isCredentialLike,
  inferServiceFromText,
  isStructuredForConsolidation,
  runConsolidate,
  normalizeSuggestedLabel,
  unionFind,
  getRoot,
  mergeResults,
  filterByScope,
  safeEmbed,
  deepMerge,
  buildInstallDefaults,
  // Encryption primitives (used by CredentialsDB)
  deriveKey,
  encryptValue,
  decryptValue,
  // Classes for testing
  FactsDB,
  CredentialsDB,
  ProposalsDB,
  EventLog,
  EventBus,
  computeFingerprint,
  VectorDB,
  Embeddings,
  WriteAheadLog,
  // Classification (for tests)
  parseClassificationResponse,
  findSimilarByEmbedding,
  // Reflection parsing (for tests) - re-exported from service
  parsePatternsFromReflectionResponse,
  loadReflectionDedupeCorpusVectors,
  normalizeVector,
  dotProductSimilarity,
  // FTS5 search service (Issue #151)
  searchFts,
  rebuildFtsIndex,
  buildFts5Query,
  // RRF scoring pipeline (Issue #152)
  fuseResults,
  applyPostRrfAdjustments,
  RRF_K_DEFAULT,
  runExplicitDeepRetrieval,
  packIntoBudget,
  serializeFactForContext,
  estimateTokenCount,
  DEFAULT_RETRIEVAL_CONFIG,
  // GraphRAG retrieval (Issue #145)
  expandGraph,
  formatLinkPath,
  HOP_SCORE_DECAY,
  // Shortest-path traversal (Issue #140)
  findShortestPath,
  resolveInput,
  formatPath,
  // Knowledge gap analysis (Issue #141)
  analyzeKnowledgeGaps,
  detectOrphans,
  detectWeak,
  detectSuggestedLinks,
  computeIsolationScore,
  computeRankScore,
  // Topic cluster detection (Issue #146)
  detectClusters,
  generateClusterLabel,
  // Retrieval aliases (Issue #149)
  AliasDB,
  generateAliases,
  storeAliases,
  searchAliasStrategy,
  // Issue lifecycle tracking (Issue #137)
  IssueStore,
  // Workflow trace tracking (Issue #209)
  WorkflowStore,
  WorkflowTracker,
  sequenceDistance,
  sequenceSimilarity,
  extractGoalKeywords,
  hashToolSequence,
  // Workflow crystallization (Issue #208)
  CrystallizationStore,
  detectCrystallizationCandidates,
  crystallizeSkill,
  SkillValidator,
  buildNonPlaceholderEmailPattern,
  CrystallizationProposer,
  computePatternId,
  computeEvidenceHash,
  computeLegacyEvidenceHash,
  scorePattern,
  deriveSkillName,
  isExecOnlySequence,
  // Plugin self-extension (Issue #210)
  ToolProposalStore,
  GapDetector,
  ToolProposer,
  computeGapId,
  deriveToolNameFromSequence,
  // Verification store for critical facts (Issue #162)
  VerificationStore,
  shouldAutoVerify,
  VerificationError,
  // Provenance tracing (Issue #163)
  ProvenanceService,
  // Learnings intake buffer — staged memory promotion (Issue #617)
  LearningsDB,
};

export { versionInfo } from "./versionInfo.js";
export {
  sanitizeMessagesForClaude,
  sanitizeMessagesForOpenAIResponses,
  type MessageLike,
} from "./utils/sanitize-messages.js";
export { getHybridMemoryContextBudgetHint } from "./services/context-budget.js";
export type { ContradictionRecord } from "./backends/facts-db.js";
export type { RetrievalPipelineOptions } from "./services/retrieval-orchestrator.js";
export default memoryHybridPlugin;
