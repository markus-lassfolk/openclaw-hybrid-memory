import type { StoreConfig, StoreSourceProfile } from "../config/types/core.js";

export type ResolvedDedupeProfile = Required<Pick<StoreSourceProfile, "onDuplicate">> & StoreSourceProfile;

const FALLBACK_PROFILE: ResolvedDedupeProfile = {
  vectorThreshold: 0.95,
  lexicalJaccard: 0.9,
  onDuplicate: "skip",
};

function matchesPattern(pattern: string, source: string): boolean {
  if (pattern === source) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(source);
}

export function resolveDedupeProfile(source: string | null | undefined, store: StoreConfig): ResolvedDedupeProfile {
  const effectiveSource = source?.trim() || "unknown";
  const base = { ...FALLBACK_PROFILE, ...(store.defaultProfile ?? {}) };
  const profiles = store.sourceProfiles ?? {};

  const exact = profiles[effectiveSource];
  if (exact) return { ...base, ...exact, onDuplicate: exact.onDuplicate ?? base.onDuplicate };

  for (const [pattern, profile] of Object.entries(profiles)) {
    if (matchesPattern(pattern, effectiveSource)) {
      return { ...base, ...profile, onDuplicate: profile.onDuplicate ?? base.onDuplicate };
    }
  }

  return base;
}
