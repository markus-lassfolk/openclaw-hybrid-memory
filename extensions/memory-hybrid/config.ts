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
  model?: string;      // when unset, runtime uses getDefaultCronModel(cfg, "default")
  batchSize: number;   // facts per LLM call (default 20)
  /** When true, LLM can suggest new categories from "other" facts; labels with at least minFactsForNewCategory become real categories (default true) */
  suggestCategories?: boolean;
  /** Minimum facts with the same suggested label before we create that category (default 10). Not told to the LLM. */
  minFactsForNewCategory?: number;
};

/** Auto-recall injection line format: full = [backend/category] text, short = category: text, minimal = text only, progressive = memory index (agent fetches on demand), progressive_hybrid = pinned in full + rest as index */
export type AutoRecallInjectionFormat = "full" | "short" | "minimal" | "progressive" | "progressive_hybrid";

/** Multi-agent memory scoping configuration (dynamic agent detection) */
export type MultiAgentConfig = {
  /** Agent ID of the orchestrator (main agent). Default: "main". This agent sees all scopes. */
  orchestratorId: string;
  /** Default storage scope for new facts. Options: "global" (backward compatible, default), "agent" (specialists auto-scope), "auto" (orchestrator→global, specialists→agent). */
  defaultStoreScope: "global" | "agent" | "auto";
  /** When true, throw error if agent detection fails in "agent" or "auto" scope mode (instead of silently falling back to orchestrator). Default: false. */
  strictAgentScoping?: boolean;
  /**
   * ⚠️ SECURITY: When true, tools can use caller-provided scope params (userId, agentId, sessionId) to access other users' memories.
   * This is UNSAFE in multi-tenant deployments but useful in single-user setups for advanced filtering.
   * Default: false (secure by default — tools only see memories from authenticated context).
   */
  trustToolScopeParams?: boolean;
};

/** Entity-centric recall: when prompt mentions an entity from the list, merge lookup(entity) facts into candidates */
export type EntityLookupConfig = {
  enabled: boolean;
  entities: string[];           // e.g. ["user", "owner", "decision"]; prompt matched case-insensitively
  maxFactsPerEntity: number;    // max facts to merge per matched entity (default 2)
};

/** Auto-recall on authentication failures (reactive memory trigger) */
export type AuthFailureRecallConfig = {
  enabled: boolean;
  /** Auth failure patterns to detect (regex strings). Default includes SSH, HTTP 401/403, API key errors. */
  patterns: string[];
  /** Max recalls per target per session (dedup to avoid spam). Default: 1. */
  maxRecallsPerTarget: number;
  /** Inject credentials as system hint even if they were stored in the vault. Default: true. */
  includeVaultHints: boolean;
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
  summarizeModel?: string;       // when unset, runtime uses getDefaultCronModel(cfg, "default")
  /** Max candidates for progressive index (default 15). Only when injectionFormat is progressive or progressive_hybrid. */
  progressiveMaxCandidates?: number;
  /** Max tokens for the index block in progressive mode (default: 300 when injectionFormat is progressive or progressive_hybrid). */
  progressiveIndexMaxTokens?: number;
  /** Group index lines by category (e.g. "Preferences (3):") for readability (default false). */
  progressiveGroupByCategory?: boolean;
  /** Min recall count or permanent decay to treat as "pinned" in progressive_hybrid (default 3). */
  progressivePinnedRecallCount?: number;
  /** Scope filter for auto-recall (userId, agentId, sessionId). When set, only global + matching scopes are injected. */
  scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
  /** Auto-recall on authentication failures (reactive trigger after tool results) */
  authFailure: AuthFailureRecallConfig;
};

/** Store options: fuzzy dedupe and optional classify-before-write. */
export type StoreConfig = {
  fuzzyDedupe: boolean;
  /** Classify incoming fact against existing similar facts (ADD/UPDATE/DELETE/NOOP) before storing (default: false) */
  classifyBeforeWrite?: boolean;
  /** Model for classification; when unset, runtime uses getDefaultCronModel(cfg, "default") */
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

/** Graph-based spreading activation: auto-linking and traversal settings */
export type GraphConfig = {
  enabled: boolean;
  autoLink: boolean;            // Auto-create RELATED_TO links during storage
  autoLinkMinScore: number;     // Min similarity score for auto-linking (default 0.7)
  autoLinkLimit: number;        // Max similar facts to link per storage (default 3)
  maxTraversalDepth: number;    // Max hops for graph traversal in recall (default 2)
  useInRecall: boolean;         // Enable graph traversal in memory_recall (default true)
};

/** Reflection / pattern synthesis from session history */
export type ReflectionConfig = {
  enabled: boolean;
  model?: string;            // when unset, runtime uses getDefaultCronModel(cfg, "default")
  defaultWindow: number;      // Time window in days (default: 14)
  minObservations: number;   // Min observations to support a pattern (default: 2)
};

/** Procedural memory: auto-generated skills from learned patterns */
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

/** Dynamic memory tiering (hot/warm/cold). */
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

/** Search options: HyDE query expansion */
export type SearchConfig = {
  /** Generate hypothetical answer before embedding for vector search (default false) */
  hydeEnabled: boolean;
  /** Model for HyDE generation; when unset uses llm.default / legacy default (issue #92) */
  hydeModel?: string;
};

/** Ingest workspace files: index markdown files as facts for search */
export type IngestConfig = {
  /** Glob patterns relative to workspace (e.g. ["skills/**\/*.md", "TOOLS.md"]) */
  paths: string[];
  /** Chunk size in characters for LLM extraction (default 800) */
  chunkSize: number;
  /** Overlap between chunks (default 100) */
  overlap: number;
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

/** Auto-capture configuration for credential scanning from tool call inputs */
export type CredentialAutoCaptureConfig = {
  /** Enable scanning of tool call inputs for credential patterns (default: false, opt-in) */
  toolCalls: boolean;
  /**
   * Pattern set to use: "builtin" uses the built-in regex set (default: "builtin").
   * Custom patterns are not currently supported but reserved for future extension.
   */
  patterns?: "builtin";
  /** Emit info-level log on each capture (default: true) */
  logCaptures?: boolean;
};

/** Opt-in credentials: structured, encrypted storage for API keys, tokens, etc. */
export type CredentialsConfig = {
  enabled: boolean;
  store: "sqlite";
  /** Encryption key: "env:VAR_NAME" resolves from env, or raw string (not recommended) */
  encryptionKey: string;
  /** When enabled, detect credential patterns in conversation and prompt to store (default false) */
  autoDetect?: boolean;
  /** Auto-capture credentials from tool call inputs (default: disabled) */
  autoCapture?: CredentialAutoCaptureConfig;
  /** Days before expiry to warn (default 7) */
  expiryWarningDays?: number;
};


/** Error reporting configuration for GlitchTip/Sentry integration (opt-in, privacy-first) */
export type ErrorReportingConfig = {
  enabled: boolean;
  /** DSN for self-hosted mode. Not required in schema (only at runtime for self-hosted). */
  dsn?: string;
  consent: boolean;
  /** "community" (default): use hardcoded community DSN. "self-hosted": require custom DSN. */
  mode: "community" | "self-hosted";
  environment?: string;
  sampleRate?: number;
  /** Optional UUID identifying this bot instance; sent as tag so GlitchTip can group errors by bot. */
  botId?: string;
  /** Optional friendly name for this bot (e.g. Maeve, Doris); sent as tag for readable reports. */
  botName?: string;
};

export type HybridMemoryConfig = {
  embedding: {
    provider: "openai";
    model: string;
    apiKey: string;
    /** Optional ordered preference list (gateway fallback). First model defines vector dimension; all must have same dimension. */
    models?: string[];
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
  /** Graph-based spreading activation: auto-linking and graph traversal */
  graph: GraphConfig;
  /** Write-Ahead Log for crash resilience (default: enabled) */
  wal: WALConfig;
  /** Opt-in persona proposals: agent self-evolution with human approval (default: disabled) */
  personaProposals: PersonaProposalsConfig;
  /** Reflection layer — synthesize behavioral patterns from facts (default: disabled) */
  reflection: ReflectionConfig;
  /** Procedural memory — procedure tagging and auto-skills (default: enabled) */
  procedures: ProceduresConfig;
  /** Dynamic memory tiering — hot/warm/cold (default: enabled) */
  memoryTiering: MemoryTieringConfig;
  /** Optional: LLM preference lists and per-provider API config for direct chat calls (issue #87). */
  llm?: LLMConfig;
  /** Optional: Gemini for distill (1M context). apiKey/defaultModel deprecated in favor of llm + gateway. */
  distill?: {
    apiKey?: string;
    defaultModel?: string;
    /** Fallback models to try if primary model fails after retries (optional). Deprecated: use llm.default/heavy. */
    fallbackModels?: string[];
    /** Enable directive extraction from sessions (default: true). */
    extractDirectives?: boolean;
    /** Enable reinforcement extraction from sessions (default: true). */
    extractReinforcement?: boolean;
    /** Reinforcement boost added to facts search score (default: 0.1). */
    reinforcementBoost?: number;
    /** Phase 2: Reinforcement boost added to procedures search score (default: 0.1). */
    reinforcementProcedureBoost?: number;
    /** Phase 2: Number of reinforcements to trigger auto-promotion of procedures (default: 2). */
    reinforcementPromotionThreshold?: number;
  };
  /** Auto-build multilingual keywords from memory (default: enabled). Run at first startup if no file, then weekly. */
  languageKeywords: { autoBuild: boolean; weeklyIntervalDays: number };
  /** Optional: ingest workspace markdown files as facts (skills, TOOLS.md, etc.) */
  ingest?: IngestConfig;
  /** Optional: search tweaks (HyDE query expansion) */
  search?: SearchConfig;
  /** Optional: self-correction analysis — semantic dedup, TOOLS sectioning, auto-rewrite, spawn */
  selfCorrection?: SelfCorrectionConfig;
  /** Multi-agent memory scoping — dynamic agent detection and scope defaults (default: orchestratorId="main", defaultStoreScope="global") */
  multiAgent: MultiAgentConfig;
  /** Optional: error reporting to GlitchTip/Sentry (opt-in, default: disabled) */
  errorReporting?: ErrorReportingConfig;
  /** Set when user specified a mode in config; used by verify to show "Mode: Normal" etc. */
  mode?: ConfigMode | "custom";
};

/** Self-correction pipeline: semantic dedup, TOOLS.md sectioning, auto-rewrite vs approve */
export type SelfCorrectionConfig = {
  /** Use embedding similarity to skip near-duplicate facts before MEMORY_STORE (default: true). */
  semanticDedup: boolean;
  /** Similarity threshold for semantic dedup, 0–1 (default: 0.92). */
  semanticDedupThreshold: number;
  /** TOOLS.md section heading for new rules, e.g. "Self-correction rules" (default: "Self-correction rules"). */
  toolsSection: string;
  /** When true (default), insert suggested TOOLS rules under toolsSection. Set false to only suggest in report (then use --approve to apply). */
  applyToolsByDefault: boolean;
  /** When true, LLM rewrites TOOLS.md to integrate new rules (no duplicates/contradictions). When false, use section insert (or suggest if applyToolsByDefault is false) (default: false). */
  autoRewriteTools: boolean;
  /** When true and incident count > spawnThreshold, run Phase 2 via `openclaw sessions spawn --model <model>` for large context. Model is chosen from config (Gemini/OpenAI/Claude) when spawnModel is empty (default: false). */
  analyzeViaSpawn: boolean;
  /** Use spawn for Phase 2 when incidents exceed this count (default: 15). */
  spawnThreshold: number;
  /** Model for spawn when analyzeViaSpawn is true. Empty = use provider default from config (see getDefaultCronModel). */
  spawnModel: string;
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

/** Tier for cron job model selection: "default" = standard, "heavy" = larger context/reasoning. */
/** "nano" = ultra-cheap for high-frequency ops (autoClassify, HyDE, classifyBeforeWrite, summarize); falls back to "default" when unset. */
export type CronModelTier = "default" | "heavy" | "nano";

/**
 * Per-provider API credentials for direct LLM calls (bypasses the gateway agent endpoint).
 * Built-in defaults: google uses distill.apiKey + Gemini OpenAI-compat endpoint; openai uses embedding.apiKey.
 */
export type LLMProviderConfig = {
  /** API key for this provider. Overrides built-in defaults (distill.apiKey for google, embedding.apiKey for openai). */
  apiKey?: string;
  /** OpenAI-compatible base URL. Overrides built-in defaults. */
  baseURL?: string;
};

/** LLM model preference: ordered lists per tier with direct provider API calls. */
export type LLMConfig = {
  /** Internal: set to "gateway" when auto-derived from agents.defaults.model; undefined when from plugin config. */
  _source?: "gateway";
  /** Ordered preference for default-tier LLM calls (first available wins). */
  default: string[];
  /** Ordered preference for heavy-tier LLM calls (e.g. distill, spawn). */
  heavy: string[];
  /**
   * Optional: ordered model list for nano/ultra-light ops — autoClassify, HyDE, classifyBeforeWrite, auto-recall summarize.
   * These run on every chat message or write, so cheapness matters most.
   * When not set, falls back to the default tier.
   * Ideal models: openai/gpt-4.1-nano, google/gemini-2.0-flash-lite, anthropic/claude-haiku-*.
   */
  nano?: string[];
  /** When true, if all preferred models fail, try the fallback model. */
  fallbackToDefault?: boolean;
  /** When fallbackToDefault is true, this model is tried last. */
  fallbackModel?: string;
  /**
   * Per-provider API config for direct LLM calls.
   * Keys are provider prefixes as they appear in model IDs (e.g. "google", "openai", "anthropic").
   * Built-in providers (google, openai) have defaults; others require explicit apiKey + baseURL.
   * Example: { google: { apiKey: "AIzaSy..." }, anthropic: { apiKey: "sk-ant-...", baseURL: "https://api.anthropic.com/v1" } }
   */
  providers?: Record<string, LLMProviderConfig | undefined>;
};

/** Minimal plugin config shape for resolving cron job model (no full parse). */
export type CronModelConfig = {
  embedding?: { apiKey?: string };
  distill?: { apiKey?: string; defaultModel?: string; fallbackModels?: string[] };
  reflection?: { model?: string };
  /** Optional: when present, use for cron LLM (e.g. Claude). */
  claude?: { apiKey?: string; defaultModel?: string };
  /** Optional: gateway-routed LLM preference lists (issue #87). When set, overrides provider-based resolution. */
  llm?: LLMConfig;
};

/**
 * OpenClaw gateway expects provider/model IDs (e.g. openai/gpt-5.2, google/gemini-2.5-flash).
 * These defaults match common gateway catalogs; use llm.default/heavy in config for your exact list.
 */
const OPENAI_DEFAULT_CRON_MODEL = "openai/gpt-5.2";
const OPENAI_HEAVY_CRON_MODEL = "openai/gpt-5.2";
const GEMINI_DEFAULT_MODEL = "google/gemini-2.5-flash";
const GEMINI_HEAVY_MODEL = "google/gemini-3.1-pro-preview";
const CLAUDE_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const CLAUDE_HEAVY_MODEL = "anthropic/claude-opus-4-6";

function hasKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.length >= 10;
}

/** Legacy single-model resolution (for backward compat when no llm config). Used only when no list is built. */
function getDefaultCronModelLegacy(
  pluginConfig: CronModelConfig | undefined,
  tier: CronModelTier,
): string {
  if (!pluginConfig) return tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL;
  if (hasKey(pluginConfig.distill?.apiKey)) {
    const defaultModel = pluginConfig.distill?.defaultModel?.trim();
    if (defaultModel) return defaultModel;
    return tier === "heavy" ? GEMINI_HEAVY_MODEL : GEMINI_DEFAULT_MODEL;
  }
  if (hasKey(pluginConfig.claude?.apiKey)) {
    const defaultModel = pluginConfig.claude?.defaultModel?.trim();
    if (defaultModel) return defaultModel;
    return tier === "heavy" ? CLAUDE_HEAVY_MODEL : CLAUDE_DEFAULT_MODEL;
  }
  if (hasKey(pluginConfig.embedding?.apiKey)) {
    return tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL;
  }
  return tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL;
}

/**
 * Preferred provider order for out-of-the-box failover: Research/Heavy favours Gemini (context), then OpenAI, then Claude.
 * Uses OpenClaw-style provider/model IDs so the gateway accepts them. First working model wins at runtime.
 */
function getDefaultPreferredModelList(
  pluginConfig: CronModelConfig | undefined,
  tier: CronModelTier,
): string[] {
  if (!pluginConfig) {
    return [tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL];
  }
  const list: string[] = [];
  if (hasKey(pluginConfig.distill?.apiKey)) {
    const m = pluginConfig.distill?.defaultModel?.trim();
    list.push(m || (tier === "heavy" ? GEMINI_HEAVY_MODEL : GEMINI_DEFAULT_MODEL));
  }
  if (hasKey(pluginConfig.embedding?.apiKey)) {
    list.push(tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL);
  }
  if (hasKey(pluginConfig.claude?.apiKey)) {
    const m = pluginConfig.claude?.defaultModel?.trim();
    list.push(m || (tier === "heavy" ? CLAUDE_HEAVY_MODEL : CLAUDE_DEFAULT_MODEL));
  }
  if (list.length === 0) {
    list.push(getDefaultCronModelLegacy(pluginConfig, tier));
  }
  const distillFallbacks = pluginConfig.distill?.fallbackModels;
  if (Array.isArray(distillFallbacks)) {
    for (const m of distillFallbacks) {
      const t = typeof m === "string" ? m.trim() : "";
      if (t && !list.includes(t)) list.push(t);
    }
  }
  const fallback = pluginConfig.llm?.fallbackModel?.trim();
  if (fallback && !list.includes(fallback)) {
    list.push(fallback);
  }
  return list;
}

/**
 * Return ordered list of models to try for an LLM call.
 * - "nano": ultra-cheap for autoClassify, HyDE, classifyBeforeWrite, summarize. Falls back to "default" if llm.nano is unset.
 * - "default": HyDE, classify, reflection, general.
 * - "heavy": distill, self-correction, spawn.
 * First working model wins.
 */
export function getLLMModelPreference(
  pluginConfig: CronModelConfig | undefined,
  tier: CronModelTier,
): string[] {
  if (tier === "nano") {
    const nanoList = pluginConfig?.llm?.nano;
    if (Array.isArray(nanoList) && nanoList.length > 0) {
      const trimmed = nanoList.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
      if (trimmed.length > 0) return trimmed;
    }
    // No nano list configured — fall back to default tier
    return getLLMModelPreference(pluginConfig, "default");
  }
  const list = tier === "heavy" ? pluginConfig?.llm?.heavy : pluginConfig?.llm?.default;
  if (Array.isArray(list) && list.length > 0) {
    const trimmed = list.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
    if (trimmed.length > 0) {
      if (pluginConfig?.llm?.fallbackToDefault) {
        const fallback = pluginConfig.llm.fallbackModel?.trim();
        if (fallback && !trimmed.includes(fallback)) {
          return [...trimmed, fallback];
        }
        return trimmed;
      }
      return trimmed;
    }
  }
  return getDefaultPreferredModelList(pluginConfig, tier);
}

/**
 * Report which providers have API keys (for verify/transparency).
 * Checks both legacy key fields (distill.apiKey → gemini, embedding.apiKey → openai)
 * and the new llm.providers map so all configured providers are shown.
 */
export function getProvidersWithKeys(pluginConfig: CronModelConfig | undefined): string[] {
  if (!pluginConfig) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  function add(name: string) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }

  // Legacy / built-in key fields
  if (hasKey(pluginConfig.distill?.apiKey)) add("gemini");
  if (hasKey(pluginConfig.embedding?.apiKey)) add("openai");
  if (hasKey(pluginConfig.claude?.apiKey)) add("claude");

  // llm.providers map — any provider with an explicit apiKey
  const providers = pluginConfig.llm?.providers;
  if (providers && typeof providers === "object") {
    for (const [prefix, pCfg] of Object.entries(providers)) {
      if (pCfg && hasKey(pCfg.apiKey)) {
        // Map known prefixes to friendly names; keep others as-is
        const display = prefix === "google" ? "gemini" : prefix === "anthropic" ? "anthropic" : prefix;
        add(display);
      }
    }
  }

  return out;
}

/**
 * Resolve which LLM model to use for a maintenance cron job based on user config.
 * When llm.default/heavy are set, returns the first model in the preference list (gateway-routed).
 * Otherwise legacy: prefer provider the user has configured (Gemini > Claude > OpenAI) > fallback.
 */
export function getDefaultCronModel(
  pluginConfig: CronModelConfig | undefined,
  tier: CronModelTier,
): string {
  const preferred = getLLMModelPreference(pluginConfig, tier);
  return preferred[0] ?? (tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL);
}

/** Build minimal config for getDefaultCronModel from full HybridMemoryConfig (used by cron jobs and self-correction spawn). */
export function getCronModelConfig(cfg: HybridMemoryConfig): CronModelConfig {
  return {
    embedding: cfg.embedding,
    distill: cfg.distill,
    reflection: cfg.reflection,
    claude: (cfg as Record<string, unknown>).claude as CronModelConfig["claude"],
    llm: cfg.llm,
  };
}

/**
 * Resolve default model and fallback list for reflection/cron (default or heavy tier).
 * Single place for getCronModelConfig + getLLMModelPreference + cfg.llm fallback logic.
 */
export function resolveReflectionModelAndFallbacks(
  cfg: HybridMemoryConfig,
  tier: CronModelTier,
): { defaultModel: string; fallbackModels: string[] | undefined } {
  const cronCfg = getCronModelConfig(cfg);
  const pref = getLLMModelPreference(cronCfg, tier);
  const defaultModel = pref[0] ?? (tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL);
  const fallbackModels = pref.length > 1 ? pref.slice(1) : (cfg.llm ? undefined : cfg.distill?.fallbackModels);
  return { defaultModel, fallbackModels };
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

/** Configuration mode presets. See docs/CONFIGURATION-MODES.md. */
export type ConfigMode = "essential" | "normal" | "expert" | "full";

/** Deep-merge: base + overrides (overrides win). Used to apply preset then user config. */
function deepMergePreset(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const b = out[key];
    const o = overrides[key];
    if (o !== undefined && o !== null && typeof o === "object" && !Array.isArray(o) && typeof b === "object" && b !== null && !Array.isArray(b)) {
      out[key] = deepMergePreset(b as Record<string, unknown>, o as Record<string, unknown>);
    } else if (o !== undefined) {
      out[key] = o;
    }
  }
  return out;
}

/** Deep-equal comparison that's order-independent for objects */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  
  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (!deepEqual(aArr[i], bArr[i])) return false;
    }
    return true;
  }
  
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!deepEqual(aKeys, bKeys)) return false;
  
  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/** True if user value explicitly overrides a preset key (same key, different value). Extra keys in user (e.g. encryptionKey) do not count. */
function userOverridesPresetValue(userVal: unknown, presetVal: unknown): boolean {
  if (presetVal !== undefined && presetVal !== null && typeof presetVal === "object" && !Array.isArray(presetVal)) {
    if (userVal === undefined || userVal === null || typeof userVal !== "object" || Array.isArray(userVal)) return false;
    const u = userVal as Record<string, unknown>;
    const p = presetVal as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (key in u && userOverridesPresetValue(u[key], p[key])) return true;
    }
    return false;
  }
  return !deepEqual(userVal, presetVal);
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
    distill: { extractDirectives: true, extractReinforcement: true },
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
    search: { hydeEnabled: true, hydeModel: "google/gemini-2.5-flash" },
    ingest: { paths: ["skills/**/*.md", "TOOLS.md", "AGENTS.md"] },
    distill: { extractDirectives: true, extractReinforcement: true },
  },
};

export const hybridConfigSchema = {
  parse(value: unknown): HybridMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-hybrid config required");
    }
    let cfg = value as Record<string, unknown>;
    const modeRaw = cfg.mode;
    const validModes: ConfigMode[] = ["essential", "normal", "expert", "full"];
    let appliedMode: ConfigMode | undefined;
    let hasPresetOverrides = false; // true when user explicitly overrode a preset value (show "Custom" in verify)
    if (typeof modeRaw === "string" && validModes.includes(modeRaw as ConfigMode)) {
      appliedMode = modeRaw as ConfigMode;
      const preset = PRESET_OVERRIDES[appliedMode];
      const userRaw = { ...cfg } as Record<string, unknown>;
      delete userRaw.mode;
      cfg = deepMergePreset(preset, cfg) as Record<string, unknown>;
      delete cfg.mode;
      // Only "Custom" when user explicitly set a preset key to a different value (not when they only add e.g. embedding or credentials.encryptionKey)
      for (const key of Object.keys(preset)) {
        if (!(key in userRaw)) continue;
        if (userOverridesPresetValue(userRaw[key], preset[key])) {
          hasPresetOverrides = true;
          break;
        }
      }
    }

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required. Set it in plugins.entries[\"openclaw-hybrid-memory\"].config.embedding. Run 'openclaw hybrid-mem verify --fix' for help.");
    }
    const rawKey = (embedding.apiKey as string).trim();
    if (rawKey.length < 10 || rawKey === "YOUR_OPENAI_API_KEY" || rawKey === "<OPENAI_API_KEY>") {
      throw new Error("embedding.apiKey is missing or a placeholder. Set a valid OpenAI API key in config. Run 'openclaw hybrid-mem verify --fix' for help.");
    }

    const singleModel = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
    const modelsRaw = Array.isArray(embedding.models) ? (embedding.models as string[]).filter((m) => typeof m === "string" && (m as string).trim().length > 0).map((m) => (m as string).trim()) : [];
    let embeddingModels: string[] | undefined;
    if (modelsRaw.length > 0) {
      const valid: string[] = [];
      for (const m of modelsRaw) {
        try {
          vectorDimsForModel(m);
          valid.push(m);
        } catch {
          console.warn(`memory-hybrid: embedding.models — model "${m}" is not recognized and will be skipped. Check spelling or use a supported model (e.g. text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002).`);
        }
      }
      if (valid.length > 0) {
        const firstDim = vectorDimsForModel(valid[0]);
        if (valid.every((m) => vectorDimsForModel(m) === firstDim)) {
          embeddingModels = valid;
        } else {
          const dims = valid.map((m) => `${m}=${vectorDimsForModel(m)}`).join(", ");
          console.warn(`memory-hybrid: embedding.models — models have mismatched vector dimensions (${dims}); all will be ignored. Models in a list must share the same output dimension.`);
        }
      }
    }
    const model = embeddingModels?.[0] ?? singleModel;
    vectorDimsForModel(model);

    // Parse custom categories
    const customCategories: string[] = Array.isArray(cfg.categories)
      ? (cfg.categories as string[]).filter((c) => typeof c === "string" && c.length > 0)
      : [];

    // Merge into runtime categories
    if (customCategories.length > 0) {
      setMemoryCategories(customCategories);
    }

    // Parse autoClassify config (model left undefined when not set — runtime uses getDefaultCronModel)
    const acCfg = cfg.autoClassify as Record<string, unknown> | undefined;
    const autoClassify: AutoClassifyConfig = {
      enabled: acCfg?.enabled === true,
      model: typeof acCfg?.model === "string" ? acCfg.model : undefined,
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
      const limit = typeof ar.limit === "number" && ar.limit > 0 ? Math.floor(ar.limit) : 10;
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
      const summarizeModel = typeof ar.summarizeModel === "string" ? ar.summarizeModel : undefined;
      const progressiveMaxCandidates =
        typeof ar.progressiveMaxCandidates === "number" && ar.progressiveMaxCandidates > 0
          ? Math.floor(ar.progressiveMaxCandidates)
          : 15;
      let progressiveIndexMaxTokens: number | undefined =
        typeof ar.progressiveIndexMaxTokens === "number" && ar.progressiveIndexMaxTokens > 0
          ? Math.floor(ar.progressiveIndexMaxTokens)
          : undefined;
      // Default index cap to 300 when using progressive disclosure (keeps index ~150–300 tokens)
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
      // Auth failure recall config
      const authFailureRaw = ar.authFailure as Record<string, unknown> | undefined;
      const authFailure: AuthFailureRecallConfig = {
        enabled: authFailureRaw?.enabled !== false, // enabled by default
        patterns: Array.isArray(authFailureRaw?.patterns)
          ? (authFailureRaw.patterns as string[]).filter((p) => typeof p === "string" && p.length > 0)
          : [],
        maxRecallsPerTarget: typeof authFailureRaw?.maxRecallsPerTarget === "number" && authFailureRaw.maxRecallsPerTarget >= 0
          ? Math.floor(authFailureRaw.maxRecallsPerTarget)
          : 1,
        includeVaultHints: authFailureRaw?.includeVaultHints !== false,
      };
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
        authFailure,
      };
    } else {
      autoRecall = {
        enabled: arRaw !== false,
        maxTokens: 800,
        maxPerMemoryChars: 0,
        injectionFormat: "full",
        limit: 10,
        minScore: 0.3,
        preferLongTerm: false,
        useImportanceRecency: false,
        entityLookup: { enabled: false, entities: [], maxFactsPerEntity: 2 },
        summaryThreshold: 300,
        summaryMaxChars: 80,
        useSummaryInInjection: true,
        summarizeWhenOverBudget: false,
        summarizeModel: undefined,
        progressiveMaxCandidates: 15,
        progressiveIndexMaxTokens: undefined,
        progressiveGroupByCategory: false,
        progressivePinnedRecallCount: 3,
        authFailure: {
          enabled: true,
          patterns: [],
          maxRecallsPerTarget: 1,
          includeVaultHints: true,
        },
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
      classifyModel: typeof storeRaw?.classifyModel === "string" ? storeRaw.classifyModel : undefined,
    };

    // Parse WAL config (enabled by default for crash resilience)
    const walRaw = cfg.wal as Record<string, unknown> | undefined;
    const wal: WALConfig = {
      enabled: walRaw?.enabled !== false,
      walPath: typeof walRaw?.walPath === "string" ? walRaw.walPath : undefined,
      maxAge: typeof walRaw?.maxAge === "number" && walRaw.maxAge > 0 ? walRaw.maxAge : 5 * 60 * 1000,
    };

    // Helper to parse credential autoCapture and expiryWarningDays (shared between vault and memory-only modes)
    function parseCredentialOptions(credRaw: Record<string, unknown> | undefined): {
      autoCapture: CredentialAutoCaptureConfig | undefined;
      autoDetect: boolean;
      expiryWarningDays: number;
    } {
      const autoCaptureRaw = credRaw?.autoCapture as Record<string, unknown> | undefined;
      const autoCapture: CredentialAutoCaptureConfig | undefined = autoCaptureRaw
        ? {
            toolCalls: autoCaptureRaw.toolCalls === true,
            patterns: "builtin",
            logCaptures: autoCaptureRaw.logCaptures !== false,
          }
        : undefined;
      return {
        autoCapture,
        autoDetect: credRaw?.autoDetect === true,
        expiryWarningDays: typeof credRaw?.expiryWarningDays === "number" && credRaw.expiryWarningDays >= 0
          ? Math.floor(credRaw.expiryWarningDays)
          : 7,
      };
    }

    // Parse credentials config (opt-in). Vault works with or without encryption; encryption is never required.
    const credRaw = cfg.credentials as Record<string, unknown> | undefined;
    const explicitlyDisabled = credRaw?.enabled === false;
    const encKeyRaw = typeof credRaw?.encryptionKey === "string" ? credRaw.encryptionKey : "";
    let encryptionKey = "";
    if (encKeyRaw.startsWith("env:")) {
      const envVar = encKeyRaw.slice(4).trim();
      const val = process.env[envVar];
      if (val && val.length >= 16) {
        encryptionKey = val;
      } else if (encKeyRaw.length > 0) {
        // env:VAR set but missing or too short → use plaintext vault, do not block plugin load
        console.warn(
          `memory-hybrid: credentials.encryptionKey env var ${envVar} is not set or too short (min 16 chars). Using plaintext vault. Set the variable or omit credentials.encryptionKey.`,
        );
      }
    } else if (encKeyRaw.length >= 16) {
      encryptionKey = encKeyRaw;
    } else if (encKeyRaw.length > 0) {
      // Short key (1-15 chars) → use plaintext vault, do not block plugin load
      console.warn(
        "memory-hybrid: credentials.encryptionKey must be at least 16 characters for encryption. Using plaintext vault. Omit it or set a 16+ char key (or env:VAR).",
      );
    }
    const hasValidKey = encryptionKey.length >= 16;
    const shouldEnable = !explicitlyDisabled && (credRaw?.enabled === true || hasValidKey);

    let credentials: CredentialsConfig;
    if (shouldEnable) {
      const opts = parseCredentialOptions(credRaw);
      // M1 FIX: Log info message when plaintext mode is chosen explicitly
      if (!hasValidKey && credRaw?.enabled === true) {
        console.info("Credentials vault enabled (plaintext mode — no encryption key set)");
      }
      credentials = {
        enabled: true,
        store: "sqlite",
        encryptionKey: hasValidKey ? encryptionKey : "",
        ...opts,
      };
    } else {
      credentials = {
        enabled: false,
        store: "sqlite",
        encryptionKey: "",
        autoDetect: false,
        expiryWarningDays: 7,
      };
    }

    // Parse graph config
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

    // Parse reflection config
    const reflectionRaw = cfg.reflection as Record<string, unknown> | undefined;
    const reflection: ReflectionConfig = {
      enabled: reflectionRaw?.enabled === true,
      model: typeof reflectionRaw?.model === "string" ? reflectionRaw.model : undefined,
      defaultWindow: typeof reflectionRaw?.defaultWindow === "number" && reflectionRaw.defaultWindow > 0
        ? Math.min(90, Math.floor(reflectionRaw.defaultWindow))
        : 14,
      minObservations: typeof reflectionRaw?.minObservations === "number" && reflectionRaw.minObservations >= 1
        ? Math.floor(reflectionRaw.minObservations)
        : 2,
    };

    // Parse procedures config
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

    // Parse optional distill config (Gemini for session distillation)
    const distillRaw = cfg.distill as Record<string, unknown> | undefined;
    const distill =
      distillRaw && typeof distillRaw === "object"
        ? {
            apiKey: typeof distillRaw.apiKey === "string" ? distillRaw.apiKey : undefined,
            defaultModel: typeof distillRaw.defaultModel === "string" ? distillRaw.defaultModel : undefined,
            fallbackModels: Array.isArray(distillRaw.fallbackModels) && distillRaw.fallbackModels.every((m) => typeof m === "string")
              ? (distillRaw.fallbackModels as string[])
              : undefined,
            extractDirectives: distillRaw.extractDirectives !== false,
            extractReinforcement: distillRaw.extractReinforcement !== false,
            reinforcementBoost: typeof distillRaw.reinforcementBoost === "number" && distillRaw.reinforcementBoost >= 0 && distillRaw.reinforcementBoost <= 1.0
              ? distillRaw.reinforcementBoost
              : 0.1,
            reinforcementProcedureBoost: typeof distillRaw.reinforcementProcedureBoost === "number" && distillRaw.reinforcementProcedureBoost >= 0 && distillRaw.reinforcementProcedureBoost <= 1.0
              ? distillRaw.reinforcementProcedureBoost
              : 0.1,
            reinforcementPromotionThreshold: typeof distillRaw.reinforcementPromotionThreshold === "number" && distillRaw.reinforcementPromotionThreshold >= 1
              ? Math.floor(distillRaw.reinforcementPromotionThreshold)
              : 2,
          }
        : undefined;

    const langKwRaw = cfg.languageKeywords as Record<string, unknown> | undefined;
    const languageKeywords =
      langKwRaw && typeof langKwRaw === "object"
        ? {
            autoBuild: langKwRaw.autoBuild !== false,
            weeklyIntervalDays:
              typeof langKwRaw.weeklyIntervalDays === "number" && langKwRaw.weeklyIntervalDays >= 1
                ? Math.min(30, Math.floor(langKwRaw.weeklyIntervalDays))
                : 7,
          }
        : { autoBuild: true, weeklyIntervalDays: 7 };

    // Parse memory tiering config
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

    // Parse optional ingest config
    const ingestRaw = cfg.ingest as Record<string, unknown> | undefined;
    const ingest: IngestConfig | undefined =
      ingestRaw && Array.isArray(ingestRaw.paths) && ingestRaw.paths.length > 0
        ? {
            paths: (ingestRaw.paths as string[]).filter((p) => typeof p === "string" && p.length > 0),
            chunkSize: typeof ingestRaw.chunkSize === "number" && ingestRaw.chunkSize > 0
              ? Math.floor(ingestRaw.chunkSize)
              : 800,
            overlap: typeof ingestRaw.overlap === "number" && ingestRaw.overlap >= 0
              ? Math.floor(ingestRaw.overlap)
              : 100,
          }
          : undefined;

    // Parse optional search config (HyDE). When hydeModel is unset, runtime uses getDefaultCronModel (issue #92).
    const searchRaw = cfg.search as Record<string, unknown> | undefined;
    const search: SearchConfig | undefined =
      searchRaw && typeof searchRaw === "object"
        ? {
            hydeEnabled: searchRaw.hydeEnabled === true,
            hydeModel:
              typeof searchRaw.hydeModel === "string" && searchRaw.hydeModel.trim().length > 0
                ? searchRaw.hydeModel.trim()
                : undefined,
          }
        : undefined;

    // Parse optional self-correction config
    const scRaw = cfg.selfCorrection as Record<string, unknown> | undefined;
    const selfCorrection: SelfCorrectionConfig | undefined =
      scRaw && typeof scRaw === "object"
        ? {
            semanticDedup: scRaw.semanticDedup !== false,
            semanticDedupThreshold:
              typeof scRaw.semanticDedupThreshold === "number" && scRaw.semanticDedupThreshold >= 0 && scRaw.semanticDedupThreshold <= 1
                ? scRaw.semanticDedupThreshold
                : 0.92,
            toolsSection:
              typeof scRaw.toolsSection === "string" && scRaw.toolsSection.trim().length > 0
                ? scRaw.toolsSection.trim()
                : "Self-correction rules",
            applyToolsByDefault: scRaw.applyToolsByDefault !== false,
            autoRewriteTools: scRaw.autoRewriteTools === true,
            analyzeViaSpawn: scRaw.analyzeViaSpawn === true,
            spawnThreshold:
              typeof scRaw.spawnThreshold === "number" && scRaw.spawnThreshold >= 1
                ? Math.floor(scRaw.spawnThreshold)
                : 15,
            spawnModel: typeof scRaw.spawnModel === "string" ? scRaw.spawnModel : "",
          }
        : undefined;

    // Parse multi-agent config (dynamic agent detection)
    const multiAgentRaw = cfg.multiAgent as Record<string, unknown> | undefined;
    // Parse optional error reporting config
    const errorReportingRaw = cfg.errorReporting as Record<string, unknown> | undefined;
    const errorReporting: ErrorReportingConfig | undefined =
      errorReportingRaw && typeof errorReportingRaw === "object"
        ? (() => {
            const enabled = errorReportingRaw.enabled === true;
            const consent = errorReportingRaw.consent === true;
            const dsnRaw = typeof errorReportingRaw.dsn === "string" ? errorReportingRaw.dsn.trim() : "";
            const modeRaw = typeof errorReportingRaw.mode === "string" ? errorReportingRaw.mode : "community";
            const mode: "community" | "self-hosted" = modeRaw === "self-hosted" ? "self-hosted" : "community";
            
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
          })()
        : undefined;

    const multiAgent: MultiAgentConfig = {
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

    // Parse optional llm config (direct provider API calls, issue #87)
    const llmRaw = cfg.llm as Record<string, unknown> | undefined;
    const defaultList = llmRaw && Array.isArray(llmRaw.default) ? (llmRaw.default as string[]).filter((m) => typeof m === "string" && m.trim().length > 0) : [];
    const heavyList = llmRaw && Array.isArray(llmRaw.heavy) ? (llmRaw.heavy as string[]).filter((m) => typeof m === "string" && m.trim().length > 0) : [];
    const llmProvidersRaw = llmRaw?.providers;
    const llmProviders: Record<string, LLMProviderConfig | undefined> | undefined =
      llmProvidersRaw && typeof llmProvidersRaw === "object" && !Array.isArray(llmProvidersRaw)
        ? Object.fromEntries(
            Object.entries(llmProvidersRaw as Record<string, unknown>).map(([k, v]) => {
              if (!v || typeof v !== "object" || Array.isArray(v)) return [k, undefined];
              const pv = v as Record<string, unknown>;
              return [k.toLowerCase(), {
                apiKey: typeof pv.apiKey === "string" && pv.apiKey.trim().length > 0 ? pv.apiKey.trim() : undefined,
                baseURL: typeof pv.baseURL === "string" && pv.baseURL.trim().length > 0 ? pv.baseURL.trim() : undefined,
              } as LLMProviderConfig];
            }),
          )
        : undefined;
    const nanoList = llmRaw && Array.isArray(llmRaw.nano)
      ? (llmRaw.nano as string[]).filter((m) => typeof m === "string" && m.trim().length > 0)
      : [];
    const llm: LLMConfig | undefined =
      defaultList.length > 0 || heavyList.length > 0
        ? {
            default: defaultList,
            heavy: heavyList,
            ...(nanoList.length > 0 ? { nano: nanoList } : {}),
            fallbackToDefault: llmRaw?.fallbackToDefault === true,
            fallbackModel: typeof llmRaw?.fallbackModel === "string" && (llmRaw.fallbackModel as string).trim().length > 0 ? (llmRaw.fallbackModel as string).trim() : undefined,
            providers: llmProviders,
          }
        : undefined;

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
        models: embeddingModels,
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
      procedures,
      memoryTiering,
      llm,
      distill,
      languageKeywords,
      ingest,
      search,
      selfCorrection,
      multiAgent,
      errorReporting,
      mode: hasPresetOverrides ? "custom" : appliedMode,
    };
  },
};
