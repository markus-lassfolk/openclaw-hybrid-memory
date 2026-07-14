/**
 * Serendipity Level-4 sweep (Issue #2119) — opt-in scheduled revisit of the
 * deferred backlog ("use idle time to work on things noticed before").
 *
 * Config-safe and idempotent: it prunes expired findings and builds a backlog
 * digest. It never edits code. When `sweep.dispatch` is off (the default) it
 * only reports. When on — and promotion deps are available — it promotes the
 * top in-bounds findings into goals or active tasks, which are then driven to
 * completion by their own guardrailed systems (goal stewardship / task ledger).
 * The agent still acts under normal approval; the sweep only hands off work.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SerendipityStore } from "../backends/serendipity-store.js";
import type { HybridMemoryConfig } from "../config.js";
import type { SerendipityScopeContext } from "../types/serendipity-types.js";
import { nowIso } from "../utils/dates.js";
import { getEnv } from "../utils/env-manager.js";
import { resolveGoalsDir } from "./goal-registry.js";
import { buildSerendipityDigestReport, type SerendipityDigestReport } from "./serendipity-digest.js";
import { promoteFinding, type SerendipityPromotionDeps } from "./serendipity-promotion.js";

/**
 * Fill in goalsDir/workspaceRoot (resolved from env + config) around the stores
 * a caller already has, so the CLI and cron step can share promotion wiring.
 */
export function resolveSweepPromotionDeps(
  cfg: HybridMemoryConfig,
  base: Pick<SerendipityPromotionDeps, "factsDb" | "vectorDb" | "embeddings" | "eventLog" | "api" | "logger">,
): Omit<SerendipityPromotionDeps, "store" | "cfg"> {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const goalsDir =
    cfg.goalStewardship?.enabled === true ? resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir) : undefined;
  return { ...base, goalsDir, workspaceRoot };
}

export interface SerendipitySweepDispatch {
  id: string;
  title: string;
  target: "goal" | "task";
  ok: boolean;
  refId?: string;
  message: string;
}

export interface SerendipitySweepSummary {
  runId: string;
  generatedAt: string;
  status: "ok" | "skipped";
  skipReason?: string;
  level: number;
  minLevel: number;
  dispatch: boolean;
  prunedExpired: number;
  actionable: number;
  /** Promotions attempted this run (empty unless dispatch is on and deps present). */
  dispatched: SerendipitySweepDispatch[];
  digest?: SerendipityDigestReport;
}

export interface RunSerendipitySweepOptions {
  cfg: HybridMemoryConfig;
  store: SerendipityStore | null;
  /** Scope used to resolve the effective engagement level (defaults to global). */
  scope?: SerendipityScopeContext;
  runId?: string;
  sinceDays?: number;
  /**
   * Promotion deps (goal/task creation). When absent, dispatch degrades to
   * reporting only — the sweep still prunes + reports but cannot hand off work.
   */
  promotion?: Omit<SerendipityPromotionDeps, "store" | "cfg">;
}

export async function runSerendipitySweep(opts: RunSerendipitySweepOptions): Promise<SerendipitySweepSummary> {
  const sp = opts.cfg.serendipityProtocol;
  const runId = opts.runId ?? `serendipity-sweep-${nowIso()}`;
  const base: SerendipitySweepSummary = {
    runId,
    generatedAt: nowIso(),
    status: "skipped",
    level: 0,
    minLevel: sp.sweep.minLevel,
    dispatch: sp.sweep.dispatch,
    prunedExpired: 0,
    actionable: 0,
    dispatched: [],
  };

  if (!sp.enabled) return { ...base, skipReason: "serendipity_disabled" };
  if (!opts.store) return { ...base, skipReason: "store_unavailable" };
  if (!sp.sweep.enabled) return { ...base, skipReason: "sweep_disabled" };

  const store = opts.store;
  const level = store.resolveLevel(opts.scope ?? {}, sp.defaultLevel);
  if (level < sp.sweep.minLevel) {
    return { ...base, level, skipReason: "below_min_level" };
  }

  // Idempotent: prune expired backlog, then report. Safe to run concurrently.
  const prunedExpired = store.archiveExpired();
  const sinceDays = opts.sinceDays ?? 30;
  const digest = buildSerendipityDigestReport({ store, sinceDays, level });

  const dispatched: SerendipitySweepDispatch[] = [];
  if (sp.sweep.dispatch && opts.promotion) {
    const target = sp.sweep.target;
    for (const entry of digest.backlog.top.slice(0, sp.sweep.maxDispatch)) {
      const finding = store.get(entry.id);
      if (!finding) continue;
      try {
        const result = await promoteFinding(finding, target, { store, cfg: opts.cfg, ...opts.promotion });
        dispatched.push({
          id: finding.id,
          title: finding.title,
          target,
          ok: result.ok,
          refId: result.refId,
          message: result.message,
        });
      } catch (err) {
        dispatched.push({ id: finding.id, title: finding.title, target, ok: false, message: String(err) });
      }
    }
  }

  return {
    ...base,
    status: "ok",
    level,
    prunedExpired,
    actionable: digest.backlog.actionable,
    dispatched,
    digest,
  };
}

/** One-line operator summary for logs / cron stdout. */
export function renderSerendipitySweepSummary(summary: SerendipitySweepSummary): string {
  if (summary.status === "skipped") {
    return `Serendipity sweep ${summary.runId}: skipped (${summary.skipReason ?? "unknown"}).`;
  }
  const ok = summary.dispatched.filter((d) => d.ok).length;
  const dispatched = summary.dispatch ? `, promoted ${ok}/${summary.dispatched.length}` : "";
  return `Serendipity sweep ${summary.runId}: level ${summary.level}, ${summary.actionable} actionable, pruned ${summary.prunedExpired} expired${dispatched}.`;
}
