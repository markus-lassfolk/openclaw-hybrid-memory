/**
 * Loom nightly maintenance (Epic #2150): the two upkeep tasks that keep the Loom
 * honest over time — degrade beliefs that have gone stale, and re-scan facts for
 * drift (deprecated commands + unresolved contradictions). Report-only for drift
 * by default; nothing here mutates fact text unless `applySafeDrift` is set.
 *
 * Runs both nightly (via the `loom-maintenance` orchestrator step) and on demand
 * (via `hybrid-mem loom maintenance`), so this is the single shared implementation.
 */
import type { FactsDB } from "../backends/facts-db.js";
import type { LoomStore } from "../backends/loom-store.js";
import { runDriftScout } from "./drift-scout.js";

export interface LoomMaintenanceDeps {
  factsDb: FactsDB;
  loomStore: LoomStore | null;
}

export interface LoomMaintenanceOptions {
  /** Belief staleness window (days); claims older than this degrade to `stale`. */
  staleAfterDays: number;
  /** Deprecated → replacement command pairs the drift scan looks for. */
  deprecatedCommands?: Record<string, string>;
  /** Apply mechanical `auto_safe` drift fixes (default false — nightly stays report-only). */
  applySafeDrift?: boolean;
}

export interface LoomMaintenanceResult {
  /** False when the Loom store is absent (feature disabled) — nothing was done. */
  ran: boolean;
  /** Claims degraded to `stale` by the sweep. */
  staleDegraded: number;
  /** New drift findings recorded this run. */
  driftNew: number;
  /** Drift findings that already existed (deduped). */
  driftExisting: number;
  /** Drift findings mechanically auto-fixed (only when applySafeDrift is set). */
  driftApplied: number;
}

/** Run the belief stale-claim sweep and a drift scan. Safe to call when the Loom is disabled (returns ran:false). */
export function runLoomMaintenance(deps: LoomMaintenanceDeps, opts: LoomMaintenanceOptions): LoomMaintenanceResult {
  const empty: LoomMaintenanceResult = { ran: false, staleDegraded: 0, driftNew: 0, driftExisting: 0, driftApplied: 0 };
  const { loomStore } = deps;
  if (!loomStore) return empty;

  const staleDegraded = loomStore.sweepStaleClaims(opts.staleAfterDays);
  const report = runDriftScout(
    { factsDb: deps.factsDb, loomStore },
    {
      include: ["facts"],
      applySafe: opts.applySafeDrift ?? false,
      deprecatedCommands: opts.deprecatedCommands ?? {},
    },
  );

  return {
    ran: true,
    staleDegraded,
    driftNew: report.newCount,
    driftExisting: report.existingCount,
    driftApplied: report.appliedSafeCount,
  };
}
