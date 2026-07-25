import { pluginLogger } from "../../utils/logger.js";

import type {
  CouncilConfig,
  CouncilProvenanceMode,
  CronReliabilityConfig,
  HealthConfig,
  MaintenanceConfig,
  MaintenanceFailureReportingConfig,
  MaintenancePrivacyRedactionConfig,
  MonthlyReviewConfig,
  NightlyCycleConfig,
  ProvenanceConfig,
  VerificationConfig,
} from "../types/maintenance.js";

export function parseVerificationConfig(cfg: Record<string, unknown>): VerificationConfig {
  const verifRaw = cfg.verification as Record<string, unknown> | undefined;
  return {
    enabled: verifRaw?.enabled === true,
    backupPath:
      typeof verifRaw?.backupPath === "string" && verifRaw.backupPath.trim().length > 0
        ? verifRaw.backupPath.trim()
        : "~/.openclaw/verified-facts.json",
    reverificationDays:
      typeof verifRaw?.reverificationDays === "number" && verifRaw.reverificationDays > 0
        ? Math.floor(verifRaw.reverificationDays)
        : 30,
    autoClassify: verifRaw?.autoClassify !== false,
    continuousVerification: verifRaw?.continuousVerification === true,
    cycleDays: typeof verifRaw?.cycleDays === "number" && verifRaw.cycleDays > 0 ? Math.floor(verifRaw.cycleDays) : 30,
    verificationModel:
      typeof verifRaw?.verificationModel === "string" && verifRaw.verificationModel.trim().length > 0
        ? verifRaw.verificationModel.trim()
        : undefined,
  };
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}

export function parseProvenanceConfig(cfg: Record<string, unknown>): ProvenanceConfig {
  const provRaw = cfg.provenance as Record<string, unknown> | undefined;
  return {
    enabled: provRaw?.enabled === true,
    retentionDays:
      typeof provRaw?.retentionDays === "number" && provRaw.retentionDays > 0 ? Math.floor(provRaw.retentionDays) : 365,
  };
}

export function parseNightlyCycleConfig(cfg: Record<string, unknown>): NightlyCycleConfig {
  const nightlyCycleRaw = cfg.nightlyCycle as Record<string, unknown> | undefined;
  const legacyDreaming = cfg.dreaming as Record<string, unknown> | undefined;
  const legacyFrequency = legacyDreaming?.frequency;
  // A cron expression is the only legacy frequency representation with a lossless schedule mapping.
  const legacyCron =
    typeof legacyFrequency === "string" &&
    legacyFrequency.trim().split(/\s+/).length >= 5 &&
    legacyFrequency.trim().split(/\s+/).length <= 6
      ? legacyFrequency.trim()
      : undefined;
  const legacyModel =
    typeof legacyDreaming?.model === "string" && legacyDreaming.model.trim().length > 0
      ? legacyDreaming.model.trim()
      : undefined;
  if (legacyCron && (typeof nightlyCycleRaw?.schedule !== "string" || nightlyCycleRaw.schedule.trim().length === 0)) {
    pluginLogger.warn(
      "memory-hybrid: migrated deprecated dreaming.frequency cron expression to nightlyCycle.schedule for this run.",
    );
  }
  if (legacyModel && (typeof nightlyCycleRaw?.model !== "string" || nightlyCycleRaw.model.trim().length === 0)) {
    pluginLogger.warn("memory-hybrid: migrated deprecated dreaming.model to nightlyCycle.model for this run.");
  }
  return {
    enabled: nightlyCycleRaw?.enabled === true,
    schedule:
      typeof nightlyCycleRaw?.schedule === "string" && nightlyCycleRaw.schedule.trim().length > 0
        ? nightlyCycleRaw.schedule.trim()
        : (legacyCron ?? "45 2 * * *"),
    reflectWindowDays:
      typeof nightlyCycleRaw?.reflectWindowDays === "number" && nightlyCycleRaw.reflectWindowDays >= 1
        ? Math.min(90, Math.floor(nightlyCycleRaw.reflectWindowDays))
        : 7,
    pruneMode:
      nightlyCycleRaw?.pruneMode === "expired" ||
      nightlyCycleRaw?.pruneMode === "decay" ||
      nightlyCycleRaw?.pruneMode === "both"
        ? (nightlyCycleRaw.pruneMode as "expired" | "decay" | "both")
        : "both",
    model:
      typeof nightlyCycleRaw?.model === "string" && nightlyCycleRaw.model.trim().length > 0
        ? nightlyCycleRaw.model.trim()
        : legacyModel,
    consolidateAfterDays:
      typeof nightlyCycleRaw?.consolidateAfterDays === "number" && nightlyCycleRaw.consolidateAfterDays >= 1
        ? Math.min(365, Math.floor(nightlyCycleRaw.consolidateAfterDays))
        : 7,
    maxUnconsolidatedAgeDays:
      typeof nightlyCycleRaw?.maxUnconsolidatedAgeDays === "number" && nightlyCycleRaw.maxUnconsolidatedAgeDays >= 1
        ? Math.min(3650, Math.floor(nightlyCycleRaw.maxUnconsolidatedAgeDays))
        : 90,
    maxEventsPerConsolidation:
      typeof nightlyCycleRaw?.maxEventsPerConsolidation === "number" && nightlyCycleRaw.maxEventsPerConsolidation >= 1
        ? Math.min(1000, Math.floor(nightlyCycleRaw.maxEventsPerConsolidation))
        : 200,
    logRetentionDays:
      typeof nightlyCycleRaw?.logRetentionDays === "number" && nightlyCycleRaw.logRetentionDays >= 0
        ? Math.min(3650, Math.floor(nightlyCycleRaw.logRetentionDays))
        : 30,
    vacuumOnCycle: nightlyCycleRaw?.vacuumOnCycle !== false,
    reclassifyDecayOnCycle: nightlyCycleRaw?.reclassifyDecayOnCycle !== false,
    reclassifyInactiveDays:
      typeof nightlyCycleRaw?.reclassifyInactiveDays === "number" && nightlyCycleRaw.reclassifyInactiveDays >= 1
        ? Math.min(3650, Math.floor(nightlyCycleRaw.reclassifyInactiveDays))
        : 90,
    reclassifyPromoteRecallCount:
      typeof nightlyCycleRaw?.reclassifyPromoteRecallCount === "number" &&
      nightlyCycleRaw.reclassifyPromoteRecallCount >= 1
        ? Math.floor(nightlyCycleRaw.reclassifyPromoteRecallCount)
        : 3,
    eventLogArchivalDays:
      typeof nightlyCycleRaw?.eventLogArchivalDays === "number" && nightlyCycleRaw.eventLogArchivalDays >= 0
        ? Math.floor(nightlyCycleRaw.eventLogArchivalDays)
        : undefined,
    eventLogArchivePath:
      typeof nightlyCycleRaw?.eventLogArchivePath === "string" && nightlyCycleRaw.eventLogArchivePath.trim().length > 0
        ? nightlyCycleRaw.eventLogArchivePath.trim()
        : undefined,
    consolidationEventTypeAllow: parseStringList(nightlyCycleRaw?.consolidationEventTypeAllow),
    consolidationEventTypeDeny: parseStringList(nightlyCycleRaw?.consolidationEventTypeDeny),
    enableReflectionRules: nightlyCycleRaw?.enableReflectionRules !== false,
    autoPropose: nightlyCycleRaw?.autoPropose === true,
    ingestDreamFindings:
      nightlyCycleRaw?.ingestDreamFindings === true
        ? true
        : nightlyCycleRaw?.ingestDreamFindings === false
          ? false
          : undefined,
  };
}

export function parseHealthConfig(cfg: Record<string, unknown>): HealthConfig {
  const healthRaw = cfg.health as Record<string, unknown> | undefined;
  return {
    enabled: healthRaw?.enabled !== false,
    authenticated: healthRaw?.authenticated !== false,
  };
}

function parseCouncilConfig(cfg: Record<string, unknown>): CouncilConfig {
  const councilRaw = (cfg.maintenance as Record<string, unknown> | undefined)?.council as
    | Record<string, unknown>
    | undefined;
  const validModes: CouncilProvenanceMode[] = ["meta+receipt", "meta", "receipt", "none"];
  const provenance: CouncilProvenanceMode =
    typeof councilRaw?.provenance === "string" && validModes.includes(councilRaw.provenance as CouncilProvenanceMode)
      ? (councilRaw.provenance as CouncilProvenanceMode)
      : "meta+receipt";
  const sessionKeyPrefix =
    typeof councilRaw?.sessionKeyPrefix === "string" && councilRaw.sessionKeyPrefix.trim().length > 0
      ? councilRaw.sessionKeyPrefix.trim()
      : "council-review";
  return { provenance, sessionKeyPrefix };
}

function parseCronReliabilityConfig(cfg: Record<string, unknown>): CronReliabilityConfig {
  const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
  const reliabilityRaw = maintenanceRaw?.cronReliability as Record<string, unknown> | undefined;
  return {
    nightlyCron:
      typeof reliabilityRaw?.nightlyCron === "string" && reliabilityRaw.nightlyCron.trim().length > 0
        ? reliabilityRaw.nightlyCron.trim()
        : "0 3 * * *",
    weeklyBackupCron:
      typeof reliabilityRaw?.weeklyBackupCron === "string" && reliabilityRaw.weeklyBackupCron.trim().length > 0
        ? reliabilityRaw.weeklyBackupCron.trim()
        : "0 4 * * 0",
    verifyOnBoot: reliabilityRaw?.verifyOnBoot !== false,
    staleThresholdHours:
      typeof reliabilityRaw?.staleThresholdHours === "number" && reliabilityRaw.staleThresholdHours > 0
        ? Math.floor(reliabilityRaw.staleThresholdHours)
        : 28,
  };
}

function parseMaintenanceFailureReportingConfig(cfg: Record<string, unknown>): MaintenanceFailureReportingConfig {
  const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
  const failureReportingRaw = maintenanceRaw?.failureReporting as Record<string, unknown> | undefined;
  return {
    enabled: failureReportingRaw?.enabled !== false,
  };
}

function parseMaintenancePrivacyRedactionConfig(cfg: Record<string, unknown>): MaintenancePrivacyRedactionConfig {
  const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
  const raw = maintenanceRaw?.privacyRedaction as Record<string, unknown> | undefined;
  // parseStringList collapses an explicitly-empty array to undefined (indistinguishable from "not
  // provided"), which would silently restore the default list even when an operator explicitly
  // configured `[]` to opt out of all exemptions. Check Array.isArray directly to preserve that intent.
  return {
    enabled: raw?.enabled === true,
    exemptCategories: Array.isArray(raw?.exemptCategories) ? (parseStringList(raw.exemptCategories) ?? []) : ["entity"],
    exemptKeys: Array.isArray(raw?.exemptKeys) ? (parseStringList(raw.exemptKeys) ?? []) : ["email", "phone", "mobile"],
  };
}

function parseStepGuards(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = Math.floor(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseWorkerLeasesConfig(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const quietRaw = o.quietWindow as Record<string, unknown> | undefined;
  const quietWindow =
    quietRaw && typeof quietRaw === "object"
      ? {
          enabled: quietRaw.enabled === true,
          start:
            typeof quietRaw.start === "string" && quietRaw.start.trim().length > 0 ? quietRaw.start.trim() : "01:00",
          end: typeof quietRaw.end === "string" && quietRaw.end.trim().length > 0 ? quietRaw.end.trim() : "06:00",
          tz: typeof quietRaw.tz === "string" && quietRaw.tz.trim().length > 0 ? quietRaw.tz.trim() : "UTC",
        }
      : undefined;
  return {
    enabled: o.enabled === true,
    defaultTtlSeconds:
      typeof o.defaultTtlSeconds === "number" && o.defaultTtlSeconds > 0 ? Math.floor(o.defaultTtlSeconds) : 120,
    heartbeatIntervalSeconds:
      typeof o.heartbeatIntervalSeconds === "number" && o.heartbeatIntervalSeconds > 0
        ? Math.floor(o.heartbeatIntervalSeconds)
        : 30,
    ...(quietWindow ? { quietWindow } : {}),
    ...(typeof o.contextUsageThreshold === "number" && o.contextUsageThreshold >= 0 && o.contextUsageThreshold <= 1
      ? { contextUsageThreshold: o.contextUsageThreshold }
      : {}),
  };
}

function parseMaintenanceOrchestratorConfig(cfg: Record<string, unknown>) {
  const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
  const orchestratorRaw = maintenanceRaw?.orchestrator as Record<string, unknown> | undefined;
  if (!orchestratorRaw) return undefined;
  const workerLeases = parseWorkerLeasesConfig(orchestratorRaw.workerLeases);
  return {
    stepGuards: parseStepGuards(orchestratorRaw.stepGuards),
    maxCatchUpDays:
      typeof orchestratorRaw.maxCatchUpDays === "number" && orchestratorRaw.maxCatchUpDays > 0
        ? Math.floor(orchestratorRaw.maxCatchUpDays)
        : undefined,
    llmCooldownBetweenStepsMs:
      typeof orchestratorRaw.llmCooldownBetweenStepsMs === "number" && orchestratorRaw.llmCooldownBetweenStepsMs >= 0
        ? Math.floor(orchestratorRaw.llmCooldownBetweenStepsMs)
        : undefined,
    rateLimitMaxRetries:
      typeof orchestratorRaw.rateLimitMaxRetries === "number" && orchestratorRaw.rateLimitMaxRetries > 0
        ? Math.floor(orchestratorRaw.rateLimitMaxRetries)
        : undefined,
    maxRuntimeMinutes:
      typeof orchestratorRaw.maxRuntimeMinutes === "number" && orchestratorRaw.maxRuntimeMinutes > 0
        ? Math.floor(orchestratorRaw.maxRuntimeMinutes)
        : undefined,
    stepTimeoutMinutes:
      typeof orchestratorRaw.stepTimeoutMinutes === "number" && orchestratorRaw.stepTimeoutMinutes > 0
        ? Math.floor(orchestratorRaw.stepTimeoutMinutes)
        : undefined,
    consolidatedCronJobs:
      typeof orchestratorRaw.consolidatedCronJobs === "boolean" ? orchestratorRaw.consolidatedCronJobs : undefined,
    ...(workerLeases ? { workerLeases } : {}),
  };
}

export function parseMaintenanceConfig(cfg: Record<string, unknown>): MaintenanceConfig {
  const maintenanceRaw = cfg.maintenance as Record<string, unknown> | undefined;
  const monthlyReviewRaw = maintenanceRaw?.monthlyReview as Record<string, unknown> | undefined;
  const monthlyReview: MonthlyReviewConfig = {
    enabled: monthlyReviewRaw?.enabled === true,
    model:
      typeof monthlyReviewRaw?.model === "string" && monthlyReviewRaw.model.trim().length > 0
        ? monthlyReviewRaw.model.trim()
        : undefined,
    dayOfMonth:
      typeof monthlyReviewRaw?.dayOfMonth === "number" && Number.isFinite(monthlyReviewRaw.dayOfMonth)
        ? Math.min(31, Math.max(1, Math.floor(monthlyReviewRaw.dayOfMonth)))
        : 1,
  };
  const decayRaw = maintenanceRaw?.decay as Record<string, unknown> | undefined;
  const routineMiningRaw = maintenanceRaw?.routineMining as Record<string, unknown> | undefined;
  return {
    monthlyReview,
    cronReliability: parseCronReliabilityConfig(cfg),
    failureReporting: parseMaintenanceFailureReportingConfig(cfg),
    privacyRedaction: parseMaintenancePrivacyRedactionConfig(cfg),
    council: parseCouncilConfig(cfg),
    orchestrator: parseMaintenanceOrchestratorConfig(cfg),
    decay: {
      mode: decayRaw?.mode === "cliff" ? "cliff" : "half-life",
      secondChance: decayRaw?.secondChance !== false,
    },
    routineMining: {
      enabled: routineMiningRaw?.enabled !== false,
      maxPerRun:
        typeof routineMiningRaw?.maxPerRun === "number" && (routineMiningRaw.maxPerRun as number) > 0
          ? Math.floor(routineMiningRaw.maxPerRun as number)
          : 2,
      timezone:
        typeof routineMiningRaw?.timezone === "string" && routineMiningRaw.timezone.trim().length > 0
          ? routineMiningRaw.timezone.trim()
          : "UTC",
    },
    contradictions: parseContradictionsConfig(maintenanceRaw?.contradictions as Record<string, unknown> | undefined),
  };
}

function parseContradictionsConfig(raw: Record<string, unknown> | undefined): MaintenanceConfig["contradictions"] {
  // >= 0, not > 0: similarityFloor: 0 is a meaningful choice (consider every vector neighbor,
  // no cosine floor) — a `> 0` guard silently discarded that explicit choice for the default.
  const similarityFloor =
    typeof raw?.similarityFloor === "number" && raw.similarityFloor >= 0 && raw.similarityFloor <= 1
      ? raw.similarityFloor
      : 0.85;
  const minConfidence =
    typeof raw?.minConfidence === "number" && raw.minConfidence >= 0 && raw.minConfidence <= 1
      ? raw.minConfidence
      : 0.7;
  return {
    freeText: raw?.freeText !== false,
    similarityFloor,
    maxPairsPerRun:
      typeof raw?.maxPairsPerRun === "number" && raw.maxPairsPerRun >= 0 ? Math.floor(raw.maxPairsPerRun) : 40,
    minConfidence,
    model: typeof raw?.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined,
  };
}
