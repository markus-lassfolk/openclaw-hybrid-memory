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

export function logStorageSyncMetrics(state: VerifyRunState, snapshot: StorageSyncSnapshot): void {
  const { log, OK, FAIL, WARN_LINE } = state;
  log("\n───── Storage sync metrics ─────");
  log(`${OK} ${formatStorageSyncSummary(snapshot)}`);
  if (snapshot.hasIdSetDrift) {
    log(`${FAIL} ID-set drift: vectorOrphans=${snapshot.vectorOrphans.length} sqliteOrphans=${snapshot.sqliteOrphans.length}`);
  }
  if (snapshot.duplicateIdExtraRows > 0) {
    log(`${WARN_LINE} Duplicate Lance IDs in listing: ${snapshot.duplicateIdExtraRows} extra row reference(s)`);
  }
  if (snapshot.hasEmbeddingDrift) {
    log(
      `${FAIL} Embedding drift: canonicalEmbeddings=${snapshot.canonicalEmbeddings} vs lanceRows=${snapshot.lanceRowCount}`,
    );
  }
  if (snapshot.hasStructuralDrift) {
    log(
      `${WARN_LINE} Structural drift detected (row counts differ but ID orphan sets are empty). Try \`${STORAGE_OPTIMIZE_REMEDIATION}\` or \`${STORAGE_REPAIR_REMEDIATION}\`.`,
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
    log(
      `  → Run \`${STORAGE_REBUILD_ALIASES_REMEDIATION}\` (add \`--re-embed\` after embedding model change).`,
    );
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
