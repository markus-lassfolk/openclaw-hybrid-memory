export type AuditHealthExitReason =
  | "ok"
  | "warnings"
  | "errors"
  | "strict_warnings"
  | "strict_errors"
  | "strict_failed";

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
