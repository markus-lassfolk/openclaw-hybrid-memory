/**
 * Whitelisted safe auto-fix actions for maintenance log analyzer (Issue #1199).
 * Use `--auto-fix` for lock clear + retry-once. Add `--auto-fix-all` for vacuum-on-busy
 * (after repeated SQLITE_BUSY in the persistence window) and reembed-vectorless when
 * embedding-auth findings are present.
 */

import { existsSync, unlinkSync } from "node:fs";
import { hostname as osHostname } from "node:os";

import { vacuumAndCheckpoint } from "../backends/facts-db/housekeeping.js";
import type { FactsDB } from "../backends/facts-db.js";
import { spawnSync } from "../utils/process-runner.js";
import { markStepRetryOnce, readLockInfoAtPath } from "./cron-guard.js";
import {
  countPersistedSqliteBusySince,
  type MaintenanceFinding,
  maintenanceRules,
} from "./maintenance-log-analyzer.js";
import { isPidAlive } from "./task-queue-watchdog.js";

/**
 * Whether a rule declares `defaultAction: "retry-once"` in maintenance-rules.json. Dispatch reads
 * this instead of a hardcoded rule-id list, so a rule newly marked retry-once there automatically
 * gets the #2094 bounded-retry treatment without a matching hand-edit here.
 */
function isRetryOnceRule(ruleId: string): boolean {
  return maintenanceRules().some((rule) => rule.id === ruleId && rule.defaultAction === "retry-once");
}

const LOCK_PATH_RE = /(\/[^\s"']+\.lock)/g;

/** `cleared: true` only when a lock file was actually removed — distinct from "there was nothing
 * to clear," so a caller reporting an auto-fix outcome doesn't claim success for a no-op. */
export function clearStaleLock(lockPath: string): { ok: boolean; cleared: boolean; detail: string } {
  if (!existsSync(lockPath)) return { ok: true, cleared: false, detail: "no lock file" };
  // readLockInfoAtPath shares cron-guard.ts's own lock-file parser (JSON payload, with a legacy
  // bare-epoch-ms fallback) — this file previously reimplemented an incompatible whitespace-split
  // parser that treated every real (JSON) lock as unparseable and force-deleted it as "malformed"
  // without ever checking the recorded owner's liveness.
  const info = readLockInfoAtPath(lockPath);
  if (!info) {
    try {
      unlinkSync(lockPath);
      return { ok: true, cleared: true, detail: "removed malformed lock" };
    } catch (e) {
      return { ok: false, cleared: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  // isPidAlive distinguishes ESRCH (no such process) from EPERM (process exists but we lack
  // permission to signal it) — a bare catch-all here would treat a live-but-unsignalable owner
  // as "gone" and delete its lock out from under it. A recorded owner on a different host (or a
  // legacy lock with no pid at all) can't be liveness-checked from here, so it's treated as
  // reclaimable — matching acquireStepLock's own reclaim semantics in cron-guard.ts.
  if (info.pid !== undefined && info.hostname === osHostname() && isPidAlive(info.pid)) {
    return { ok: false, cleared: false, detail: `live pid ${info.pid}` };
  }
  try {
    unlinkSync(lockPath);
    return {
      ok: true,
      cleared: true,
      detail: info.pid !== undefined ? `removed stale lock (pid ${info.pid} gone)` : "removed stale lock",
    };
  } catch (e) {
    return { ok: false, cleared: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Idempotent annotation for orchestrator retry — no shell. Persists a per-step retry-once marker
 * (#2094) that runMaintenanceOrchestrator's guard check consumes to force one run of this step
 * outside its normal cadence window, so a transient-llm/transient-network failure actually gets
 * retried instead of the annotation being purely cosmetic.
 */
export function recordRetryOnce(finding: MaintenanceFinding, openclawDir?: string): MaintenanceFinding {
  if (finding.actionTaken === "auto-fixed-retry-once") return finding;
  try {
    markStepRetryOnce(finding.step, openclawDir);
  } catch (err) {
    // Report honestly instead of claiming "auto-fixed-retry-once" — a swallowed write failure
    // here previously left the digest showing the transient failure as remediated even though no
    // marker file exists, so the orchestrator's hasStepRetryOncePending() check never sees it and
    // the step never gets its forced retry (defeats #2094's bounded-retry guarantee silently).
    return {
      ...finding,
      actionTaken: "reported",
      suggestedAction: `${finding.suggestedAction} [auto-fix failed: could not write retry-once marker: ${err instanceof Error ? err.message : String(err)}]`,
    };
  }
  return {
    ...finding,
    actionTaken: "auto-fixed-retry-once",
    suggestedAction: `${finding.suggestedAction} [auto-fix: marked retry-once for next maintenance run]`,
  };
}

/**
 * Apply a single safe auto-fix based on rule id and log content.
 */
export function applyMaintenanceAutoFix(finding: MaintenanceFinding, openclawDir?: string): MaintenanceFinding {
  const id = finding.ruleId;

  if (id === "sqlite-busy" || id === "scan-lock-present") {
    const text = `${finding.logExcerpt}\n${finding.logPath}`;
    // Try every extracted lock path, not just the first — a log excerpt can legitimately mention
    // more than one .lock-suffixed path (e.g. an unrelated path in a stack trace ahead of the
    // real stale lock), and giving up after the first non-clearable match could skip a later,
    // genuinely stale and clearable lock in the same text.
    let lastOutcome: { path: string; detail: string } | undefined;
    for (const m of text.matchAll(LOCK_PATH_RE)) {
      const p = m[1];
      if (!p) continue;
      const r = clearStaleLock(p);
      if (r.cleared) {
        return {
          ...finding,
          actionTaken: "auto-fixed-clear-stale-lock",
          suggestedAction: `${finding.suggestedAction} Auto-fix: ${r.detail} (${p}).`,
        };
      }
      lastOutcome = { path: p, detail: r.detail };
    }
    if (lastOutcome) {
      return {
        ...finding,
        actionTaken: "reported",
        suggestedAction: `${finding.suggestedAction} Auto-fix skipped: ${lastOutcome.detail} (${lastOutcome.path}).`,
      };
    }
    // No lock path was even mentioned in the log excerpt, so there was nothing to clear — but
    // sqlite-busy/scan-lock-present are still declared defaultAction "retry-once" in
    // maintenance-rules.json. Without this fallback that declared retry-once was a silent no-op
    // whenever the finding didn't happen to include a .lock-suffixed path.
    if (isRetryOnceRule(id)) {
      return recordRetryOnce(finding, openclawDir);
    }
    return finding;
  }

  if (isRetryOnceRule(id)) {
    return recordRetryOnce(finding, openclawDir);
  }

  return finding;
}

export type HeavyMaintenanceAutoFixOptions = {
  findings: MaintenanceFinding[];
  findingsDbPath: string;
  factsDb: FactsDB;
  /** Seconds to look back for repeated SQLITE_BUSY in maintenance_finding. Default: 86400. */
  sqliteBusyWindowSec?: number;
  /**
   * Invokes the OpenClaw CLI (e.g. `openclaw hybrid-mem …`). First element of args must be `hybrid-mem`.
   * Override in tests.
   */
  spawnOpenclaw?: (args: string[]) => { status: number | null; stderr?: string };
};

function defaultSpawnOpenclaw(args: string[]): { status: number | null; stderr?: string } {
  const bin = process.env.OPENCLAW_BIN?.trim() || "openclaw";
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  return { status: r.status, stderr: r.stderr ? String(r.stderr) : undefined };
}

/**
 * Heavy / shell-touching fixes enabled only with `--auto-fix-all` (#1199).
 * Call after {@link applyMaintenanceAutoFix} on each row.
 */
export function applyHeavyMaintenanceAutoFixes(opts: HeavyMaintenanceAutoFixOptions): MaintenanceFinding[] {
  const spawn = opts.spawnOpenclaw ?? defaultSpawnOpenclaw;
  let out = opts.findings;
  const windowSec = opts.sqliteBusyWindowSec ?? 86400;
  const sinceSec = Math.floor(Date.now() / 1000) - windowSec;

  const historical = countPersistedSqliteBusySince(opts.findingsDbPath, sinceSec);
  const busyThisBatch = opts.findings.filter((f) => f.ruleId === "sqlite-busy").length;

  if (busyThisBatch > 0 && historical + busyThisBatch >= 2) {
    let vacuumOk = false;
    try {
      vacuumAndCheckpoint(opts.factsDb.getRawDb());
      vacuumOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out = out.map((f) =>
        f.ruleId === "sqlite-busy"
          ? {
              ...f,
              suggestedAction: `${f.suggestedAction} [auto-fix-all: VACUUM failed — ${msg}]`,
            }
          : f,
      );
    }
    if (vacuumOk) {
      const opt = spawn(["hybrid-mem", "vectordb-optimize"]);
      const optOk = opt.status === 0;
      const extra = optOk
        ? " Ran VACUUM+wcheckpoint + vectordb-optimize."
        : ` VACUUM ok; vectordb-optimize exit=${opt.status}${opt.stderr ? ` (${opt.stderr.slice(0, 200)})` : ""}.`;
      out = out.map((f) =>
        f.ruleId === "sqlite-busy"
          ? {
              ...f,
              // Only claim the fix succeeded when both the VACUUM AND the follow-up
              // vectordb-optimize actually completed — a spawn failure here left the digest
              // reporting "auto-fixed-vacuum-on-busy" for a finding that was only half-remediated.
              actionTaken: optOk ? "auto-fixed-vacuum-on-busy" : f.actionTaken,
              suggestedAction: `${f.suggestedAction} [auto-fix-all:${extra}]`,
            }
          : f,
      );
    }
  }

  if (opts.findings.some((f) => f.ruleId === "embedding-auth")) {
    const r = spawn(["hybrid-mem", "reembed-vectorless", "--limit", "200", "--apply"]);
    const ok = r.status === 0;
    out = out.map((f) =>
      f.ruleId === "embedding-auth"
        ? {
            ...f,
            actionTaken: ok ? "auto-fixed-reembed-vectorless" : f.actionTaken,
            suggestedAction: `${f.suggestedAction} [auto-fix-all: reembed-vectorless --limit 200 exit=${r.status}${ok ? "" : ` ${r.stderr?.slice(0, 200) ?? ""}`}]`,
          }
        : f,
    );
  }

  return out;
}
