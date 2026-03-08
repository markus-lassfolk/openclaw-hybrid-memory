import { homedir } from "node:os";
import { join } from "node:path";
import type { StoreConfig, WALConfig, EventLogConfig, PathConfig } from "../types/core.js";
import type {
  CredentialsConfig,
  CredentialAutoCaptureConfig,
  VectorConfig,
  ActiveTaskConfig,
  SelfCorrectionConfig,
  LLMConfig,
  LLMProviderConfig,
} from "../types/index.js";
import { parseDuration } from "../../utils/duration.js";

export const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_LANCE_PATH = join(homedir(), ".openclaw", "memory", "lancedb");
export const DEFAULT_SQLITE_PATH = join(homedir(), ".openclaw", "memory", "facts.db");
export const DEFAULT_EVENT_ARCHIVE_PATH = "~/.openclaw/event-archive";

export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  // Local / HuggingFace models that users may have previously generated vectors with
  "all-MiniLM-L6-v2": 384,
  "bge-small-en-v1.5": 384,
  // Common Ollama embedding models
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
  "bge-m3": 1024,
  "bge-large": 1024,
};

export const OPENAI_MODELS = new Set([
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
]);

const MAX_ENV_RESOLVE_LENGTH = 10000;

export function resolveEnvVars(value: string): string {
  if (value.length > MAX_ENV_RESOLVE_LENGTH) {
    throw new Error(`Config value too long for environment variable resolution (max ${MAX_ENV_RESOLVE_LENGTH} chars).`);
  }
  // Use [^}]+ not (.*?) to avoid ReDoS (js/polynomial-redos): no backtracking on malicious input.
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const name = String(envVar).trim();
    if (!name) throw new Error("Environment variable name is empty");
    const envValue = process.env[name];
    if (!envValue) throw new Error(`Environment variable ${name} is not set`);
    return envValue;
  });
}

export function parseStoreConfig(cfg: Record<string, unknown>): StoreConfig {
  const storeRaw = cfg.store as Record<string, unknown> | undefined;
  return {
    fuzzyDedupe: storeRaw?.fuzzyDedupe === true,
    classifyBeforeWrite: storeRaw?.classifyBeforeWrite === true,
    classifyModel: typeof storeRaw?.classifyModel === "string" ? storeRaw.classifyModel : undefined,
  };
}

export function parseWALConfig(cfg: Record<string, unknown>): WALConfig {
  const walRaw = cfg.wal as Record<string, unknown> | undefined;
  return {
    enabled: walRaw?.enabled !== false,
    walPath: typeof walRaw?.walPath === "string" ? walRaw.walPath : undefined,
    maxAge: typeof walRaw?.maxAge === "number" && walRaw.maxAge > 0 ? walRaw.maxAge : 5 * 60 * 1000,
  };
}

export function parseEventLogConfig(cfg: Record<string, unknown>): EventLogConfig {
  const eventLogRaw = cfg.eventLog as Record<string, unknown> | undefined;
  return {
    archivalDays:
      typeof eventLogRaw?.archivalDays === "number" && eventLogRaw.archivalDays >= 1
        ? Math.min(3650, Math.floor(eventLogRaw.archivalDays))
        : 90,
    archivePath:
      typeof eventLogRaw?.archivePath === "string" && eventLogRaw.archivePath.trim().length > 0
        ? eventLogRaw.archivePath.trim()
        : DEFAULT_EVENT_ARCHIVE_PATH,
  };
}

export function parsePathConfig(cfg: Record<string, unknown>): PathConfig {
  const pathRaw = cfg.path as Record<string, unknown> | undefined;
  return {
    enabled: pathRaw?.enabled !== false,
    maxPathDepth:
      typeof pathRaw?.maxPathDepth === "number" && pathRaw.maxPathDepth > 0
        ? Math.min(20, Math.floor(pathRaw.maxPathDepth))
        : 10,
  };
}

export function parseVectorConfig(cfg: Record<string, unknown>): VectorConfig {
  const vectorRaw = cfg.vector as Record<string, unknown> | undefined;
  return {
    autoRepair: vectorRaw?.autoRepair === true,
  };
}

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
        requirePatternMatch: autoCaptureRaw.requirePatternMatch === true,
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

export function parseCredentialsConfig(cfg: Record<string, unknown>): CredentialsConfig {
  const credRaw = cfg.credentials as Record<string, unknown> | undefined;
  const explicitlyDisabled = credRaw?.enabled === false;
  const encKeyRaw = typeof credRaw?.encryptionKey === "string" ? credRaw.encryptionKey : "";
  let encryptionKey = "";
  if (encKeyRaw.startsWith("env:")) {
    const envVar = encKeyRaw.slice(4).trim();
    const val = process.env[envVar];
    if (val && val.length >= 16) {
      encryptionKey = val;
    }
  } else if (encKeyRaw.length >= 16) {
    encryptionKey = encKeyRaw;
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
      encryptionKey: "",
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
  const resolvedKey = hasValidKey ? encryptionKey : "";
  Object.defineProperty(credentials, "encryptionKey", {
    value: resolvedKey,
    enumerable: false,
    writable: false,
  });
  return credentials;
}

export function parseActiveTaskConfig(cfg: Record<string, unknown>): ActiveTaskConfig {
  const activeTaskRaw = cfg.activeTask as Record<string, unknown> | undefined;

  // Resolve staleThreshold — support both new string format and legacy staleHours number.
  // Priority: staleThreshold string > staleHours number > default "24h".
  let resolvedStaleThreshold = "24h";
  if (
    typeof activeTaskRaw?.staleThreshold === "string" &&
    activeTaskRaw.staleThreshold.trim().length > 0
  ) {
    try {
      parseDuration(activeTaskRaw.staleThreshold.trim());
    } catch (err: unknown) {
      throw new Error(
        `activeTask.staleThreshold is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    resolvedStaleThreshold = activeTaskRaw.staleThreshold.trim();
  } else if (
    typeof activeTaskRaw?.staleHours === "number" &&
    activeTaskRaw.staleHours > 0
  ) {
    // Backward compat: convert legacy staleHours number → "Xh" string.
    const converted = `${activeTaskRaw.staleHours}h`;
    try {
      parseDuration(converted);
    } catch (err: unknown) {
      throw new Error(
        `activeTask.staleHours is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    resolvedStaleThreshold = converted;
  }

  const staleWarningRaw = activeTaskRaw?.staleWarning as Record<string, unknown> | undefined;
  return {
    enabled: activeTaskRaw?.enabled !== false,
    filePath:
      typeof activeTaskRaw?.filePath === "string" && activeTaskRaw.filePath.trim().length > 0
        ? activeTaskRaw.filePath.trim()
        : "ACTIVE-TASK.md",
    autoCheckpoint: activeTaskRaw?.autoCheckpoint !== false,
    injectionBudget:
      typeof activeTaskRaw?.injectionBudget === "number" && activeTaskRaw.injectionBudget > 0
        ? Math.floor(activeTaskRaw.injectionBudget)
        : 500,
    staleThreshold: resolvedStaleThreshold,
    flushOnComplete: activeTaskRaw?.flushOnComplete !== false,
    staleWarning: {
      enabled: staleWarningRaw?.enabled !== false, // default: true
    },
  };
}

export function parseSelfCorrectionConfig(cfg: Record<string, unknown>): SelfCorrectionConfig | undefined {
  const scRaw = cfg.selfCorrection as Record<string, unknown> | undefined;
  if (!scRaw || typeof scRaw !== "object") return undefined;
  return {
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
  };
}

export function parseLLMConfig(cfg: Record<string, unknown>): LLMConfig | undefined {
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
    defaultList.length > 0 || heavyList.length > 0 || nanoList.length > 0 || llmProviders !== undefined
      ? {
          default: defaultList,
          heavy: heavyList,
          ...(nanoList.length > 0 ? { nano: nanoList } : {}),
          fallbackToDefault: llmRaw?.fallbackToDefault === true,
          fallbackModel: typeof llmRaw?.fallbackModel === "string" && (llmRaw.fallbackModel as string).trim().length > 0 ? (llmRaw.fallbackModel as string).trim() : undefined,
          providers: llmProviders,
        }
      : undefined;
  return llm;
}
