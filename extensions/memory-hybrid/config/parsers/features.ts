import type {
  GraphConfig,
  GraphRetrievalConfig,
  ClustersConfig,
  GapsConfig,
  AliasesConfig,
  IngestConfig,
  MemoryTieringConfig,
  AmbientConfig,
  ReinforcementConfig,
  FutureDateProtectionConfig,
  DocumentsConfig,
  WorkflowTrackingConfig,
  CrystallizationConfig,
  SelfExtensionConfig,
  ImplicitFeedbackConfig,
  ImplicitSignalType,
  ClosedLoopConfig,
  FrustrationDetectionConfig,
  FrustrationSignalWeights,
  CrossAgentLearningConfig,
  ToolEffectivenessConfig,
  CostTrackingConfig,
  DashboardConfig,
} from "../types/features.js";
import type { PersonaProposalsConfig } from "../types/agents.js";
import { IDENTITY_FILE_TYPES, type IdentityFileType } from "../types/agents.js";
import type { ErrorReportingConfig, MultiAgentConfig } from "../types/index.js";
import { DEFAULT_GLITCHTIP_DSN } from "../../services/error-reporter.js";

export function parseGraphConfig(cfg: Record<string, unknown>): GraphConfig {
  const graphRaw = cfg.graph as Record<string, unknown> | undefined;
  return {
    enabled: graphRaw?.enabled !== false,
    autoLink: graphRaw?.autoLink === true,
    autoLinkMinScore:
      typeof graphRaw?.autoLinkMinScore === "number" && graphRaw.autoLinkMinScore >= 0 && graphRaw.autoLinkMinScore <= 1
        ? graphRaw.autoLinkMinScore
        : 0.7,
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
        return [...IDENTITY_FILE_TYPES];
      }
      const filtered = (proposalsRaw.allowedFiles as string[]).filter((f) =>
        IDENTITY_FILE_TYPES.includes(f as IdentityFileType),
      ) as IdentityFileType[];
      // Fallback to defaults if filter produces empty array
      return filtered.length > 0 ? filtered : [...IDENTITY_FILE_TYPES];
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
  };
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
 * Parse error reporting config. Sentinel/GlitchTip is enabled by default (opt-out) and reports to
 * the public community DSN. Presets do not set errorReporting — this parser is the single source
 * of defaults. Do not change to opt-in or remove the public DSN default without explicit product decision.
 */
export function parseErrorReportingConfig(cfg: Record<string, unknown>): ErrorReportingConfig {
  const errorReportingRaw = cfg.errorReporting as Record<string, unknown> | undefined;

  // When errorReporting is not specified: opt-out defaults (enabled + consent true, community DSN)
  if (!errorReportingRaw || typeof errorReportingRaw !== "object") {
    return {
      enabled: true,
      dsn: DEFAULT_GLITCHTIP_DSN,
      consent: true,
      mode: "community",
      sampleRate: 1.0,
    };
  }

  // enabled defaults to true — user must explicitly set enabled: false to opt out
  let enabled = errorReportingRaw.enabled !== false;
  // consent defaults to true — user must explicitly set consent: false to opt out
  const consent = errorReportingRaw.consent !== false;
  const dsnRaw = typeof errorReportingRaw.dsn === "string" ? errorReportingRaw.dsn.trim() : "";
  const modeRaw = typeof errorReportingRaw.mode === "string" ? errorReportingRaw.mode : "community";
  const mode: "community" | "self-hosted" = modeRaw === "self-hosted" ? "self-hosted" : "community";

  if (enabled && !consent) {
    console.warn("memory-hybrid: errorReporting.enabled=true but consent is false; disabling error reporting.");
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

  // Optional friendly name (e.g. Maeve, Doris) for readable GlitchTip reports
  const botNameRaw = typeof errorReportingRaw.botName === "string" ? errorReportingRaw.botName.trim() : "";
  const botName = botNameRaw.length > 0 ? botNameRaw.slice(0, 64) : undefined;

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
              console.warn(
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
    feedToSelfCorrection: raw?.feedToSelfCorrection !== false,
    trajectoryLLMAnalysis: raw?.trajectoryLLMAnalysis === true,
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
  return {
    enabled: raw?.enabled !== false,
    port: typeof raw?.port === "number" && raw.port >= 1024 && raw.port <= 65535 ? Math.floor(raw.port) : 7700,
    gitRepo: typeof raw?.gitRepo === "string" ? raw.gitRepo : undefined,
  };
}
