export type AuditHealthExitReason =
  | "ok"
  | "warnings"
  | "errors"
  | "strict_warnings"
  | "strict_errors"
  | "strict_failed";

/**
 * Minimal schema-consistent failure artifact emitted when the audit-health run cannot produce
 * a full report (e.g. uncaught exception during report building). Always contains enough fields
 * for downstream `jq` consumers to detect failure without special-casing a 0-byte file (#1823).
 */
export type AuditHealthFailureArtifact = {
  schemaVersion: 1;
  generatedAt: string;
  ok: false;
  status: "failed";
  exitCode: 2;
  exitReason: AuditHealthExitReason;
  strictFailureReason: string;
  errorCount: number;
  warningCount: number;
  errors: Array<{ section: string; message: string }>;
  warnings: string[];
  elapsedMs?: number;
};

export type AuditHealthExitInfo = {
  exitCode: 0 | 2;
  exitReason: AuditHealthExitReason;
  warningCount: number;
  errorCount: number;
  strictFailureReason?: string;
};

export function buildAuditHealthExitInfo(input: {
  strict: boolean;
  warningCount: number;
  errorCount: number;
  ok?: boolean;
  status?: string;
}): AuditHealthExitInfo {
  const warningCount = Math.max(0, input.warningCount || 0);
  const errorCount = Math.max(0, input.errorCount || 0);
  const strict = input.strict === true;

  const looksDegraded = input.ok === false || (input.status != null && input.status !== "ok");
  const strictFailed = strict && (warningCount > 0 || errorCount > 0 || looksDegraded);

  if (strictFailed) {
    const strictFailureReason = (() => {
      if (errorCount > 0 && warningCount > 0) {
        return `${errorCount} error(s) and ${warningCount} warning(s) present and --strict was set`;
      }
      if (errorCount > 0) return `${errorCount} error(s) present and --strict was set`;
      if (warningCount > 0) return `${warningCount} warning(s) present and --strict was set`;
      return "--strict was set and the report was not ok";
    })();
    return {
      exitCode: 2,
      exitReason: errorCount > 0 ? "strict_errors" : warningCount > 0 ? "strict_warnings" : "strict_failed",
      warningCount,
      errorCount,
      strictFailureReason,
    };
  }

  return {
    exitCode: 0,
    exitReason: errorCount > 0 ? "errors" : warningCount > 0 ? "warnings" : "ok",
    warningCount,
    errorCount,
  };
}

/**
 * Build a schema-consistent failure artifact for the case where the audit-health run fails
 * before producing a full report (uncaught exception, fatal DB error, etc.).
 *
 * The artifact is intentionally minimal but parseable by the same `jq` pipelines that consume
 * a successful `--json` run. Downstream QA/cron consumers should never receive a 0-byte file
 * (#1823).
 */
export function buildAuditFailureArtifact(err: unknown, elapsedMs?: number): AuditHealthFailureArtifact {
  const message = err instanceof Error ? err.message : String(err);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    status: "failed",
    exitCode: 2,
    exitReason: "strict_failed",
    strictFailureReason: message,
    errorCount: 1,
    warningCount: 0,
    errors: [{ section: "audit-health", message }],
    warnings: [],
    ...(elapsedMs != null ? { elapsedMs } : {}),
  };
}
