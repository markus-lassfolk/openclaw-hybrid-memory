/**
 * CLI registration — split from register-corrections-and-pipeline.ts (merge-conflict remediation).
 */

import { capturePluginError } from "../../../services/error-reporter.js";
import { type ExtractImplicitFeedbackProgressSnapshot } from "../../cmd-feedback.js";
function formatFollowUpError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export type FollowUpProgressSupplier = () => string | undefined;

export interface RunVerboseFollowUpOptions {
  progressSupplier?: FollowUpProgressSupplier;
  heartbeatIntervalMs?: number;
  stageIndex?: number;
  stageTotal?: number;
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

export async function runVerboseFollowUp<T>(
  label: string,
  verbose: boolean,
  fn: () => Promise<T> | T,
  opts: RunVerboseFollowUpOptions = {},
): Promise<T> {
  const started = Date.now();
  const stagePrefix =
    opts.stageIndex && opts.stageTotal && opts.stageTotal > 0 ? `stage ${opts.stageIndex}/${opts.stageTotal} ` : "";
  const stageLabel = `${stagePrefix}${label}`.trim();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (verbose) {
    console.log(`[dream-cycle] ${stageLabel} — start`);
    heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      let progressSuffix = "";
      if (opts.progressSupplier) {
        try {
          const progress = opts.progressSupplier();
          if (progress) progressSuffix = ` — ${progress}`;
        } catch {
          // Ignore progress supplier failures; heartbeat should never crash the process.
        }
      }
      console.log(`[dream-cycle] ${stageLabel} — still running after ${elapsedSec}s${progressSuffix}`);
    }, opts.heartbeatIntervalMs ?? 60_000);
    heartbeat.unref?.();
  }
  try {
    const result = await fn();
    if (verbose) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      console.log(`[dream-cycle] ${stageLabel} — complete in ${elapsedSec}s`);
    }
    return result;
  } catch (err) {
    if (verbose) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      console.error(`[dream-cycle] ${stageLabel} — failed after ${elapsedSec}s: ${formatFollowUpError(err)}`);
    }
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
