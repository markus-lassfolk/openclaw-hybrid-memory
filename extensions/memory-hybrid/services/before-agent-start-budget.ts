/**
 * Wall-clock budget for before_agent_start hooks (#1979).
 * OpenClaw gateway kills the whole hook chain at ~15s; stay under with margin.
 */

import { withTimeout } from "../utils/timeout.js";

/** Total wall-clock budget for all before_agent_start stages in one turn. */
export const GATEWAY_BEFORE_AGENT_START_BUDGET_MS = 12_000;

/** Skip optional prepend stages when less than this budget remains. */
export const BEFORE_AGENT_START_OPTIONAL_STAGE_MIN_MS = 800;

/** Goals / active-tasks must run unless the gateway budget is truly exhausted. */
export const BEFORE_AGENT_START_PROTECTED_STAGE_MIN_MS = 200;

/** Stages that inject goals or active tasks — never skip at the 800ms optional threshold. */
export const PROTECTED_BEFORE_AGENT_START_STAGES = new Set([
  "goal-context",
  "goal-stewardship",
  "active-task-injection",
]);

export type BeforeAgentStartTurnRef = { value: number | null };

export function markBeforeAgentStartTurn(ref?: BeforeAgentStartTurnRef): void {
  if (ref) ref.value = Date.now();
}

export function beforeAgentStartElapsedMs(ref?: BeforeAgentStartTurnRef): number {
  if (!ref?.value) return 0;
  return Date.now() - ref.value;
}

export function beforeAgentStartRemainingMs(ref?: BeforeAgentStartTurnRef): number {
  if (!ref?.value) return GATEWAY_BEFORE_AGENT_START_BUDGET_MS;
  return Math.max(0, GATEWAY_BEFORE_AGENT_START_BUDGET_MS - beforeAgentStartElapsedMs(ref));
}

/** Cap a stage timeout to remaining gateway hook budget. */
export function resolveBeforeAgentStartStageTimeoutMs(
  ref: BeforeAgentStartTurnRef | undefined,
  defaultTimeoutMs: number,
  reserveMs = 500,
): number {
  const remaining = beforeAgentStartRemainingMs(ref);
  if (remaining <= reserveMs) return Math.max(100, remaining - 50);
  return Math.min(defaultTimeoutMs, remaining - reserveMs);
}

export function isProtectedBeforeAgentStartStage(stage: string): boolean {
  return PROTECTED_BEFORE_AGENT_START_STAGES.has(stage);
}

export function shouldSkipOptionalBeforeAgentStartStage(
  ref?: BeforeAgentStartTurnRef,
  stage?: string,
): boolean {
  const minMs =
    stage && isProtectedBeforeAgentStartStage(stage)
      ? BEFORE_AGENT_START_PROTECTED_STAGE_MIN_MS
      : BEFORE_AGENT_START_OPTIONAL_STAGE_MIN_MS;
  return beforeAgentStartRemainingMs(ref) < minMs;
}

/** Log when a single optional stage exceeds this wall clock (ms). */
export const BEFORE_AGENT_START_STAGE_SLOW_MS = 2000;

type BeforeAgentStartLogger = { debug?: (msg: string) => void; warn?: (msg: string) => void } | undefined;

export type RunOptionalBeforeAgentStartStageOpts = {
  /** Default stage timeout; capped to remaining gateway budget when set. */
  timeoutMs?: number;
};

/**
 * Run an optional prepend stage under the shared gateway hook budget (#1979).
 * Skips when budget is exhausted; logs per-stage and cumulative slow-path timing.
 * Protected stages (goals, active-tasks) use a lower skip threshold.
 */
export async function runOptionalBeforeAgentStartStage<T>(
  ref: BeforeAgentStartTurnRef | undefined,
  stage: string,
  logger: BeforeAgentStartLogger,
  fn: () => Promise<T | undefined>,
  opts?: RunOptionalBeforeAgentStartStageOpts,
): Promise<T | undefined> {
  if (shouldSkipOptionalBeforeAgentStartStage(ref, stage)) {
    logger?.debug?.(
      `memory-hybrid: ${stage} skipped — before_agent_start budget exhausted (${beforeAgentStartRemainingMs(ref)}ms left)`,
    );
    return undefined;
  }
  const stageStart = Date.now();
  const runFn = async (): Promise<T | undefined> => fn();
  try {
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      const cappedMs = resolveBeforeAgentStartStageTimeoutMs(ref, opts.timeoutMs, 100);
      const result = await withTimeout(cappedMs, runFn, undefined);
      if (result == null && Date.now() - stageStart >= cappedMs - 50) {
        logger?.warn?.(
          `memory-hybrid: before_agent_start stage ${stage} timed out after ${cappedMs}ms (${beforeAgentStartRemainingMs(ref)}ms budget remaining)`,
        );
        return undefined;
      }
      return result ?? undefined;
    }
    return await runFn();
  } finally {
    const stageMs = Date.now() - stageStart;
    const remaining = beforeAgentStartRemainingMs(ref);
    if (stageMs >= BEFORE_AGENT_START_STAGE_SLOW_MS) {
      logger?.warn?.(
        `memory-hybrid: before_agent_start stage ${stage} took ${stageMs}ms (${remaining}ms budget remaining, ${beforeAgentStartElapsedMs(ref)}ms total)`,
      );
    } else {
      logSlowBeforeAgentStartIfNeeded(logger, ref, stage);
    }
  }
}

export function logSlowBeforeAgentStartIfNeeded(
  logger: { warn?: (msg: string) => void } | undefined,
  ref: BeforeAgentStartTurnRef | undefined,
  stage: string,
): void {
  const elapsed = beforeAgentStartElapsedMs(ref);
  if (elapsed > 5000) {
    logger?.warn?.(
      `memory-hybrid: before_agent_start slow — ${stage} at ${elapsed}ms elapsed (${beforeAgentStartRemainingMs(ref)}ms budget remaining)`,
    );
  }
}
