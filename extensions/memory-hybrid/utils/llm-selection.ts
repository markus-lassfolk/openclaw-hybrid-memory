import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel, getLLMModelPreferenceUnfiltered } from "../config.js";

export type CronModelTier = "nano" | "maintenance" | "default" | "heavy";

export type TierPreferenceWithSources = {
  tier: CronModelTier;
  models: string[];
  sources: string[];
  /** True when the tier list was explicitly configured in plugin config (llm.<tier> array). */
  explicit: boolean;
};

function readTierList(cfg: HybridMemoryConfig, tier: CronModelTier): string[] | undefined {
  const list =
    tier === "nano"
      ? cfg.llm?.nano
      : tier === "maintenance"
        ? cfg.llm?.maintenance
        : tier === "heavy"
          ? cfg.llm?.heavy
          : cfg.llm?.default;
  if (!Array.isArray(list)) return undefined;
  const trimmed = list.map((m) => (typeof m === "string" ? m.trim() : "")).filter((m) => m.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveTierPreferenceWithSources(
  cfg: HybridMemoryConfig,
  tier: CronModelTier,
): TierPreferenceWithSources {
  const cronCfg = getCronModelConfig(cfg);
  const models = getLLMModelPreferenceUnfiltered(cronCfg, tier);

  const sources: string[] = [];
  const configuredTierList = readTierList(cfg, tier);
  const explicit = configuredTierList != null;
  const configuredDefault = readTierList(cfg, "default");

  for (let i = 0; i < models.length; i++) {
    if (configuredTierList && configuredTierList[i] === models[i]) {
      sources.push(`llm.${tier}[${i}]`);
      continue;
    }
    if (
      (tier === "nano" || tier === "maintenance") &&
      !configuredTierList &&
      configuredDefault &&
      configuredDefault[i] === models[i]
    ) {
      sources.push(`llm.default[${i}]`);
      continue;
    }
    sources.push("built-in");
  }

  return { tier, models, sources, explicit };
}

export type ResolvedModelWithSource = {
  model: string;
  source: string;
};

export function resolveModelFromTier(cfg: HybridMemoryConfig, tier: CronModelTier): ResolvedModelWithSource {
  const pref = resolveTierPreferenceWithSources(cfg, tier);
  const defaultModel = getDefaultCronModel(getCronModelConfig(cfg), tier);
  const model = pref.models[0] ?? defaultModel;
  const source = pref.models.length > 0 ? (pref.sources[0] ?? "built-in") : "built-in";
  return { model, source };
}
