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

function normalizeProfile(sourcePattern: string, raw?: StoreConfig["defaultProfile"]): Partial<ResolvedDedupeProfile> {
  const partial: Partial<ResolvedDedupeProfile> = { sourcePattern };
  if (typeof raw?.vectorThreshold === "number" && raw.vectorThreshold > 0 && raw.vectorThreshold <= 1) {
    partial.vectorThreshold = raw.vectorThreshold;
  }
  if (typeof raw?.lexicalJaccard === "number" && raw.lexicalJaccard > 0 && raw.lexicalJaccard <= 1) {
    partial.lexicalJaccard = raw.lexicalJaccard;
  }
  if (typeof raw?.maxPerDay === "number" && raw.maxPerDay > 0) {
    partial.maxPerDay = Math.floor(raw.maxPerDay);
  }
  if (raw?.onDuplicate !== undefined) {
    partial.onDuplicate = raw.onDuplicate;
  }
  if (typeof raw?.boostBy === "number" && raw.boostBy > 0) {
    partial.boostBy = Math.min(1, raw.boostBy);
  }
  return partial;
}

export function resolveDedupeProfile(source: string | null | undefined, store: StoreConfig): ResolvedDedupeProfile {
  const sourceKey = source?.trim() || "conversation";
  const base = { ...DEFAULT_PROFILE, ...normalizeProfile("<default>", store.defaultProfile) };
  const profiles = store.sourceProfiles ?? {};

  if (profiles[sourceKey]) return { ...base, ...normalizeProfile(sourceKey, profiles[sourceKey]) };

  for (const [pattern, profile] of Object.entries(profiles)) {
    if (!pattern.includes("*")) continue;
    if (globToRegExp(pattern).test(sourceKey)) return { ...base, ...normalizeProfile(pattern, profile) };
  }

  return base;
}
