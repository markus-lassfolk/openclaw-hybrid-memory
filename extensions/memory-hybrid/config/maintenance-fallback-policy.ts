/**
 * Maintenance-tier LLM fallback policy (Issue #1226).
 *
 * Prevents distill/reflection-style maintenance paths from chaining into expensive models
 * when `llm.maintenance` aliases to a broad `llm.default` list.
 */

import type { HybridMemoryConfig } from "./types/index.js";

export type MaintenanceFallbackPolicy = "default" | "cheap-only" | "explicit-only" | "allow-heavy";

export function normalizeMaintenanceFallbackPolicy(raw: unknown): MaintenanceFallbackPolicy | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase().replace(/_/g, "-");
  if (v === "default" || v === "legacy") return "default";
  if (v === "cheap-only") return "cheap-only";
  if (v === "explicit-only" || v === "same-tier") return "explicit-only";
  if (v === "allow-heavy") return "allow-heavy";
  return undefined;
}

/**
 * Effective policy for maintenance-tier resolution.
 * - Unset config → `cheap-only` (safe default; Issue #1226).
 * - `allow-heavy` → same as `default` (full tier + global fallbacks).
 */
export function effectiveMaintenanceFallbackPolicy(cfg: HybridMemoryConfig): MaintenanceFallbackPolicy {
  const p = cfg.llm?.maintenanceFallbackPolicy;
  if (p === "default" || p === "allow-heavy") return "default";
  if (p === "explicit-only" || p === "cheap-only") return p;
  return "cheap-only";
}

/** Human-readable label for `openclaw hybrid-mem config` / verbose distill. */
export function describeMaintenanceFallbackPolicy(cfg: HybridMemoryConfig): string {
  const eff = effectiveMaintenanceFallbackPolicy(cfg);
  const raw = cfg.llm?.maintenanceFallbackPolicy;
  if (raw === undefined) {
    return `${eff} (effective; unset in config — expensive maintenance fallbacks are stripped by default)`;
  }
  return `${eff}${raw !== eff ? ` (from llm.maintenanceFallbackPolicy=${JSON.stringify(raw)})` : ""}`;
}

/**
 * Heuristic: models that should not be used as automatic maintenance fallbacks unless the
 * operator lists them explicitly in `llm.maintenance` (Issue #1226 acceptance list + minimax).
 */
export function isExpensiveMaintenanceFallbackModel(modelId: string): boolean {
  const full = modelId.trim().toLowerCase();
  if (!full) return false;
  const seg = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;

  // Cheap / maintenance-friendly — never classify as expensive.
  if (
    /\b(nano|flash-lite|haiku)\b/.test(seg) ||
    /(^|[-._])mini($|[-._])/i.test(seg) ||
    /gpt-4\.1-mini|gpt-4o-mini|gpt-4\.1-nano|1\.5-flash|2\.0-flash-lite|2\.5-flash(?!-pro)/i.test(seg)
  ) {
    if (/minimax-m2\.7|^minimax-m2$/i.test(seg)) return true;
    return false;
  }

  if (/\bo3\b/i.test(seg) && !/o3-mini/i.test(seg)) return true;
  if (/gpt-5\.5/i.test(seg)) return true;
  if (/gpt-5\.4/i.test(seg) && !/mini/i.test(seg)) return true;
  if (/^gpt-4o$/i.test(seg) || /^gpt-4o[^m]/i.test(seg)) return true;
  if (/minimax-m2\.7|^minimax-m2$/i.test(seg)) return true;
  if (/claude-opus|opus-4/i.test(seg)) return true;
  if (/gemini-3|gemini-2\.5-pro|gemini-3\.1-pro/i.test(seg)) return true;
  if (/^gpt-5\./i.test(seg) && !/mini/i.test(seg)) return true;

  return false;
}

export function filterMaintenanceTierFallbackModels(
  chain: string[],
  primary: string,
  explicitMaintenanceSet: Set<string> | undefined,
): string[] {
  return chain.filter((m) => {
    const t = m.trim();
    if (!t || t === primary) return false;
    if (explicitMaintenanceSet?.has(t)) return true;
    return !isExpensiveMaintenanceFallbackModel(t);
  });
}
