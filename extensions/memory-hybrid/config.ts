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
};

/** Auto-recall injection line format: full = [backend/category] text, short = category: text, minimal = text only */
export type AutoRecallInjectionFormat = "full" | "short" | "minimal";

/** Entity-centric recall: when prompt mentions an entity from the list, merge lookup(entity) facts into candidates */
export type EntityLookupConfig = {
  enabled: boolean;
  entities: string[];           // e.g. ["user", "owner", "decision"]; prompt matched case-insensitively
  maxFactsPerEntity: number;    // max facts to merge per matched entity (default 2)
};

/** Auto-recall: enable/disable plus token cap, format, limit, minScore, preferLongTerm, importance/recency, entity lookup, summary */
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
};

/** Store options: fuzzy dedupe (2.3) uses normalized-text hash to skip near-duplicate facts. */
export type StoreConfig = {
  fuzzyDedupe: boolean;
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
};

/** Default categories — can be extended via config.categories */
export const DEFAULT_MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
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
      throw new Error("embedding.apiKey is required. Set it in plugins.entries[\"memory-hybrid\"].config.embedding. Run 'openclaw hybrid-mem verify --fix' for help.");
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
    };

    // Parse autoRecall: boolean (legacy) or { enabled?, maxTokens?, maxPerMemoryChars?, injectionFormat? }
    const arRaw = cfg.autoRecall;
    const VALID_FORMATS = ["full", "short", "minimal"] as const;
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
      };
    }

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" && cfg.captureMaxChars > 0
        ? cfg.captureMaxChars
        : 5000;

    const storeRaw = cfg.store as Record<string, unknown> | undefined;
    const store: StoreConfig = {
      fuzzyDedupe: storeRaw?.fuzzyDedupe === true,
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
    };
  },
};
