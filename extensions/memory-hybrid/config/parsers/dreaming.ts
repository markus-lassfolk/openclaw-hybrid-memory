/**
 * Parse `dreaming` config (#2170–#2177). Opt-in flags use `=== true`; shadow defaults on when enabled.
 */

import { pluginLogger } from "../../utils/logger.js";
import {
  DEFAULT_DREAM_COMPOSE,
  DEFAULT_DREAMING_CONFIG,
  type DreamComposeStep,
  type DreamingConfig,
  type DreamingMode,
  type DreamingPrevalenceTier,
  type DreamSteeringConfig,
} from "../types/dreaming.js";

const COMPOSE_STEPS = new Set<DreamComposeStep>([
  "distill",
  "self-correction",
  "reflect",
  "consolidate",
  "contradictions",
  "dream-cycle-core",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCompose(raw: unknown): DreamComposeStep[] {
  if (!Array.isArray(raw)) return [...DEFAULT_DREAM_COMPOSE];
  const out: DreamComposeStep[] = [];
  for (const item of raw) {
    if (typeof item === "string" && COMPOSE_STEPS.has(item as DreamComposeStep)) {
      out.push(item as DreamComposeStep);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_DREAM_COMPOSE];
}

/**
 * Legacy `dreaming.phases` used the same stage names as modern `compose`.
 * Only map it when every value is recognised: silently dropping an old phase
 * would be worse than keeping the default pipeline and emitting a diagnostic.
 */
function legacyPhasesToCompose(raw: unknown): DreamComposeStep[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((item) => typeof item === "string" && COMPOSE_STEPS.has(item as DreamComposeStep))) {
    return undefined;
  }
  return raw as DreamComposeStep[];
}

function warnLegacyDreamingConfig(raw: Record<string, unknown>, phasesMapped: boolean): void {
  const legacyKeys = ["frequency", "model", "execution", "phases", "verboseLogging"].filter((key) => key in raw);
  if (legacyKeys.length === 0) return;
  const unmapped = [
    "frequency (unless it is a 5/6-field cron expression; then it becomes nightlyCycle.schedule)",
    "execution",
    "verboseLogging",
    ...(phasesMapped ? [] : "phases" in raw ? ["phases (contains unsupported stage names)"] : []),
  ];
  pluginLogger.warn(
    `memory-hybrid: deprecated dreaming config keys accepted for upgrade compatibility: ${legacyKeys.join(", ")}. ` +
      `${phasesMapped ? "Mapped dreaming.phases to dreaming.compose; " : ""}` +
      "dreaming.model is used as nightlyCycle.model when no explicit nightlyCycle.model is set. " +
      `No lossless runtime mapping exists for ${unmapped.join(", ")}; review docs/AUTONOMOUS-DREAMING.md#legacy-config-compatibility.`,
  );
}

function parseTier(raw: unknown, fallback: DreamingPrevalenceTier): DreamingPrevalenceTier {
  const r = asRecord(raw);
  if (!r) return { ...fallback };
  const minSessions =
    typeof r.minSessions === "number" && r.minSessions >= 0 ? Math.floor(r.minSessions) : fallback.minSessions;
  const minAgents = typeof r.minAgents === "number" && r.minAgents >= 0 ? Math.floor(r.minAgents) : fallback.minAgents;
  const minConfidence =
    typeof r.minConfidence === "number" && Number.isFinite(r.minConfidence) ? r.minConfidence : fallback.minConfidence;
  return { minSessions, minAgents, ...(minConfidence != null ? { minConfidence } : {}) };
}

function parseStringList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function parseDreamingConfig(cfg: Record<string, unknown>): DreamingConfig {
  const raw = asRecord(cfg.dreaming);
  if (!raw) return structuredClone(DEFAULT_DREAMING_CONFIG);

  const candidateRaw = asRecord(raw.candidateStore);
  const autoPromoteRaw = asRecord(raw.autoPromote);
  const autoRollbackRaw = asRecord(raw.autoRollback);
  const prevalenceRaw = asRecord(raw.prevalence);
  const permissionRaw = asRecord(raw.permissionBoundary);
  const steeringRaw = asRecord(raw.steering);
  const legacyCompose = raw.compose === undefined ? legacyPhasesToCompose(raw.phases) : undefined;
  warnLegacyDreamingConfig(raw, legacyCompose !== undefined);

  const candidateEnabled = candidateRaw?.enabled === true;
  const shadow =
    candidateRaw?.shadow === false
      ? false
      : candidateRaw?.shadow === true
        ? true
        : DEFAULT_DREAMING_CONFIG.candidateStore.shadow;

  const observeWindowHours =
    typeof autoRollbackRaw?.observeWindowHours === "number" && autoRollbackRaw.observeWindowHours > 0
      ? Math.floor(autoRollbackRaw.observeWindowHours)
      : DEFAULT_DREAMING_CONFIG.autoRollback.observeWindowHours;

  const regressionThreshold =
    typeof autoRollbackRaw?.regressionThreshold === "number" &&
    Number.isFinite(autoRollbackRaw.regressionThreshold) &&
    autoRollbackRaw.regressionThreshold >= 0
      ? autoRollbackRaw.regressionThreshold
      : DEFAULT_DREAMING_CONFIG.autoRollback.regressionThreshold;

  const maxSessionsRaw = typeof raw.maxSessions === "number" ? raw.maxSessions : DEFAULT_DREAMING_CONFIG.maxSessions;
  const maxSessions = Math.max(1, Math.min(100, Math.floor(maxSessionsRaw)));

  const maxRuntimeRaw =
    typeof raw.maxRuntimeMinutes === "number" ? raw.maxRuntimeMinutes : DEFAULT_DREAMING_CONFIG.maxRuntimeMinutes;
  const maxRuntimeMinutes = Math.max(1, Math.min(240, Math.floor(maxRuntimeRaw)));

  const modeRaw = raw.mode;
  const mode: DreamingMode =
    modeRaw === "supervised" || modeRaw === "autonomous" ? modeRaw : DEFAULT_DREAMING_CONFIG.mode;

  const targetScopeRaw = permissionRaw?.targetScope;
  const targetScope =
    targetScopeRaw === "session" ||
    targetScopeRaw === "agent" ||
    targetScopeRaw === "user" ||
    targetScopeRaw === "global"
      ? targetScopeRaw
      : DEFAULT_DREAMING_CONFIG.permissionBoundary.targetScope;

  const profileRaw = steeringRaw?.profile;
  const profile: DreamSteeringConfig["profile"] =
    profileRaw === "personal" || profileRaw === "coding" || profileRaw === "ops" || profileRaw === "custom"
      ? profileRaw
      : DEFAULT_DREAMING_CONFIG.steering.profile;

  return {
    enabled: raw.enabled === true,
    mode,
    compose: legacyCompose ?? parseCompose(raw.compose),
    maxSessions,
    maxRuntimeMinutes,
    skipNightlyOverlap: raw.skipNightlyOverlap === true,
    promoteAfterRun: raw.promoteAfterRun === true,
    candidateStore: {
      enabled: candidateEnabled,
      shadow,
    },
    autoPromote: {
      enabled: autoPromoteRaw?.enabled === true,
      requireProvenance: autoPromoteRaw?.requireProvenance !== false,
      blockOnContradictionWorsening: autoPromoteRaw?.blockOnContradictionWorsening !== false,
      shadowValidation: (() => {
        const sv = asRecord(autoPromoteRaw?.shadowValidation);
        const d = DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation;
        const num = (v: unknown, fallback: number, min = 0, max = 1e9) => {
          if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
          return Math.max(min, Math.min(max, v));
        };
        return {
          enabled: sv?.enabled !== false,
          minShadowRuns: Math.floor(num(sv?.minShadowRuns, d.minShadowRuns, 0, 365)),
          minWouldPromoteRuns: Math.floor(num(sv?.minWouldPromoteRuns, d.minWouldPromoteRuns, 0, 365)),
          maxQuarantineRate: num(sv?.maxQuarantineRate, d.maxQuarantineRate, 0, 1),
          maxFailureRate: num(sv?.maxFailureRate, d.maxFailureRate, 0, 1),
          maxZeroCandidateRate: num(sv?.maxZeroCandidateRate, d.maxZeroCandidateRate, 0, 1),
          lookbackDays: Math.floor(num(sv?.lookbackDays, d.lookbackDays, 1, 365)),
        };
      })(),
    },
    autoRollback: {
      enabled: autoRollbackRaw?.enabled === true,
      observeWindowHours,
      regressionThreshold,
    },
    prevalence: {
      session: parseTier(prevalenceRaw?.session, DEFAULT_DREAMING_CONFIG.prevalence.session),
      agent: parseTier(prevalenceRaw?.agent, DEFAULT_DREAMING_CONFIG.prevalence.agent),
      user: parseTier(prevalenceRaw?.user, DEFAULT_DREAMING_CONFIG.prevalence.user),
      global: parseTier(prevalenceRaw?.global, DEFAULT_DREAMING_CONFIG.prevalence.global),
      personalSingleTenant: prevalenceRaw?.personalSingleTenant === true,
    },
    permissionBoundary: {
      targetScope,
      enforce: permissionRaw?.enforce !== false,
      personalMode: permissionRaw?.personalMode === true,
    },
    steering: {
      profile,
      promote: parseStringList(steeringRaw?.promote, DEFAULT_DREAMING_CONFIG.steering.promote),
      ignore: parseStringList(steeringRaw?.ignore, DEFAULT_DREAMING_CONFIG.steering.ignore),
      notes: typeof steeringRaw?.notes === "string" ? steeringRaw.notes : undefined,
    },
  };
}
