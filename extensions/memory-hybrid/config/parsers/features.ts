import { DEFAULT_GLITCHTIP_DSN } from "../../services/error-reporter.js";
import { DEFAULT_PLACEHOLDER_EMAIL_DOMAINS } from "../../services/skill-validator.js";
import { pluginLogger } from "../../utils/logger.js";
import { resolveOpenClawGatewayRootUrlFromEnv } from "../../utils/openclaw-gateway-http.js";
import type { SectionDefinition, SectionTaxonomyOverrides } from "../skill-sections.js";
import type { PersonaProposalsConfig, WorkshopConfig } from "../types/agents.js";
import { PERSONA_PROPOSAL_TARGET_FILES, type PersonaProposalTargetFile } from "../types/agents.js";
import type {
  AliasesConfig,
  AmbientConfig,
  ApiTapConfig,
  ClosedLoopConfig,
  ClustersConfig,
  ContactsConfig,
  CostTrackingConfig,
  CrossAgentLearningConfig,
  CrystallizationConfig,
  DashboardConfig,
  DigestAutopilotConfig,
  DigestConfig,
  DigestWeeklyDeliveryConfig,
  DocumentsConfig,
  EntityExtractionConfig,
  FrequencyCaptureConfig,
  FrustrationDetectionConfig,
  FrustrationSignalWeights,
  FutureDateProtectionConfig,
  GapsConfig,
  GraphConfig,
  GraphRetrievalConfig,
  HumanizerConfig,
  ImplicitFeedbackConfig,
  ImplicitSignalType,
  IngestConfig,
  LifecycleAdaptersConfig,
  MemoryTieringConfig,
  ReinforcementConfig,
  SelfExtensionConfig,
  ToolEffectivenessConfig,
  WorkflowTrackingConfig,
} from "../types/features.js";
import type { ErrorReportingConfig, MultiAgentConfig } from "../types/index.js";
import { DEFAULT_WIKI_INTEGRATION_CONFIG, type WikiIntegrationConfig } from "../types/wiki-integration.js";
import {
  DEFAULT_WORKBOARD_COLUMNS,
  DEFAULT_WORKBOARD_CONFIG,
  type WorkboardColumnMapping,
  type WorkboardConfig,
} from "../types/workboard.js";

export function parseEntityExtractionConfig(cfg: Record<string, unknown>): EntityExtractionConfig {
  const raw = cfg.entityExtraction as Record<string, unknown> | undefined;
  const stopWords = Array.isArray(raw?.stopWords)
    ? [
        ...new Set(
          (raw.stopWords as unknown[])
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return { stopWords };
}

export function parseContactsConfig(cfg: Record<string, unknown>): ContactsConfig {
  const raw = cfg.contacts as Record<string, unknown> | undefined;
  const importPath = typeof raw?.importPath === "string" && raw.importPath.trim() ? raw.importPath.trim() : null;
  return {
    profileEnrichment: raw?.profileEnrichment !== false,
    requireSurname: raw?.requireSurname === true,
    importPath,
  };
}

function parseUnitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
}

export function parseGraphConfig(cfg: Record<string, unknown>): GraphConfig {
  const graphRaw = cfg.graph as Record<string, unknown> | undefined;
  const legacyMinScore = graphRaw?.autoLinkMinScore;
  const autoLinkStrength = parseUnitInterval(graphRaw?.autoLinkStrength ?? legacyMinScore, 0.7);
  const autoLinkSimilarityThreshold = parseUnitInterval(graphRaw?.autoLinkSimilarityThreshold ?? legacyMinScore, 0.7);
  if (
    legacyMinScore !== undefined &&
    graphRaw?.autoLinkStrength === undefined &&
    graphRaw?.autoLinkSimilarityThreshold === undefined
  ) {
    pluginLogger.warn?.(
      "memory-hybrid: graph.autoLinkMinScore is deprecated — use graph.autoLinkStrength (RELATED_TO weight) and graph.autoLinkSimilarityThreshold (embedding cosine gate).",
    );
  }
  return {
    enabled: graphRaw?.enabled !== false,
    autoLink: graphRaw?.autoLink === true,
    autoLinkStrength,
    autoLinkSimilarityThreshold,
    autoLinkMinScore: autoLinkStrength,
    autoLinkLimit:
      typeof graphRaw?.autoLinkLimit === "number" && graphRaw.autoLinkLimit > 0
        ? Math.floor(graphRaw.autoLinkLimit)
        : 3,
    maxTraversalDepth:
      typeof graphRaw?.maxTraversalDepth === "number" && graphRaw.maxTraversalDepth > 0
        ? Math.floor(graphRaw.maxTraversalDepth)
        : 2,
    useInRecall: graphRaw?.useInRecall !== false,
    coOccurrenceWeight:
      typeof graphRaw?.coOccurrenceWeight === "number" &&
      graphRaw.coOccurrenceWeight >= 0 &&
      graphRaw.coOccurrenceWeight <= 1
        ? graphRaw.coOccurrenceWeight
        : 0.3,
    autoSupersede: graphRaw?.autoSupersede !== false,
    strengthenOnRecall: graphRaw?.strengthenOnRecall === true,
    hubDegreeCap:
      graphRaw?.hubDegreeCap === null
        ? null
        : typeof graphRaw?.hubDegreeCap === "number" && graphRaw.hubDegreeCap > 0
          ? Math.floor(graphRaw.hubDegreeCap)
          : 500,
    hubScorePenalty:
      typeof graphRaw?.hubScorePenalty === "number" && graphRaw.hubScorePenalty > 0 && graphRaw.hubScorePenalty < 1
        ? graphRaw.hubScorePenalty
        : null,
  };
}

export function parseGraphRetrievalConfig(cfg: Record<string, unknown>): GraphRetrievalConfig {
  const graphRetrievalRaw = cfg.graphRetrieval as Record<string, unknown> | undefined;
  return {
    enabled: graphRetrievalRaw?.enabled !== false,
    defaultExpand: graphRetrievalRaw?.defaultExpand === true,
    maxExpandDepth:
      typeof graphRetrievalRaw?.maxExpandDepth === "number" && graphRetrievalRaw.maxExpandDepth >= 0
        ? Math.min(5, Math.floor(graphRetrievalRaw.maxExpandDepth))
        : 3,
    maxExpandedResults:
      typeof graphRetrievalRaw?.maxExpandedResults === "number" && graphRetrievalRaw.maxExpandedResults >= 0
        ? Math.min(50, Math.floor(graphRetrievalRaw.maxExpandedResults))
        : 20,
  };
}

export function parseClustersConfig(cfg: Record<string, unknown>): ClustersConfig {
  const clustersRaw = cfg.clusters as Record<string, unknown> | undefined;
  return {
    enabled: clustersRaw?.enabled !== false,
    minClusterSize:
      typeof clustersRaw?.minClusterSize === "number" && clustersRaw.minClusterSize >= 1
        ? Math.floor(clustersRaw.minClusterSize)
        : 3,
    refreshIntervalDays:
      typeof clustersRaw?.refreshIntervalDays === "number" && clustersRaw.refreshIntervalDays >= 0
        ? Math.floor(clustersRaw.refreshIntervalDays)
        : 7,
    labelModel:
      typeof clustersRaw?.labelModel === "string" && clustersRaw.labelModel.trim().length > 0
        ? clustersRaw.labelModel.trim()
        : null,
  };
}

export function parseGapsConfig(cfg: Record<string, unknown>): GapsConfig {
  const gapsRaw = cfg.gaps as Record<string, unknown> | undefined;
  return {
    enabled: gapsRaw?.enabled !== false,
    similarityThreshold:
      typeof gapsRaw?.similarityThreshold === "number" &&
      gapsRaw.similarityThreshold >= 0 &&
      gapsRaw.similarityThreshold <= 1
        ? gapsRaw.similarityThreshold
        : 0.8,
  };
}

export function parseAliasesConfig(cfg: Record<string, unknown>): AliasesConfig {
  const aliasesRaw = cfg.aliases as Record<string, unknown> | undefined;
  return {
    enabled: aliasesRaw?.enabled === true,
    maxAliases:
      typeof aliasesRaw?.maxAliases === "number" && aliasesRaw.maxAliases > 0
        ? Math.min(10, Math.floor(aliasesRaw.maxAliases))
        : 5,
    model: typeof aliasesRaw?.model === "string" ? aliasesRaw.model : undefined,
  };
}

export function parseIngestConfig(cfg: Record<string, unknown>): IngestConfig | undefined {
  const ingestRaw = cfg.ingest as Record<string, unknown> | undefined;
  if (!ingestRaw || !Array.isArray(ingestRaw.paths) || ingestRaw.paths.length === 0) return undefined;
  return {
    paths: (ingestRaw.paths as string[]).filter((p) => typeof p === "string" && p.length > 0),
    chunkSize:
      typeof ingestRaw.chunkSize === "number" && ingestRaw.chunkSize > 0 ? Math.floor(ingestRaw.chunkSize) : 800,
    overlap: typeof ingestRaw.overlap === "number" && ingestRaw.overlap >= 0 ? Math.floor(ingestRaw.overlap) : 100,
  };
}

export function parseMemoryTieringConfig(cfg: Record<string, unknown>): MemoryTieringConfig {
  const tierRaw = cfg.memoryTiering as Record<string, unknown> | undefined;
  const hotByRecallRaw = tierRaw?.hotByRecall as Record<string, unknown> | undefined;
  return {
    enabled: tierRaw?.enabled !== false,
    hotMaxTokens:
      typeof tierRaw?.hotMaxTokens === "number" && tierRaw.hotMaxTokens > 0 ? Math.floor(tierRaw.hotMaxTokens) : 2000,
    compactionOnSessionEnd: tierRaw?.compactionOnSessionEnd !== false,
    inactivePreferenceDays:
      typeof tierRaw?.inactivePreferenceDays === "number" && tierRaw.inactivePreferenceDays >= 0
        ? Math.floor(tierRaw.inactivePreferenceDays)
        : 7,
    hotMaxFacts:
      typeof tierRaw?.hotMaxFacts === "number" && tierRaw.hotMaxFacts > 0 ? Math.floor(tierRaw.hotMaxFacts) : 50,
    coldAfterInactivityDays:
      typeof tierRaw?.coldAfterInactivityDays === "number" && tierRaw.coldAfterInactivityDays >= 0
        ? Math.floor(tierRaw.coldAfterInactivityDays)
        : 30,
    hotMinAccessCount:
      typeof tierRaw?.hotMinAccessCount === "number" && tierRaw.hotMinAccessCount > 0
        ? Math.floor(tierRaw.hotMinAccessCount)
        : 3,
    hotAccessWindowDays:
      typeof tierRaw?.hotAccessWindowDays === "number" && tierRaw.hotAccessWindowDays >= 0
        ? Math.floor(tierRaw.hotAccessWindowDays)
        : 7,
    hotPreferenceImportance:
      typeof tierRaw?.hotPreferenceImportance === "number" && tierRaw.hotPreferenceImportance >= 0
        ? Math.min(1, tierRaw.hotPreferenceImportance)
        : 0.7,
    hotByRecall: {
      windowDays:
        typeof hotByRecallRaw?.windowDays === "number" && hotByRecallRaw.windowDays >= 0
          ? Math.floor(hotByRecallRaw.windowDays)
          : 7,
      topN: typeof hotByRecallRaw?.topN === "number" && hotByRecallRaw.topN >= 0 ? Math.floor(hotByRecallRaw.topN) : 20,
    },
    structuralByCategory: tierRaw?.structuralByCategory !== false,
    structuralPermanent: tierRaw?.structuralPermanent === true,
  };
}

export function parseAmbientConfig(cfg: Record<string, unknown>): AmbientConfig {
  const ambientRaw = cfg.ambient as Record<string, unknown> | undefined;
  return {
    enabled: ambientRaw?.enabled === true,
    multiQuery: ambientRaw?.multiQuery === true,
    topicShiftThreshold:
      typeof ambientRaw?.topicShiftThreshold === "number" &&
      ambientRaw.topicShiftThreshold >= 0 &&
      ambientRaw.topicShiftThreshold <= 2
        ? ambientRaw.topicShiftThreshold
        : 0.4,
    maxQueriesPerTrigger:
      typeof ambientRaw?.maxQueriesPerTrigger === "number" && ambientRaw.maxQueriesPerTrigger >= 1
        ? Math.min(4, Math.floor(ambientRaw.maxQueriesPerTrigger))
        : 4,
    budgetTokens:
      typeof ambientRaw?.budgetTokens === "number" && ambientRaw.budgetTokens > 0
        ? Math.floor(ambientRaw.budgetTokens)
        : 2000,
  };
}

export function parseReinforcementConfig(cfg: Record<string, unknown>): ReinforcementConfig {
  const reinforcementRaw = cfg.reinforcement as Record<string, unknown> | undefined;
  const scRaw = cfg.selfCorrection as Record<string, unknown> | undefined;
  const readReinforcementField = <T>(
    reinfKey: keyof ReinforcementConfig,
    scKey: string,
    parse: (v: unknown) => T | undefined,
    fallback: T,
  ): T => {
    const fromReinf = reinforcementRaw ? parse(reinforcementRaw[reinfKey as string]) : undefined;
    if (fromReinf !== undefined) return fromReinf;
    const fromSc = scRaw ? parse(scRaw[scKey]) : undefined;
    if (fromSc !== undefined) {
      if (reinforcementRaw && reinforcementRaw[reinfKey as string] === undefined && scRaw?.[scKey] !== undefined) {
        pluginLogger.warn(
          `memory-hybrid: selfCorrection.${scKey} is deprecated — use reinforcement.${String(reinfKey)} instead.`,
        );
      }
      return fromSc;
    }
    return fallback;
  };
  return {
    enabled: reinforcementRaw?.enabled !== false,
    passiveBoost:
      typeof reinforcementRaw?.passiveBoost === "number" &&
      reinforcementRaw.passiveBoost >= 0 &&
      reinforcementRaw.passiveBoost <= 1
        ? reinforcementRaw.passiveBoost
        : 0.1,
    activeBoost:
      typeof reinforcementRaw?.activeBoost === "number" &&
      reinforcementRaw.activeBoost >= 0 &&
      reinforcementRaw.activeBoost <= 1
        ? reinforcementRaw.activeBoost
        : 0.05,
    maxConfidence:
      typeof reinforcementRaw?.maxConfidence === "number" &&
      reinforcementRaw.maxConfidence > 0 &&
      reinforcementRaw.maxConfidence <= 1
        ? reinforcementRaw.maxConfidence
        : 1.0,
    similarityThreshold:
      typeof reinforcementRaw?.similarityThreshold === "number" &&
      reinforcementRaw.similarityThreshold > 0 &&
      reinforcementRaw.similarityThreshold <= 1
        ? reinforcementRaw.similarityThreshold
        : 0.85,
    maxEventsPerFact:
      typeof reinforcementRaw?.maxEventsPerFact === "number" && reinforcementRaw.maxEventsPerFact > 0
        ? Math.floor(reinforcementRaw.maxEventsPerFact)
        : 50,
    diversityWeight:
      typeof reinforcementRaw?.diversityWeight === "number" && reinforcementRaw.diversityWeight >= 0
        ? Math.min(1.0, reinforcementRaw.diversityWeight)
        : 1.0,
    trackContext: reinforcementRaw?.trackContext !== false,
    boostAmount:
      typeof reinforcementRaw?.boostAmount === "number" && reinforcementRaw.boostAmount > 0
        ? reinforcementRaw.boostAmount
        : 1.0,
    positiveRulesSection: readReinforcementField(
      "positiveRulesSection",
      "positiveRulesSection",
      (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined),
      "Positive Reinforcement Rules",
    ),
    reinforcementLLMAnalysis: readReinforcementField(
      "reinforcementLLMAnalysis",
      "reinforcementLLMAnalysis",
      (v) => (typeof v === "boolean" ? v : undefined),
      true,
    ),
    reinforcementToProposals: readReinforcementField(
      "reinforcementToProposals",
      "reinforcementToProposals",
      (v) => (typeof v === "boolean" ? v : undefined),
      true,
    ),
    analysisBatchSize: (() => {
      const raw =
        typeof reinforcementRaw?.analysisBatchSize === "number"
          ? reinforcementRaw.analysisBatchSize
          : typeof scRaw?.analysisBatchSize === "number"
            ? scRaw.analysisBatchSize
            : undefined;
      if (
        raw !== undefined &&
        reinforcementRaw?.analysisBatchSize === undefined &&
        scRaw?.analysisBatchSize !== undefined
      ) {
        pluginLogger.warn(
          "memory-hybrid: selfCorrection.analysisBatchSize is deprecated — use reinforcement.analysisBatchSize instead.",
        );
      }
      return typeof raw === "number" && raw >= 1 ? Math.floor(raw) : undefined;
    })(),
    maxIncidentsPerRun: readReinforcementField(
      "maxIncidentsPerRun",
      "maxIncidentsPerRun",
      (v) => (typeof v === "number" && v >= 1 ? Math.floor(v) : undefined),
      100,
    ),
    model:
      typeof reinforcementRaw?.model === "string" && reinforcementRaw.model.trim().length > 0
        ? reinforcementRaw.model.trim()
        : undefined,
    thinking:
      reinforcementRaw?.thinking === "adaptive" || reinforcementRaw?.thinking === "disabled"
        ? reinforcementRaw.thinking
        : undefined,
  };
}

export function parseFutureDateProtectionConfig(cfg: Record<string, unknown>): FutureDateProtectionConfig {
  const fdpRaw = cfg.futureDateProtection as Record<string, unknown> | undefined;
  return {
    enabled: fdpRaw?.enabled !== false, // default: true
    // Fix #5: 0 means "no limit"; only fall back to 365 when value is absent/negative/non-number
    maxFreezeDays:
      typeof fdpRaw?.maxFreezeDays === "number" && fdpRaw.maxFreezeDays >= 0 ? Math.floor(fdpRaw.maxFreezeDays) : 365,
  };
}

export function parseDocumentsConfig(cfg: Record<string, unknown>): DocumentsConfig {
  const documentsRaw = cfg.documents as Record<string, unknown> | undefined;
  const chunkSize =
    typeof documentsRaw?.chunkSize === "number" && documentsRaw.chunkSize >= 100
      ? Math.floor(documentsRaw.chunkSize)
      : 2000;
  const chunkOverlap =
    typeof documentsRaw?.chunkOverlap === "number" && documentsRaw.chunkOverlap >= 0
      ? Math.floor(documentsRaw.chunkOverlap)
      : 200;
  return {
    enabled: documentsRaw?.enabled === true,
    pythonPath:
      typeof documentsRaw?.pythonPath === "string" && documentsRaw.pythonPath.trim().length > 0
        ? documentsRaw.pythonPath.trim()
        : "python3",
    chunkSize,
    chunkOverlap: Math.min(chunkOverlap, Math.max(0, chunkSize - 100)),
    maxDocumentSize:
      typeof documentsRaw?.maxDocumentSize === "number" && documentsRaw.maxDocumentSize > 0
        ? Math.floor(documentsRaw.maxDocumentSize)
        : 50 * 1024 * 1024,
    autoTag: documentsRaw?.autoTag !== false,
    visionEnabled: documentsRaw?.visionEnabled === true,
    visionModel:
      typeof documentsRaw?.visionModel === "string" && documentsRaw.visionModel.trim().length > 0
        ? documentsRaw.visionModel.trim()
        : undefined,
    allowedPaths: Array.isArray(documentsRaw?.allowedPaths)
      ? (documentsRaw.allowedPaths as string[])
          .filter((p) => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
      : undefined,
  };
}

export function parsePersonaProposalsConfig(cfg: Record<string, unknown>): PersonaProposalsConfig {
  const proposalsRaw = cfg.personaProposals as Record<string, unknown> | undefined;
  return {
    enabled: proposalsRaw?.enabled === true,
    autoApply: proposalsRaw?.autoApply === true,
    allowedFiles: (() => {
      if (!Array.isArray(proposalsRaw?.allowedFiles)) {
        return [...PERSONA_PROPOSAL_TARGET_FILES];
      }
      // An explicitly configured empty array (or one that filters down to empty) means the
      // operator locked persona proposals out of every file — respect that instead of
      // silently reopening the full default allowlist (same class as maintenance.
      // privacyRedaction.exemptCategories/exemptKeys).
      return (proposalsRaw.allowedFiles as string[]).filter((f) =>
        PERSONA_PROPOSAL_TARGET_FILES.includes(f as PersonaProposalTargetFile),
      ) as PersonaProposalTargetFile[];
    })(),
    maxProposalsPerWeek:
      typeof proposalsRaw?.maxProposalsPerWeek === "number" && proposalsRaw.maxProposalsPerWeek > 0
        ? Math.floor(proposalsRaw.maxProposalsPerWeek)
        : 5,
    minConfidence:
      typeof proposalsRaw?.minConfidence === "number" &&
      proposalsRaw.minConfidence >= 0 &&
      proposalsRaw.minConfidence <= 1
        ? proposalsRaw.minConfidence
        : 0.7,
    proposalTTLDays:
      typeof proposalsRaw?.proposalTTLDays === "number" && proposalsRaw.proposalTTLDays >= 0
        ? Math.floor(proposalsRaw.proposalTTLDays)
        : 30,
    minSessionEvidence:
      typeof proposalsRaw?.minSessionEvidence === "number" && proposalsRaw.minSessionEvidence > 0
        ? Math.floor(proposalsRaw.minSessionEvidence)
        : 10,
    requireScopeFilter: proposalsRaw?.requireScopeFilter === true,
    separateSelfCorrectionQuota: proposalsRaw?.separateSelfCorrectionQuota !== false,
    workshopMaxPending:
      typeof proposalsRaw?.workshopMaxPending === "number" && proposalsRaw.workshopMaxPending >= 0
        ? Math.floor(proposalsRaw.workshopMaxPending)
        : undefined,
    personaRuleRouting: parsePersonaRuleRoutingConfig(proposalsRaw),
  };
}

function parsePersonaRuleRoutingConfig(
  proposalsRaw: Record<string, unknown> | undefined,
): PersonaProposalsConfig["personaRuleRouting"] {
  const raw = proposalsRaw?.personaRuleRouting as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const semanticRaw = raw.semanticDedup as Record<string, unknown> | undefined;
  const out: NonNullable<PersonaProposalsConfig["personaRuleRouting"]> = {};
  if (raw.enabled === false) out.enabled = false;
  if (raw.enabled === true) out.enabled = true;
  if (raw.routingMode === "advisory" || raw.routingMode === "enforce") out.routingMode = raw.routingMode;
  if (semanticRaw?.enabled === true) out.semanticDedup = { enabled: true };
  if (semanticRaw?.enabled === false) out.semanticDedup = { enabled: false };
  if (typeof raw.dedupeThreshold === "number" && raw.dedupeThreshold > 0 && raw.dedupeThreshold <= 1) {
    out.dedupeThreshold = raw.dedupeThreshold;
  }
  if (typeof raw.nearDedupeThreshold === "number" && raw.nearDedupeThreshold > 0 && raw.nearDedupeThreshold <= 1) {
    out.nearDedupeThreshold = raw.nearDedupeThreshold;
  }
  if (
    typeof raw.contradictionThreshold === "number" &&
    raw.contradictionThreshold > 0 &&
    raw.contradictionThreshold <= 1
  ) {
    out.contradictionThreshold = raw.contradictionThreshold;
  }
  if (typeof raw.routingCacheTtlSeconds === "number" && raw.routingCacheTtlSeconds >= 0) {
    out.routingCacheTtlSeconds = Math.floor(raw.routingCacheTtlSeconds);
  }
  if (typeof raw.topK === "number" && raw.topK > 0) {
    out.topK = Math.floor(raw.topK);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseWorkshopConfig(cfg: Record<string, unknown>): WorkshopConfig | undefined {
  const raw = cfg.workshop as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const out: WorkshopConfig = {};
  if (raw.enabled === true) out.enabled = true;
  if (raw.enabled === false) out.enabled = false;
  if (raw.allowAgentMutations === true) out.allowAgentMutations = true;
  if (raw.allowAgentMutations === false) out.allowAgentMutations = false;
  if (typeof raw.maxPending === "number" && raw.maxPending >= 0) {
    out.maxPending = Math.floor(raw.maxPending);
  }
  if (typeof raw.sessionKey === "string" && raw.sessionKey.trim().length > 0) {
    out.sessionKey = raw.sessionKey.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseMultiAgentConfig(cfg: Record<string, unknown>): MultiAgentConfig {
  const multiAgentRaw = cfg.multiAgent as Record<string, unknown> | undefined;
  return {
    orchestratorId:
      typeof multiAgentRaw?.orchestratorId === "string" && multiAgentRaw.orchestratorId.trim().length > 0
        ? multiAgentRaw.orchestratorId.trim()
        : "main",
    defaultStoreScope: (() => {
      const scope = multiAgentRaw?.defaultStoreScope;
      if (scope === "agent" || scope === "auto") return scope;
      return "global"; // backward compatible default
    })(),
    strictAgentScoping: multiAgentRaw?.strictAgentScoping === true,
    trustToolScopeParams: multiAgentRaw?.trustToolScopeParams === true, // Default: false (secure by default)
  };
}

/**
 * Parse error reporting config. Error reporting and telemetry default to **opt-out** (enabled = true)
 * during the active development phase of this tool. This is a deliberate product decision:
 *
 * - During early development, crash reports and error telemetry are essential for quickly identifying
 *   and fixing issues across diverse user environments.
 * - The community DSN reports to a shared GlitchTip instance operated by the project maintainer.
 * - Users can opt out at any time by setting `errorReporting.enabled: false` or `errorReporting.consent: false`
 *   in their config.
 *
 * DESIGN DECISION: Opt-out (not opt-in) is intentional for the development phase.
 * This default SHOULD be revisited and switched to opt-in before a stable/production release.
 * Track this at: https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/600
 *
 * Do not change this default without an explicit product decision and changelog entry.
 */
export function parseErrorReportingConfig(cfg: Record<string, unknown>): ErrorReportingConfig {
  const errorReportingRaw = cfg.errorReporting as Record<string, unknown> | undefined;

  // When errorReporting is not specified: opt-out defaults (enabled + consent true, community DSN)
  if (!errorReportingRaw || typeof errorReportingRaw !== "object") {
    return {
      enabled: true, // opt-out during dev phase — see JSDoc above
      dsn: DEFAULT_GLITCHTIP_DSN,
      consent: true,
      mode: "community",
      sampleRate: 1.0,
      updateNudge: {
        enabled: true,
        intervalHours: 24,
        cacheTtlHours: 24,
      },
    };
  }

  // enabled defaults to true — user must explicitly set enabled: false to opt out
  let enabled = errorReportingRaw.enabled !== false; // opt-out: true unless user explicitly disables
  // consent defaults to true — user must explicitly set consent: false to opt out
  const consent = errorReportingRaw.consent !== false;
  const dsnRaw = typeof errorReportingRaw.dsn === "string" ? errorReportingRaw.dsn.trim() : "";
  const modeRaw = typeof errorReportingRaw.mode === "string" ? errorReportingRaw.mode : "community";
  const mode: "community" | "self-hosted" = modeRaw === "self-hosted" ? "self-hosted" : "community";

  if (enabled && !consent) {
    pluginLogger.warn("memory-hybrid: errorReporting.enabled=true but consent is false; disabling error reporting.");
    enabled = false;
  }

  // Validate DSN when enabled in self-hosted mode
  if (enabled && mode === "self-hosted") {
    if (!dsnRaw) {
      throw new Error(
        'errorReporting mode is "self-hosted" but dsn is empty or missing. ' +
          'Provide a valid DSN or switch to mode: "community".',
      );
    }
    // Reject placeholders
    const placeholderPatterns = /<key>|<host>|<project-id>|YOUR_DSN|PLACEHOLDER/i;
    if (placeholderPatterns.test(dsnRaw)) {
      throw new Error(
        "errorReporting.dsn contains placeholder values. " +
          'Replace <key>, <host>, <project-id> with actual values, or use mode: "community".',
      );
    }
  }

  // Optional botId: UUID format so GlitchTip can group errors by bot
  const botIdRaw = typeof errorReportingRaw.botId === "string" ? errorReportingRaw.botId.trim() : "";
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const botId = botIdRaw.length > 0 && uuidLike.test(botIdRaw) ? botIdRaw : undefined;

  // Optional friendly name for readable GlitchTip reports
  const botNameRaw = typeof errorReportingRaw.botName === "string" ? errorReportingRaw.botName.trim() : "";
  const botName = botNameRaw.length > 0 ? botNameRaw.slice(0, 64) : undefined;

  const updateNudgeRaw =
    errorReportingRaw.updateNudge && typeof errorReportingRaw.updateNudge === "object"
      ? (errorReportingRaw.updateNudge as Record<string, unknown>)
      : undefined;
  const updateNudge = {
    enabled: updateNudgeRaw?.enabled !== false,
    intervalHours:
      updateNudgeRaw?.intervalHours === 0
        ? 0
        : typeof updateNudgeRaw?.intervalHours === "number" && updateNudgeRaw.intervalHours > 0
          ? Math.min(24 * 30, updateNudgeRaw.intervalHours)
          : 24,
    cacheTtlHours:
      updateNudgeRaw?.cacheTtlHours === 0
        ? 0
        : typeof updateNudgeRaw?.cacheTtlHours === "number" && updateNudgeRaw.cacheTtlHours > 0
          ? Math.min(24 * 30, updateNudgeRaw.cacheTtlHours)
          : 24,
  };

  // Optional resolvedIssues map for version-aware filtering
  const validVersionPattern = /^\d+\.\d+\.\d+/;
  const resolvedIssues =
    errorReportingRaw.resolvedIssues &&
    typeof errorReportingRaw.resolvedIssues === "object" &&
    !Array.isArray(errorReportingRaw.resolvedIssues)
      ? Object.fromEntries(
          Object.entries(errorReportingRaw.resolvedIssues).filter((entry): entry is [string, string] => {
            if (typeof entry[1] !== "string") return false;
            if (!validVersionPattern.test(entry[1])) {
              pluginLogger.warn(
                `memory-hybrid: errorReporting.resolvedIssues["${entry[0]}"] has invalid version "${entry[1]}" — skipped.`,
              );
              return false;
            }
            return true;
          }),
        )
      : undefined;

  return {
    enabled,
    consent,
    mode,
    dsn: mode === "community" ? dsnRaw || DEFAULT_GLITCHTIP_DSN : dsnRaw || undefined,
    environment: typeof errorReportingRaw.environment === "string" ? errorReportingRaw.environment : undefined,
    sampleRate:
      typeof errorReportingRaw.sampleRate === "number" &&
      errorReportingRaw.sampleRate >= 0 &&
      errorReportingRaw.sampleRate <= 1
        ? errorReportingRaw.sampleRate
        : 1.0,
    botId,
    botName,
    resolvedIssues,
    updateNudge,
  };
}

export function parseWorkflowTrackingConfig(cfg: Record<string, unknown>): WorkflowTrackingConfig {
  const raw = cfg.workflowTracking as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    maxTracesPerDay:
      typeof raw?.maxTracesPerDay === "number" && raw.maxTracesPerDay > 0 ? Math.floor(raw.maxTracesPerDay) : 100,
    retentionDays: typeof raw?.retentionDays === "number" && raw.retentionDays > 0 ? Math.floor(raw.retentionDays) : 90,
    goalExtractionModel:
      typeof raw?.goalExtractionModel === "string" && raw.goalExtractionModel.trim().length > 0
        ? raw.goalExtractionModel.trim()
        : undefined,
  };
}

function parseSectionTaxonomyOverrides(raw: unknown): SectionTaxonomyOverrides | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: SectionTaxonomyOverrides = {};
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const sections: SectionDefinition[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const section = entry as Record<string, unknown>;
      const id = typeof section.id === "string" ? section.id.trim() : "";
      const label = typeof section.label === "string" ? section.label.trim() : "";
      const aliases = Array.isArray(section.aliases)
        ? (section.aliases as unknown[])
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
        : [];
      if (id.length > 0 && label.length > 0 && aliases.length > 0) {
        sections.push({ id, label, aliases: [...new Set(aliases)] });
      }
    }
    const normalizedCategory = category.trim();
    if (normalizedCategory.length > 0 && sections.length > 0) out[normalizedCategory] = sections;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseCrystallizationConfig(cfg: Record<string, unknown>): CrystallizationConfig {
  const raw = cfg.crystallization as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    minUsageCount: typeof raw?.minUsageCount === "number" && raw.minUsageCount > 0 ? Math.floor(raw.minUsageCount) : 5,
    minSuccessRate:
      typeof raw?.minSuccessRate === "number" && raw.minSuccessRate >= 0 && raw.minSuccessRate <= 1
        ? raw.minSuccessRate
        : 0.7,
    autoApprove: raw?.autoApprove === true,
    outputDir:
      typeof raw?.outputDir === "string" && raw.outputDir.trim().length > 0
        ? raw.outputDir.trim()
        : "~/.openclaw/workspace/skills/auto",
    maxCrystallized:
      typeof raw?.maxCrystallized === "number" && raw.maxCrystallized > 0 ? Math.floor(raw.maxCrystallized) : 50,
    pruneUnusedDays:
      typeof raw?.pruneUnusedDays === "number" && raw.pruneUnusedDays >= 0 ? Math.floor(raw.pruneUnusedDays) : 30,
    maxPendingProposals:
      typeof raw?.maxPendingProposals === "number" && raw.maxPendingProposals >= 0
        ? Math.floor(raw.maxPendingProposals)
        : 100,
    evidenceCountBucketSize:
      typeof raw?.evidenceCountBucketSize === "number" && raw.evidenceCountBucketSize >= 1
        ? Math.min(1000, Math.floor(raw.evidenceCountBucketSize))
        : 5,
    sectionTaxonomy: parseSectionTaxonomyOverrides(raw?.sectionTaxonomy),
    placeholderEmailDomains: (() => {
      const raw_domains = raw?.placeholderEmailDomains;
      if (!Array.isArray(raw_domains)) return [...DEFAULT_PLACEHOLDER_EMAIL_DOMAINS];
      const valid = raw_domains
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .map((d) => d.trim());
      return valid.length > 0 ? valid : [...DEFAULT_PLACEHOLDER_EMAIL_DOMAINS];
    })(),
    excludeSystemGoals: raw?.excludeSystemGoals !== false,
    excludeGoalPatterns: (() => {
      const rawPatterns = raw?.excludeGoalPatterns;
      if (!Array.isArray(rawPatterns)) return undefined;
      const valid = rawPatterns
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim());
      return valid.length > 0 ? valid : undefined;
    })(),
  };
}

export function parseSelfExtensionConfig(cfg: Record<string, unknown>): SelfExtensionConfig {
  const raw = cfg.selfExtension as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    minGapFrequency:
      typeof raw?.minGapFrequency === "number" && raw.minGapFrequency > 0 ? Math.floor(raw.minGapFrequency) : 3,
    minToolSavings:
      typeof raw?.minToolSavings === "number" && raw.minToolSavings > 0 ? Math.floor(raw.minToolSavings) : 2,
    maxProposals: typeof raw?.maxProposals === "number" && raw.maxProposals > 0 ? Math.floor(raw.maxProposals) : 20,
  };
}

const ALL_IMPLICIT_SIGNAL_TYPES: ImplicitSignalType[] = [
  "rephrase",
  "immediate_action",
  "topic_change",
  "grateful_close",
  "self_service",
  "escalation",
  "terse_response",
  "extended_engagement",
  "copy_paste",
  "correction_cascade",
  "silence_after_action",
];

export function parseImplicitFeedbackConfig(cfg: Record<string, unknown>): ImplicitFeedbackConfig {
  const raw = cfg.implicitFeedback as Record<string, unknown> | undefined;
  const validTypes = new Set<string>(ALL_IMPLICIT_SIGNAL_TYPES);
  const signalTypes: ImplicitSignalType[] = Array.isArray(raw?.signalTypes)
    ? (raw.signalTypes as unknown[]).filter((t): t is ImplicitSignalType => typeof t === "string" && validTypes.has(t))
    : ALL_IMPLICIT_SIGNAL_TYPES;

  // Issue #754: top-level aliases take precedence over nested keys
  const topLevelTrajectoryLLMAnalysis =
    typeof cfg.trajectoryLLMAnalysis === "boolean" ? cfg.trajectoryLLMAnalysis : undefined;
  const topLevelFeedToSelfCorrection =
    typeof cfg.feedToSelfCorrection === "boolean" ? cfg.feedToSelfCorrection : undefined;

  // Deprecation warnings for old nested keys when top-level is also set
  if (topLevelTrajectoryLLMAnalysis !== undefined && raw?.trajectoryLLMAnalysis !== undefined) {
    pluginLogger.warn(
      "memory-hybrid: both `trajectoryLLMAnalysis` (top-level) and `implicitFeedback.trajectoryLLMAnalysis` are set; " +
        "using top-level `trajectoryLLMAnalysis`. The nested key is deprecated — move it to the top level.",
    );
  }
  if (topLevelFeedToSelfCorrection !== undefined && raw?.feedToSelfCorrection !== undefined) {
    pluginLogger.warn(
      "memory-hybrid: both `feedToSelfCorrection` (top-level) and `implicitFeedback.feedToSelfCorrection` are set; " +
        "using top-level `feedToSelfCorrection`. The nested key is deprecated — move it to the top level.",
    );
  }

  return {
    enabled: raw?.enabled !== false,
    minConfidence:
      typeof raw?.minConfidence === "number" && raw.minConfidence >= 0 && raw.minConfidence <= 1
        ? raw.minConfidence
        : 0.5,
    signalTypes,
    rephraseThreshold:
      typeof raw?.rephraseThreshold === "number" && raw.rephraseThreshold > 0 && raw.rephraseThreshold <= 1
        ? raw.rephraseThreshold
        : 0.8,
    topicChangeThreshold:
      typeof raw?.topicChangeThreshold === "number" && raw.topicChangeThreshold >= 0 && raw.topicChangeThreshold <= 1
        ? raw.topicChangeThreshold
        : 0.3,
    terseResponseRatio:
      typeof raw?.terseResponseRatio === "number" && raw.terseResponseRatio > 0 && raw.terseResponseRatio <= 1
        ? raw.terseResponseRatio
        : 0.4,
    feedToReinforcement: raw?.feedToReinforcement !== false,
    // Issue #754: top-level takes precedence; fall back to nested with deprecation warning
    feedToSelfCorrection:
      topLevelFeedToSelfCorrection !== undefined ? topLevelFeedToSelfCorrection : raw?.feedToSelfCorrection !== false,
    maxLessonsPerDay:
      typeof raw?.maxLessonsPerDay === "number" && raw.maxLessonsPerDay >= 0
        ? Math.min(1000, Math.floor(raw.maxLessonsPerDay))
        : 50,
    lessonDedupeJaccard:
      typeof raw?.lessonDedupeJaccard === "number" && raw.lessonDedupeJaccard > 0 && raw.lessonDedupeJaccard <= 1
        ? raw.lessonDedupeJaccard
        : 0.7,
    autoCleanup: raw?.autoCleanup !== false,
    cleanupLimit:
      typeof raw?.cleanupLimit === "number" && raw.cleanupLimit >= 0
        ? Math.min(10000, Math.floor(raw.cleanupLimit))
        : 1000,
    maxSessionsPerRun:
      typeof raw?.maxSessionsPerRun === "number" && raw.maxSessionsPerRun >= 0
        ? Math.min(10000, Math.floor(raw.maxSessionsPerRun))
        : 50,
    maxSignalsPerRun:
      typeof raw?.maxSignalsPerRun === "number" && raw.maxSignalsPerRun >= 0
        ? Math.min(100000, Math.floor(raw.maxSignalsPerRun))
        : 100,
    maxTrajectoriesPerRun:
      typeof raw?.maxTrajectoriesPerRun === "number" && raw.maxTrajectoriesPerRun >= 0
        ? Math.min(10000, Math.floor(raw.maxTrajectoriesPerRun))
        : 50,
    maxWallClockSeconds:
      typeof raw?.maxWallClockSeconds === "number" && raw.maxWallClockSeconds >= 0
        ? Math.min(86400, Math.floor(raw.maxWallClockSeconds))
        : // 240s, not 300 (#2041): leaves margin below a common 300s external verification timeout
          // instead of exactly matching it — see cmd-feedback.ts's runExtractImplicitFeedbackForCli.
          240,
    trajectoryLLMAnalysis:
      topLevelTrajectoryLLMAnalysis !== undefined ? topLevelTrajectoryLLMAnalysis : raw?.trajectoryLLMAnalysis === true,
    llmSignalAnalysis: raw?.llmSignalAnalysis !== false,
    llmSignalBatchSize:
      typeof raw?.llmSignalBatchSize === "number" && raw.llmSignalBatchSize >= 1
        ? Math.min(50, Math.floor(raw.llmSignalBatchSize))
        : 10,
    triggerSelfCorrectionRun: raw?.triggerSelfCorrectionRun === true,
    selfCorrectionBridgeMaxIncidents:
      typeof raw?.selfCorrectionBridgeMaxIncidents === "number" && raw.selfCorrectionBridgeMaxIncidents >= 1
        ? Math.min(100, Math.floor(raw.selfCorrectionBridgeMaxIncidents))
        : 5,
    selfCorrectionBridgeMinConfidence:
      typeof raw?.selfCorrectionBridgeMinConfidence === "number" &&
      raw.selfCorrectionBridgeMinConfidence >= 0 &&
      raw.selfCorrectionBridgeMinConfidence <= 1
        ? raw.selfCorrectionBridgeMinConfidence
        : 0.7,
  };
}

export function parseClosedLoopConfig(cfg: Record<string, unknown>): ClosedLoopConfig {
  const raw = cfg.closedLoop as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled !== false,
    measurementWindowDays:
      typeof raw?.measurementWindowDays === "number" && raw.measurementWindowDays > 0
        ? Math.floor(raw.measurementWindowDays)
        : 7,
    minSampleSize: typeof raw?.minSampleSize === "number" && raw.minSampleSize > 0 ? Math.floor(raw.minSampleSize) : 5,
    autoDeprecateThreshold:
      typeof raw?.autoDeprecateThreshold === "number" ? Math.max(-1, Math.min(0, raw.autoDeprecateThreshold)) : -0.3,
    autoBoostThreshold:
      typeof raw?.autoBoostThreshold === "number" ? Math.max(0, Math.min(1, raw.autoBoostThreshold)) : 0.5,
    runInNightlyCycle: raw?.runInNightlyCycle !== false,
  };
}

export function parseFrustrationDetectionConfig(cfg: Record<string, unknown>): FrustrationDetectionConfig {
  const raw = cfg.frustrationDetection as Record<string, unknown> | undefined;

  // Parse optional signal weights
  const weightsRaw = raw?.signalWeights as Record<string, unknown> | undefined;
  let signalWeights: FrustrationSignalWeights | undefined;
  if (weightsRaw && typeof weightsRaw === "object") {
    const validSignals = [
      "short_reply",
      "imperative_tone",
      "repeated_instruction",
      "caps_or_emphasis",
      "explicit_frustration",
      "correction_frequency",
      "question_to_command",
      "reduced_context",
      "emoji_shift",
    ];
    const parsed: FrustrationSignalWeights = {};
    for (const sig of validSignals) {
      if (typeof weightsRaw[sig] === "number") {
        (parsed as Record<string, number>)[sig] = Math.max(0, Math.min(1, weightsRaw[sig] as number));
      }
    }
    if (Object.keys(parsed).length > 0) signalWeights = parsed;
  }

  const thresholdsRaw = raw?.adaptationThresholds as Record<string, unknown> | undefined;

  return {
    enabled: raw?.enabled === true,
    windowSize:
      typeof raw?.windowSize === "number" && raw.windowSize >= 2 && raw.windowSize <= 50
        ? Math.floor(raw.windowSize)
        : 8,
    decayRate: typeof raw?.decayRate === "number" && raw.decayRate > 0 && raw.decayRate <= 1 ? raw.decayRate : 0.85,
    signalWeights,
    injectionThreshold:
      typeof raw?.injectionThreshold === "number" && raw.injectionThreshold >= 0 && raw.injectionThreshold <= 1
        ? raw.injectionThreshold
        : 0.3,
    adaptationThresholds: {
      medium:
        typeof thresholdsRaw?.medium === "number" && thresholdsRaw.medium >= 0 && thresholdsRaw.medium <= 1
          ? thresholdsRaw.medium
          : 0.3,
      high:
        typeof thresholdsRaw?.high === "number" && thresholdsRaw.high >= 0 && thresholdsRaw.high <= 1
          ? thresholdsRaw.high
          : 0.5,
      critical:
        typeof thresholdsRaw?.critical === "number" && thresholdsRaw.critical >= 0 && thresholdsRaw.critical <= 1
          ? thresholdsRaw.critical
          : 0.7,
    },
    feedToImplicitPipeline: raw?.feedToImplicitPipeline !== false,
  };
}

export function parseCrossAgentLearningConfig(cfg: Record<string, unknown>): CrossAgentLearningConfig {
  const raw = cfg.crossAgentLearning as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    windowDays:
      typeof raw?.windowDays === "number" && raw.windowDays >= 1 ? Math.min(90, Math.floor(raw.windowDays)) : 14,
    model: typeof raw?.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined,
    fallbackModels: Array.isArray(raw?.fallbackModels)
      ? (raw.fallbackModels as string[]).filter((m) => typeof m === "string" && m.trim().length > 0)
      : undefined,
    batchSize: typeof raw?.batchSize === "number" && raw.batchSize >= 5 ? Math.min(100, Math.floor(raw.batchSize)) : 20,
    minSourceConfidence:
      typeof raw?.minSourceConfidence === "number" && raw.minSourceConfidence >= 0 && raw.minSourceConfidence <= 1
        ? raw.minSourceConfidence
        : 0.4,
    runInNightlyCycle: raw?.runInNightlyCycle !== false,
  };
}

export function parseToolEffectivenessConfig(cfg: Record<string, unknown>): ToolEffectivenessConfig {
  const raw = cfg.toolEffectiveness as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled !== false,
    minCalls: typeof raw?.minCalls === "number" && raw.minCalls >= 1 ? Math.floor(raw.minCalls) : 3,
    topN: typeof raw?.topN === "number" && raw.topN >= 1 ? Math.min(50, Math.floor(raw.topN)) : 10,
    lowScoreThreshold:
      typeof raw?.lowScoreThreshold === "number" && raw.lowScoreThreshold >= 0 && raw.lowScoreThreshold <= 1
        ? raw.lowScoreThreshold
        : 0.3,
    decayFactor:
      typeof raw?.decayFactor === "number" && raw.decayFactor > 0 && raw.decayFactor <= 1 ? raw.decayFactor : 0.95,
    runInNightlyCycle: raw?.runInNightlyCycle !== false,
    injectHints: raw?.injectHints !== false,
  };
}

export function parseCostTrackingConfig(cfg: Record<string, unknown>): CostTrackingConfig {
  const raw = cfg.costTracking as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled !== false,
    retainDays: typeof raw?.retainDays === "number" && raw.retainDays >= 1 ? Math.floor(raw.retainDays) : 90,
    pruneInNightlyCycle: raw?.pruneInNightlyCycle !== false,
  };
}

export function parseDashboardConfig(cfg: Record<string, unknown>): DashboardConfig {
  const raw = cfg.dashboard as Record<string, unknown> | undefined;
  const token = typeof raw?.token === "string" && raw.token.trim().length > 0 ? raw.token.trim() : undefined;
  return {
    enabled: raw?.enabled !== false,
    port: typeof raw?.port === "number" && raw.port >= 1024 && raw.port <= 65535 ? Math.floor(raw.port) : 7700,
    token,
    gitRepo: typeof raw?.gitRepo === "string" ? raw.gitRepo : undefined,
  };
}

export function parseApiTapConfig(cfg: Record<string, unknown>): ApiTapConfig {
  const raw = cfg.apiTap as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    captureTimeoutSeconds:
      typeof raw?.captureTimeoutSeconds === "number" && raw.captureTimeoutSeconds >= 5
        ? Math.min(300, Math.floor(raw.captureTimeoutSeconds))
        : 60,
    endpointTtlDays:
      typeof raw?.endpointTtlDays === "number" && raw.endpointTtlDays >= 1
        ? Math.min(365, Math.floor(raw.endpointTtlDays))
        : 30,
    maxEndpointsPerSession:
      typeof raw?.maxEndpointsPerSession === "number" && raw.maxEndpointsPerSession >= 1
        ? Math.min(500, Math.floor(raw.maxEndpointsPerSession))
        : 50,
    allowedPatterns: Array.isArray(raw?.allowedPatterns)
      ? (raw.allowedPatterns as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [],
    blockedPatterns: Array.isArray(raw?.blockedPatterns)
      ? (raw.blockedPatterns as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : ["**/*oauth*/**", "**/*auth*/**", "**/*login*/**", "**/*signin*/**", "**/*token*/**", "**/*password*/**"],
  };
}

export function parseHumanizerConfig(cfg: Record<string, unknown>): HumanizerConfig {
  const raw = cfg.humanizer as Record<string, unknown> | undefined;
  const maxTextLength =
    typeof raw?.maxTextLength === "number" && raw.maxTextLength >= 1
      ? Math.min(20_000, Math.floor(raw.maxTextLength))
      : 4000;
  const minTextLength =
    typeof raw?.minTextLength === "number" && raw.minTextLength >= 0
      ? Math.min(maxTextLength, Math.floor(raw.minTextLength))
      : 100;
  return {
    enabled: raw?.enabled === true,
    bin: typeof raw?.bin === "string" && raw.bin.trim().length > 0 ? raw.bin.trim() : "humanizer",
    minTextLength,
    maxTextLength,
    modelTag: typeof raw?.modelTag === "string" && raw.modelTag.trim().length > 0 ? raw.modelTag.trim() : undefined,
    skillTag: typeof raw?.skillTag === "string" && raw.skillTag.trim().length > 0 ? raw.skillTag.trim() : undefined,
  };
}

export function parseFrequencyCaptureConfig(cfg: Record<string, unknown>): FrequencyCaptureConfig {
  const raw = cfg.frequencyCapture as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    mentionThreshold:
      typeof raw?.mentionThreshold === "number" && raw.mentionThreshold >= 1 ? Math.floor(raw.mentionThreshold) : 3,
    lookbackSessions:
      typeof raw?.lookbackSessions === "number" && raw.lookbackSessions >= 1 ? Math.floor(raw.lookbackSessions) : 5,
    defaultImportance:
      typeof raw?.defaultImportance === "number" && raw.defaultImportance >= 0 && raw.defaultImportance <= 1
        ? raw.defaultImportance
        : 0.6,
    captureCredentials: raw?.captureCredentials !== false,
    ttlDays: typeof raw?.ttlDays === "number" && raw.ttlDays >= 1 ? Math.floor(raw.ttlDays) : 30,
  };
}

/** Safe parse for cron install paths that do not run the full hybrid config validator.
 * Issue #2056: prefer `mode: "none"` as the default so plugin-owned weekly-pending-digest
 * never installs with the unsafe `isolated + agentTurn + announce` shape that the OpenClaw
 * cron safety guard rejects. Operators who want announce delivery must opt in with
 * `mode: "telegram"` AND a non-empty `chatId`. The legacy `"system"` value is still
 * accepted as input for backwards compatibility but is normalized here to `"none"` because
 * the cron job resolver has no safe way to construct an explicit destination for it. */
export function parseDigestWeeklyDeliveryOnly(cfg: Record<string, unknown>): DigestWeeklyDeliveryConfig {
  const digest = cfg.digest as Record<string, unknown> | undefined;
  const weekly = digest?.weekly as Record<string, unknown> | undefined;
  const delivery = weekly?.delivery as Record<string, unknown> | undefined;
  const modeRaw = delivery?.mode;
  const valid = ["telegram", "system", "none"] as const;
  let mode: (typeof valid)[number] = "none";
  if (typeof modeRaw === "string" && (valid as readonly string[]).includes(modeRaw)) {
    mode = modeRaw as (typeof valid)[number];
  } else if (modeRaw !== undefined) {
    pluginLogger.warn(
      `memory-hybrid: invalid digest.weekly.delivery.mode "${modeRaw}"; expected telegram|none. Using "none".`,
    );
  }
  const chatId =
    typeof delivery?.chatId === "string" && delivery.chatId.trim().length > 0 ? delivery.chatId.trim() : undefined;
  if (mode === "telegram" && !chatId) {
    pluginLogger.warn(
      `memory-hybrid: digest.weekly.delivery.mode is "telegram" but chatId is missing; using "none".`,
    );
    return { mode: "none" };
  }
  if (mode === "system") {
    // Legacy/destinationless mode; the cron job resolver cannot safely emit an explicit
    // destination for it. Downgrade to "none" so issue #2056 cannot reintroduce the unsafe
    // shape on installations that still carry the old "system" config in their YAML/JSON.
    return { mode: "none" };
  }
  return { mode, ...(chatId ? { chatId } : {}) };
}

export function parseDigestConfig(cfg: Record<string, unknown>): DigestConfig {
  return {
    weekly: { delivery: parseDigestWeeklyDeliveryOnly(cfg) },
    autopilot: parseDigestAutopilotConfig(cfg),
  };
}

const DIGEST_AUTOPILOT_PERSONA_POLICIES = ["disabled", "report-only", "cautious", "apply-safe"] as const;
const DIGEST_AUTOPILOT_PROCEDURE_POLICIES = ["disabled", "report-only", "dry-run-skills", "auto-safe"] as const;
const DIGEST_AUTOPILOT_VERIFIED_POLICIES = ["disabled", "report-only", "classify", "apply-obvious"] as const;
const DIGEST_AUTOPILOT_READ_ONLY_POLICIES = ["disabled", "report-only", "classify"] as const;

function parseAutopilotPolicy<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
  field: string,
): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  if (value === undefined) return fallback;
  throw new Error(`Invalid digest.autopilot.${field}: ${String(value)}`);
}

function parseAutopilotPositiveInt(value: unknown, fallback: number, field: string, min = 1, max = 100_000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid digest.autopilot.${field}: ${String(value)}`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`Invalid digest.autopilot.${field}: ${String(value)}`);
  }
  return normalized;
}

function parseAutopilotStrictBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  if (value === false) return false;
  throw new Error(`Invalid digest.autopilot.${field}: expected boolean, received ${typeof value} (${String(value)})`);
}

export function parseDigestAutopilotConfig(cfg: Record<string, unknown>): DigestAutopilotConfig {
  const digest = cfg.digest as Record<string, unknown> | undefined;
  const autopilot = digest?.autopilot as Record<string, unknown> | undefined;
  const modeRaw = autopilot?.mode;
  const mode = modeRaw === "apply" ? "apply" : "dry-run";
  if (modeRaw !== undefined && modeRaw !== "apply" && modeRaw !== "dry-run") {
    throw new Error(`Invalid digest.autopilot.mode: ${String(modeRaw)}`);
  }
  const scheduleRaw = autopilot?.schedule;
  const schedule = "after-weekly-pending-digest" as const;
  if (scheduleRaw !== undefined && scheduleRaw !== schedule) {
    throw new Error(`Invalid digest.autopilot.schedule: ${String(scheduleRaw)}`);
  }

  return {
    enabled: parseAutopilotStrictBoolean(autopilot?.enabled, "enabled", false),
    mode,
    schedule,
    maxPersona: parseAutopilotPositiveInt(autopilot?.maxPersona, 20, "maxPersona", 0),
    maxProcedures: parseAutopilotPositiveInt(autopilot?.maxProcedures, 50, "maxProcedures", 0),
    maxVerified: parseAutopilotPositiveInt(autopilot?.maxVerified, 100, "maxVerified", 0),
    maxTools: parseAutopilotPositiveInt(autopilot?.maxTools, 50, "maxTools", 0),
    maxCrystallization: parseAutopilotPositiveInt(autopilot?.maxCrystallization, 50, "maxCrystallization", 0),
    personaPolicy: parseAutopilotPolicy(
      autopilot?.personaPolicy,
      DIGEST_AUTOPILOT_PERSONA_POLICIES,
      "cautious",
      "personaPolicy",
    ),
    procedurePolicy: parseAutopilotPolicy(
      autopilot?.procedurePolicy,
      DIGEST_AUTOPILOT_PROCEDURE_POLICIES,
      "auto-safe",
      "procedurePolicy",
    ),
    verifiedPolicy: parseAutopilotPolicy(
      autopilot?.verifiedPolicy,
      DIGEST_AUTOPILOT_VERIFIED_POLICIES,
      "classify",
      "verifiedPolicy",
    ),
    toolPolicy: parseAutopilotPolicy(
      autopilot?.toolPolicy,
      DIGEST_AUTOPILOT_READ_ONLY_POLICIES,
      "classify",
      "toolPolicy",
    ),
    crystallizationPolicy: parseAutopilotPolicy(
      autopilot?.crystallizationPolicy,
      DIGEST_AUTOPILOT_READ_ONLY_POLICIES,
      "classify",
      "crystallizationPolicy",
    ),
    notifyOnNoop: parseAutopilotStrictBoolean(autopilot?.notifyOnNoop, "notifyOnNoop", false),
    notifyOnDryRunActions: parseAutopilotStrictBoolean(
      autopilot?.notifyOnDryRunActions,
      "notifyOnDryRunActions",
      false,
    ),
    notifyOnApplyActions: parseAutopilotStrictBoolean(autopilot?.notifyOnApplyActions, "notifyOnApplyActions", true),
    notifyOnHumanReviewRequired: parseAutopilotStrictBoolean(
      autopilot?.notifyOnHumanReviewRequired,
      "notifyOnHumanReviewRequired",
      true,
    ),
    notifyOnFailure: parseAutopilotStrictBoolean(autopilot?.notifyOnFailure, "notifyOnFailure", true),
    guardWindowHours: parseAutopilotPositiveInt(autopilot?.guardWindowHours, 120, "guardWindowHours"),
    lockTtlMinutes: parseAutopilotPositiveInt(autopilot?.lockTtlMinutes, 120, "lockTtlMinutes"),
  };
}

export function parseLifecycleConfig(cfg: Record<string, unknown>): LifecycleAdaptersConfig {
  const raw = cfg.lifecycle as Record<string, unknown> | undefined;
  const adapters = raw?.adapters as Record<string, unknown> | undefined;
  const github = adapters?.github as Record<string, unknown> | undefined;
  const evolutionRaw = raw?.evolution as Record<string, unknown> | undefined;
  const fragmentRaw = (raw?.fragmentEmbedding ?? raw?.fragmentLevelEmbedding) as Record<string, unknown> | undefined;
  const halfLifeRaw = raw?.contentTypeHalfLives as Record<string, unknown> | undefined;
  const validAction = (value: unknown): "expire-now" | "expire-soon" | "keep-stable" | undefined =>
    value === "expire-now" || value === "expire-soon" || value === "keep-stable" ? value : undefined;
  const repos = Array.isArray(github?.repos)
    ? (github?.repos as unknown[])
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .map((r) => r.trim())
    : undefined;
  return {
    adapters: {
      github: {
        enabled: github?.enabled === true,
        repo: typeof github?.repo === "string" && github.repo.trim().length > 0 ? github.repo.trim() : undefined,
        repos: repos && repos.length > 0 ? repos : undefined,
        tokenRef:
          typeof github?.tokenRef === "string" && github.tokenRef.trim().length > 0
            ? github.tokenRef.trim()
            : undefined,
        onMerged: validAction(github?.onMerged),
        onClosed: validAction(github?.onClosed),
        onOpen: validAction(github?.onOpen),
      },
    },
    contentTypeHalfLives: {
      enabled: halfLifeRaw?.enabled !== false,
    },
    evolution: {
      enabled: evolutionRaw?.enabled === true,
      maxNeighborsPerFact:
        typeof evolutionRaw?.maxNeighborsPerFact === "number" && evolutionRaw.maxNeighborsPerFact > 0
          ? Math.floor(evolutionRaw.maxNeighborsPerFact)
          : 5,
      dailyLlmCallCap:
        typeof evolutionRaw?.dailyLlmCallCap === "number" && evolutionRaw.dailyLlmCallCap > 0
          ? Math.floor(evolutionRaw.dailyLlmCallCap)
          : 50,
      mode: evolutionRaw?.mode === "llm" ? "llm" : "heuristic",
    },
    fragmentEmbedding: {
      enabled: fragmentRaw?.enabled === true,
      minChars:
        typeof fragmentRaw?.minChars === "number" && fragmentRaw.minChars > 0 ? Math.floor(fragmentRaw.minChars) : 6000,
    },
  };
}

function parseLiveChangeFeedPositiveInt(value: unknown, fallback: number, field: string, min = 1, max = 3650): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid liveChangeFeed.${field}: ${String(value)}`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`Invalid liveChangeFeed.${field}: ${String(value)}`);
  }
  return normalized;
}

function parseLiveChangeFeedBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  if (value === false) return false;
  throw new Error(`Invalid liveChangeFeed boolean: expected boolean, received ${typeof value} (${String(value)})`);
}

export function parseLiveChangeFeedConfig(
  cfg: Record<string, unknown>,
): import("../types/features.js").LiveChangeFeedConfig {
  const raw = cfg.liveChangeFeed as Record<string, unknown> | undefined;
  const notifyOnRaw = raw?.notifyOn as Record<string, unknown> | undefined;
  return {
    enabled: parseLiveChangeFeedBoolean(raw?.enabled, true),
    retentionDays: parseLiveChangeFeedPositiveInt(raw?.retentionDays, 90, "retentionDays", 1, 3650),
    notifyInChat: parseLiveChangeFeedBoolean(raw?.notifyInChat, true),
    notifyOn: {
      sessionAdaptation: parseLiveChangeFeedBoolean(notifyOnRaw?.sessionAdaptation, true),
      proposalCreated: parseLiveChangeFeedBoolean(notifyOnRaw?.proposalCreated, true),
      proposalApplied: parseLiveChangeFeedBoolean(notifyOnRaw?.proposalApplied, true),
      proposalReverted: parseLiveChangeFeedBoolean(notifyOnRaw?.proposalReverted, false),
      dreamCycleComplete: parseLiveChangeFeedBoolean(notifyOnRaw?.dreamCycleComplete, false),
    },
    maxInChatEventsPerTurn: parseLiveChangeFeedPositiveInt(
      raw?.maxInChatEventsPerTurn,
      5,
      "maxInChatEventsPerTurn",
      1,
      20,
    ),
    inChatBudgetTokens: parseLiveChangeFeedPositiveInt(raw?.inChatBudgetTokens, 150, "inChatBudgetTokens", 50, 500),
  };
}

export function parseWikiIntegrationConfig(cfg: Record<string, unknown>): WikiIntegrationConfig {
  const raw = cfg.wikiIntegration as Record<string, unknown> | undefined;
  if (!raw || raw.enabled !== true) return { ...DEFAULT_WIKI_INTEGRATION_CONFIG };

  const mutations = raw.mutations as Record<string, unknown> | undefined;
  return {
    enabled: true,
    publicArtifacts: raw.publicArtifacts !== false,
    corpusSupplement: raw.corpusSupplement !== false,
    workspaceExportIntervalMinutes: parsePositiveIntClamped(
      raw.workspaceExportIntervalMinutes,
      DEFAULT_WIKI_INTEGRATION_CONFIG.workspaceExportIntervalMinutes,
      0,
      1440,
    ),
    mutations: {
      enabled: mutations?.enabled === true,
    },
  };
}

export function parseWorkboardConfig(cfg: Record<string, unknown>): WorkboardConfig {
  const raw = cfg.workboard as Record<string, unknown> | undefined;
  if (!raw || raw.enabled !== true) return { ...DEFAULT_WORKBOARD_CONFIG };

  const columnsRaw = raw.columns as Record<string, unknown> | undefined;
  const columns: WorkboardColumnMapping = {
    taskInProgress: parseColumnName(columnsRaw?.taskInProgress, DEFAULT_WORKBOARD_COLUMNS.taskInProgress),
    taskWaiting: parseColumnName(columnsRaw?.taskWaiting, DEFAULT_WORKBOARD_COLUMNS.taskWaiting),
    taskDone: parseColumnName(columnsRaw?.taskDone, DEFAULT_WORKBOARD_COLUMNS.taskDone),
    taskFailed: parseNullableColumnName(columnsRaw?.taskFailed, DEFAULT_WORKBOARD_COLUMNS.taskFailed),
    taskStale: parseNullableColumnName(columnsRaw?.taskStale, DEFAULT_WORKBOARD_COLUMNS.taskStale),
    taskParked: parseNullableColumnName(columnsRaw?.taskParked, DEFAULT_WORKBOARD_COLUMNS.taskParked),
    goalActive: parseColumnName(columnsRaw?.goalActive, DEFAULT_WORKBOARD_COLUMNS.goalActive),
    goalBlocked: parseNullableColumnName(columnsRaw?.goalBlocked, DEFAULT_WORKBOARD_COLUMNS.goalBlocked),
    goalStalled: parseNullableColumnName(columnsRaw?.goalStalled, DEFAULT_WORKBOARD_COLUMNS.goalStalled),
    goalCompleted: parseColumnName(columnsRaw?.goalCompleted, DEFAULT_WORKBOARD_COLUMNS.goalCompleted),
  };

  return {
    enabled: true,
    gatewayUrl:
      typeof raw.gatewayUrl === "string" && raw.gatewayUrl.trim().length > 0
        ? raw.gatewayUrl.trim()
        : resolveOpenClawGatewayRootUrlFromEnv(),
    syncIntervalMinutes: parsePositiveIntClamped(
      raw.syncIntervalMinutes,
      DEFAULT_WORKBOARD_CONFIG.syncIntervalMinutes,
      1,
      60,
    ),
    syncTasks: raw.syncTasks !== false,
    syncGoals: raw.syncGoals !== false,
    columns,
    bidirectional: raw.bidirectional !== false,
    cardTag:
      typeof raw.cardTag === "string" && raw.cardTag.trim().length > 0
        ? raw.cardTag.trim()
        : DEFAULT_WORKBOARD_CONFIG.cardTag,
  };
}

function parsePositiveIntClamped(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function parseColumnName(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

function parseNullableColumnName(value: unknown, fallback: string | null): string | null {
  if (value === null || value === false) return null;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}
