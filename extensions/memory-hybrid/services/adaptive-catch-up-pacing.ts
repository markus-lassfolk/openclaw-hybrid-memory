/**
 * Adaptive catch-up pressure backoff: provider Retry-After is a hard floor and is not
 * reduced by the normal adaptive max-delay cap (used only when no Retry-After hint).
 */
export function computeAdaptivePressureDelayMs(opts: {
  currentDelayMs: number;
  batchRetryAfterMs?: number;
  maxAdaptiveDelayMs: number;
  backoffMinDelayMs: number;
}): number {
  const retryAfterFloor = opts.batchRetryAfterMs ?? 0;
  const retryAfterDelay = Math.max(retryAfterFloor, opts.currentDelayMs);
  const scaledDelay = Math.ceil(retryAfterDelay * 1.5);
  const computed = Math.max(opts.backoffMinDelayMs, scaledDelay, retryAfterFloor);
  if (retryAfterFloor > 0) {
    return computed;
  }
  return Math.min(opts.maxAdaptiveDelayMs, computed);
}
