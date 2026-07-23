/**
 * Dream auto-rollback (#2170) — apply reverse plans with post_hash drift checks.
 */

import type { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { hashFactContent, type RollbackResult } from "./dream-candidate-ops.js";

export type RollbackDreamRunOptions = {
  reason?: string;
  /** Skip observation-window / status checks (CLI escape hatch). */
  force?: boolean;
};

/**
 * Roll back a promoted dream run using each entry's reverse plan.
 * Aborts individual entries whose live post_hash drifted since promote.
 */
export function rollbackDreamRun(
  factsDb: FactsDB,
  store: DreamCandidateStore,
  dreamRunId: string,
  options: RollbackDreamRunOptions = {},
): RollbackResult {
  const run = store.getDreamRun(dreamRunId);
  if (!run) {
    return {
      rolledBack: false,
      status: "failed",
      restoredFactIds: [],
      abortedEntries: [],
      error: `dream run not found: ${dreamRunId}`,
    };
  }

  if (run.status === "rolled_back") {
    return {
      rolledBack: true,
      status: "rolled_back",
      restoredFactIds: [],
      abortedEntries: [],
    };
  }

  if (run.status !== "promoted" && !options.force) {
    return {
      rolledBack: false,
      status: run.status,
      restoredFactIds: [],
      abortedEntries: [],
      error: `cannot rollback dream run in status ${run.status}`,
    };
  }

  const applied = store
    .listCandidateEntries(dreamRunId)
    .filter((e) => e.status === "applied")
    .sort((a, b) => b.sortOrder - a.sortOrder);

  const restoredFactIds: string[] = [];
  const abortedEntries: Array<{ entryId: string; reason: string }> = [];

  try {
    const tx = createTransaction(
      factsDb.getRawDb(),
      () => {
        for (const entry of applied) {
          // Drift check: if we recorded postHash, live content must still match.
          if (entry.postHash && entry.appliedFactId) {
            const live = factsDb.getById(entry.appliedFactId);
            if (live) {
              const liveHash = hashFactContent(live);
              if (liveHash !== entry.postHash) {
                abortedEntries.push({
                  entryId: entry.id,
                  reason: "post_hash_drift",
                });
                continue;
              }
            }
          }

          const reverse = entry.reverse;
          switch (reverse.op) {
            case "delete_fact": {
              const factId =
                (typeof reverse.payload.factId === "string" ? reverse.payload.factId : null) ?? entry.appliedFactId;
              if (factId) {
                factsDb.delete(factId);
                restoredFactIds.push(factId);
              }
              break;
            }
            case "unsupersede": {
              const oldId =
                (typeof reverse.payload.oldFactId === "string" ? reverse.payload.oldFactId : null) ??
                entry.targetFactId;
              // For a `delete` op the applied fact IS the target fact — falling back to
              // entry.appliedFactId when `newFactId` is explicitly null (delete/contradiction
              // reverse plans) used to delete the just-restored old fact, defeating the
              // rollback. Only delete `newId` when the reverse plan supplies an explicit
              // string id AND that id differs from the restored oldId.
              const payloadNewFactIdKey = "newFactId" in reverse.payload;
              const payloadNewFactId = (reverse.payload as { newFactId?: unknown }).newFactId;
              let newId: string | null = null;
              if (typeof payloadNewFactId === "string" && payloadNewFactId.length > 0) {
                newId = payloadNewFactId;
              } else if (!payloadNewFactIdKey) {
                // Legacy reverse plans that omit newFactId entirely fall back to entry.appliedFactId,
                // but only if it isn't the same fact we just restored (never delete the restored fact).
                if (entry.appliedFactId && entry.appliedFactId !== oldId) {
                  newId = entry.appliedFactId;
                }
              }
              if (oldId) {
                factsDb
                  .getRawDb()
                  .prepare(
                    "UPDATE facts SET superseded_at = NULL, superseded_by = NULL, valid_until = NULL WHERE id = ?",
                  )
                  .run(oldId);
                factsDb.invalidateSupersededTextsCache();
                restoredFactIds.push(oldId);
              }
              if (newId && newId !== oldId) {
                factsDb.delete(newId);
              }
              break;
            }
            case "restore_text": {
              const factId =
                (typeof reverse.payload.factId === "string" ? reverse.payload.factId : null) ?? entry.targetFactId;
              const text = typeof reverse.payload.text === "string" ? reverse.payload.text : null;
              if (factId && text != null) {
                factsDb.getRawDb().prepare("UPDATE facts SET text = ? WHERE id = ?").run(text, factId);
                restoredFactIds.push(factId);
              }
              break;
            }
            case "noop":
              break;
            default:
              abortedEntries.push({ entryId: entry.id, reason: `unknown_reverse_op:${reverse.op}` });
              continue;
          }
          store.updateCandidateEntry(entry.id, { status: "rolled_back" });
        }
      },
      "IMMEDIATE",
    );
    tx();
  } catch (err) {
    return {
      rolledBack: false,
      status: run.status,
      restoredFactIds,
      abortedEntries,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const reason = options.reason ?? "manual_rollback";
  const fullyClean = abortedEntries.length === 0;
  // Only mark rolled_back when every applied entry reversed cleanly (#2173 correctness).
  const markRolledBack = fullyClean && (run.status === "promoted" || options.force === true);

  if (markRolledBack) {
    try {
      store.updateDreamRunStatus(dreamRunId, "rolled_back", { rollbackReason: reason });
    } catch {
      // Already rolled_back or illegal — ignore when force path partially applied.
    }
  }

  return {
    rolledBack: markRolledBack,
    status: markRolledBack ? "rolled_back" : run.status,
    restoredFactIds,
    abortedEntries,
    error: fullyClean ? undefined : abortedEntries.map((a) => a.reason).join(";"),
  };
}
