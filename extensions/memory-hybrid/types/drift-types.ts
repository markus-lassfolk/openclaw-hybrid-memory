/** Drift scout — stale instructions, deprecated commands, contradictions (Issue #2146). */

export const DRIFT_TYPES = [
  "deprecated_command",
  "contradicted_fact",
  "stale_wiki",
  "stale_active_task",
  "cron_deprecated_command",
  "stale_skill_reference",
  "other",
] as const;
export type DriftType = (typeof DRIFT_TYPES)[number];

export const DRIFT_SEVERITIES = ["low", "medium", "high"] as const;
export type DriftSeverity = (typeof DRIFT_SEVERITIES)[number];

export const DRIFT_REPAIRABILITY = ["auto_safe", "human_review", "manual_investigation"] as const;
export type DriftRepairability = (typeof DRIFT_REPAIRABILITY)[number];

export const DRIFT_STATUSES = ["open", "acknowledged", "snoozed", "superseded", "promoted", "resolved"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export interface DriftAffectedRef {
  kind: "fact" | "wiki" | "cron" | "skill" | "active_task" | "claim" | "other";
  id: string;
  label?: string;
}

export interface CreateDriftFindingInput {
  driftType: DriftType;
  oldText: string;
  replacementText?: string;
  affectedIds?: DriftAffectedRef[];
  severity?: DriftSeverity;
  repairability?: DriftRepairability;
  suggestedRepair?: string;
  linkedClaimIds?: string[];
  linkedEvidenceCapsuleIds?: string[];
}

export interface DriftFinding {
  id: string;
  driftType: DriftType;
  oldText: string;
  replacementText: string | null;
  affectedIds: DriftAffectedRef[];
  severity: DriftSeverity;
  repairability: DriftRepairability;
  suggestedRepair: string | null;
  status: DriftStatus;
  linkedClaimIds: string[];
  linkedEvidenceCapsuleIds: string[];
  snoozedUntil: string | null;
  promotedTo: string | null;
  detectedAt: string;
  updatedAt: string;
  dedupHash: string;
}

export interface DriftFindingFilter {
  status?: DriftStatus[];
  driftType?: DriftType[];
  severity?: DriftSeverity[];
  limit?: number;
}

export interface DriftScoutOptions {
  sinceDays?: number;
  include?: Array<"cron" | "skills" | "wiki" | "facts" | "active_tasks">;
  applySafe?: boolean;
}

export interface DriftScoutReport {
  scannedAt: string;
  findings: DriftFinding[];
  newCount: number;
  existingCount: number;
  appliedSafeCount: number;
}
