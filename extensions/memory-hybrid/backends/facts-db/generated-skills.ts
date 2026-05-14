import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { determineRiskLevel } from "../../services/procedure-promotion-policy.js";
import type {
  GeneratedSkillLifecycleState,
  GeneratedSkillTelemetryDecision,
  GeneratedSkillTelemetryEntry,
  GeneratedSkillTelemetryOutcome,
  MemoryScope,
  ProcedureEntry,
} from "../../types/memory.js";
import { procedureRowToEntry } from "./procedures.js";

export type GeneratedSkillLifecyclePolicy = {
  promoteAfterSuccessfulUses: number;
  demoteFalsePositiveRate: number;
  demoteMinSamples: number;
  archiveAfterUnusedDays: number;
  revisionNearMissThreshold: number;
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
};

export type GeneratedSkillTelemetryFlags = {
  promotionCandidate: boolean;
  overTriggering: boolean;
  revisionCandidate: boolean;
  neverUsed: boolean;
  archiveCandidate: boolean;
};

export type GeneratedSkillTelemetryReportRow = {
  procedureId: string;
  skillName: string;
  skillPath: string;
  skillVersion: number;
  /** Heuristic tier from procedure task + recipe (same classifier as procedure promotion). */
  riskLevel: "low" | "medium" | "high";
  state: GeneratedSkillLifecycleState;
  stateReason: string | null;
  generatedAt: number | null;
  metrics: GeneratedSkillTelemetryMetrics;
  flags: GeneratedSkillTelemetryFlags;
  recommendation: "promote" | "demote" | "archive" | "revise" | "observe";
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
};

const MAX_REQUEST_SUMMARY_LENGTH = 240;

type GeneratedSkillTelemetryRow = {
  id: string;
  procedure_id: string;
  skill_name: string;
  skill_version: number;
  request_hash: string | null;
  request_summary: string | null;
  decision: GeneratedSkillTelemetryDecision;
  confidence: number | null;
  reason: string | null;
  task_outcome: GeneratedSkillTelemetryOutcome | null;
  user_correction: number;
  correction_reason: string | null;
  false_negative_signal: number;
  caused_rework: number;
  saved_tool_calls: number | null;
  saved_time_ms: number | null;
  scope: MemoryScope | null;
  scope_target: string | null;
  agent_id: string | null;
  session_id: string | null;
  created_at: number;
};

function parseProcedureRecipeJson(recipeJson: string): unknown {
  try {
    return JSON.parse(recipeJson) as unknown;
  } catch {
    return { malformed: true, raw: recipeJson };
  }
}

/**
 * Demote thresholds mirror promotion risk bumps: higher-risk generated skills need **stricter** false-positive
 * evidence to stay trusted (lower FP rate threshold, fewer minimum activations); low-risk skills use a slightly
 * **higher** FP bar to avoid noisy demotions. Documented in docs/PROCEDURAL-MEMORY.md.
 */
export function effectiveDemoteThresholdsForRisk(
  riskLevel: "low" | "medium" | "high",
  policy: GeneratedSkillLifecyclePolicy,
): { falsePositiveRate: number; minSamples: number } {
  const fpAdjust = riskLevel === "high" ? -0.1 : riskLevel === "medium" ? -0.05 : 0.05;
  const minSamplesAdjust = riskLevel === "high" ? -1 : 0;
  return {
    falsePositiveRate: Math.max(0.1, policy.demoteFalsePositiveRate + fpAdjust),
    minSamples: Math.max(1, policy.demoteMinSamples + minSamplesAdjust),
  };
}

function mapGeneratedSkillTelemetryRow(row: GeneratedSkillTelemetryRow): GeneratedSkillTelemetryEntry {
  return {
    id: row.id,
    procedureId: row.procedure_id,
    skillName: row.skill_name,
    skillVersion: row.skill_version,
    requestHash: row.request_hash,
    requestSummary: row.request_summary,
    decision: row.decision,
    confidence: row.confidence,
    reason: row.reason,
    taskOutcome: row.task_outcome,
    userCorrection: row.user_correction === 1,
    correctionReason: row.correction_reason,
    falseNegativeSignal: row.false_negative_signal === 1,
    causedRework: row.caused_rework === 1,
    savedToolCalls: row.saved_tool_calls,
    savedTimeMs: row.saved_time_ms,
    scope: row.scope,
    scopeTarget: row.scope_target,
    agentId: row.agent_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

function normalizeSummary(summary: string | null | undefined): string | null {
  if (typeof summary !== "string") return null;
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, MAX_REQUEST_SUMMARY_LENGTH) : null;
}

function requestHashFromInput(
  requestHash: string | null | undefined,
  requestSummary: string | null | undefined,
): string | null {
  if (typeof requestHash === "string" && requestHash.trim().length > 0) return requestHash.trim();
  const normalizedSummary = normalizeSummary(requestSummary);
  if (!normalizedSummary) return null;
  return createHash("sha256").update(normalizedSummary).digest("hex").slice(0, 16);
}

function generatedSkillRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT *
         FROM procedures
        WHERE promoted_to_skill = 1
          AND skill_path IS NOT NULL
          AND TRIM(skill_path) <> ''
        ORDER BY COALESCE(skill_generated_at, promoted_at, updated_at, created_at) DESC, task_pattern ASC`,
    )
    .all() as Array<Record<string, unknown>>;
}

function findGeneratedSkillProcedure(db: DatabaseSync, skillName: string): ProcedureEntry | null {
  const trimmed = skillName.trim();
  if (trimmed.length === 0) return null;
  for (const row of generatedSkillRows(db)) {
    const proc = procedureRowToEntry(db, row);
    if (proc.skillPath === trimmed) return proc;
    if (proc.skillPath && basename(proc.skillPath) === trimmed) return proc;
  }
  return null;
}

export function listGeneratedSkillProcedures(db: DatabaseSync): ProcedureEntry[] {
  return generatedSkillRows(db).map((row) => procedureRowToEntry(db, row));
}

export function listGeneratedSkillTelemetry(
  db: DatabaseSync,
  skillName?: string,
  limit = 50,
): GeneratedSkillTelemetryEntry[] {
  const rows = skillName
    ? (db
        .prepare(
          `SELECT *
             FROM generated_skill_telemetry
            WHERE skill_name = ?
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(skillName, limit) as GeneratedSkillTelemetryRow[])
    : (db
        .prepare(
          `SELECT *
             FROM generated_skill_telemetry
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(limit) as GeneratedSkillTelemetryRow[]);
  return rows.map(mapGeneratedSkillTelemetryRow);
}

export function recordGeneratedSkillTelemetry(
  db: DatabaseSync,
  input: GeneratedSkillTelemetryRecordInput,
  policy: GeneratedSkillLifecyclePolicy = DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
): GeneratedSkillTelemetryEntry {
  let proc = findGeneratedSkillProcedure(db, input.skillName);
  if (input.procedureId != null) {
    const row = db.prepare("SELECT * FROM procedures WHERE id = ? LIMIT 1").get(input.procedureId) as
      | Record<string, unknown>
      | undefined;
    const candidate = row ? procedureRowToEntry(db, row) : null;
    if (!candidate) throw new Error(`Procedure not found for telemetry: ${input.procedureId}`);
    if (candidate.promotedToSkill !== 1 || !candidate.skillPath?.trim()) {
      throw new Error(`Procedure ${input.procedureId} is not a promoted generated skill`);
    }
    const skill = input.skillName.trim();
    const path = candidate.skillPath.trim();
    if (path !== skill && basename(path) !== skill) {
      throw new Error(`Procedure ${input.procedureId} skill_path does not match skill name "${input.skillName}"`);
    }
    proc = candidate;
  }
  if (!proc) throw new Error(`Generated skill not found: ${input.skillName}`);
  const now = input.createdAt ?? Math.floor(Date.now() / 1000);
  const normalizedSummary = normalizeSummary(input.requestSummary);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO generated_skill_telemetry (
       id, procedure_id, skill_name, skill_version, request_hash, request_summary, decision, confidence, reason,
       task_outcome, user_correction, correction_reason, false_negative_signal, caused_rework, saved_tool_calls,
       saved_time_ms, scope, scope_target, agent_id, session_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    proc.id,
    proc.skillPath ? basename(proc.skillPath) : input.skillName,
    input.skillVersion ?? proc.skillVersion ?? 1,
    requestHashFromInput(input.requestHash, normalizedSummary),
    normalizedSummary,
    input.decision,
    input.confidence ?? null,
    normalizeSummary(input.reason),
    input.taskOutcome ?? null,
    input.userCorrection === true ? 1 : 0,
    normalizeSummary(input.correctionReason),
    input.falseNegativeSignal === true ? 1 : 0,
    input.causedRework === true ? 1 : 0,
    input.savedToolCalls ?? null,
    input.savedTimeMs ?? null,
    input.scope ?? null,
    input.scopeTarget ?? null,
    input.agentId ?? null,
    input.sessionId ?? null,
    now,
  );
  refreshGeneratedSkillLifecycleState(db, proc.skillPath ? basename(proc.skillPath) : input.skillName, policy, now);
  return mapGeneratedSkillTelemetryRow(
    db.prepare("SELECT * FROM generated_skill_telemetry WHERE id = ?").get(id) as GeneratedSkillTelemetryRow,
  );
}

export function markGeneratedSkillTelemetryFalsePositive(
  db: DatabaseSync,
  activationId: string,
  correctionReason: string,
  policy: GeneratedSkillLifecyclePolicy = DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
): GeneratedSkillTelemetryEntry | null {
  const row = db.prepare("SELECT * FROM generated_skill_telemetry WHERE id = ?").get(activationId) as
    | GeneratedSkillTelemetryRow
    | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE generated_skill_telemetry
        SET user_correction = 1,
            correction_reason = COALESCE(?, correction_reason)
      WHERE id = ?`,
  ).run(normalizeSummary(correctionReason), activationId);
  refreshGeneratedSkillLifecycleState(db, row.skill_name, policy);
  return mapGeneratedSkillTelemetryRow(
    db.prepare("SELECT * FROM generated_skill_telemetry WHERE id = ?").get(activationId) as GeneratedSkillTelemetryRow,
  );
}

export function setGeneratedSkillLifecycleState(
  db: DatabaseSync,
  skillName: string,
  state: GeneratedSkillLifecycleState,
  reason: string | null,
  at = Math.floor(Date.now() / 1000),
): ProcedureEntry | null {
  const proc = findGeneratedSkillProcedure(db, skillName);
  if (!proc) return null;
  db.prepare(
    `UPDATE procedures
        SET skill_state = ?,
            skill_state_reason = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(state, normalizeSummary(reason), at, proc.id);
  return getGeneratedSkillByName(db, skillName);
}

export function getGeneratedSkillByName(db: DatabaseSync, skillName: string): ProcedureEntry | null {
  return findGeneratedSkillProcedure(db, skillName);
}

function skillTelemetryEntries(db: DatabaseSync, skillName: string): GeneratedSkillTelemetryEntry[] {
  return (
    db
      .prepare(
        `SELECT *
           FROM generated_skill_telemetry
          WHERE skill_name = ?
          ORDER BY created_at DESC`,
      )
      .all(skillName) as GeneratedSkillTelemetryRow[]
  ).map(mapGeneratedSkillTelemetryRow);
}

function summarizeSkillTelemetry(
  proc: ProcedureEntry,
  activations: GeneratedSkillTelemetryEntry[],
  policy: GeneratedSkillLifecyclePolicy,
  now: number,
): {
  metrics: GeneratedSkillTelemetryMetrics;
  flags: GeneratedSkillTelemetryFlags;
  riskLevel: "low" | "medium" | "high";
} {
  const weekAgo = now - 7 * 24 * 60 * 60;
  let activationCountPerWeek = 0;
  let activationCountTotal = 0;
  let nearMissCount = 0;
  let falsePositiveSignals = 0;
  let falseNegativeSignals = 0;
  let repeatedCorrectionCount = 0;
  let lastUsedAt: number | null = null;
  let successCount = 0;
  let failureCount = 0;
  let partialCount = 0;
  let unknownCount = 0;
  let successfulUsesWithoutCorrection = 0;
  let consideredCount = 0;
  let skippedCount = 0;
  let savedToolCalls = 0;
  let savedTimeMs = 0;

  for (const activation of activations) {
    savedToolCalls += activation.savedToolCalls ?? 0;
    savedTimeMs += activation.savedTimeMs ?? 0;
    if (activation.decision === "selected") {
      activationCountTotal++;
      if (activation.createdAt >= weekAgo) activationCountPerWeek++;
      lastUsedAt = lastUsedAt == null ? activation.createdAt : Math.max(lastUsedAt, activation.createdAt);
      if (activation.userCorrection || activation.causedRework) falsePositiveSignals++;
      if (activation.taskOutcome === "success") {
        successCount++;
        if (!activation.userCorrection) successfulUsesWithoutCorrection++;
      } else if (activation.taskOutcome === "failure") {
        failureCount++;
      } else if (activation.taskOutcome === "partial") {
        partialCount++;
      } else {
        unknownCount++;
      }
    } else {
      nearMissCount++;
      if (activation.decision === "considered") consideredCount++;
      if (activation.decision === "skipped") skippedCount++;
    }
    if (activation.falseNegativeSignal) falseNegativeSignals++;
    if (activation.userCorrection) repeatedCorrectionCount++;
  }

  const knownOutcomeTotal = successCount + failureCount + partialCount + unknownCount;
  const successRate = knownOutcomeTotal > 0 ? successCount / knownOutcomeTotal : null;
  const failureRate = knownOutcomeTotal > 0 ? failureCount / knownOutcomeTotal : null;
  const partialRate = knownOutcomeTotal > 0 ? partialCount / knownOutcomeTotal : null;
  const unknownRate = knownOutcomeTotal > 0 ? unknownCount / knownOutcomeTotal : null;
  const falsePositiveRate = activationCountTotal > 0 ? falsePositiveSignals / activationCountTotal : null;
  const riskLevel = determineRiskLevel(proc, parseProcedureRecipeJson(proc.recipeJson));
  const { falsePositiveRate: demoteFpRate, minSamples: demoteMinSamples } = effectiveDemoteThresholdsForRisk(
    riskLevel,
    policy,
  );
  const generatedAt = proc.skillGeneratedAt ?? proc.promotedAt ?? proc.updatedAt ?? proc.createdAt ?? now;
  const archiveCandidate =
    activationCountTotal === 0 && generatedAt <= now - policy.archiveAfterUnusedDays * 24 * 60 * 60;
  const promotionCandidate =
    proc.skillState !== "demoted" &&
    proc.skillState !== "archived" &&
    proc.skillState !== "trusted" &&
    successfulUsesWithoutCorrection >= policy.promoteAfterSuccessfulUses;
  const overTriggering =
    activationCountTotal >= demoteMinSamples && falsePositiveRate != null && falsePositiveRate >= demoteFpRate;
  const revisionCandidate = nearMissCount >= policy.revisionNearMissThreshold && skippedCount >= consideredCount;

  return {
    metrics: {
      activationCountPerWeek,
      activationCountTotal,
      nearMissCount,
      falsePositiveSignals,
      falseNegativeSignals,
      repeatedCorrectionCount,
      lastUsedAt,
      successCount,
      failureCount,
      partialCount,
      unknownCount,
      successRate,
      failureRate,
      partialRate,
      unknownRate,
      successfulUsesWithoutCorrection,
      consideredCount,
      skippedCount,
      savedToolCalls,
      savedTimeMs,
      falsePositiveRate,
    },
    flags: {
      promotionCandidate,
      overTriggering,
      revisionCandidate,
      neverUsed: activationCountTotal === 0,
      archiveCandidate,
    },
    riskLevel,
  };
}

function desiredLifecycleTransition(
  currentState: GeneratedSkillLifecycleState,
  flags: GeneratedSkillTelemetryFlags,
  metrics: GeneratedSkillTelemetryMetrics,
  policy: GeneratedSkillLifecyclePolicy,
  proc: ProcedureEntry,
): { state: GeneratedSkillLifecycleState; reason: string } | null {
  if (currentState !== "archived" && flags.archiveCandidate) {
    return {
      state: "archived",
      reason: `auto-archived after ${policy.archiveAfterUnusedDays} days without any recorded activation`,
    };
  }
  if (currentState !== "demoted" && flags.overTriggering) {
    const riskLevel = determineRiskLevel(proc, parseProcedureRecipeJson(proc.recipeJson));
    const { falsePositiveRate: demoteFpRate, minSamples: demoteMinSamples } = effectiveDemoteThresholdsForRisk(
      riskLevel,
      policy,
    );
    return {
      state: "demoted",
      reason: `auto-demoted (${riskLevel} risk): FP rate ${Math.round((metrics.falsePositiveRate ?? 0) * 100)}% reached threshold ${Math.round(demoteFpRate * 100)}% over ${demoteMinSamples}+ activations`,
    };
  }
  if (currentState === "experimental" && flags.promotionCandidate) {
    return {
      state: "trusted",
      reason: `auto-promoted after ${metrics.successfulUsesWithoutCorrection} successful activations without correction`,
    };
  }
  return null;
}

export function refreshGeneratedSkillLifecycleState(
  db: DatabaseSync,
  skillName: string,
  policy: GeneratedSkillLifecyclePolicy = DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
  now = Math.floor(Date.now() / 1000),
): ProcedureEntry | null {
  const proc = findGeneratedSkillProcedure(db, skillName);
  if (!proc?.skillPath) return null;
  const canonicalSkillName = basename(proc.skillPath);
  const activations = skillTelemetryEntries(db, canonicalSkillName);
  const { metrics, flags } = summarizeSkillTelemetry(proc, activations, policy, now);
  const currentState = proc.skillState ?? "experimental";
  const transition = desiredLifecycleTransition(currentState, flags, metrics, policy, proc);
  if (transition == null) return proc;
  return setGeneratedSkillLifecycleState(db, canonicalSkillName, transition.state, transition.reason, now);
}

export function buildGeneratedSkillTelemetryReport(
  db: DatabaseSync,
  options?: {
    skillName?: string;
    policy?: Partial<GeneratedSkillLifecyclePolicy>;
    recentActivationLimit?: number;
    now?: number;
  },
): GeneratedSkillTelemetryReport {
  const policy = { ...DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY, ...(options?.policy ?? {}) };
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const procedures = listGeneratedSkillProcedures(db).filter((proc) => {
    if (!options?.skillName) return true;
    return proc.skillPath != null && basename(proc.skillPath) === options.skillName;
  });
  for (const proc of procedures) {
    if (proc.skillPath) refreshGeneratedSkillLifecycleState(db, basename(proc.skillPath), policy, now);
  }
  const rows = listGeneratedSkillProcedures(db)
    .filter((proc) => {
      if (!options?.skillName) return true;
      return proc.skillPath != null && basename(proc.skillPath) === options.skillName;
    })
    .map((proc) => {
      const skillName = basename(proc.skillPath ?? proc.taskPattern);
      const activations = skillTelemetryEntries(db, skillName);
      const { metrics, flags, riskLevel } = summarizeSkillTelemetry(proc, activations, policy, now);
      const recommendation = flags.archiveCandidate
        ? "archive"
        : flags.overTriggering
          ? "demote"
          : flags.promotionCandidate
            ? "promote"
            : flags.revisionCandidate
              ? "revise"
              : "observe";
      return {
        procedureId: proc.id,
        skillName,
        skillPath: proc.skillPath ?? skillName,
        skillVersion: proc.skillVersion ?? 1,
        riskLevel,
        state: proc.skillState ?? "experimental",
        stateReason: proc.skillStateReason ?? null,
        generatedAt: proc.skillGeneratedAt ?? proc.promotedAt ?? null,
        metrics,
        flags,
        recommendation,
        recentActivations: activations.slice(0, options?.recentActivationLimit ?? 10),
      } satisfies GeneratedSkillTelemetryReportRow;
    })
    .sort((a, b) => a.skillName.localeCompare(b.skillName));
  return {
    generatedAt: new Date(now * 1000).toISOString(),
    policy,
    totalSkills: rows.length,
    rows,
  };
}
