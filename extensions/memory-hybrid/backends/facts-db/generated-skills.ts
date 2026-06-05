import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, join, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { determineRiskLevel, parseRecipeOrRaw } from "../../utils/procedure-risk.js";
import type {
  GeneratedSkillLifecycleState,
  GeneratedSkillTelemetryDecision,
  GeneratedSkillTelemetryEntry,
  GeneratedSkillTelemetryOutcome,
  MemoryScope,
  ProcedureEntry,
} from "../../types/memory.js";
import { resolveOpenClawWorkspaceRoot } from "../../utils/openclaw-workspace.js";
import { formatTimestampUtc } from "../../utils/dates.js";
import {
  DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
  effectiveDemoteThresholdsForRisk,
} from "./generated-skills/policy.js";
export {
  DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
  effectiveDemoteThresholdsForRisk,
} from "./generated-skills/policy.js";
export type {
  GeneratedSkillLifecyclePolicy,
  GeneratedSkillTelemetryFlags,
  GeneratedSkillTelemetryMetrics,
  GeneratedSkillTelemetryRecordInput,
  GeneratedSkillTelemetryReport,
  GeneratedSkillTelemetryReportRow,
} from "./generated-skills/policy.js";
import type {
  GeneratedSkillLifecyclePolicy,
  GeneratedSkillTelemetryFlags,
  GeneratedSkillTelemetryMetrics,
  GeneratedSkillTelemetryRecordInput,
  GeneratedSkillTelemetryReport,
  GeneratedSkillTelemetryReportRow,
} from "./generated-skills/policy.js";
import { procedureRowToEntry } from "./procedures.js";

const MAX_REQUEST_SUMMARY_LENGTH = 240;

function isAbsoluteSkillPath(skillPath: string): boolean {
  return isAbsolute(skillPath) || win32.isAbsolute(skillPath);
}

function hasWindowsDrivePrefix(skillPath: string): boolean {
  return /^[A-Za-z]:[/\\]/u.test(skillPath);
}

function usesWindowsPathSemantics(skillPath: string): boolean {
  return hasWindowsDrivePrefix(skillPath) || skillPath.includes("\\");
}

function skillPathBasename(skillPath: string): string {
  return usesWindowsPathSemantics(skillPath) ? win32.basename(skillPath) : basename(skillPath);
}

function resolveSkillMdPath(skillPath: string, workspaceRoot: string): { dirPath: string; skillMdPath: string } {
  const resolvedPath = isAbsoluteSkillPath(skillPath) ? skillPath : join(workspaceRoot, skillPath);
  const usesWindowsSeparators = usesWindowsPathSemantics(resolvedPath);
  const hasSkillMdSuffix = /(?:^|[/\\])SKILL\.md$/u.test(resolvedPath);
  const dirPath = hasSkillMdSuffix ? resolvedPath.replace(/(?:^|[/\\])SKILL\.md$/u, "") : resolvedPath;
  const skillMdPath = hasSkillMdSuffix
    ? resolvedPath
    : usesWindowsSeparators
      ? win32.join(dirPath, "SKILL.md")
      : join(dirPath, "SKILL.md");
  return { dirPath, skillMdPath };
}

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

/** Per-procedure counters maintained incrementally on telemetry insert (#1415 / #1400). */
type TelemetryRollupRow = {
  gst_sel_total: number;
  gst_near_miss_total: number;
  gst_fp_signals_total: number;
  gst_fn_signals_total: number;
  gst_user_correction_total: number;
  gst_outcome_success: number;
  gst_outcome_failure: number;
  gst_outcome_partial: number;
  gst_outcome_unknown: number;
  gst_success_clear_total: number;
  gst_considered_total: number;
  gst_skipped_total: number;
  gst_saved_tool_calls_sum: number;
  gst_saved_time_ms_sum: number;
  gst_last_selected_at: number | null;
};

function readTelemetryRollup(db: DatabaseSync, procedureId: string): TelemetryRollupRow | null {
  const row = db
    .prepare(
      `SELECT gst_sel_total, gst_near_miss_total, gst_fp_signals_total, gst_fn_signals_total,
              gst_user_correction_total, gst_outcome_success, gst_outcome_failure, gst_outcome_partial,
              gst_outcome_unknown, gst_success_clear_total, gst_considered_total, gst_skipped_total,
              gst_saved_tool_calls_sum, gst_saved_time_ms_sum, gst_last_selected_at
         FROM procedures WHERE id = ?`,
    )
    .get(procedureId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    gst_sel_total: (row.gst_sel_total as number) ?? 0,
    gst_near_miss_total: (row.gst_near_miss_total as number) ?? 0,
    gst_fp_signals_total: (row.gst_fp_signals_total as number) ?? 0,
    gst_fn_signals_total: (row.gst_fn_signals_total as number) ?? 0,
    gst_user_correction_total: (row.gst_user_correction_total as number) ?? 0,
    gst_outcome_success: (row.gst_outcome_success as number) ?? 0,
    gst_outcome_failure: (row.gst_outcome_failure as number) ?? 0,
    gst_outcome_partial: (row.gst_outcome_partial as number) ?? 0,
    gst_outcome_unknown: (row.gst_outcome_unknown as number) ?? 0,
    gst_success_clear_total: (row.gst_success_clear_total as number) ?? 0,
    gst_considered_total: (row.gst_considered_total as number) ?? 0,
    gst_skipped_total: (row.gst_skipped_total as number) ?? 0,
    gst_saved_tool_calls_sum: (row.gst_saved_tool_calls_sum as number) ?? 0,
    gst_saved_time_ms_sum: (row.gst_saved_time_ms_sum as number) ?? 0,
    gst_last_selected_at: (row.gst_last_selected_at as number | null) ?? null,
  };
}

/** Recompute rollup columns from `generated_skill_telemetry` (e.g. after correction edits). */
export function rebuildGeneratedSkillTelemetryRollupsForProcedure(db: DatabaseSync, procedureId: string): void {
  db.prepare(
    `UPDATE procedures AS p
       SET gst_sel_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected'),
           gst_near_miss_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision != 'selected'),
           gst_fp_signals_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND (t.user_correction = 1 OR t.caused_rework = 1)),
           gst_fn_signals_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.false_negative_signal = 1),
           gst_user_correction_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.user_correction = 1),
           gst_outcome_success = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected' AND t.task_outcome = 'success'),
           gst_outcome_failure = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected' AND t.task_outcome = 'failure'),
           gst_outcome_partial = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected' AND t.task_outcome = 'partial'),
            gst_outcome_unknown = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected' AND (t.task_outcome IS NULL OR t.task_outcome = '' OR t.task_outcome NOT IN ('success','failure','partial'))),
            gst_success_clear_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected' AND t.task_outcome = 'success' AND t.user_correction = 0),
           gst_considered_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'considered'),
           gst_skipped_total = (SELECT COUNT(*) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'skipped'),
           gst_saved_tool_calls_sum = (SELECT COALESCE(SUM(CASE WHEN t.saved_tool_calls > 0 THEN t.saved_tool_calls ELSE 0 END), 0) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id),
           gst_saved_time_ms_sum = (SELECT COALESCE(SUM(CASE WHEN t.saved_time_ms > 0 THEN t.saved_time_ms ELSE 0 END), 0) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id),
           gst_last_selected_at = (SELECT MAX(t.created_at) FROM generated_skill_telemetry t WHERE t.procedure_id = p.id AND t.decision = 'selected')
     WHERE p.id = ?`,
  ).run(procedureId);
}

function applyTelemetryRollupDelta(
  db: DatabaseSync,
  procedureId: string,
  input: GeneratedSkillTelemetryRecordInput,
  savedCalls: number,
  savedTimeMs: number,
  nowSec: number,
): void {
  let dSel = 0;
  let dNear = 0;
  let dFp = 0;
  let dFn = 0;
  let dUserCorr = 0;
  let dSucc = 0;
  let dFail = 0;
  let dPart = 0;
  let dUnk = 0;
  let dClear = 0;
  let dConsidered = 0;
  let dSkipped = 0;
  if (input.userCorrection === true || input.causedRework === true) dFp = 1;
  if (input.decision === "selected") {
    dSel = 1;
    const outcome = input.taskOutcome;
    if (outcome === "success") {
      dSucc = 1;
      if (input.userCorrection !== true) dClear = 1;
    } else if (outcome === "failure") {
      dFail = 1;
    } else if (outcome === "partial") {
      dPart = 1;
    } else {
      dUnk = 1;
    }
  } else {
    dNear = 1;
    if (input.decision === "considered") dConsidered = 1;
    if (input.decision === "skipped") dSkipped = 1;
  }
  if (input.falseNegativeSignal === true) dFn = 1;
  if (input.userCorrection === true) dUserCorr = 1;
  const positiveSavedCalls = savedCalls > 0 ? savedCalls : 0;
  const positiveSavedTimeMs = savedTimeMs > 0 ? savedTimeMs : 0;
  const lastSelectedAt = input.decision === "selected" ? nowSec : 0;
  db.prepare(
    `UPDATE procedures SET
       gst_sel_total = gst_sel_total + ?,
       gst_near_miss_total = gst_near_miss_total + ?,
       gst_fp_signals_total = gst_fp_signals_total + ?,
       gst_fn_signals_total = gst_fn_signals_total + ?,
       gst_user_correction_total = gst_user_correction_total + ?,
       gst_outcome_success = gst_outcome_success + ?,
       gst_outcome_failure = gst_outcome_failure + ?,
       gst_outcome_partial = gst_outcome_partial + ?,
       gst_outcome_unknown = gst_outcome_unknown + ?,
       gst_success_clear_total = gst_success_clear_total + ?,
       gst_considered_total = gst_considered_total + ?,
       gst_skipped_total = gst_skipped_total + ?,
       gst_saved_tool_calls_sum = gst_saved_tool_calls_sum + ?,
       gst_saved_time_ms_sum = gst_saved_time_ms_sum + ?,
       gst_last_selected_at = CASE WHEN ? > COALESCE(gst_last_selected_at, 0) THEN ? ELSE gst_last_selected_at END
     WHERE id = ?`,
  ).run(
    dSel,
    dNear,
    dFp,
    dFn,
    dUserCorr,
    dSucc,
    dFail,
    dPart,
    dUnk,
    dClear,
    dConsidered,
    dSkipped,
    positiveSavedCalls,
    positiveSavedTimeMs,
    lastSelectedAt,
    lastSelectedAt,
    procedureId,
  );
}

function countSelectedActivationsSince(db: DatabaseSync, procedureId: string, sinceSec: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM generated_skill_telemetry
        WHERE procedure_id = ? AND decision = 'selected' AND created_at >= ?`,
    )
    .get(procedureId, sinceSec) as { c: number };
  return row?.c ?? 0;
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

function findGeneratedSkillProcedureMatches(db: DatabaseSync, skillName: string): ProcedureEntry[] {
  const trimmed = skillName.trim();
  if (trimmed.length === 0) return [];
  const matches: ProcedureEntry[] = [];
  for (const row of generatedSkillRows(db)) {
    const proc = procedureRowToEntry(db, row);
    if (!proc.skillPath?.trim()) continue;
    const path = proc.skillPath.trim();
    if (path === trimmed || skillPathBasename(path) === trimmed) matches.push(proc);
  }
  return matches;
}

function findGeneratedSkillProcedure(db: DatabaseSync, skillName: string): ProcedureEntry | null {
  return findGeneratedSkillProcedureMatches(db, skillName)[0] ?? null;
}

function findGeneratedSkillProcedureStrict(db: DatabaseSync, skillName: string): ProcedureEntry | null {
  const trimmed = skillName.trim();
  const matches = findGeneratedSkillProcedureMatches(db, trimmed);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous skill name "${trimmed}": multiple promoted procedures match; pass procedureId to disambiguate`,
    );
  }
  return matches[0] ?? null;
}

function findProcedureById(db: DatabaseSync, procedureId: string): ProcedureEntry | null {
  const row = db.prepare("SELECT * FROM procedures WHERE id = ? LIMIT 1").get(procedureId) as
    | Record<string, unknown>
    | undefined;
  return row ? procedureRowToEntry(db, row) : null;
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
  let proc: ProcedureEntry | null = null;
  if (input.procedureId != null) {
    const candidate = findProcedureById(db, input.procedureId);
    if (!candidate) throw new Error(`Procedure not found for telemetry: ${input.procedureId}`);
    if (candidate.promotedToSkill !== 1 || !candidate.skillPath?.trim()) {
      throw new Error(`Procedure ${input.procedureId} is not a promoted generated skill`);
    }
    const skill = input.skillName.trim();
    const path = candidate.skillPath.trim();
    if (path !== skill && skillPathBasename(path) !== skill) {
      throw new Error(`Procedure ${input.procedureId} skill_path does not match skill name "${input.skillName}"`);
    }
    proc = candidate;
  } else {
    proc = findGeneratedSkillProcedureStrict(db, input.skillName);
  }
  if (!proc) throw new Error(`Generated skill not found: ${input.skillName}`);
  if (input.userCorrection === true) {
    const normalizedCorrectionReason = normalizeSummary(input.correctionReason);
    if (!normalizedCorrectionReason) {
      throw new Error("user correction telemetry requires a non-empty correctionReason");
    }
  }
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
    proc.skillPath ? skillPathBasename(proc.skillPath) : input.skillName,
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
  applyTelemetryRollupDelta(db, proc.id, input, input.savedToolCalls ?? 0, input.savedTimeMs ?? 0, now);
  refreshGeneratedSkillLifecycleState(
    db,
    proc.skillPath ? skillPathBasename(proc.skillPath) : input.skillName,
    policy,
    now,
    proc.id,
  );
  return mapGeneratedSkillTelemetryRow(
    db.prepare("SELECT * FROM generated_skill_telemetry WHERE id = ?").get(id) as GeneratedSkillTelemetryRow,
  );
}

const REPEATED_CORRECTION_WINDOW_SEC = 30 * 24 * 60 * 60;

function countRepeatedUserCorrectionBuckets(activations: GeneratedSkillTelemetryEntry[], now: number): number {
  const windowStart = now - REPEATED_CORRECTION_WINDOW_SEC;
  const byHash = new Map<string, number>();
  for (const activation of activations) {
    if (!activation.userCorrection || activation.createdAt < windowStart) continue;
    const hash = activation.requestHash;
    if (typeof hash !== "string" || hash.length === 0) continue;
    byHash.set(hash, (byHash.get(hash) ?? 0) + 1);
  }
  let repeatedBuckets = 0;
  for (const count of byHash.values()) {
    if (count >= 2) repeatedBuckets++;
  }
  return repeatedBuckets;
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
  rebuildGeneratedSkillTelemetryRollupsForProcedure(db, row.procedure_id);
  refreshGeneratedSkillLifecycleState(db, row.skill_name, policy, undefined, row.procedure_id);
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
  procedureId?: string,
): ProcedureEntry | null {
  let proc: ProcedureEntry | null = null;
  if (procedureId != null) {
    proc = findProcedureById(db, procedureId);
    if (proc && (proc.promotedToSkill !== 1 || !proc.skillPath?.trim())) {
      return null;
    }
  } else {
    proc = findGeneratedSkillProcedure(db, skillName);
  }
  if (!proc) return null;
  if (state === "experimental") {
    // When a skill is reset/unblocked back to experimental, update skill_generated_at to mark
    // the new evaluation window start. This prevents pre-reset telemetry from counting against
    // the skill's overTriggering and promotionCandidate evaluations.
    db.prepare(
      `UPDATE procedures
         SET skill_state = ?,
             skill_state_reason = ?,
             skill_generated_at = ?,
             skill_state_changed_at = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(state, normalizeSummary(reason), at, at, at, proc.id);
  } else {
    db.prepare(
      `UPDATE procedures
         SET skill_state = ?,
             skill_state_reason = ?,
             skill_state_changed_at = ?,
             updated_at = ?
        WHERE id = ?`,
    ).run(state, normalizeSummary(reason), at, at, proc.id);
  }
  return getGeneratedSkillByName(db, skillName, procedureId);
}

export function getGeneratedSkillByName(
  db: DatabaseSync,
  skillName: string,
  procedureId?: string,
): ProcedureEntry | null {
  if (procedureId != null) {
    const proc = findProcedureById(db, procedureId);
    if (proc && (proc.promotedToSkill !== 1 || !proc.skillPath?.trim())) {
      return null;
    }
    return proc;
  }
  return findGeneratedSkillProcedure(db, skillName);
}

function skillTelemetryEntries(
  db: DatabaseSync,
  skillName: string,
  procedureId?: string,
): GeneratedSkillTelemetryEntry[] {
  const query = procedureId
    ? `SELECT *
         FROM generated_skill_telemetry
        WHERE skill_name = ? AND procedure_id = ?
        ORDER BY created_at DESC`
    : `SELECT *
         FROM generated_skill_telemetry
        WHERE skill_name = ?
        ORDER BY created_at DESC`;
  const params = procedureId ? [skillName, procedureId] : [skillName];
  return (db.prepare(query).all(...params) as GeneratedSkillTelemetryRow[]).map(mapGeneratedSkillTelemetryRow);
}

function skillTelemetryRecentEntries(
  db: DatabaseSync,
  skillName: string,
  limit: number,
  procedureId?: string,
): GeneratedSkillTelemetryEntry[] {
  const query = procedureId
    ? `SELECT id, procedure_id, skill_name, skill_version, request_hash, request_summary, decision, confidence,
                reason, task_outcome, user_correction, correction_reason, false_negative_signal, caused_rework,
                saved_tool_calls, saved_time_ms, scope, scope_target, agent_id, session_id, created_at
           FROM generated_skill_telemetry
          WHERE skill_name = ? AND procedure_id = ?
          ORDER BY created_at DESC
          LIMIT ?`
    : `SELECT id, procedure_id, skill_name, skill_version, request_hash, request_summary, decision, confidence,
                reason, task_outcome, user_correction, correction_reason, false_negative_signal, caused_rework,
                saved_tool_calls, saved_time_ms, scope, scope_target, agent_id, session_id, created_at
           FROM generated_skill_telemetry
          WHERE skill_name = ?
          ORDER BY created_at DESC
          LIMIT ?`;
  const params = procedureId ? [skillName, procedureId, limit] : [skillName, limit];
  return (db.prepare(query).all(...params) as GeneratedSkillTelemetryRow[]).map(mapGeneratedSkillTelemetryRow);
}

type RawTelemetryCounts = {
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
  successfulUsesWithoutCorrection: number;
  consideredCount: number;
  skippedCount: number;
  savedToolCalls: number;
  savedTimeMs: number;
  cleanUsesAfterDemotion: number;
};

function deriveMetricsAndFlags(
  counts: RawTelemetryCounts,
  proc: ProcedureEntry,
  policy: GeneratedSkillLifecyclePolicy,
  now: number,
): { metrics: GeneratedSkillTelemetryMetrics; flags: GeneratedSkillTelemetryFlags } {
  const knownOutcomeTotal = counts.successCount + counts.failureCount + counts.partialCount + counts.unknownCount;
  const successRate = knownOutcomeTotal > 0 ? counts.successCount / knownOutcomeTotal : null;
  const failureRate = knownOutcomeTotal > 0 ? counts.failureCount / knownOutcomeTotal : null;
  const partialRate = knownOutcomeTotal > 0 ? counts.partialCount / knownOutcomeTotal : null;
  const unknownRate = knownOutcomeTotal > 0 ? counts.unknownCount / knownOutcomeTotal : null;
  const exposureTotal = counts.activationCountTotal + counts.nearMissCount;
  const falsePositiveRate = exposureTotal > 0 ? counts.falsePositiveSignals / exposureTotal : null;
  const riskLevel = determineRiskLevel(proc, parseRecipeOrRaw(proc.recipeJson));
  const { falsePositiveRate: demoteFpRate, minSamples: demoteMinSamples } = effectiveDemoteThresholdsForRisk(
    riskLevel,
    policy,
  );
  const generatedAt = proc.skillGeneratedAt ?? proc.promotedAt ?? proc.updatedAt ?? proc.createdAt ?? now;
  const archiveBaselineAt = proc.skillState === "demoted" ? (proc.skillStateChangedAt ?? generatedAt) : generatedAt;
  const archiveCandidate =
    counts.activationCountTotal === 0 && archiveBaselineAt <= now - policy.archiveAfterUnusedDays * 24 * 60 * 60;
  const promotionCandidate =
    proc.skillState !== "demoted" &&
    proc.skillState !== "archived" &&
    proc.skillState !== "trusted" &&
    proc.skillState !== "uninstalled" &&
    proc.skillState !== "rejected" &&
    counts.successfulUsesWithoutCorrection >= policy.promoteAfterSuccessfulUses;
  const overTriggering =
    exposureTotal >= demoteMinSamples && falsePositiveRate != null && falsePositiveRate >= demoteFpRate;
  const revisionCandidate =
    counts.nearMissCount >= policy.revisionNearMissThreshold && counts.skippedCount >= counts.consideredCount;
  const unblockAfterCleanUses = policy.unblockAfterCleanUses ?? 0;
  const unblockCandidate =
    unblockAfterCleanUses > 0 &&
    (proc.skillState === "demoted" || proc.skillState === "archived") &&
    counts.cleanUsesAfterDemotion >= unblockAfterCleanUses;

  return {
    metrics: {
      activationCountPerWeek: counts.activationCountPerWeek,
      activationCountTotal: counts.activationCountTotal,
      nearMissCount: counts.nearMissCount,
      falsePositiveSignals: counts.falsePositiveSignals,
      falseNegativeSignals: counts.falseNegativeSignals,
      correctionCount: counts.correctionCount,
      repeatedCorrectionCount: counts.repeatedCorrectionCount,
      lastUsedAt: counts.lastUsedAt,
      successCount: counts.successCount,
      failureCount: counts.failureCount,
      partialCount: counts.partialCount,
      unknownCount: counts.unknownCount,
      successRate,
      failureRate,
      partialRate,
      unknownRate,
      successfulUsesWithoutCorrection: counts.successfulUsesWithoutCorrection,
      consideredCount: counts.consideredCount,
      skippedCount: counts.skippedCount,
      savedToolCalls: counts.savedToolCalls,
      savedTimeMs: counts.savedTimeMs,
      falsePositiveRate,
      cleanUsesAfterDemotion: counts.cleanUsesAfterDemotion,
    },
    flags: {
      promotionCandidate,
      overTriggering,
      revisionCandidate,
      neverUsed: counts.activationCountTotal === 0,
      archiveCandidate,
      unblockCandidate,
    },
  };
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

  // For experimental and trusted skills, evaluate only activations since skill_generated_at.
  // For demoted/archived skills, evaluate only activations since skill_state_changed_at.
  // This prevents pre-reset telemetry from blocking promotion or re-triggering demotion
  // after an operator manually resets or the system auto-unblocks a skill.
  const isExperimentalOrTrusted =
    proc.skillState === "experimental" || proc.skillState === "trusted" || proc.skillState === "draft";
  const isDemotedOrArchived = proc.skillState === "demoted" || proc.skillState === "archived";
  let evalWindowStart = 0;
  if (isExperimentalOrTrusted && proc.skillGeneratedAt !== null && proc.skillGeneratedAt !== undefined) {
    evalWindowStart = proc.skillGeneratedAt;
  } else if (isDemotedOrArchived && proc.skillStateChangedAt !== null && proc.skillStateChangedAt !== undefined) {
    evalWindowStart = proc.skillStateChangedAt;
  }
  const evalActivations = evalWindowStart > 0 ? activations.filter((a) => a.createdAt >= evalWindowStart) : activations;

  let activationCountPerWeek = 0;
  let activationCountTotal = 0;
  let nearMissCount = 0;
  let falsePositiveSignals = 0;
  let falseNegativeSignals = 0;
  let correctionCount = 0;
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

  // For unblock tracking: count clean (uncorrected) successful activations since the
  // most recent demotion/archive state change. Use skill_state_changed_at as the
  // reset baseline — it tracks state transitions exclusively and is not affected by
  // other procedure updates (e.g., upsertProcedure).
  const demotedOrArchivedAt =
    proc.skillState === "demoted" || proc.skillState === "archived"
      ? (proc.skillStateChangedAt ?? proc.updatedAt ?? 0)
      : null;
  let cleanUsesAfterDemotion = 0;

  for (const activation of evalActivations) {
    const calls = activation.savedToolCalls ?? 0;
    const timeMs = activation.savedTimeMs ?? 0;
    savedToolCalls += calls > 0 ? calls : 0;
    savedTimeMs += timeMs > 0 ? timeMs : 0;
    if (activation.userCorrection || activation.causedRework) falsePositiveSignals++;
    if (activation.userCorrection) correctionCount++;
    if (activation.decision === "selected") {
      activationCountTotal++;
      if (activation.createdAt >= weekAgo) activationCountPerWeek++;
      lastUsedAt = lastUsedAt == null ? activation.createdAt : Math.max(lastUsedAt, activation.createdAt);
      if (activation.taskOutcome === "success") {
        successCount++;
        if (!activation.userCorrection) {
          successfulUsesWithoutCorrection++;
          // Count clean uses recorded after a demotion reset
          if (demotedOrArchivedAt != null && activation.createdAt > demotedOrArchivedAt) {
            cleanUsesAfterDemotion++;
          }
        }
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
  }
  const repeatedCorrectionCount = countRepeatedUserCorrectionBuckets(evalActivations, now);

  const knownOutcomeTotal = successCount + failureCount + partialCount + unknownCount;
  const successRate = knownOutcomeTotal > 0 ? successCount / knownOutcomeTotal : null;
  const failureRate = knownOutcomeTotal > 0 ? failureCount / knownOutcomeTotal : null;
  const partialRate = knownOutcomeTotal > 0 ? partialCount / knownOutcomeTotal : null;
  const unknownRate = knownOutcomeTotal > 0 ? unknownCount / knownOutcomeTotal : null;
  const exposureTotal = activationCountTotal + nearMissCount;
  const falsePositiveRate = exposureTotal > 0 ? falsePositiveSignals / exposureTotal : null;
  const riskLevel = determineRiskLevel(proc, parseRecipeOrRaw(proc.recipeJson));
  const { falsePositiveRate: demoteFpRate, minSamples: demoteMinSamples } = effectiveDemoteThresholdsForRisk(
    riskLevel,
    policy,
  );
  const generatedAt = proc.skillGeneratedAt ?? proc.promotedAt ?? proc.updatedAt ?? proc.createdAt ?? now;
  const archiveBaselineAt = proc.skillState === "demoted" ? (proc.skillStateChangedAt ?? generatedAt) : generatedAt;
  const lastActivityAt = lastUsedAt ?? archiveBaselineAt;
  const promotionCandidate =
    proc.skillState !== "demoted" &&
    proc.skillState !== "archived" &&
    proc.skillState !== "trusted" &&
    proc.skillState !== "uninstalled" &&
    proc.skillState !== "rejected" &&
    successfulUsesWithoutCorrection >= policy.promoteAfterSuccessfulUses;
  const unblockAfterCleanUses = policy.unblockAfterCleanUses ?? 0;
  const unblockCandidate =
    unblockAfterCleanUses > 0 &&
    (proc.skillState === "demoted" || proc.skillState === "archived") &&
    cleanUsesAfterDemotion >= unblockAfterCleanUses;
  const archiveCandidate =
    !promotionCandidate && !unblockCandidate && now - lastActivityAt >= policy.archiveAfterUnusedDays * 24 * 60 * 60;
  const overTriggering =
    exposureTotal >= demoteMinSamples && falsePositiveRate != null && falsePositiveRate >= demoteFpRate;
  const revisionCandidate = nearMissCount >= policy.revisionNearMissThreshold && skippedCount >= consideredCount;

  return {
    metrics: {
      activationCountPerWeek,
      activationCountTotal,
      nearMissCount,
      falsePositiveSignals,
      falseNegativeSignals,
      correctionCount,
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
      cleanUsesAfterDemotion,
    },
    flags: {
      promotionCandidate,
      overTriggering,
      revisionCandidate,
      neverUsed: activationCountTotal === 0,
      archiveCandidate,
      unblockCandidate,
    },
    riskLevel,
  };
}

function _summarizeSkillTelemetryFromRollups(
  db: DatabaseSync,
  proc: ProcedureEntry,
  canonicalSkillName: string,
  policy: GeneratedSkillLifecyclePolicy,
  now: number,
): {
  metrics: GeneratedSkillTelemetryMetrics;
  flags: GeneratedSkillTelemetryFlags;
  riskLevel: "low" | "medium" | "high";
} {
  const r = readTelemetryRollup(db, proc.id);
  if (!r) {
    return summarizeSkillTelemetry(proc, skillTelemetryEntries(db, canonicalSkillName, proc.id), policy, now);
  }
  const weekAgo = now - 7 * 24 * 60 * 60;
  const activationCountPerWeek = countSelectedActivationsSince(db, proc.id, weekAgo);
  const activationCountTotal = r.gst_sel_total;
  const nearMissCount = r.gst_near_miss_total;
  const falsePositiveSignals = r.gst_fp_signals_total;
  const falseNegativeSignals = r.gst_fn_signals_total;
  const correctionCount = r.gst_user_correction_total;
  const lastUsedAt = r.gst_last_selected_at;
  const successCount = r.gst_outcome_success;
  const failureCount = r.gst_outcome_failure;
  const partialCount = r.gst_outcome_partial;
  const unknownCount = r.gst_outcome_unknown;
  const successfulUsesWithoutCorrection = r.gst_success_clear_total;
  const consideredCount = r.gst_considered_total;
  const skippedCount = r.gst_skipped_total;
  const savedToolCalls = r.gst_saved_tool_calls_sum;
  const savedTimeMs = r.gst_saved_time_ms_sum;
  const repeatedCorrectionCount = countRepeatedUserCorrectionBuckets(
    skillTelemetryEntries(db, canonicalSkillName, proc.id),
    now,
  );
  const demotedOrArchivedAt =
    proc.skillState === "demoted" || proc.skillState === "archived"
      ? (proc.skillStateChangedAt ?? proc.updatedAt ?? 0)
      : null;
  let cleanUsesAfterDemotion = 0;
  if (demotedOrArchivedAt != null) {
    const postDemotionActivations = skillTelemetryEntries(db, canonicalSkillName, proc.id).filter(
      (a) =>
        a.decision === "selected" &&
        a.taskOutcome === "success" &&
        !a.userCorrection &&
        a.createdAt > demotedOrArchivedAt,
    );
    cleanUsesAfterDemotion = postDemotionActivations.length;
  }
  const riskLevel = determineRiskLevel(proc, parseRecipeOrRaw(proc.recipeJson));
  const summary = deriveMetricsAndFlags(
    {
      activationCountPerWeek,
      activationCountTotal,
      nearMissCount,
      falsePositiveSignals,
      falseNegativeSignals,
      correctionCount,
      repeatedCorrectionCount,
      lastUsedAt,
      successCount,
      failureCount,
      partialCount,
      unknownCount,
      successfulUsesWithoutCorrection,
      consideredCount,
      skippedCount,
      savedToolCalls,
      savedTimeMs,
      cleanUsesAfterDemotion,
    },
    proc,
    policy,
    now,
  );
  return { ...summary, riskLevel };
}

function desiredLifecycleTransition(
  currentState: GeneratedSkillLifecycleState,
  flags: GeneratedSkillTelemetryFlags,
  metrics: GeneratedSkillTelemetryMetrics,
  policy: GeneratedSkillLifecyclePolicy,
  riskLevel: "low" | "medium" | "high",
): { state: GeneratedSkillLifecycleState; reason: string } | null {
  // Uninstalled and rejected are terminal — no automatic transitions out.
  if (currentState === "uninstalled" || currentState === "rejected") return null;

  if (currentState !== "archived" && flags.archiveCandidate) {
    return {
      state: "archived",
      reason: `auto-archived after ${policy.archiveAfterUnusedDays} days without selected-activation activity`,
    };
  }
  // Allow automatic unblocking of demoted/archived skills when they accumulate
  // enough clean uses after the demotion reset AND are not currently overtriggering.
  // Evaluate this before the overTriggering check so archived skills with high historical
  // FP rates can transition directly to experimental rather than demoted, but only if
  // the current post-demotion false-positive rate is acceptable.
  if (flags.unblockCandidate && !flags.overTriggering) {
    return {
      state: "experimental",
      reason: `auto-unblocked after ${metrics.cleanUsesAfterDemotion} clean activations since demotion`,
    };
  }
  if (currentState !== "demoted" && currentState !== "archived" && flags.overTriggering) {
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
  policy?: GeneratedSkillLifecyclePolicy,
  now?: number,
  procedureId?: string,
): ProcedureEntry | null;
export function refreshGeneratedSkillLifecycleState(
  db: DatabaseSync,
  skillName: string,
  policy: GeneratedSkillLifecyclePolicy,
  now: number,
  returnMetrics: true,
  procedureId?: string,
): {
  proc: ProcedureEntry;
  metrics: GeneratedSkillTelemetryMetrics;
  flags: GeneratedSkillTelemetryFlags;
  riskLevel: "low" | "medium" | "high";
} | null;
export function refreshGeneratedSkillLifecycleState(
  db: DatabaseSync,
  skillName: string,
  policy: GeneratedSkillLifecyclePolicy = DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
  now = Math.floor(Date.now() / 1000),
  returnMetricsOrProcedureId: boolean | string = false,
  procedureId?: string,
):
  | ProcedureEntry
  | {
      proc: ProcedureEntry;
      metrics: GeneratedSkillTelemetryMetrics;
      flags: GeneratedSkillTelemetryFlags;
      riskLevel: "low" | "medium" | "high";
    }
  | null {
  const returnMetrics = returnMetricsOrProcedureId === true;
  const resolvedProcedureId = typeof returnMetricsOrProcedureId === "string" ? returnMetricsOrProcedureId : procedureId;
  const proc =
    resolvedProcedureId != null
      ? findProcedureById(db, resolvedProcedureId)
      : findGeneratedSkillProcedure(db, skillName);
  if (!proc?.skillPath) return null;
  const canonicalSkillName = skillPathBasename(proc.skillPath);
  const activations = skillTelemetryEntries(db, canonicalSkillName, proc.id);
  const { metrics, flags, riskLevel } = summarizeSkillTelemetry(proc, activations, policy, now);
  const currentState = proc.skillState ?? "experimental";
  const transition = desiredLifecycleTransition(currentState, flags, metrics, policy, riskLevel);
  const updatedProc =
    transition == null
      ? proc
      : (setGeneratedSkillLifecycleState(db, canonicalSkillName, transition.state, transition.reason, now, proc.id) ??
        proc);
  if (returnMetrics) {
    return { proc: updatedProc, metrics, flags, riskLevel };
  }
  return updatedProc;
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
  const policy = {
    ...DEFAULT_GENERATED_SKILL_LIFECYCLE_POLICY,
    ...(options?.policy ?? {}),
  };
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const recentLimit = options?.recentActivationLimit ?? 10;
  const procedures = listGeneratedSkillProcedures(db).filter((proc) => {
    if (!options?.skillName) return true;
    return proc.skillPath != null && skillPathBasename(proc.skillPath) === options.skillName;
  });
  const refreshResults = new Map<
    string,
    {
      proc: ProcedureEntry;
      metrics: GeneratedSkillTelemetryMetrics;
      flags: GeneratedSkillTelemetryFlags;
      riskLevel: "low" | "medium" | "high";
    }
  >();
  for (const proc of procedures) {
    if (proc.skillPath) {
      const skillName = skillPathBasename(proc.skillPath);
      const result = refreshGeneratedSkillLifecycleState(db, skillName, policy, now, true, proc.id);
      if (result) refreshResults.set(proc.id, result);
    }
  }
  const rows = listGeneratedSkillProcedures(db)
    .filter((proc) => {
      if (!options?.skillName) return true;
      return proc.skillPath != null && skillPathBasename(proc.skillPath) === options.skillName;
    })
    .map((proc) => {
      const skillName = skillPathBasename(proc.skillPath ?? proc.taskPattern);
      const cachedResult = refreshResults.get(proc.id);
      let procFresh: ProcedureEntry = proc;
      let metrics: GeneratedSkillTelemetryMetrics;
      let flags: GeneratedSkillTelemetryFlags;
      let riskLevel: "low" | "medium" | "high";
      if (cachedResult) {
        ({ proc: procFresh, metrics, flags, riskLevel } = cachedResult);
      } else {
        const activations = skillTelemetryEntries(db, skillName, proc.id);
        const summary = summarizeSkillTelemetry(proc, activations, policy, now);
        metrics = summary.metrics;
        flags = summary.flags;
        riskLevel = summary.riskLevel;
      }
      const currentState = procFresh.skillState ?? "experimental";
      const stateReason = procFresh.skillStateReason ?? null;
      const generatedAt = procFresh.skillGeneratedAt ?? procFresh.promotedAt ?? null;
      let recommendation: "promote" | "demote" | "archive" | "revise" | "unblock" | "observe";

      if (currentState === "uninstalled" || currentState === "rejected") {
        recommendation = "observe";
      } else if (currentState === "experimental" && stateReason?.startsWith("auto-unblocked")) {
        recommendation = "unblock";
      } else if (currentState === "archived" && flags.archiveCandidate) {
        recommendation = "observe";
      } else if (currentState === "demoted" && flags.overTriggering) {
        recommendation = "observe";
      } else if (flags.unblockCandidate && !flags.overTriggering) {
        recommendation = "unblock";
      } else if (flags.archiveCandidate) {
        recommendation = "archive";
      } else if (flags.overTriggering) {
        recommendation = "demote";
      } else if (flags.promotionCandidate) {
        recommendation = "promote";
      } else if (flags.revisionCandidate) {
        recommendation = "revise";
      } else {
        recommendation = "observe";
      }
      return {
        procedureId: procFresh.id,
        skillName,
        skillPath: procFresh.skillPath ?? skillName,
        skillVersion: procFresh.skillVersion ?? 1,
        riskLevel,
        state: currentState,
        stateReason,
        generatedAt,
        metrics,
        flags,
        recommendation,
        recentActivations: skillTelemetryRecentEntries(db, skillName, recentLimit, procFresh.id),
      } satisfies GeneratedSkillTelemetryReportRow;
    })
    .sort((a, b) => a.skillName.localeCompare(b.skillName));
  return {
    generatedAt: formatTimestampUtc(now),
    policy,
    totalSkills: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Disk reconciler (#1391) — detect DB rows whose skill file no longer exists
// ---------------------------------------------------------------------------

export type GeneratedSkillDoctorRow = {
  procedureId: string;
  skillName: string;
  skillPath: string;
  state: GeneratedSkillLifecycleState;
  issue: "missing_on_disk" | "stat_error";
  resolvedAbsolutePath: string;
  fixed: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type GeneratedSkillDoctorReport = {
  checkedAt: string;
  totalChecked: number;
  issues: GeneratedSkillDoctorRow[];
  fixedCount: number;
  failedFixCount: number;
  fixedProcedureIds: string[];
};

/**
 * Reconcile the DB's generated-skill records against disk.
 *
 * For each procedure row that is marked promoted (`promoted_to_skill = 1`) and has a
 * `skill_path`, this function requires the resolved `SKILL.md` file to exist on disk.
 * Rows whose SKILL.md is missing are reported as `"missing_on_disk"` and, when `fix` is
 * true, non-terminal rows are transitioned to the `"uninstalled"` state. Rejected rows
 * remain rejected because that terminal operator decision must not be overwritten by
 * disk reconciliation.
 *
 * @param workspaceRoot  Absolute path used to resolve relative skill paths. Defaults to canonical OpenClaw workspace resolution.
 * @param fix            When true, update missing rows to `uninstalled` in the DB.
 */
export function reconcileGeneratedSkillDiskState(
  db: DatabaseSync,
  opts: { workspaceRoot?: string; fix?: boolean; now?: number } = {},
): GeneratedSkillDoctorReport {
  const workspaceRoot = opts.workspaceRoot ?? resolveOpenClawWorkspaceRoot();
  const fix = opts.fix ?? false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const procedures = listGeneratedSkillProcedures(db);
  const issues: GeneratedSkillDoctorRow[] = [];
  const fixedProcedureIds: string[] = [];
  let totalChecked = 0;

  for (const proc of procedures) {
    if (!proc.skillPath) continue;
    // Skip terminal rows — they are already correctly modelled and must not be
    // overwritten by disk reconciliation.
    if (proc.skillState === "uninstalled" || proc.skillState === "rejected") continue;

    totalChecked++;

    // Accept either a SKILL.md file path or the parent directory, but always
    // require the actual SKILL.md file to exist. A bare directory is not an
    // installed generated skill.
    const { dirPath, skillMdPath } = resolveSkillMdPath(proc.skillPath, workspaceRoot);

    let statError: unknown;
    let missing = false;
    try {
      missing = !statSync(skillMdPath).isFile();
    } catch (err) {
      statError = err;
      missing = true;
    }
    if (!missing) continue;

    // Derive skill name from the directory component of the path (not the raw skill_path
    // which might include a SKILL.md suffix or be a full directory path).
    const skillName = skillPathBasename(dirPath);
    const errorCode =
      typeof statError === "object" && statError !== null && "code" in statError
        ? String((statError as { code?: unknown }).code)
        : undefined;
    const isMissingOnDisk = !statError || errorCode === "ENOENT";
    let fixed = false;
    if (fix && isMissingOnDisk) {
      // Use the full skill_path for the lookup so findGeneratedSkillProcedure
      // matches on exact path regardless of basename edge cases.
      const updated = setGeneratedSkillLifecycleState(
        db,
        proc.skillPath,
        "uninstalled",
        "operator-confirmed doctor --fix: skill file no longer exists on disk",
        now,
      );
      fixed = updated?.skillState === "uninstalled";
      if (fixed) fixedProcedureIds.push(proc.id);
    }
    issues.push({
      procedureId: proc.id,
      skillName,
      skillPath: proc.skillPath,
      state: proc.skillState ?? "experimental",
      issue: isMissingOnDisk ? "missing_on_disk" : "stat_error",
      resolvedAbsolutePath: skillMdPath,
      fixed,
      ...(errorCode ? { errorCode } : {}),
      ...(statError instanceof Error ? { errorMessage: statError.message } : {}),
    });
  }

  return {
    checkedAt: formatTimestampUtc(now),
    totalChecked,
    issues,
    fixedCount: fixedProcedureIds.length,
    failedFixCount: fix ? issues.filter((issue) => !issue.fixed).length : 0,
    fixedProcedureIds,
  };
}
