import type { ResearchConfig } from "../types/research.js";

const DEFAULT_TOPIC_BLOCKLIST = ["credential", "secret", "security"];

function parseCount(value: unknown, fallback: number, max = 100): number {
  // >= 0, not > 0: several callers treat 0 as a meaningful value (e.g. trigger.cooldownDays: 0
  // means "no cooldown, may re-queue the same night") — a `> 0` guard silently discarded an
  // explicit 0 and substituted the fallback instead.
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(max, Math.floor(value))
    : fallback;
}

function parseUnitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseResearchConfig(cfg: Record<string, unknown>): ResearchConfig {
  const raw = cfg.research as Record<string, unknown> | undefined;
  const insightsRaw = raw?.insights as Record<string, unknown> | undefined;
  const triggerRaw = raw?.trigger as Record<string, unknown> | undefined;
  const executorRaw = raw?.executor as Record<string, unknown> | undefined;
  const deliveryRaw = raw?.delivery as Record<string, unknown> | undefined;

  const blocklist = Array.isArray(triggerRaw?.topicBlocklist)
    ? (triggerRaw.topicBlocklist as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().toLowerCase())
    : DEFAULT_TOPIC_BLOCKLIST;

  return {
    enabled: raw?.enabled !== false,
    schedule: parseOptionalString(raw?.schedule) ?? "30 3 * * *",
    insights: {
      maxPerRun: parseCount(insightsRaw?.maxPerRun, 2, 10),
      windowDays: parseCount(insightsRaw?.windowDays, 7, 90),
      minEvidence: parseCount(insightsRaw?.minEvidence, 2, 20),
      model: parseOptionalString(insightsRaw?.model),
    },
    trigger: {
      minImportance: parseUnitInterval(triggerRaw?.minImportance, 0.74),
      minEvidence: parseCount(triggerRaw?.minEvidence, 2, 20),
      cooldownDays: parseCount(triggerRaw?.cooldownDays, 14, 365),
      maxPerNight: parseCount(triggerRaw?.maxPerNight, 1, 5),
      topicBlocklist: blocklist,
    },
    executor: {
      maxBriefingChars: parseCount(executorRaw?.maxBriefingChars, 4000, 20_000),
      maxSources: parseCount(executorRaw?.maxSources, 8, 25),
    },
    delivery: {
      mode: deliveryRaw?.mode === "announce" ? "announce" : "none",
      channel: parseOptionalString(deliveryRaw?.channel),
      to: parseOptionalString(deliveryRaw?.to),
      injectDays:
        typeof deliveryRaw?.injectDays === "number" && Number.isFinite(deliveryRaw.injectDays)
          ? Math.max(0, Math.min(30, Math.floor(deliveryRaw.injectDays)))
          : 3,
      maxBriefings: parseCount(deliveryRaw?.maxBriefings, 2, 10),
    },
  };
}
