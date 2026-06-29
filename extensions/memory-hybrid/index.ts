import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import { hybridConfigSchema } from "./config/hybrid-schema.js";
import { versionInfo } from "./versionInfo.js";
import { PLUGIN_ID } from "./utils/constants.js";
import { runMemoryHybridRegister } from "./setup/register-plugin.js";
import { isHybridMemHelpInvocation } from "./index-help.js";

export { isHybridMemHelpInvocation };
export { isHybridMemCredentialsOnlyInvocation } from "./index-credentials-cli.js";
export { isHybridMemUpgradeOnlyInvocation } from "./index-upgrade-cli.js";
export {
  isHybridMemJsonInvocation,
  isHybridMemCredentialsValueOnlyInvocation,
  isHybridMemMachineOutputInvocation,
} from "./utils/hybrid-mem-json-cli.js";
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
export type { ShortestPathResult, PathStep, ShortestPathLookup } from "./services/shortest-path.js";
export type {
  GapFact,
  SuggestedLink,
  KnowledgeGapReport,
  GapMode,
  GapFactsDB,
  GapVectorDB,
  GapEmbeddings,
} from "./services/knowledge-gaps.js";
export type {
  TopicCluster,
  ClusterDetectionResult,
  ClusterDetectionOptions,
  ClusterFactLookup,
} from "./services/topic-clusters.js";

export { _testing } from "./index-testing-exports.js";

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
