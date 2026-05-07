/**
 * Whitelisted safe auto-fix actions for maintenance log analyzer (Issue #1199).
 * Unsafe actions (vacuum-on-busy, reembed, purge) stay report-only — see README.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import type { MaintenanceFinding } from "./maintenance-log-analyzer.js";

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
