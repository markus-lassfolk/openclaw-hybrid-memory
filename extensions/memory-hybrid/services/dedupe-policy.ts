import type { StoreConfig } from "../config/types/core.js";

export type StoreDedupeAction = "skip" | "boost" | "merge" | "store";

export type ResolvedDedupeProfile = {
  sourcePattern: string;
  vectorThreshold?: number;
  lexicalJaccard?: number;
  maxPerDay?: number;
  onDuplicate: StoreDedupeAction;
  boostBy: number;
};

const DEFAULT_PROFILE: ResolvedDedupeProfile = {
  sourcePattern: "<default>",
  vectorThreshold: 0.95,
  lexicalJaccard: 0.9,
  onDuplicate: "skip",
  boostBy: 0.05,
};

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizeProfile(sourcePattern: string, raw?: StoreConfig["defaultProfile"]): ResolvedDedupeProfile {
  return {
    ...DEFAULT_PROFILE,
    sourcePattern,
    vectorThreshold:
      typeof raw?.vectorThreshold === "number" && raw.vectorThreshold > 0 && raw.vectorThreshold <= 1
        ? raw.vectorThreshold
        : DEFAULT_PROFILE.vectorThreshold,
    lexicalJaccard:
      typeof raw?.lexicalJaccard === "number" && raw.lexicalJaccard > 0 && raw.lexicalJaccard <= 1
        ? raw.lexicalJaccard
        : DEFAULT_PROFILE.lexicalJaccard,
    maxPerDay:
      typeof raw?.maxPerDay === "number" && raw.maxPerDay > 0 ? Math.floor(raw.maxPerDay) : undefined,
    onDuplicate: raw?.onDuplicate ?? DEFAULT_PROFILE.onDuplicate,
    boostBy: typeof raw?.boostBy === "number" && raw.boostBy > 0 ? Math.min(1, raw.boostBy) : DEFAULT_PROFILE.boostBy,
  };
}

export function resolveDedupeProfile(source: string | null | undefined, store: StoreConfig): ResolvedDedupeProfile {
  const sourceKey = source?.trim() || "conversation";
  const base = normalizeProfile("<default>", store.defaultProfile);
  const profiles = store.sourceProfiles ?? {};

  if (profiles[sourceKey]) return { ...base, ...normalizeProfile(sourceKey, profiles[sourceKey]) };

  for (const [pattern, profile] of Object.entries(profiles)) {
    if (!pattern.includes("*")) continue;
    if (globToRegExp(pattern).test(sourceKey)) return { ...base, ...normalizeProfile(pattern, profile) };
  }

  return base;
}
