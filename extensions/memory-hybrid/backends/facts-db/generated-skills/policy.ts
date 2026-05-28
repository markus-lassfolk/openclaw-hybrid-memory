import type {
  GeneratedSkillLifecycleState,
  GeneratedSkillTelemetryDecision,
  GeneratedSkillTelemetryEntry,
  GeneratedSkillTelemetryOutcome,
  MemoryScope,
} from "../../../types/memory.js";

export type GeneratedSkillLifecyclePolicy = {
  promoteAfterSuccessfulUses: number;
  demoteFalsePositiveRate: number;
  demoteMinSamples: number;
  archiveAfterUnusedDays: number;
  revisionNearMissThreshold: number;
  unblockAfterCleanUses: number;
};

export type GeneratedSkillTelemetryRecordInput = {
  skillName: string;
  procedureId?: string | null;
  skillVersion?: number | null;
  requestHash?: string | null;
  requestSummary?: string | null;
  decision: GeneratedSkillTelemetryDecision;
  confidence?: number | null;
  reason?: string | null;
  taskOutcome?: GeneratedSkillTelemetryOutcome | null;
  userCorrection?: boolean;
  correctionReason?: string | null;
  falseNegativeSignal?: boolean;
  causedRework?: boolean;
  savedToolCalls?: number | null;
  savedTimeMs?: number | null;
  scope?: MemoryScope | null;
  scopeTarget?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  createdAt?: number;
};

export type GeneratedSkillTelemetryMetrics = {
  activationCountPerWeek: number;
  activationCountTotal: number;
  nearMissCount: number;
  falsePositiveSignals: number;
  falseNegativeSignals: number;
  correctionCount: number;
  repeatedCorrectionCount: number;
  lastUsedAt: number | null;
  successCount: number;
  failureCount: number;
  partialCount: number;
  unknownCount: number;
  successRate: number | null;
  failureRate: number | null;
  partialRate: number | null;
  unknownRate: number | null;
  successfulUsesWithoutCorrection: number;
  consideredCount: number;
  skippedCount: number;
  savedToolCalls: number;
  savedTimeMs: number;
  falsePositiveRate: number | null;
  cleanUsesAfterDemotion: number;
};

export type GeneratedSkillTelemetryFlags = {
  promotionCandidate: boolean;
  overTriggering: boolean;
  revisionCandidate: boolean;
  neverUsed: boolean;
  archiveCandidate: boolean;
  unblockCandidate: boolean;
};

export type GeneratedSkillTelemetryReportRow = {
  procedureId: string;
  skillName: string;
  skillPath: string;
  skillVersion: number;
  riskLevel: "low" | "medium" | "high";
  state: GeneratedSkillLifecycleState;
  stateReason: string | null;
  generatedAt: number | null;
  metrics: GeneratedSkillTelemetryMetrics;
  flags: GeneratedSkillTelemetryFlags;
  recommendation: "promote" | "demote" | "archive" | "revise" | "unblock" | "observe";
  recentActivations: GeneratedSkillTelemetryEntry[];
};

export type GeneratedSkillTelemetryReport = {
  generatedAt: string;
  policy: GeneratedSkillLifecyclePolicy;
  totalSkills: number;
  rows: GeneratedSkillTelemetryReportRow[];
};

export const DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY: GeneratedSkillLifecyclePolicy = {
  promoteAfterSuccessfulUses: 3,
  demoteFalsePositiveRate: 0.4,
  demoteMinSamples: 3,
  archiveAfterUnusedDays: 30,
  revisionNearMissThreshold: 3,
  unblockAfterCleanUses: 5,
};

export function effectiveDemoteThresholdsForRisk(
  riskLevel: "low" | "medium" | "high",
  policy: GeneratedSkillLifecyclePolicy,
): { falsePositiveRate: number; minSamples: number } {
  const fpAdjust = riskLevel === "high" ? -0.1 : riskLevel === "medium" ? -0.05 : 0.05;
  const minSamplesAdjust = riskLevel === "high" ? -1 : 0;
  return {
    falsePositiveRate: Math.min(1, Math.max(0.1, policy.demoteFalsePositiveRate + fpAdjust)),
    minSamples: Math.max(1, policy.demoteMinSamples + minSamplesAdjust),
  };
}
