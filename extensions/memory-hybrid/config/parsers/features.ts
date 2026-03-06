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
} from "../types/features.js";
import type { PersonaProposalsConfig, MemoryToSkillsConfig } from "../types/agents.js";
import { IDENTITY_FILE_TYPES, type IdentityFileType } from "../types/agents.js";
import type { ErrorReportingConfig, MultiAgentConfig } from "../types/index.js";

export function parseGraphConfig(cfg: Record<string, unknown>): GraphConfig {
  const graphRaw = cfg.graph as Record<string, unknown> | undefined;
  return {
    enabled: graphRaw?.enabled !== false,
    autoLink: graphRaw?.autoLink === true,
    autoLinkMinScore: typeof graphRaw?.autoLinkMinScore === "number" && graphRaw.autoLinkMinScore >= 0 && graphRaw.autoLinkMinScore <= 1
      ? graphRaw.autoLinkMinScore
      : 0.7,
    autoLinkLimit: typeof graphRaw?.autoLinkLimit === "number" && graphRaw.autoLinkLimit > 0
      ? Math.floor(graphRaw.autoLinkLimit)
      : 3,
    maxTraversalDepth: typeof graphRaw?.maxTraversalDepth === "number" && graphRaw.maxTraversalDepth > 0
      ? Math.floor(graphRaw.maxTraversalDepth)
      : 2,
    useInRecall: graphRaw?.useInRecall !== false,
    coOccurrenceWeight: typeof graphRaw?.coOccurrenceWeight === "number" && graphRaw.coOccurrenceWeight >= 0 && graphRaw.coOccurrenceWeight <= 1
      ? graphRaw.coOccurrenceWeight
      : 0.3,
    autoSupersede: graphRaw?.autoSupersede !== false,
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
    chunkSize: typeof ingestRaw.chunkSize === "number" && ingestRaw.chunkSize > 0
      ? Math.floor(ingestRaw.chunkSize)
      : 800,
    overlap: typeof ingestRaw.overlap === "number" && ingestRaw.overlap >= 0
      ? Math.floor(ingestRaw.overlap)
      : 100,
  };
}

export function parseMemoryTieringConfig(cfg: Record<string, unknown>): MemoryTieringConfig {
  const tierRaw = cfg.memoryTiering as Record<string, unknown> | undefined;
  return {
    enabled: tierRaw?.enabled !== false,
    hotMaxTokens: typeof tierRaw?.hotMaxTokens === "number" && tierRaw.hotMaxTokens > 0
      ? Math.floor(tierRaw.hotMaxTokens)
      : 2000,
    compactionOnSessionEnd: tierRaw?.compactionOnSessionEnd !== false,
    inactivePreferenceDays: typeof tierRaw?.inactivePreferenceDays === "number" && tierRaw.inactivePreferenceDays >= 0
      ? Math.floor(tierRaw.inactivePreferenceDays)
      : 7,
    hotMaxFacts: typeof tierRaw?.hotMaxFacts === "number" && tierRaw.hotMaxFacts > 0
      ? Math.floor(tierRaw.hotMaxFacts)
      : 50,
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
      typeof ambientRaw?.maxQueriesPerTrigger === "number" &&
      ambientRaw.maxQueriesPerTrigger >= 1
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
      typeof reinforcementRaw?.passiveBoost === "number" && reinforcementRaw.passiveBoost >= 0 && reinforcementRaw.passiveBoost <= 1
        ? reinforcementRaw.passiveBoost
        : 0.1,
    activeBoost:
      typeof reinforcementRaw?.activeBoost === "number" && reinforcementRaw.activeBoost >= 0 && reinforcementRaw.activeBoost <= 1
        ? reinforcementRaw.activeBoost
        : 0.05,
    maxConfidence:
      typeof reinforcementRaw?.maxConfidence === "number" && reinforcementRaw.maxConfidence > 0 && reinforcementRaw.maxConfidence <= 1
        ? reinforcementRaw.maxConfidence
        : 1.0,
    similarityThreshold:
      typeof reinforcementRaw?.similarityThreshold === "number" && reinforcementRaw.similarityThreshold > 0 && reinforcementRaw.similarityThreshold <= 1
        ? reinforcementRaw.similarityThreshold
        : 0.85,
  };
}

export function parseFutureDateProtectionConfig(cfg: Record<string, unknown>): FutureDateProtectionConfig {
  const fdpRaw = cfg.futureDateProtection as Record<string, unknown> | undefined;
  return {
    enabled: fdpRaw?.enabled !== false, // default: true
    // Fix #5: 0 means "no limit"; only fall back to 365 when value is absent/negative/non-number
    maxFreezeDays:
      typeof fdpRaw?.maxFreezeDays === "number" && fdpRaw.maxFreezeDays >= 0
        ? Math.floor(fdpRaw.maxFreezeDays)
        : 365,
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
    allowedPaths: Array.isArray(documentsRaw?.allowedPaths)
      ? (documentsRaw.allowedPaths as string[]).filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : undefined,
  };
}

export function parsePersonaProposalsConfig(cfg: Record<string, unknown>): PersonaProposalsConfig {
  const proposalsRaw = cfg.personaProposals as Record<string, unknown> | undefined;
  return {
    enabled: proposalsRaw?.enabled === true,
    allowedFiles: (() => {
      if (!Array.isArray(proposalsRaw?.allowedFiles)) {
        return [...IDENTITY_FILE_TYPES];
      }
      const filtered = (proposalsRaw.allowedFiles as string[]).filter((f) =>
        IDENTITY_FILE_TYPES.includes(f as IdentityFileType)
      ) as IdentityFileType[];
      // Fallback to defaults if filter produces empty array
      return filtered.length > 0 ? filtered : [...IDENTITY_FILE_TYPES];
    })(),
    maxProposalsPerWeek: typeof proposalsRaw?.maxProposalsPerWeek === "number" && proposalsRaw.maxProposalsPerWeek > 0
      ? Math.floor(proposalsRaw.maxProposalsPerWeek)
      : 5,
    minConfidence: typeof proposalsRaw?.minConfidence === "number" && proposalsRaw.minConfidence >= 0 && proposalsRaw.minConfidence <= 1
      ? proposalsRaw.minConfidence
      : 0.7,
    proposalTTLDays: typeof proposalsRaw?.proposalTTLDays === "number" && proposalsRaw.proposalTTLDays >= 0
      ? Math.floor(proposalsRaw.proposalTTLDays)
      : 30,
    minSessionEvidence: typeof proposalsRaw?.minSessionEvidence === "number" && proposalsRaw.minSessionEvidence > 0
      ? Math.floor(proposalsRaw.minSessionEvidence)
      : 10,
  };
}

export function parseMemoryToSkillsConfig(cfg: Record<string, unknown>): MemoryToSkillsConfig {
  const memoryToSkillsRaw = cfg.memoryToSkills as Record<string, unknown> | undefined;
  return {
    enabled: memoryToSkillsRaw?.enabled === true,
    schedule: typeof memoryToSkillsRaw?.schedule === "string" && memoryToSkillsRaw.schedule.trim().length > 0
      ? memoryToSkillsRaw.schedule.trim()
      : "15 2 * * *",
    windowDays: typeof memoryToSkillsRaw?.windowDays === "number" && memoryToSkillsRaw.windowDays >= 1
      ? Math.min(365, Math.floor(memoryToSkillsRaw.windowDays))
      : 30,
    minInstances: typeof memoryToSkillsRaw?.minInstances === "number" && memoryToSkillsRaw.minInstances >= 1
      ? Math.floor(memoryToSkillsRaw.minInstances)
      : 3,
    consistencyThreshold: typeof memoryToSkillsRaw?.consistencyThreshold === "number" && memoryToSkillsRaw.consistencyThreshold >= 0 && memoryToSkillsRaw.consistencyThreshold <= 1
      ? memoryToSkillsRaw.consistencyThreshold
      : 0.7,
    outputDir: typeof memoryToSkillsRaw?.outputDir === "string" && memoryToSkillsRaw.outputDir.length > 0
      ? memoryToSkillsRaw.outputDir
      : "skills/auto-generated",
    notify: memoryToSkillsRaw?.notify !== false,
    autoPublish: memoryToSkillsRaw?.autoPublish === true,
    validateScript: typeof memoryToSkillsRaw?.validateScript === "string" && memoryToSkillsRaw.validateScript.trim().length > 0 ? memoryToSkillsRaw.validateScript.trim() : undefined,
    writeByDefault: memoryToSkillsRaw?.writeByDefault === true,
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

export function parseErrorReportingConfig(cfg: Record<string, unknown>): ErrorReportingConfig | undefined {
  const errorReportingRaw = cfg.errorReporting as Record<string, unknown> | undefined;
  if (!errorReportingRaw || typeof errorReportingRaw !== "object") return undefined;

  let enabled = errorReportingRaw.enabled === true;
  const consent = errorReportingRaw.consent === true;
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
        'Provide a valid DSN or switch to mode: "community".'
      );
    }
    // Reject placeholders
    const placeholderPatterns = /<key>|<host>|<project-id>|YOUR_DSN|PLACEHOLDER/i;
    if (placeholderPatterns.test(dsnRaw)) {
      throw new Error(
        'errorReporting.dsn contains placeholder values. ' +
        'Replace <key>, <host>, <project-id> with actual values, or use mode: "community".'
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

  return {
    enabled,
    consent,
    mode,
    dsn: dsnRaw || undefined,
    environment: typeof errorReportingRaw.environment === "string" ? errorReportingRaw.environment : undefined,
    sampleRate: typeof errorReportingRaw.sampleRate === "number" && errorReportingRaw.sampleRate >= 0 && errorReportingRaw.sampleRate <= 1
      ? errorReportingRaw.sampleRate
      : 1.0,
    botId,
    botName,
  };
}

export function parseWorkflowTrackingConfig(cfg: Record<string, unknown>): WorkflowTrackingConfig {
  const raw = cfg.workflowTracking as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled === true,
    maxTracesPerDay:
      typeof raw?.maxTracesPerDay === "number" && raw.maxTracesPerDay > 0
        ? Math.floor(raw.maxTracesPerDay)
        : 100,
    retentionDays:
      typeof raw?.retentionDays === "number" && raw.retentionDays > 0
        ? Math.floor(raw.retentionDays)
        : 90,
    goalExtractionModel:
      typeof raw?.goalExtractionModel === "string" && raw.goalExtractionModel.trim().length > 0
        ? raw.goalExtractionModel.trim()
        : undefined,
  };
}
