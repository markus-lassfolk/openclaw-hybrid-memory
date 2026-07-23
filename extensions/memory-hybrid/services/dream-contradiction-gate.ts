/**
 * Live contradiction-worsening gate for Dream promote (#2170).
 *
 * Uses FactsDB heuristics (no NLI write path). Fail closed on DB errors.
 */

import type { FactsDB } from "../backends/facts-db.js";
import {
  isFactVerified,
  scoreFactContradiction,
} from "../backends/facts-db/contradictions.js";
import { DREAM_CONTRADICTION_WORSEN_SCORE } from "../config/types/dreaming.js";
import type { CandidateEntryRecord } from "./dream-candidate-ops.js";

export type ContradictionWorsenResult = {
  worsens: boolean;
  reason: string;
};

/**
 * True when applying `entry` would worsen high-severity contradictions vs live FactsDB.
 */
export function evaluateContradictionWorsening(
  factsDb: FactsDB,
  entry: CandidateEntryRecord,
  scoreThreshold: number = DREAM_CONTRADICTION_WORSEN_SCORE,
): ContradictionWorsenResult {
  if (entry.payload.contradictionWorsens === true) {
    return { worsens: true, reason: "contradiction_worsens_flag" };
  }

  try {
    const db = factsDb.getRawDb();

    if (entry.op === "delete" || entry.op === "supersede") {
      const targetId = entry.targetFactId?.trim();
      if (!targetId) {
        return { worsens: false, reason: "no_target" };
      }
      if (isFactVerified(db, targetId)) {
        return { worsens: true, reason: "deletes_verified_fact" };
      }
      if (factsDb.isContradicted(targetId)) {
        return { worsens: true, reason: "deletes_unresolved_contradiction_side" };
      }
      return { worsens: false, reason: "ok" };
    }

    const entity = entry.payload.entity?.trim();
    const key = entry.payload.key?.trim();
    const value = entry.payload.value;
    if (!entity || !key || value == null || String(value).trim() === "") {
      // Unstructured candidates: prevalence/provenance still apply; no entity/key conflict scan.
      return { worsens: false, reason: "no_entity_key" };
    }

    const scope = entry.payload.scope ?? null;
    const scopeTarget = entry.payload.scopeTarget ?? null;
    const excludeId = entry.payload.id?.trim() || "";
    const conflicts = factsDb.findConflictingFacts(
      entity,
      key,
      String(value),
      excludeId,
      scope,
      scopeTarget,
    );

    for (const old of conflicts) {
      if (isFactVerified(db, old.id)) {
        return { worsens: true, reason: `conflicts_verified_${old.id.slice(0, 8)}` };
      }
      const scored = scoreFactContradiction(
        entry.payload.text ?? "",
        String(value),
        old.text ?? "",
        old.value ?? "",
      );
      if (scored.score >= scoreThreshold) {
        return {
          worsens: true,
          reason: `heuristic_score_${scored.score.toFixed(2)}_vs_${old.id.slice(0, 8)}`,
        };
      }
    }

    return { worsens: false, reason: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { worsens: true, reason: `contradiction_gate_error:${message.slice(0, 80)}` };
  }
}
