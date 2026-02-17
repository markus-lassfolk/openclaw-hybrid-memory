import { homedir } from "node:os";
import { join } from "node:path";

export const DECAY_CLASSES = [
  "permanent",
  "stable",
  "active",
  "session",
  "checkpoint",
] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

/** TTL defaults in seconds per decay class. null = never expires. */
export const TTL_DEFAULTS: Record<DecayClass, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600, // 90 days
  active: 14 * 24 * 3600, // 14 days
  session: 24 * 3600, // 24 hours
  checkpoint: 4 * 3600, // 4 hours
};

export type AutoClassifyConfig = {
  enabled: boolean;
  model: string;       // e.g. "gpt-4.1-nano", "gpt-4o-mini", or any chat model
  batchSize: number;   // facts per LLM call (default 20)
  /** When true, LLM can suggest new categories from "other" facts; labels with at least minFactsForNewCategory become real categories (default true) */
  suggestCategories?: boolean;
  /** Minimum facts with the same suggested label before we create that category (default 10). Not told to the LLM. */
  minFactsForNewCategory?: number;
};

/** Auto-recall injection line format: full = [backend/category] text, short = category: text, minimal = text only, progressive = memory index (agent fetches on demand), progressive_hybrid = pinned in full + rest as index */
export type AutoRecallInjectionFormat = "full" | "short" | "minimal" | "progressive" | "progressive_hybrid";

/** Entity-centric recall: when prompt mentions an entity from the list, merge lookup(entity) facts into candidates */
export type EntityLookupConfig = {
  enabled: boolean;
  entities: string[];           // e.g. ["user", "owner", "decision"]; prompt matched case-insensitively
  maxFactsPerEntity: number;    // max facts to merge per matched entity (default 2)
};

/** Auto-recall: enable/disable plus token cap, format, limit, minScore, preferLongTerm, importance/recency, entity lookup, summary, progressive options */
export type AutoRecallConfig = {
  enabled: boolean;
  maxTokens: number;
  maxPerMemoryChars: number;
  injectionFormat: AutoRecallInjectionFormat;
  limit: number;
  minScore: number;
  preferLongTerm: boolean;
  useImportanceRecency: boolean;
  entityLookup: EntityLookupConfig;
  summaryThreshold: number;      // facts longer than this get a summary stored; 0 = disabled (default 300)
  summaryMaxChars: number;       // summary length when generated (default 80)
  useSummaryInInjection: boolean;  // inject summary instead of full text when present (default true)
  summarizeWhenOverBudget: boolean;  // when token cap forces dropping memories, LLM-summarize all into 2-3 sentences (1.4)
  summarizeModel: string;        // model for summarize-when-over-budget (default gpt-4o-mini)
  /** FR-009: Max candidates for progressive index (default 15). Only when injectionFormat is progressive or progressive_hybrid. */
  progressiveMaxCandidates?: number;
  /** FR-009: Max tokens for the index block in progressive mode (default: 300 when injectionFormat is progressive or progressive_hybrid). */
  progressiveIndexMaxTokens?: number;
  /** FR-009: Group index lines by category (e.g. "Preferences (3):") for readability (default false). */
  progressiveGroupByCategory?: boolean;
  /** FR-009: Min recall count or permanent decay to treat as "pinned" in progressive_hybrid (default 3). */
  progressivePinnedRecallCount?: number;
  /** FR-006: Scope filter for auto-recall (userId, agentId, sessionId). When set, only global + matching scopes are injected. */
  scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
};

/** Store options: fuzzy dedupe (2.3) and optional FR-008 classify-before-write. */
export type StoreConfig = {
  fuzzyDedupe: boolean;
  /** FR-008: Classify incoming fact against existing similar facts (ADD/UPDATE/DELETE/NOOP) before storing (default: false) */
  classifyBeforeWrite?: boolean;
  /** Model for classification (default: gpt-4o-mini) */
  classifyModel?: string;
};

/** Write-Ahead Log (WAL) configuration for crash resilience */
export type WALConfig = {
  /** Enable WAL for crash resilience (default: true) */
  enabled: boolean;
  /** Path to WAL file (default: same directory as SQLite DB) */
  walPath?: string;
  /** Maximum age of WAL entries before they're considered stale (ms, default: 5 minutes) */
  maxAge?: number;
};

/** Proposal statuses for persona evolution workflow */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Identity file types that can be proposed for modification */
export const IDENTITY_FILE_TYPES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;
export type IdentityFileType = (typeof IDENTITY_FILE_TYPES)[number];

/** Opt-in persona proposals: agent self-evolution with human approval gate */
export type PersonaProposalsConfig = {
  enabled: boolean;
  /** Identity files that can be modified via proposals (default: ["SOUL.md", "IDENTITY.md", "USER.md"]) */
  allowedFiles: IdentityFileType[];
  /** Max proposals per week to prevent spam (default: 5) */
  maxProposalsPerWeek: number;
  /** Min confidence score 0-1 for proposals (default: 0.7) */
  minConfidence: number;
  /** Days before proposals auto-expire if not reviewed (default: 30, 0 = never) */
  proposalTTLDays: number;
  /** Require minimum session evidence count (default: 10) */
  minSessionEvidence: number;
};

/** Graph-based spreading activation (FR-007): auto-linking and traversal settings */
export type GraphConfig = {
  enabled: boolean;
  autoLink: boolean;            // Auto-create RELATED_TO links during storage
  autoLinkMinScore: number;     // Min similarity score for auto-linking (default 0.7)
  autoLinkLimit: number;        // Max similar facts to link per storage (default 3)
  maxTraversalDepth: number;    // Max hops for graph traversal in recall (default 2)
  useInRecall: boolean;         // Enable graph traversal in memory_recall (default true)
};

/** FR-011: Reflection / pattern synthesis from session history */
export type ReflectionConfig = {
  enabled: boolean;
  model: string;             // LLM for reflection (default: gpt-4o-mini)
  defaultWindow: number;     // Time window in days (default: 14)
  minObservations: number;   // Min observations to support a pattern (default: 2)
};

/** FR-004: Dynamic memory tiering (hot/warm/cold). */
export type MemoryTieringConfig = {
  enabled: boolean;
  /** Max tokens for HOT tier always loaded at session start (default: 2000). */
  hotMaxTokens: number;
  /** Run compaction on agent_end (default: true). */
  compactionOnSessionEnd: boolean;
  /** Days without access to treat preference as inactive -> warm (default: 7). */
  inactivePreferenceDays: number;
  /** Cap HOT tier to this many facts when promoting blockers (default: 50). */
  hotMaxFacts: number;
};

/** Procedural memory (issue #23): auto-generated skills from learned patterns */
export type ProceduresConfig = {
  enabled: boolean;
  /** Session JSONL directory (default: ~/.openclaw/agents/main/sessions) */
  sessionsDir: string;
  /** Min tool steps to consider a procedure (default: 2) */
  minSteps: number;
  /** Validations before auto-generating a skill (default: 3) */
  validationThreshold: number;
  /** TTL days for procedure confidence / revalidation (default: 30) */
  skillTTLDays: number;
  /** Path to auto-generated skills (default: workspace/skills/auto) */
  skillsAutoPath: string;
  /** Require human approval before promoting auto-skill to permanent (default: true) */
  requireApprovalForPromote: boolean;
};

/** Credential types supported by the credentials store */
export const CREDENTIAL_TYPES = [
  "token",
  "password",
  "api_key",
  "ssh",
  "bearer",
  "other",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Opt-in credentials: structured, encrypted storage for API keys, tokens, etc. */
export type CredentialsConfig = {
  enabled: boolean;
  store: "sqlite";
  /** Encryption key: "env:VAR_NAME" resolves from env, or raw string (not recommended) */
  encryptionKey: string;
  /** When enabled, detect credential patterns in conversation and prompt to store (default false) */
  autoDetect?: boolean;
  /** Days before expiry to warn (default 7) */
  expiryWarningDays?: number;
};


export type HybridMemoryConfig = {
  embedding: {
    provider: "openai";
    model: string;
    apiKey: string;
  };
  lanceDbPath: string;
  sqlitePath: string;
  autoCapture: boolean;
  autoRecall: AutoRecallConfig;
  /** Max characters per captured/stored fact (filter and truncation). Default 5000. */
  captureMaxChars: number;
  categories: string[];
  autoClassify: AutoClassifyConfig;
  /** Store options (2.3): fuzzyDedupe = skip store when normalized text matches existing. */
  store: StoreConfig;
  /** Opt-in credential management: structured, encrypted storage (default: disabled) */
  credentials: CredentialsConfig;
  /** Graph-based spreading activation (FR-007): auto-linking and graph traversal */
  graph: GraphConfig;
  /** Write-Ahead Log for crash resilience (default: enabled) */
  wal: WALConfig;
  /** Opt-in persona proposals: agent self-evolution with human approval (default: disabled) */
  personaProposals: PersonaProposalsConfig;
  /** FR-011: Reflection layer — synthesize behavioral patterns from facts (default: disabled) */
  reflection: ReflectionConfig;
  /** FR-004: Dynamic memory tiering — hot/warm/cold (default: enabled) */
  memoryTiering: MemoryTieringConfig;
  /** Optional: Gemini for distill (1M context). apiKey or env GOOGLE_API_KEY/GEMINI_API_KEY. defaultModel used when --model not passed. */
  distill?: { apiKey?: string; defaultModel?: string };
  /** Procedural memory — procedure tagging and auto-skills (default: enabled) */
  procedures: ProceduresConfig;
};

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

export type MemoryCategory = string;

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_LANCE_PATH = join(homedir(), ".openclaw", "memory", "lancedb");
const DEFAULT_SQLITE_PATH = join(homedir(), ".openclaw", "memory", "facts.db");

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) throw new Error(`Unsupported embedding model: ${model}`);
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) throw new Error(`Environment variable ${envVar} is not set`);
    return envValue;
  });
}

export const hybridConfigSchema = {
  parse(value: unknown): HybridMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-hybrid config required");
    }
    const cfg = value as Record<string, unknown>;

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required. Set it in plugins.entries[\"openclaw-hybrid-memory\"].config.embedding. Run 'openclaw hybrid-mem verify --fix' for help.");
    }
    const rawKey = (embedding.apiKey as string).trim();
    if (rawKey.length < 10 || rawKey === "YOUR_OPENAI_API_KEY" || rawKey === "<OPENAI_API_KEY>") {
      throw new Error("embedding.apiKey is missing or a placeholder. Set a valid OpenAI API key in config. Run 'openclaw hybrid-mem verify --fix' for help.");
    }

    const model =
      typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
    vectorDimsForModel(model);

    // Parse custom categories
    const customCategories: string[] = Array.isArray(cfg.categories)
      ? (cfg.categories as string[]).filter((c) => typeof c === "string" && c.length > 0)
      : [];

    // Merge into runtime categories
    if (customCategories.length > 0) {
      setMemoryCategories(customCategories);
    }

    // Parse autoClassify config
    // Model default: cheapest available chat model. Use "gpt-4o-mini" as a
    // safe default; users can override with any model their API key supports.
    const acCfg = cfg.autoClassify as Record<string, unknown> | undefined;
    const autoClassify: AutoClassifyConfig = {
      enabled: acCfg?.enabled === true,
      model: typeof acCfg?.model === "string" ? acCfg.model : "gpt-4o-mini",
      batchSize: typeof acCfg?.batchSize === "number" ? acCfg.batchSize : 20,
      suggestCategories: acCfg?.suggestCategories !== false,
      minFactsForNewCategory: typeof acCfg?.minFactsForNewCategory === "number" ? acCfg.minFactsForNewCategory : 10,
    };

    // Parse autoRecall: boolean (legacy) or { enabled?, maxTokens?, maxPerMemoryChars?, injectionFormat? }
    const arRaw = cfg.autoRecall;
    const VALID_FORMATS = ["full", "short", "minimal", "progressive", "progressive_hybrid"] as const;
    let autoRecall: AutoRecallConfig;
    if (typeof arRaw === "object" && arRaw !== null && !Array.isArray(arRaw)) {
      const ar = arRaw as Record<string, unknown>;
      const format = typeof ar.injectionFormat === "string" && VALID_FORMATS.includes(ar.injectionFormat as typeof VALID_FORMATS[number])
        ? (ar.injectionFormat as AutoRecallInjectionFormat)
        : "full";
      const limit = typeof ar.limit === "number" && ar.limit > 0 ? Math.floor(ar.limit) : 5;
      const minScore = typeof ar.minScore === "number" && ar.minScore >= 0 && ar.minScore <= 1 ? ar.minScore : 0.3;
      const preferLongTerm = ar.preferLongTerm === true;
      const useImportanceRecency = ar.useImportanceRecency === true;
      const entityLookupRaw = ar.entityLookup as Record<string, unknown> | undefined;
      const entityLookup: EntityLookupConfig = {
        enabled: entityLookupRaw?.enabled === true,
        entities: Array.isArray(entityLookupRaw?.entities)
          ? (entityLookupRaw.entities as string[]).filter((e) => typeof e === "string" && e.length > 0)
          : [],
        maxFactsPerEntity:
          typeof entityLookupRaw?.maxFactsPerEntity === "number" && entityLookupRaw.maxFactsPerEntity > 0
            ? Math.floor(entityLookupRaw.maxFactsPerEntity)
            : 2,
      };
      const summaryThreshold =
        typeof ar.summaryThreshold === "number" && ar.summaryThreshold >= 0 ? ar.summaryThreshold : 300;
      const summaryMaxChars =
        typeof ar.summaryMaxChars === "number" && ar.summaryMaxChars > 0 ? Math.min(ar.summaryMaxChars, 500) : 80;
      const useSummaryInInjection = ar.useSummaryInInjection !== false;
      const summarizeWhenOverBudget = ar.summarizeWhenOverBudget === true;
      const summarizeModel = typeof ar.summarizeModel === "string" ? ar.summarizeModel : "gpt-4o-mini";
      const progressiveMaxCandidates =
        typeof ar.progressiveMaxCandidates === "number" && ar.progressiveMaxCandidates > 0
          ? Math.floor(ar.progressiveMaxCandidates)
          : 15;
      let progressiveIndexMaxTokens: number | undefined =
        typeof ar.progressiveIndexMaxTokens === "number" && ar.progressiveIndexMaxTokens > 0
          ? Math.floor(ar.progressiveIndexMaxTokens)
          : undefined;
      // FR-009: default index cap to 300 when using progressive disclosure (keeps index ~150–300 tokens)
      if ((format === "progressive" || format === "progressive_hybrid") && progressiveIndexMaxTokens === undefined) {
        progressiveIndexMaxTokens = 300;
      }
      const progressiveGroupByCategory = ar.progressiveGroupByCategory === true;
      const progressivePinnedRecallCount =
        typeof ar.progressivePinnedRecallCount === "number" && ar.progressivePinnedRecallCount >= 0
          ? Math.floor(ar.progressivePinnedRecallCount)
          : 3;
      const scopeFilterRaw = ar.scopeFilter as Record<string, unknown> | undefined;
      const scopeFilter =
        scopeFilterRaw && typeof scopeFilterRaw === "object" && !Array.isArray(scopeFilterRaw)
          ? {
              userId: typeof scopeFilterRaw.userId === "string" && scopeFilterRaw.userId.trim().length > 0 ? scopeFilterRaw.userId.trim() : undefined,
              agentId: typeof scopeFilterRaw.agentId === "string" && scopeFilterRaw.agentId.trim().length > 0 ? scopeFilterRaw.agentId.trim() : undefined,
              sessionId: typeof scopeFilterRaw.sessionId === "string" && scopeFilterRaw.sessionId.trim().length > 0 ? scopeFilterRaw.sessionId.trim() : undefined,
            }
          : undefined;
      autoRecall = {
        enabled: ar.enabled !== false,
        maxTokens: typeof ar.maxTokens === "number" && ar.maxTokens > 0 ? ar.maxTokens : 800,
        maxPerMemoryChars: typeof ar.maxPerMemoryChars === "number" && ar.maxPerMemoryChars >= 0 ? ar.maxPerMemoryChars : 0,
        injectionFormat: format,
        limit,
        minScore,
        preferLongTerm,
        useImportanceRecency,
        entityLookup,
        summaryThreshold,
        summaryMaxChars,
        useSummaryInInjection,
        summarizeWhenOverBudget,
        summarizeModel,
        progressiveMaxCandidates,
        progressiveIndexMaxTokens,
        progressiveGroupByCategory,
        progressivePinnedRecallCount,
        scopeFilter,
      };
    } else {
      autoRecall = {
        enabled: arRaw !== false,
        maxTokens: 800,
        maxPerMemoryChars: 0,
        injectionFormat: "full",
        limit: 5,
        minScore: 0.3,
        preferLongTerm: false,
        useImportanceRecency: false,
        entityLookup: { enabled: false, entities: [], maxFactsPerEntity: 2 },
        summaryThreshold: 300,
        summaryMaxChars: 80,
        useSummaryInInjection: true,
        summarizeWhenOverBudget: false,
        summarizeModel: "gpt-4o-mini",
        progressiveMaxCandidates: 15,
        progressiveIndexMaxTokens: undefined,
        progressiveGroupByCategory: false,
        progressivePinnedRecallCount: 3,
      };
    }

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" && cfg.captureMaxChars > 0
        ? cfg.captureMaxChars
        : 5000;

    const storeRaw = cfg.store as Record<string, unknown> | undefined;
    const store: StoreConfig = {
      fuzzyDedupe: storeRaw?.fuzzyDedupe === true,
      classifyBeforeWrite: storeRaw?.classifyBeforeWrite === true,
      classifyModel: typeof storeRaw?.classifyModel === "string" ? storeRaw.classifyModel : "gpt-4o-mini",
    };

    // Parse WAL config (enabled by default for crash resilience)
    const walRaw = cfg.wal as Record<string, unknown> | undefined;
    const wal: WALConfig = {
      enabled: walRaw?.enabled !== false,
      walPath: typeof walRaw?.walPath === "string" ? walRaw.walPath : undefined,
      maxAge: typeof walRaw?.maxAge === "number" && walRaw.maxAge > 0 ? walRaw.maxAge : 5 * 60 * 1000,
    };

    // Parse credentials config (opt-in). Enable automatically when a valid encryption key is set.
    const credRaw = cfg.credentials as Record<string, unknown> | undefined;
    const explicitlyDisabled = credRaw?.enabled === false;
    const encKeyRaw = typeof credRaw?.encryptionKey === "string" ? credRaw.encryptionKey : "";
    let encryptionKey = "";
    if (encKeyRaw.startsWith("env:")) {
      const envVar = encKeyRaw.slice(4).trim();
      const val = process.env[envVar];
      if (val) encryptionKey = val;
    } else if (encKeyRaw.length >= 16) {
      encryptionKey = encKeyRaw;
    }
    const hasValidKey = encryptionKey.length >= 16;
    const shouldEnable = !explicitlyDisabled && (credRaw?.enabled === true || hasValidKey);

    let credentials: CredentialsConfig;
    if (shouldEnable && hasValidKey) {
      credentials = {
        enabled: true,
        store: "sqlite",
        encryptionKey,
        autoDetect: credRaw?.autoDetect === true,
        expiryWarningDays: typeof credRaw?.expiryWarningDays === "number" && credRaw.expiryWarningDays >= 0
          ? Math.floor(credRaw.expiryWarningDays)
          : 7,
      };
    } else if (shouldEnable && !hasValidKey) {
      if (encKeyRaw.startsWith("env:")) {
        throw new Error(`Credentials encryption key env var ${encKeyRaw.slice(4).trim()} is not set. Run 'openclaw hybrid-mem verify --fix' for help.`);
      }
      throw new Error("credentials.encryptionKey must be at least 16 characters (or use env:VAR). Run 'openclaw hybrid-mem verify --fix' for help.");
    } else {
      credentials = {
        enabled: false,
        store: "sqlite",
        encryptionKey: "",
        autoDetect: false,
        expiryWarningDays: 7,
      };
    }

    // Parse graph config (FR-007)
    const graphRaw = cfg.graph as Record<string, unknown> | undefined;
    const graph: GraphConfig = {
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
    };

    // Parse persona proposals config (opt-in, disabled by default)
    const proposalsRaw = cfg.personaProposals as Record<string, unknown> | undefined;
    const personaProposals: PersonaProposalsConfig = {
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

    // Parse reflection config (FR-011)
    const reflectionRaw = cfg.reflection as Record<string, unknown> | undefined;
    const reflection: ReflectionConfig = {
      enabled: reflectionRaw?.enabled === true,
      model: typeof reflectionRaw?.model === "string" ? reflectionRaw.model : "gpt-4o-mini",
      defaultWindow: typeof reflectionRaw?.defaultWindow === "number" && reflectionRaw.defaultWindow > 0
        ? Math.min(90, Math.floor(reflectionRaw.defaultWindow))
        : 14,
      minObservations: typeof reflectionRaw?.minObservations === "number" && reflectionRaw.minObservations >= 1
        ? Math.floor(reflectionRaw.minObservations)
        : 2,
    };

    // Parse optional distill config (Gemini for session distillation)
    const distillRaw = cfg.distill as Record<string, unknown> | undefined;
    const distill =
      distillRaw && typeof distillRaw === "object"
        ? {
            apiKey: typeof distillRaw.apiKey === "string" ? distillRaw.apiKey : undefined,
            defaultModel: typeof distillRaw.defaultModel === "string" ? distillRaw.defaultModel : undefined,
          }
        : undefined;

    // Parse FR-004 memory tiering config
    const tierRaw = cfg.memoryTiering as Record<string, unknown> | undefined;
    const memoryTiering: MemoryTieringConfig = {
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

    // Parse procedures config (issue #23)
    const defaultSessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
    const proceduresRaw = cfg.procedures as Record<string, unknown> | undefined;
    const procedures: ProceduresConfig = {
      enabled: proceduresRaw?.enabled !== false,
      sessionsDir: typeof proceduresRaw?.sessionsDir === "string" && proceduresRaw.sessionsDir.length > 0
        ? proceduresRaw.sessionsDir
        : defaultSessionsDir,
      minSteps: typeof proceduresRaw?.minSteps === "number" && proceduresRaw.minSteps >= 1
        ? Math.floor(proceduresRaw.minSteps)
        : 2,
      validationThreshold: typeof proceduresRaw?.validationThreshold === "number" && proceduresRaw.validationThreshold >= 1
        ? Math.floor(proceduresRaw.validationThreshold)
        : 3,
      skillTTLDays: typeof proceduresRaw?.skillTTLDays === "number" && proceduresRaw.skillTTLDays >= 1
        ? Math.floor(proceduresRaw.skillTTLDays)
        : 30,
      skillsAutoPath: typeof proceduresRaw?.skillsAutoPath === "string" && proceduresRaw.skillsAutoPath.length > 0
        ? proceduresRaw.skillsAutoPath
        : "skills/auto",
      requireApprovalForPromote: proceduresRaw?.requireApprovalForPromote !== false,
    };

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      lanceDbPath:
        typeof cfg.lanceDbPath === "string" ? cfg.lanceDbPath : DEFAULT_LANCE_PATH,
      sqlitePath:
        typeof cfg.sqlitePath === "string" ? cfg.sqlitePath : DEFAULT_SQLITE_PATH,
      autoCapture: cfg.autoCapture !== false,
      autoRecall,
      captureMaxChars,
      categories: [...getMemoryCategories()],
      autoClassify,
      store,
      credentials,
      graph,
      wal,
      personaProposals,
      reflection,
      memoryTiering,
      distill,
      procedures,
    };
  },
};
