function formatMaintenanceError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export type MaintenanceProgressSupplier = () => string | undefined;

export interface RunMaintenanceHeartbeatOptions {
  progressSupplier?: MaintenanceProgressSupplier;
  heartbeatIntervalMs?: number;
  forceHeartbeat?: boolean;
}

export async function runMaintenanceHeartbeat<T>(
  label: string,
  verbose: boolean,
  fn: () => Promise<T> | T,
  opts: RunMaintenanceHeartbeatOptions = {},
): Promise<T> {
  const emit = verbose || opts.forceHeartbeat === true;
  const started = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (emit) {
    console.log(`memory-hybrid: ${label} — start`);
    heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      let progressSuffix = "";
      if (opts.progressSupplier) {
        try {
          const progress = opts.progressSupplier();
          if (progress) progressSuffix = `; ${progress}`;
        } catch {
          // Heartbeat logging must never fail the command.
        }
      }
      console.log(`memory-hybrid: ${label} — still running after ${elapsedSec}s${progressSuffix}`);
    }, opts.heartbeatIntervalMs ?? 60_000);
    heartbeat.unref?.();
  }
  try {
    const result = await fn();
    if (emit) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      console.log(`memory-hybrid: ${label} — complete in ${elapsedSec}s`);
    }
    return result;
  } catch (err) {
    if (emit) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      console.error(`memory-hybrid: ${label} — failed after ${elapsedSec}s: ${formatMaintenanceError(err)}`);
    }
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
