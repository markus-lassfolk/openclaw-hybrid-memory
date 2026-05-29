/** Dream-cycle follow-up progress formatting and verbose stage runner. */

import type { ExtractImplicitFeedbackProgressSnapshot } from "../../cmd-feedback.js";
import type { VerificationCycleResult } from "../../../services/continuous-verifier.js";
import { runMaintenanceHeartbeat } from "./maintenance-heartbeat.js";

export type FollowUpProgressSupplier = () => string | undefined;

export interface RunVerboseFollowUpOptions {
  progressSupplier?: FollowUpProgressSupplier;
  heartbeatIntervalMs?: number;
  stageIndex?: number;
  stageTotal?: number;
}

export interface ContinuousVerificationAssessment {
  status: "healthy" | "degraded";
  shouldFailPipeline: boolean;
  summary?: string;
}

export function formatExtractImplicitFeedbackProgress(
  snapshot: ExtractImplicitFeedbackProgressSnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const parts: string[] = [`stage=${snapshot.stage}`];

  if (snapshot.stage === "scan-sessions") {
    parts.push(`sessions=${snapshot.sessionsVisited}/${snapshot.sessionsDiscovered}`);
    if (snapshot.sessionsProcessed !== snapshot.sessionsVisited) {
      parts.push(`processed=${snapshot.sessionsProcessed}`);
    }
    const skipped = snapshot.sessionsReadErrors + snapshot.sessionsTooShort;
    if (skipped > 0) parts.push(`skipped=${skipped}`);
    if (snapshot.currentSession) parts.push(`current=${snapshot.currentSession}`);
    parts.push(`signals=${snapshot.signalsExtracted} (${snapshot.positiveCount}+/${snapshot.negativeCount}-)`);
    if (snapshot.trajectoriesBuilt > 0) parts.push(`traj=${snapshot.trajectoriesBuilt}`);
  } else if (snapshot.stage === "cleanup-duplicates") {
    parts.push(`collapsed=${snapshot.cleanupCollapsed}`);
    if (snapshot.cleanupScanned > 0) parts.push(`scanned=${snapshot.cleanupScanned}`);
    if (snapshot.cleanupBatches > 0) parts.push(`batches=${snapshot.cleanupBatches}`);
  } else if (snapshot.stage === "closed-loop") {
    parts.push(`signals=${snapshot.signalsExtracted} (${snapshot.positiveCount}+/${snapshot.negativeCount}-)`);
    if (snapshot.trajectoriesBuilt > 0) parts.push(`traj=${snapshot.trajectoriesBuilt}`);
  }

  return parts.join("; ");
}

export function assessContinuousVerificationResult(result: VerificationCycleResult): ContinuousVerificationAssessment {
  if (result.errors > 0) {
    return {
      status: "degraded",
      shouldFailPipeline: true,
      summary: `${result.errors}/${result.checked} verification check(s) errored`,
    };
  }
  if (result.checked > 0 && result.confirmed === 0 && result.stale === 0) {
    return {
      status: "degraded",
      shouldFailPipeline: true,
      summary: `all ${result.checked} verification check(s) were uncertain`,
    };
  }
  return { status: "healthy", shouldFailPipeline: false };
}

export async function runVerboseFollowUp<T>(
  label: string,
  verbose: boolean,
  fn: () => Promise<T> | T,
  opts: RunVerboseFollowUpOptions = {},
): Promise<T> {
  const stagePrefix =
    opts.stageIndex && opts.stageTotal && opts.stageTotal > 0 ? `stage ${opts.stageIndex}/${opts.stageTotal} ` : "";
  const stageLabel = `${stagePrefix}${label}`.trim();
  return runMaintenanceHeartbeat(stageLabel, verbose, fn, {
    progressSupplier: opts.progressSupplier,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    jsonMode: false,
    logPrefix: "[dream-cycle]",
    progressSeparator: " — ",
  });
}
