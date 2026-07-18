import type { LoomConfig } from "../types/index.js";

function parseDeprecatedCommands(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * Parse the `loom` config section (Epic #2150). The Loom is ON by default —
 * only an explicit `loom.enabled: false` disables the whole subsystem. Every
 * sub-section defaults to following the master `enabled` flag when it has no
 * explicit `enabled` key of its own, so a bare `{}` (or no `loom` key at all)
 * turns on every Loom feature, and `{ loom: { drift: { enabled: false } } }`
 * turns off just that one section while leaving the rest on.
 */
export function parseLoomConfig(cfg: Record<string, unknown>): LoomConfig {
  const raw = cfg.loom as Record<string, unknown> | undefined;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  const int = (v: unknown, fallback: number, min: number, max: number): number =>
    Math.floor(num(v, fallback, min, max));
  const sub = (key: string): Record<string, unknown> | undefined => raw?.[key] as Record<string, unknown> | undefined;

  const enabled = raw?.enabled !== false;
  const subEnabled = (key: string): boolean => {
    const s = sub(key);
    return s?.enabled === undefined ? enabled : s.enabled !== false;
  };

  const evidenceRaw = sub("evidence");
  const beliefsRaw = sub("beliefs");
  const liveChecksRaw = sub("liveChecks");
  const openLoopsRaw = sub("openLoops");
  const driftRaw = sub("drift");
  const lifecycleRaw = sub("lifecycle");
  const attentionRaw = sub("attention");
  const runwayRaw = sub("runway");
  const briefRaw = sub("brief");
  const reportRaw = sub("report");
  const procedureTriageRaw = sub("procedureTriage");

  return {
    enabled,
    evidence: {
      enabled: subEnabled("evidence"),
      redactSecrets: evidenceRaw?.redactSecrets !== false,
      rejectUnredactable: evidenceRaw?.rejectUnredactable !== false,
    },
    beliefs: {
      enabled: subEnabled("beliefs"),
      staleAfterDays: int(beliefsRaw?.staleAfterDays, 30, 1, 3650),
    },
    liveChecks: {
      enabled: subEnabled("liveChecks"),
      defaultTtlHours: int(liveChecksRaw?.defaultTtlHours, 24, 1, 8760),
    },
    openLoops: {
      enabled: subEnabled("openLoops"),
      defaultResurfaceDays: int(openLoopsRaw?.defaultResurfaceDays, 7, 1, 3650),
    },
    drift: {
      enabled: subEnabled("drift"),
      deprecatedCommands: parseDeprecatedCommands(driftRaw?.deprecatedCommands),
    },
    lifecycle: {
      enabled: subEnabled("lifecycle"),
      staleAfterDays: int(lifecycleRaw?.staleAfterDays, 45, 1, 3650),
      requireStrongConfirmForVerified: lifecycleRaw?.requireStrongConfirmForVerified !== false,
    },
    attention: {
      enabled: subEnabled("attention"),
      defaultLimit: int(attentionRaw?.defaultLimit, 20, 1, 500),
    },
    runway: {
      enabled: subEnabled("runway"),
      maxItemsPerSection: int(runwayRaw?.maxItemsPerSection, 8, 1, 100),
    },
    brief: {
      enabled: subEnabled("brief"),
      maxChars: int(briefRaw?.maxChars, 4000, 200, 50_000),
    },
    report: {
      enabled: subEnabled("report"),
      maxItemsPerSection: int(reportRaw?.maxItemsPerSection, 10, 1, 200),
    },
    procedureTriage: {
      enabled: subEnabled("procedureTriage"),
      defaultBatchSize: int(procedureTriageRaw?.defaultBatchSize, 20, 1, 500),
    },
    maintenance: {
      enabled: subEnabled("maintenance"),
      applySafeDrift: sub("maintenance")?.applySafeDrift === true,
    },
  };
}
