// Re-export all types
export * from "./types/index.js";

// Config schema — isolated module so `hybridConfigSchema` is never undefined when the config
// barrel re-exports parsers (avoids circular init: parsers → … → config/index before `hybridConfigSchema` is set).
export { hybridConfigSchema } from "./hybrid-schema.js";

// Re-export utilities
export {
  DEFAULT_MEMORY_CATEGORIES,
  getMemoryCategories,
  setMemoryCategories,
  isValidCategory,
  PRESET_OVERRIDES,
  isCompactVerbosity,
} from "./utils.js";

// Re-export embedding dimension utilities
export { EMBEDDING_DIMENSIONS, OPENAI_MODELS } from "./parsers/core.js";

// Re-export vectorDimsForModel and parseVerbosityLevel from parsers/index
export { vectorDimsForModel, parseVerbosityLevel } from "./parsers/index.js";

// LLM model utilities
import type { CronModelConfig, CronModelTier, HybridMemoryConfig } from "./types/index.js";
import { resolveSecretRef } from "./parsers/core.js";

const OPENAI_NANO_CRON_MODEL = "openai/gpt-4.1-nano";
const OPENAI_DEFAULT_CRON_MODEL = "openai/gpt-4.1-mini";
const OPENAI_HEAVY_CRON_MODEL = "openai/gpt-5.4";
const GEMINI_NANO_MODEL = "google/gemini-2.5-flash-lite";
const GEMINI_DEFAULT_MODEL = "google/gemini-2.5-flash";
const GEMINI_HEAVY_MODEL = "google/gemini-3.1-pro-preview";
const CLAUDE_NANO_MODEL = "anthropic/claude-haiku-4-5-20251001";
const CLAUDE_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const CLAUDE_HEAVY_MODEL = "anthropic/claude-opus-4-6";

function hasKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.length >= 10;
}

/** True if apiKey is present and, for env:/file: SecretRefs, resolvable at runtime (verify / getProvidersWithKeys). */
function hasEffectiveKey(apiKey: string | undefined): boolean {
  if (!hasKey(apiKey)) return false;
  const k = apiKey!.trim();
  if (k.startsWith("env:") || k.startsWith("file:")) return resolveSecretRef(k) !== undefined;
  return true;
}

/** Legacy single-model resolution (for backward compat when no llm config). Used only when no list is built. */
function getDefaultCronModelLegacy(pluginConfig: CronModelConfig | undefined, tier: CronModelTier): string {
  if (!pluginConfig) {
    if (tier === "heavy") return OPENAI_HEAVY_CRON_MODEL;
    if (tier === "nano") return OPENAI_NANO_CRON_MODEL;
    return OPENAI_DEFAULT_CRON_MODEL;
  }
  if (hasKey(pluginConfig.distill?.apiKey)) {
    const defaultModel = pluginConfig.distill?.defaultModel?.trim();
    // If the user explicitly configured a defaultModel, respect it for all tiers.
    // Only fall back to provider-specific nano/heavy variants when no explicit model is set.
    // Users who want a specific cheap model for nano operations should configure llm.nano instead.
    if (defaultModel) return defaultModel;
    if (tier === "heavy") return GEMINI_HEAVY_MODEL;
    if (tier === "nano") return GEMINI_NANO_MODEL;
    return GEMINI_DEFAULT_MODEL;
  }
  if (hasKey(pluginConfig.claude?.apiKey)) {
    const defaultModel = pluginConfig.claude?.defaultModel?.trim();
    // Same: respect explicit defaultModel for all tiers; use nano variant only when unset.
    if (defaultModel) return defaultModel;
    if (tier === "heavy") return CLAUDE_HEAVY_MODEL;
    if (tier === "nano") return CLAUDE_NANO_MODEL;
    return CLAUDE_DEFAULT_MODEL;
  }
  if (hasKey(pluginConfig.embedding?.apiKey)) {
    if (tier === "heavy") return OPENAI_HEAVY_CRON_MODEL;
    if (tier === "nano") return OPENAI_NANO_CRON_MODEL;
    return OPENAI_DEFAULT_CRON_MODEL;
  }
  if (tier === "heavy") return OPENAI_HEAVY_CRON_MODEL;
  if (tier === "nano") return OPENAI_NANO_CRON_MODEL;
  return OPENAI_DEFAULT_CRON_MODEL;
}

/**
 * Preferred provider order for out-of-the-box failover: Research/Heavy favours Gemini (context), then OpenAI, then Claude.
 * Uses OpenClaw-style provider/model IDs so the gateway accepts them. First working model wins at runtime.
 */
function getDefaultPreferredModelList(pluginConfig: CronModelConfig | undefined, tier: CronModelTier): string[] {
  if (!pluginConfig) {
    if (tier === "heavy") return [OPENAI_HEAVY_CRON_MODEL];
    if (tier === "nano") return [OPENAI_NANO_CRON_MODEL];
    return [OPENAI_DEFAULT_CRON_MODEL];
  }
  const list: string[] = [];
  if (hasKey(pluginConfig.distill?.apiKey)) {
    const m = pluginConfig.distill?.defaultModel?.trim();
    // Respect explicit defaultModel for all tiers; fall back to tier-specific defaults only when unset.
    list.push(
      m || (tier === "nano" ? GEMINI_NANO_MODEL : tier === "heavy" ? GEMINI_HEAVY_MODEL : GEMINI_DEFAULT_MODEL),
    );
  }
  if (hasKey(pluginConfig.embedding?.apiKey)) {
    if (tier === "nano") list.push(OPENAI_NANO_CRON_MODEL);
    else list.push(tier === "heavy" ? OPENAI_HEAVY_CRON_MODEL : OPENAI_DEFAULT_CRON_MODEL);
  }
  if (hasKey(pluginConfig.claude?.apiKey)) {
    const m = pluginConfig.claude?.defaultModel?.trim();
    // Respect explicit defaultModel for all tiers; fall back to tier-specific defaults only when unset.
    list.push(
      m || (tier === "nano" ? CLAUDE_NANO_MODEL : tier === "heavy" ? CLAUDE_HEAVY_MODEL : CLAUDE_DEFAULT_MODEL),
    );
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
function getDisabledProviderSet(pluginConfig: CronModelConfig | undefined): Set<string> {
  const disabled = pluginConfig?.llm?.disabledProviders;
  if (!Array.isArray(disabled) || disabled.length === 0) return new Set();
  return new Set(disabled.map((p) => String(p).trim().toLowerCase()));
}

/**
 * Infer provider from model name.
 * Supports bare model names (e.g., gemini-2.5-flash -> google, claude-sonnet-4-6 -> anthropic, gpt-4 -> openai).
 */
function inferProviderFromModel(model: string): string {
  if (model.includes("/")) {
    return model.split("/")[0].trim().toLowerCase();
  }
  const bare = model.trim().toLowerCase();
  if (bare.startsWith("gemini-")) return "google";
  if (bare.startsWith("claude-")) return "anthropic";
  if (bare.startsWith("gpt-") || bare.match(/^o[0-9]/)) return "openai";
  return "openai";
}

function filterModelsByDisabled(models: string[], disabledSet: Set<string>): string[] {
  if (disabledSet.size === 0) return models;
  return models.filter((m) => {
    const prefix = inferProviderFromModel(m);
    return !disabledSet.has(prefix);
  });
}

/** Same as getLLMModelPreference but does not exclude disabledProviders. Use for verify table so disabled providers are still listed. */
export function getLLMModelPreferenceUnfiltered(
  pluginConfig: CronModelConfig | undefined,
  tier: CronModelTier,
): string[] {
  if (tier === "nano") {
    const nanoList = pluginConfig?.llm?.nano;
    if (Array.isArray(nanoList) && nanoList.length > 0) {
      const trimmed = nanoList.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
      if (trimmed.length > 0) return trimmed;
    }
    return getLLMModelPreferenceUnfiltered(pluginConfig, "default");
  }
  const list = tier === "heavy" ? pluginConfig?.llm?.heavy : pluginConfig?.llm?.default;
  if (Array.isArray(list) && list.length > 0) {
    const trimmed = list.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
    if (trimmed.length > 0) {
      if (pluginConfig?.llm?.fallbackToDefault) {
        const fallback = pluginConfig.llm.fallbackModel?.trim();
        if (fallback && !trimmed.includes(fallback)) return [...trimmed, fallback];
      }
      return trimmed;
    }
  }
  return getDefaultPreferredModelList(pluginConfig, tier);
}

export function getLLMModelPreference(pluginConfig: CronModelConfig | undefined, tier: CronModelTier): string[] {
  const disabledSet = getDisabledProviderSet(pluginConfig);
  const unfiltered = getLLMModelPreferenceUnfiltered(pluginConfig, tier);
  return filterModelsByDisabled(unfiltered, disabledSet);
}

/**
 * Report which providers have API keys (for verify/transparency).
 * Checks both legacy key fields (distill.apiKey → gemini, embedding.apiKey → openai)
 * and the new llm.providers map so all configured providers are shown.
 */
export function getProvidersWithKeys(pluginConfig: CronModelConfig | undefined): string[] {
  if (!pluginConfig) return [];
  const disabledSet = getDisabledProviderSet(pluginConfig);
  const seen = new Set<string>();
  const out: string[] = [];

  function add(name: string) {
    const lower = name.toLowerCase();
    if (disabledSet.has(lower)) return;
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(name);
    }
  }

  // Legacy / built-in key fields (resolve env:/file: so GOOGLE_API_KEY etc. count when set)
  if (hasEffectiveKey(pluginConfig.distill?.apiKey)) add("google");
  if (hasEffectiveKey(pluginConfig.embedding?.apiKey)) add("openai");
  if (hasEffectiveKey(pluginConfig.claude?.apiKey)) add("anthropic");

  // llm.providers map — any provider with an explicit apiKey
  const providers = pluginConfig.llm?.providers;
  if (providers && typeof providers === "object") {
    for (const [prefix, pCfg] of Object.entries(providers)) {
      if (pCfg && hasEffectiveKey(pCfg.apiKey)) add(prefix);
    }
  }

  // Env fallbacks so providers show as configured when only env is set (e.g. GOOGLE_API_KEY on Doris)
  if (
    !seen.has("google") &&
    typeof process.env.GOOGLE_API_KEY === "string" &&
    process.env.GOOGLE_API_KEY.trim().length >= 10
  ) {
    add("google");
  }
  if (
    !seen.has("anthropic") &&
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.trim().length >= 10
  ) {
    add("anthropic");
  }

  return out;
}

/**
 * Resolve which LLM model to use for a maintenance cron job based on user config.
 * When llm.default/heavy are set, returns the first model in the preference list (gateway-routed).
 * Otherwise legacy: prefer provider the user has configured (Gemini > Claude > OpenAI) > fallback.
 */
export function getDefaultCronModel(pluginConfig: CronModelConfig | undefined, tier: CronModelTier): string {
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
  const fallbackModels = pref.length > 1 ? pref.slice(1) : cfg.llm ? undefined : cfg.distill?.fallbackModels;
  return { defaultModel, fallbackModels };
}
