import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PassiveObserverConfig,
  ReflectionConfig,
  ProceduresConfig,
  ExtractionConfig,
} from "../types/capture.js";

export function parsePassiveObserverConfig(cfg: Record<string, unknown>): PassiveObserverConfig {
  const observerRaw = cfg.passiveObserver as Record<string, unknown> | undefined;
  return {
    enabled: observerRaw?.enabled === true,
    intervalMinutes:
      typeof observerRaw?.intervalMinutes === "number" && observerRaw.intervalMinutes >= 1
        ? Math.floor(observerRaw.intervalMinutes)
        : 15,
    model: typeof observerRaw?.model === "string" && observerRaw.model.trim().length > 0 ? observerRaw.model.trim() : undefined,
    maxCharsPerChunk:
      typeof observerRaw?.maxCharsPerChunk === "number" && observerRaw.maxCharsPerChunk >= 100
        ? Math.floor(observerRaw.maxCharsPerChunk)
        : 8000,
    minImportance:
      typeof observerRaw?.minImportance === "number" && observerRaw.minImportance >= 0 && observerRaw.minImportance <= 1
        ? observerRaw.minImportance
        : 0.5,
    deduplicationThreshold:
      typeof observerRaw?.deduplicationThreshold === "number" && observerRaw.deduplicationThreshold >= 0 && observerRaw.deduplicationThreshold <= 1
        ? observerRaw.deduplicationThreshold
        : 0.92,
    sessionsDir:
      typeof observerRaw?.sessionsDir === "string" && observerRaw.sessionsDir.trim().length > 0
        ? observerRaw.sessionsDir.trim()
        : undefined,
  };
}

export function parseReflectionConfig(cfg: Record<string, unknown>): ReflectionConfig {
  const reflectionRaw = cfg.reflection as Record<string, unknown> | undefined;
  return {
    enabled: reflectionRaw?.enabled === true,
    model: typeof reflectionRaw?.model === "string" ? reflectionRaw.model : undefined,
    defaultWindow: typeof reflectionRaw?.defaultWindow === "number" && reflectionRaw.defaultWindow > 0
      ? Math.min(90, Math.floor(reflectionRaw.defaultWindow))
      : 14,
    minObservations: typeof reflectionRaw?.minObservations === "number" && reflectionRaw.minObservations >= 1
      ? Math.floor(reflectionRaw.minObservations)
      : 2,
  };
}

export function parseProceduresConfig(cfg: Record<string, unknown>): ProceduresConfig {
  const defaultSessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
  const proceduresRaw = cfg.procedures as Record<string, unknown> | undefined;
  return {
    enabled: proceduresRaw?.enabled !== false,
    sessionsDir: typeof proceduresRaw?.sessionsDir === "string" && proceduresRaw.sessionsDir.length > 0
      ? proceduresRaw.sessionsDir
      : defaultSessionsDir,
    minSteps: typeof proceduresRaw?.minSteps === "number" && proceduresRaw.minSteps >= 1
      ? Math.floor(proceduresRaw.minSteps)
      : 2,
    validationThreshold: typeof proceduresRaw?.validationThreshold === "number" && proceduresRaw.validationThreshold >= 1
      ? Math.floor(proceduresRaw.validationThreshold)
      : 3,
    skillTTLDays: typeof proceduresRaw?.skillTTLDays === "number" && proceduresRaw.skillTTLDays >= 1
      ? Math.floor(proceduresRaw.skillTTLDays)
      : 30,
    skillsAutoPath: typeof proceduresRaw?.skillsAutoPath === "string" && proceduresRaw.skillsAutoPath.length > 0
      ? proceduresRaw.skillsAutoPath
      : "skills/auto",
    requireApprovalForPromote: proceduresRaw?.requireApprovalForPromote !== false,
  };
}

export function parseExtractionConfig(cfg: Record<string, unknown>): ExtractionConfig {
  const extractionRaw = cfg.extraction as Record<string, unknown> | undefined;
  return {
    extractionPasses: extractionRaw?.extractionPasses === true,
    verificationPass: extractionRaw?.verificationPass === true,
    extractionModel: typeof extractionRaw?.extractionModel === "string" && extractionRaw.extractionModel.trim().length > 0
      ? extractionRaw.extractionModel.trim()
      : undefined,
    implicitModel: typeof extractionRaw?.implicitModel === "string" && extractionRaw.implicitModel.trim().length > 0
      ? extractionRaw.implicitModel.trim()
      : undefined,
    verificationModel: typeof extractionRaw?.verificationModel === "string" && extractionRaw.verificationModel.trim().length > 0
      ? extractionRaw.verificationModel.trim()
      : undefined,
  };
}
