import { homedir } from "node:os";
import { join } from "node:path";
import { expandHomePlaceholders } from "../../utils/path.js";
import type {
  PassiveObserverConfig,
  ReflectionConfig,
  IdentityReflectionConfig,
  IdentityPromotionConfig,
  ProceduresConfig,
  ExtractionConfig,
  ExtractionPreFilterConfig,
} from "../types/capture.js";
import { DEFAULT_IDENTITY_REFLECTION_QUESTIONS } from "../../services/identity-reflection.js";

export function parsePassiveObserverConfig(cfg: Record<string, unknown>): PassiveObserverConfig {
  const observerRaw = cfg.passiveObserver as Record<string, unknown> | undefined;
  return {
    enabled: observerRaw?.enabled === true,
    intervalMinutes:
      typeof observerRaw?.intervalMinutes === "number" && observerRaw.intervalMinutes >= 1
        ? Math.floor(observerRaw.intervalMinutes)
        : 15,
    model:
      typeof observerRaw?.model === "string" && observerRaw.model.trim().length > 0
        ? observerRaw.model.trim()
        : undefined,
    maxCharsPerChunk:
      typeof observerRaw?.maxCharsPerChunk === "number" && observerRaw.maxCharsPerChunk >= 100
        ? Math.floor(observerRaw.maxCharsPerChunk)
        : 8000,
    minImportance:
      typeof observerRaw?.minImportance === "number" && observerRaw.minImportance >= 0 && observerRaw.minImportance <= 1
        ? observerRaw.minImportance
        : 0.5,
    deduplicationThreshold:
      typeof observerRaw?.deduplicationThreshold === "number" &&
      observerRaw.deduplicationThreshold >= 0 &&
      observerRaw.deduplicationThreshold <= 1
        ? observerRaw.deduplicationThreshold
        : 0.92,
    sessionsDir:
      typeof observerRaw?.sessionsDir === "string" && observerRaw.sessionsDir.trim().length > 0
        ? expandHomePlaceholders(observerRaw.sessionsDir.trim())
        : undefined,
  };
}

export function parseReflectionConfig(cfg: Record<string, unknown>): ReflectionConfig {
  const reflectionRaw = cfg.reflection as Record<string, unknown> | undefined;
  return {
    enabled: reflectionRaw?.enabled === true,
    model: typeof reflectionRaw?.model === "string" ? reflectionRaw.model : undefined,
    defaultWindow:
      typeof reflectionRaw?.defaultWindow === "number" && reflectionRaw.defaultWindow > 0
        ? Math.min(90, Math.floor(reflectionRaw.defaultWindow))
        : 14,
    minObservations:
      typeof reflectionRaw?.minObservations === "number" && reflectionRaw.minObservations >= 1
        ? Math.floor(reflectionRaw.minObservations)
        : 2,
  };
}

export function parseIdentityReflectionConfig(cfg: Record<string, unknown>): IdentityReflectionConfig {
  const raw = cfg.identityReflection as Record<string, unknown> | undefined;
  const parsedQuestions = Array.isArray(raw?.questions)
    ? raw.questions
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          key: typeof q.key === "string" ? q.key.trim() : "",
          prompt: typeof q.prompt === "string" ? q.prompt.trim() : "",
        }))
        .filter((q) => q.key.length > 0 && q.prompt.length > 0)
    : [];
  return {
    enabled: raw?.enabled === true,
    model: typeof raw?.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined,
    defaultWindow:
      typeof raw?.defaultWindow === "number" && raw.defaultWindow > 0
        ? Math.min(90, Math.floor(raw.defaultWindow))
        : 30,
    minInsights: typeof raw?.minInsights === "number" && raw.minInsights >= 1 ? Math.floor(raw.minInsights) : 3,
    maxInsightsPerRun:
      typeof raw?.maxInsightsPerRun === "number" && raw.maxInsightsPerRun >= 1
        ? Math.min(20, Math.floor(raw.maxInsightsPerRun))
        : 8,
    questions: parsedQuestions.length > 0 ? parsedQuestions : DEFAULT_IDENTITY_REFLECTION_QUESTIONS,
  };
}

export function parseIdentityPromotionConfig(cfg: Record<string, unknown>): IdentityPromotionConfig {
  const raw = cfg.identityPromotion as Record<string, unknown> | undefined;
  return {
    enabled: raw?.enabled !== false,
    lookbackDays:
      typeof raw?.lookbackDays === "number" && raw.lookbackDays >= 1 ? Math.min(365, Math.floor(raw.lookbackDays)) : 90,
    minDurableReflections:
      typeof raw?.minDurableReflections === "number" && raw.minDurableReflections >= 1
        ? Math.min(10, Math.floor(raw.minDurableReflections))
        : 2,
    minConfidence:
      typeof raw?.minConfidence === "number" && raw.minConfidence >= 0 && raw.minConfidence <= 1
        ? raw.minConfidence
        : 0.72,
    similarityThreshold:
      typeof raw?.similarityThreshold === "number" && raw.similarityThreshold >= 0 && raw.similarityThreshold <= 1
        ? raw.similarityThreshold
        : 0.72,
    maxPromotionsPerRun:
      typeof raw?.maxPromotionsPerRun === "number" && raw.maxPromotionsPerRun >= 1
        ? Math.min(50, Math.floor(raw.maxPromotionsPerRun))
        : 8,
  };
}

export function parseProceduresConfig(cfg: Record<string, unknown>): ProceduresConfig {
  const defaultSessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
  const proceduresRaw = cfg.procedures as Record<string, unknown> | undefined;
  return {
    enabled: proceduresRaw?.enabled !== false,
    sessionsDir:
      typeof proceduresRaw?.sessionsDir === "string" && proceduresRaw.sessionsDir.length > 0
        ? expandHomePlaceholders(proceduresRaw.sessionsDir)
        : defaultSessionsDir,
    minSteps:
      typeof proceduresRaw?.minSteps === "number" && proceduresRaw.minSteps >= 1
        ? Math.floor(proceduresRaw.minSteps)
        : 2,
    validationThreshold:
      typeof proceduresRaw?.validationThreshold === "number" && proceduresRaw.validationThreshold >= 1
        ? Math.floor(proceduresRaw.validationThreshold)
        : 3,
    skillTTLDays:
      typeof proceduresRaw?.skillTTLDays === "number" && proceduresRaw.skillTTLDays >= 1
        ? Math.floor(proceduresRaw.skillTTLDays)
        : 30,
    skillsAutoPath:
      typeof proceduresRaw?.skillsAutoPath === "string" && proceduresRaw.skillsAutoPath.length > 0
        ? proceduresRaw.skillsAutoPath
        : "skills/auto",
    requireApprovalForPromote: proceduresRaw?.requireApprovalForPromote !== false,
    maxInjectionTokens:
      typeof proceduresRaw?.maxInjectionTokens === "number" &&
      proceduresRaw.maxInjectionTokens > 0 &&
      Number.isFinite(proceduresRaw.maxInjectionTokens)
        ? Math.floor(proceduresRaw.maxInjectionTokens)
        : 500,
  };
}

function parsePreFilterConfig(raw: Record<string, unknown> | undefined): ExtractionPreFilterConfig | undefined {
  if (!raw) return undefined;
  return {
    enabled: raw.enabled === true,
    model: typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : "qwen3:8b",
    endpoint: typeof raw.endpoint === "string" && raw.endpoint.trim().length > 0 ? raw.endpoint.trim() : undefined,
    maxCharsPerSession:
      typeof raw.maxCharsPerSession === "number" && raw.maxCharsPerSession >= 100
        ? Math.floor(raw.maxCharsPerSession)
        : undefined,
  };
}

export function parseExtractionConfig(cfg: Record<string, unknown>): ExtractionConfig {
  const extractionRaw = cfg.extraction as Record<string, unknown> | undefined;
  return {
    extractionPasses: extractionRaw?.extractionPasses === true,
    verificationPass: extractionRaw?.verificationPass === true,
    extractionModel:
      typeof extractionRaw?.extractionModel === "string" && extractionRaw.extractionModel.trim().length > 0
        ? extractionRaw.extractionModel.trim()
        : undefined,
    implicitModel:
      typeof extractionRaw?.implicitModel === "string" && extractionRaw.implicitModel.trim().length > 0
        ? extractionRaw.implicitModel.trim()
        : undefined,
    verificationModel:
      typeof extractionRaw?.verificationModel === "string" && extractionRaw.verificationModel.trim().length > 0
        ? extractionRaw.verificationModel.trim()
        : undefined,
    preFilter: parsePreFilterConfig(extractionRaw?.preFilter as Record<string, unknown> | undefined),
    extractionModelTier: (() => {
      const v =
        typeof extractionRaw?.extractionModelTier === "string"
          ? extractionRaw.extractionModelTier.trim().toLowerCase()
          : "";
      return v === "nano" || v === "default" || v === "heavy" ? (v as "nano" | "default" | "heavy") : undefined;
    })(),
  };
}
