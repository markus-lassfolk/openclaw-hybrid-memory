/**
 * CLI registration for `error-reports status|peek|flush` (issue #2082).
 *
 * The error reporter has a persistent on-disk pending queue, but before this there was no
 * dedicated CLI to inspect or drain it — `doctor`/`verify` only warn and point at an expensive
 * full run or a gateway restart. These commands read the queue directly off disk so they work
 * whether or not the reporter happens to be live in this CLI process.
 */

import {
  attemptOneShotErrorReportFlush,
  computeShutdownFlushTimeoutMs,
  countPendingErrorReportsOnDisk,
  flushErrorReporter,
  getPendingErrorReportCount,
  isErrorReporterActive,
  readPendingErrorReportEnqueueRange,
  readPendingErrorReportEntries,
  resolveErrorReportPendingQueuePath,
} from "../../../services/error-reporter.js";
import { versionInfo } from "../../../versionInfo.js";
import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

function resolveQueuePath(b: ManageBindings): string | undefined {
  const sqlitePath = b.cfg.sqlitePath;
  if (!sqlitePath) return undefined;
  return resolveErrorReportPendingQueuePath(sqlitePath);
}

export function registerManageErrorReports(mem: Chainable, b: ManageBindings): void {
  const errorReports = mem
    .command("error-reports")
    .description("Inspect and drain the error-reporter's persistent pending-telemetry queue (#2082).");

  errorReports
    .command("status")
    .description("Queue path, pending count, reporter activity, and oldest/newest enqueue times.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const queuePath = resolveQueuePath(b);
        const activeCount = getPendingErrorReportCount();
        const diskCount = countPendingErrorReportsOnDisk(queuePath);
        const pendingCount = Math.max(activeCount, diskCount);
        const range = readPendingErrorReportEnqueueRange(queuePath);
        const status = {
          queuePath: queuePath ?? null,
          pendingCount,
          reporterActiveInProcess: isErrorReporterActive(),
          reportingEnabled: b.cfg.errorReporting?.enabled !== false,
          consentGiven: b.cfg.errorReporting?.consent !== false,
          oldestEnqueuedAt: range ? new Date(range.oldest).toISOString() : null,
          newestEnqueuedAt: range ? new Date(range.newest).toISOString() : null,
        };
        if (opts?.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(`Queue path:        ${status.queuePath ?? "(none — in-memory database)"}`);
        console.log(`Pending count:     ${status.pendingCount}`);
        console.log(`Reporter active:   ${status.reporterActiveInProcess} (this CLI process)`);
        console.log(`Reporting enabled: ${status.reportingEnabled}`);
        console.log(`Consent given:     ${status.consentGiven}`);
        console.log(`Oldest pending:    ${status.oldestEnqueuedAt ?? "n/a"}`);
        console.log(`Newest pending:    ${status.newestEnqueuedAt ?? "n/a"}`);
        if (pendingCount > 0) {
          console.log("");
          console.log("Run `openclaw hybrid-mem error-reports peek` to inspect entries,");
          console.log("or `openclaw hybrid-mem error-reports flush` to attempt delivery now.");
        }
      }),
    );

  errorReports
    .command("peek")
    .description("Show metadata for the oldest N pending reports (default 5) without draining them.")
    .option("--limit <n>", "Number of entries to show", "5")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { limit?: string; json?: boolean }) => {
        const limit = Number.parseInt(opts?.limit ?? "5", 10);
        if (!Number.isFinite(limit) || limit < 0) {
          throw new Error(`Invalid --limit value: ${opts?.limit}`);
        }
        const queuePath = resolveQueuePath(b);
        const entries = readPendingErrorReportEntries(queuePath, limit);
        if (opts?.json) {
          console.log(JSON.stringify({ queuePath: queuePath ?? null, entries }, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log("No pending reports on disk.");
          return;
        }
        for (const entry of entries) {
          console.log(`${new Date(entry.enqueuedAt).toISOString()}  ${entry.type}: ${entry.message}`.trim());
          if (entry.subsystem || entry.operation) {
            console.log(`  subsystem=${entry.subsystem ?? "-"} operation=${entry.operation ?? "-"} id=${entry.id}`);
          }
        }
      }),
    );

  errorReports
    .command("flush")
    .description("Attempt a bounded delivery of pending reports; reports whether the pending count changed.")
    .option("--timeout <ms>", "Flush timeout in milliseconds")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { timeout?: string; json?: boolean }) => {
        const queuePath = resolveQueuePath(b);
        const pendingBefore = Math.max(getPendingErrorReportCount(), countPendingErrorReportsOnDisk(queuePath));
        const timeoutMs = opts?.timeout
          ? Number.parseInt(opts.timeout, 10)
          : computeShutdownFlushTimeoutMs(pendingBefore);
        if (opts?.timeout && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new Error(`Invalid --timeout value: ${opts.timeout}`);
        }

        let result: {
          attempted: boolean;
          reason?: string;
          pendingBefore: number;
          pendingAfter: number;
          flushed: boolean;
        };
        if (isErrorReporterActive()) {
          // Reuse the already-live singleton reporter rather than racing a second one against
          // the same on-disk queue file.
          const flushed = await flushErrorReporter(timeoutMs);
          result = {
            attempted: true,
            pendingBefore,
            pendingAfter: getPendingErrorReportCount(),
            flushed,
          };
        } else {
          result = await attemptOneShotErrorReportFlush(
            {
              enabled: b.cfg.errorReporting?.enabled ?? true,
              dsn: b.cfg.errorReporting?.dsn,
              mode: b.cfg.errorReporting?.mode ?? "community",
              consent: b.cfg.errorReporting?.consent ?? true,
              environment: b.cfg.errorReporting?.environment,
              sampleRate: b.cfg.errorReporting?.sampleRate ?? 1.0,
              resolvedIssues: b.cfg.errorReporting?.resolvedIssues,
            },
            queuePath,
            versionInfo.pluginVersion,
            timeoutMs,
          );
        }

        if (opts?.json) {
          console.log(JSON.stringify(result, null, 2));
          if (!result.attempted) process.exitCode = 1;
          return;
        }

        if (!result.attempted) {
          console.log(`No flush attempted: ${result.reason}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Pending before: ${result.pendingBefore}`);
        console.log(`Pending after:  ${result.pendingAfter}`);
        console.log(`Flush ${result.flushed ? "succeeded" : "did not fully complete"} within ${timeoutMs}ms.`);
        if (result.pendingAfter < result.pendingBefore) {
          console.log(`Delivered ${result.pendingBefore - result.pendingAfter} report(s).`);
        } else if (result.pendingAfter > 0) {
          console.log("No reports delivered — check network connectivity to the configured DSN.");
        }
      }),
    );
}
