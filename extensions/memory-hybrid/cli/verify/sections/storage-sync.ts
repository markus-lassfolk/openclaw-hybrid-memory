/**
 * Unified SQLite ↔ LanceDB sync diagnostics and verify/doctor auto-repair.
 */

import {
  collectStorageSyncSnapshot,
  formatStorageSyncSummary,
  STORAGE_OPTIMIZE_REMEDIATION,
  STORAGE_REBUILD_ALIASES_REMEDIATION,
  STORAGE_REPAIR_REMEDIATION,
  type StorageSyncSnapshot,
} from "../../../services/storage-sync-diagnostics.js";
import { runStorageRepairPipeline, runStorageStructuralRepair } from "../../../services/storage-repair-pipeline.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import type { VerifyRunState } from "../verify-run-state.js";

/** True when the sync snapshot shows any drift a repair pass should address (#2049). */
export function storageSyncSnapshotHasDrift(snapshot: StorageSyncSnapshot): boolean {
  return (
    snapshot.hasIdSetDrift ||
    snapshot.hasEmbeddingDrift ||
    snapshot.hasStructuralDrift ||
    snapshot.duplicateIdExtraRows > 0
  );
}

export function logStorageSyncMetrics(state: VerifyRunState, snapshot: StorageSyncSnapshot): void {
  const { log, OK, FAIL, WARN_LINE } = state;
  log("\n───── Storage sync metrics ─────");
  log(`${OK} ${formatStorageSyncSummary(snapshot)}`);
  if (snapshot.hasIdSetDrift) {
    log(
      `${FAIL} ID-set drift: vectorOrphans=${snapshot.vectorOrphans.length} sqliteOrphans=${snapshot.sqliteOrphans.length}`,
    );
    // Previously this FAIL line never touched allOk/issues, so a snapshot with real orphan drift
    // still let verify exit 0 (#2049). Points at `--reconcile --fix` (not plain `--fix`) — orphan
    // deletion/rebuild stays gated behind the explicit --reconcile opt-in (see
    // applyStorageStructuralFixIfNeeded below).
    state.allOk = false;
    state.issues.push(
      `Storage sync ID-set drift: ${snapshot.vectorOrphans.length} vector orphan(s), ${snapshot.sqliteOrphans.length} sqlite orphan(s). Run \`openclaw hybrid-mem verify --reconcile --fix\` or \`${STORAGE_REPAIR_REMEDIATION}\`.`,
    );
  }
  // duplicateIdExtraRows > 0 is one of hasStructuralDrift's own trigger conditions (see
  // storage-sync-diagnostics.ts) — only report it as a separate issue when hasStructuralDrift's own
  // line below won't already cover it, so one root cause doesn't produce two overlapping bullets in
  // verify's Issues section.
  if (snapshot.duplicateIdExtraRows > 0) {
    log(`${WARN_LINE} Duplicate Lance IDs in listing: ${snapshot.duplicateIdExtraRows} extra row reference(s)`);
    if (!snapshot.hasStructuralDrift) {
      state.allOk = false;
      state.issues.push(
        `Storage sync: ${snapshot.duplicateIdExtraRows} duplicate Lance ID row reference(s). Run \`${STORAGE_OPTIMIZE_REMEDIATION}\` or \`${STORAGE_REPAIR_REMEDIATION}\`.`,
      );
    }
  }
  if (snapshot.hasEmbeddingDrift) {
    log(
      `${FAIL} Embedding drift: canonicalEmbeddings=${snapshot.canonicalEmbeddings} vs lanceRows=${snapshot.lanceRowCount}`,
    );
    state.allOk = false;
    state.issues.push(
      `Storage sync embedding drift: canonicalEmbeddings=${snapshot.canonicalEmbeddings} vs lanceRows=${snapshot.lanceRowCount}. Run \`${STORAGE_REPAIR_REMEDIATION}\`.`,
    );
  }
  if (snapshot.hasStructuralDrift) {
    log(
      `${WARN_LINE} Structural drift detected (row counts differ but ID orphan sets are empty). Try \`${STORAGE_OPTIMIZE_REMEDIATION}\` or \`${STORAGE_REPAIR_REMEDIATION}\`.`,
    );
    state.allOk = false;
    state.issues.push(
      `Storage structural drift (row counts differ). Run \`${STORAGE_OPTIMIZE_REMEDIATION}\` or \`${STORAGE_REPAIR_REMEDIATION}\`.`,
    );
  }
}

export async function runAliasStorageDiagnostics(state: VerifyRunState): Promise<void> {
  const { ctx, cfg, log, OK, FAIL, WARN_LINE, opts } = state;
  if (!cfg.aliases?.enabled || !ctx.aliasDb) return;

  log("\n───── Alias Lance index ─────");
  try {
    const diag = await ctx.aliasDb.getLanceDiagnostics();
    if (diag.schemaValid && diag.lanceDim === diag.configuredDim) {
      log(`${OK} Alias Lance schema valid (dim=${diag.configuredDim}, sqliteRows=${diag.sqliteAliasRows})`);
      return;
    }
    state.allOk = false;
    const lanceDimLabel = diag.lanceDim == null ? "unknown" : String(diag.lanceDim);
    log(
      `${FAIL} Alias Lance schema mismatch or invalid (configured dim=${diag.configuredDim}, lance dim=${lanceDimLabel}, sqliteRows=${diag.sqliteAliasRows})`,
    );
    log(`  → Run \`${STORAGE_REBUILD_ALIASES_REMEDIATION}\` (add \`--re-embed\` after embedding model change).`);
    state.issues.push(`Alias LanceDB schema mismatch (configured=${diag.configuredDim}, lance=${lanceDimLabel})`);
    if (opts.fix) {
      try {
        const result = await ctx.aliasDb.rebuildLanceFromSqlite(state.embeddings, {
          reEmbed: diag.lanceDim != null && diag.lanceDim !== diag.configuredDim,
        });
        log(
          `  → rebuild-aliases: stored=${result.stored} skipped=${result.skipped} reEmbedded=${result.reEmbedded}` +
            (result.errors.length > 0 ? ` errors=${result.errors.length}` : ""),
        );
        if (result.stored > 0) {
          state.fixes.push(`Rebuilt alias Lance index (${result.stored} row(s))`);
        }
        const after = await ctx.aliasDb.getLanceDiagnostics();
        if (after.schemaValid) {
          log(`${OK} Alias Lance schema valid after rebuild`);
        }
      } catch (err) {
        log(`${FAIL} Alias Lance rebuild failed: ${String(err)}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "cli",
          operation: "verify:rebuild-aliases",
        });
      }
    }
  } catch (err) {
    log(`${WARN_LINE} Could not inspect alias Lance index: ${String(err)}`);
  }
}

export async function applyStorageStructuralFixIfNeeded(
  state: VerifyRunState,
  snapshot: StorageSyncSnapshot,
): Promise<StorageSyncSnapshot> {
  // Gated on `hasStructuralDrift` alone, NOT the broader `storageSyncSnapshotHasDrift` (#2049 review
  // finding): the repair below reconciles/deletes orphan vectors and rebuilds sqlite-orphan vectors —
  // the same destructive/expensive operation `runVerifyReconcileSection` (reconcile.ts) deliberately
  // gates behind an explicit `--reconcile` flag, with its own conservative/balanced/aggressive budget
  // policy. Triggering that same repair from plain `--fix` alone (no `--reconcile`) would silently
  // bypass that opt-in gate. ID-set drift is still surfaced as a failing, actionable issue by
  // `logStorageSyncMetrics` above (pointing at `--reconcile --fix`); this function only auto-repairs
  // pure row-count/duplicate-listing drift with no orphans (hasStructuralDrift is defined as
  // `!hasIdSetDrift && (...)` in storage-sync-diagnostics.ts, so it never overlaps with real orphans).
  if (!state.opts.fix || !snapshot.hasStructuralDrift) {
    return snapshot;
  }

  const { log, OK, FAIL, fixes, reconcilePolicy, reconcileMaxFixes } = {
    ...state,
    reconcilePolicy: state.opts.reconcilePolicy ?? "balanced",
    reconcileMaxFixes: state.opts.reconcileMaxFixes ?? 200,
  };

  log(`\n───── Storage structural repair (--fix) ─────`);
  try {
    const { optimize, repair, errors } = await runStorageStructuralRepair({
      factsDb: state.factsDb,
      vectorDb: state.vectorDb,
      embeddings: state.embeddings,
      resolvedSqlitePath: state.resolvedSqlitePath,
      policy: reconcilePolicy,
      maxFixes: reconcileMaxFixes,
    });
    log(
      `  → optimize: compacted=${optimize.compacted} removedFragments=${optimize.removedFragments} freedBytes=${optimize.freedBytes}`,
    );
    if (repair) {
      log(
        `  → repair: vectorOrphansDeleted=${repair.reconcile.vectorOrphansDeleted} sqliteOrphansRebuilt=${repair.reconcile.sqliteOrphansRebuilt} reembedded=${repair.reembedded}`,
      );
    }
    if (errors.length > 0) {
      log(`${FAIL} Structural repair reported ${errors.length} error(s)`);
      for (const err of errors.slice(0, 5)) log(`  - ${err}`);
    } else {
      fixes.push("Ran storage optimize + repair for structural Lance/SQLite drift");
    }
  } catch (err) {
    log(`${FAIL} Structural repair failed: ${String(err)}`);
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "verify:structural-repair",
    });
  }

  const refreshed = await collectStorageSyncSnapshot(state.factsDb, state.vectorDb);
  if (refreshed) {
    log(`${OK} After repair: ${formatStorageSyncSummary(refreshed)}`);
    // A repair pass is budget-limited (reconcileMaxFixes / policy) and can legitimately leave drift
    // behind on a large backlog — report that honestly instead of a bare exit 0 that contradicts
    // `health` failing DB sync right after (#2049's core complaint).
    if (storageSyncSnapshotHasDrift(refreshed)) {
      state.allOk = false;
      state.issues.push(
        `Storage sync drift remains after \`verify --fix\` (vectorOrphans=${refreshed.vectorOrphans.length}, ` +
          `sqliteOrphans=${refreshed.sqliteOrphans.length}, duplicateIdExtraRows=${refreshed.duplicateIdExtraRows}). ` +
          `Re-run \`${STORAGE_REPAIR_REMEDIATION}\` directly with a higher --max-fixes, or an aggressive policy, to finish the repair.`,
      );
    } else {
      fixes.push("Storage sync drift fully resolved after repair");
    }
    return refreshed;
  }
  return snapshot;
}

export async function runVerifyStorageSyncSection(state: VerifyRunState): Promise<void> {
  if (!state.opts.fix && !state.opts.reconcile) return;
  if (!state.sqliteOk || !state.lanceOk || !state.vectorDb.isLanceDbAvailable()) return;

  try {
    let snapshot = await collectStorageSyncSnapshot(state.factsDb, state.vectorDb);
    if (!snapshot) return;
    logStorageSyncMetrics(state, snapshot);
    snapshot = await applyStorageStructuralFixIfNeeded(state, snapshot);
    await runAliasStorageDiagnostics(state);
  } catch (err) {
    state.log(`${state.FAIL} Storage sync diagnostics failed: ${String(err)}`);
    state.allOk = false;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "cli",
      operation: "verify:storage-sync",
    });
  }
}

export { runStorageRepairPipeline };
