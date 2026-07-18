import type { DatabaseSync } from "node:sqlite";
import type {
  ProcedureTriageDecision,
  ProcedureTriageDecisionInput,
  ProcedureTriageRecommendedAction,
} from "../../types/procedure-triage-types.js";
import { nowIso } from "../../utils/dates.js";

interface DecisionRow {
  cluster_id: string;
  decision: string;
  rationale: string | null;
  decided_by: string | null;
  decided_at: string;
}

function rowToDecision(row: DecisionRow): ProcedureTriageDecision {
  return {
    clusterId: row.cluster_id,
    decision: row.decision as ProcedureTriageRecommendedAction,
    rationale: row.rationale,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function recordProcedureTriageDecision(
  db: DatabaseSync,
  input: ProcedureTriageDecisionInput,
): ProcedureTriageDecision {
  const now = nowIso();
  db.prepare(
    `INSERT INTO loom_procedure_triage_decisions (cluster_id, decision, rationale, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cluster_id) DO UPDATE SET
       decision = excluded.decision, rationale = excluded.rationale, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  ).run(input.clusterId, input.decision, input.rationale ?? null, input.decidedBy ?? null, now);
  const row = db
    .prepare("SELECT * FROM loom_procedure_triage_decisions WHERE cluster_id = ?")
    .get(input.clusterId) as unknown as DecisionRow;
  return rowToDecision(row);
}

export function getProcedureTriageDecision(db: DatabaseSync, clusterId: string): ProcedureTriageDecision | null {
  const row = db
    .prepare("SELECT * FROM loom_procedure_triage_decisions WHERE cluster_id = ?")
    .get(clusterId) as unknown as DecisionRow | undefined;
  return row ? rowToDecision(row) : null;
}

export function listProcedureTriageDecisions(db: DatabaseSync): ProcedureTriageDecision[] {
  const rows = db
    .prepare("SELECT * FROM loom_procedure_triage_decisions ORDER BY decided_at DESC")
    .all() as unknown as DecisionRow[];
  return rows.map(rowToDecision);
}
