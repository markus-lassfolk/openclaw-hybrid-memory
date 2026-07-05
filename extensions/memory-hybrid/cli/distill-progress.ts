/**
 * Operator progress/heartbeat for verbose distill runs (#2029).
 *
 * A distill batch can block for minutes inside a single LLM call, during which the block-percentage
 * progress reporter (which only fires when a batch advances) stays silent — making a live run look
 * hung. This emits a clear start marker, a periodic heartbeat with block counts + elapsed time, and a
 * final summary line. Only ids/counts/status are logged — never raw fact text — so no sensitive memory
 * content leaks into operator logs.
 */

import { formatRemainingMaintenanceRunSecLabel } from "../utils/maintenance-run-deadline.js";

/** Verbose distill heartbeat cadence so long LLM-bound batches don't look hung (#2029). */
export const DISTILL_HEARTBEAT_INTERVAL_MS = 30_000;

export interface DistillProgressState {
  /** 1-based index of the batch/retry attempt currently in flight — increments on every retry,
   *  including a shrink-and-retry of the SAME block range, so it is not itself proof of forward
   *  progress (#2038). */
  batch: number;
  /** Blocks fully processed so far. */
  processedBlocks: number;
  /** Block index the current batch/retry starts at. Unchanged across repeated retries of the same
   *  batch — surfacing it lets an operator tell "batch N is new content" from "batch N is a
   *  relabeled retry of the same still-stuck block range" (#2038). */
  cursorBlock: number;
}

export interface DistillDoneSummary {
  /** Terminal status: "ok" | "empty" | "partial". */
  status: string;
  extracted: number;
  processedBlocks: number;
  batchFailures: number;
  truncatedBatches: number;
}

export interface DistillProgressReporter {
  /** Emit the final summary line and stop the heartbeat. Idempotent. */
  done: (summary: DistillDoneSummary) => void;
  /** Stop the heartbeat without emitting a summary (e.g. an early return path). Idempotent. */
  stop: () => void;
}

/**
 * Start emitting distill progress markers. A no-op reporter is returned when `verbose` is false or no
 * logger is available, so callers can unconditionally call `done()`/`stop()`.
 */
export function startDistillProgress(opts: {
  verbose: boolean;
  logger?: { info?: (msg: string) => void };
  sessions: number;
  totalBlocks: number;
  /** Read the live batch/processed counters at heartbeat time. */
  getState: () => DistillProgressState;
  /** Override the heartbeat cadence (tests). */
  intervalMs?: number;
}): DistillProgressReporter {
  const info = opts.logger?.info;
  if (!opts.verbose || typeof info !== "function") {
    return { done: () => {}, stop: () => {} };
  }
  const log = (msg: string) => info.call(opts.logger, msg);
  const startedMs = Date.now();
  log(`memory-hybrid: distill start — sessions=${opts.sessions} blocks=${opts.totalBlocks}`);
  const heartbeat = setInterval(() => {
    const { batch, processedBlocks, cursorBlock } = opts.getState();
    const elapsedSec = Math.floor((Date.now() - startedMs) / 1000);
    log(
      `memory-hybrid: distill — still running: batch ${batch} (block ${cursorBlock}/${opts.totalBlocks}) ` +
        `processed ${processedBlocks}/${opts.totalBlocks} blocks (elapsed ${elapsedSec}s) ` +
        `deadlineRemaining=${formatRemainingMaintenanceRunSecLabel()}`,
    );
  }, opts.intervalMs ?? DISTILL_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
  };
  return {
    stop,
    done: (summary) => {
      stop();
      const durationSec = Math.floor((Date.now() - startedMs) / 1000);
      log(
        `memory-hybrid: distill done — status=${summary.status} extracted=${summary.extracted} blocks=${summary.processedBlocks}/${opts.totalBlocks} batchFailures=${summary.batchFailures} truncatedBatches=${summary.truncatedBatches} duration=${durationSec}s`,
      );
    },
  };
}
