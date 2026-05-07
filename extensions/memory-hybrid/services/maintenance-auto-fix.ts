/**
 * Whitelisted safe auto-fix actions for maintenance log analyzer (Issue #1199).
 * Use `--auto-fix` for lock clear + retry-once. Add `--auto-fix-all` for vacuum-on-busy
 * (after repeated SQLITE_BUSY in the persistence window) and reembed-vectorless when
 * embedding-auth findings are present.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { vacuumAndCheckpoint } from "../backends/facts-db/housekeeping.js";
import type { FactsDB } from "../backends/facts-db.js";
import { spawnSync } from "../utils/process-runner.js";
import { countPersistedSqliteBusySince, type MaintenanceFinding } from "./maintenance-log-analyzer.js";

const LOCK_PATH_RE = /(\/[^\s"']+\.lock)/g;

export function clearStaleLock(lockPath: string): { ok: boolean; detail: string } {
  if (!existsSync(lockPath)) return { ok: true, detail: "no lock file" };
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(raw.split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      unlinkSync(lockPath);
      return { ok: true, detail: "removed malformed lock" };
    }
    try {
      process.kill(pid, 0);
      return { ok: false, detail: `live pid ${pid}` };
    } catch {
      unlinkSync(lockPath);
      return { ok: true, detail: `removed stale lock (pid ${pid} gone)` };
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Idempotent annotation for orchestrator retry — no shell. */
export function recordRetryOnce(finding: MaintenanceFinding): MaintenanceFinding {
  if (finding.actionTaken === "auto-fixed-retry-once") return finding;
  return {
    ...finding,
    actionTaken: "auto-fixed-retry-once",
    suggestedAction: `${finding.suggestedAction} [auto-fix: marked retry-once for next cron tick]`,
  };
}

/**
 * Apply a single safe auto-fix based on rule id and log content.
 */
export function applyMaintenanceAutoFix(finding: MaintenanceFinding): MaintenanceFinding {
  const id = finding.ruleId;

  if (id === "sqlite-busy" || id === "scan-lock-present") {
    const text = `${finding.logExcerpt}\n${finding.logPath}`;
    for (const m of text.matchAll(LOCK_PATH_RE)) {
      const p = m[1];
      if (!p) continue;
      const r = clearStaleLock(p);
      if (r.ok) {
        return {
          ...finding,
          actionTaken: "auto-fixed-clear-stale-lock",
          suggestedAction: `${finding.suggestedAction} Auto-fix: ${r.detail} (${p}).`,
        };
      }
      return {
        ...finding,
        actionTaken: "reported",
        suggestedAction: `${finding.suggestedAction} Auto-fix skipped: ${r.detail} (${p}).`,
      };
    }
    return finding;
  }

  if (id === "llm-rate-limit" || id === "gateway-network") {
    return recordRetryOnce(finding);
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
      const extra =
        opt.status === 0
          ? " Ran VACUUM+wcheckpoint + vectordb-optimize."
          : ` VACUUM ok; vectordb-optimize exit=${opt.status}${opt.stderr ? ` (${opt.stderr.slice(0, 200)})` : ""}.`;
      out = out.map((f) =>
        f.ruleId === "sqlite-busy"
          ? {
              ...f,
              actionTaken: "auto-fixed-vacuum-on-busy",
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
