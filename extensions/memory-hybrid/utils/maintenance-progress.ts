/**
 * Helpers for verbose maintenance / dream-cycle progress logging (#1228).
 */

/** Default interval for heartbeat lines when a substep has no finer-grained progress events. */
export const MAINTENANCE_VERBOSE_HEARTBEAT_MS = 15_000;

export function formatElapsedSec(sinceMs: number): string {
  return `${Math.max(0, Math.round((Date.now() - sinceMs) / 1000))}s`;
}

/**
 * Runs `fn` while emitting periodic heartbeat logs if `verbose` and work takes longer than `intervalMs`.
 * The heartbeat includes `detail()` output (live counters).
 */
export async function withVerboseHeartbeat<T>(opts: {
  verbose: boolean;
  log: (msg: string) => void;
  prefix: string;
  intervalMs?: number;
  detail: () => string;
  fn: () => Promise<T>;
}): Promise<T> {
  if (!opts.verbose) {
    return opts.fn();
  }
  const intervalMs = opts.intervalMs ?? MAINTENANCE_VERBOSE_HEARTBEAT_MS;
  const phaseStart = Date.now();
  const id = setInterval(() => {
    opts.log(`${opts.prefix} — heartbeat elapsed=${formatElapsedSec(phaseStart)} | ${opts.detail()}`);
  }, intervalMs);
  try {
    return await opts.fn();
  } finally {
    clearInterval(id);
  }
}
