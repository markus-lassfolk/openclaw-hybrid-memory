function formatError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export type ProgressSupplier = () => string | undefined;

export interface MaintenanceHeartbeatController {
  heartbeat: () => void;
}

export interface RunMaintenanceHeartbeatOptions {
  progressSupplier?: ProgressSupplier;
  heartbeatIntervalMs?: number;
  forceHeartbeat?: boolean;
  jsonMode?: boolean;
  logPrefix?: string;
  progressSeparator?: string;
}

export async function runMaintenanceHeartbeat<T>(
  label: string,
  verbose: boolean,
  fn: (heartbeat: MaintenanceHeartbeatController) => Promise<T> | T,
  opts: RunMaintenanceHeartbeatOptions = {},
): Promise<T> {
  const emit = verbose || opts.forceHeartbeat === true;
  const logStream = opts.jsonMode ? console.error : console.log;
  const prefix = opts.logPrefix ?? "memory-hybrid:";
  const progressSep = opts.progressSeparator ?? "; ";
  const intervalMs = Math.max(1, opts.heartbeatIntervalMs ?? 60_000);
  const started = Date.now();
  let lastHeartbeatAt = started;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const emitStillRunning = () => {
    if (!emit) return;
    const now = Date.now();
    if (now - lastHeartbeatAt < intervalMs) return;
    const elapsedSec = Math.floor((now - started) / 1000);
    let progressSuffix = "";
    if (opts.progressSupplier) {
      try {
        const progress = opts.progressSupplier();
        if (progress) progressSuffix = `${progressSep}${progress}`;
      } catch {
        // Heartbeat logging must never fail the command.
      }
    }
    logStream(`${prefix} ${label} — still running after ${elapsedSec}s${progressSuffix}`);
    lastHeartbeatAt = now;
  };
  const heartbeatController: MaintenanceHeartbeatController = {
    heartbeat: emitStillRunning,
  };
  if (emit) {
    logStream(`${prefix} ${label} — start`);
    heartbeat = setInterval(emitStillRunning, intervalMs);
    heartbeat.unref?.();
  }
  try {
    const result = await fn(heartbeatController);
    if (emit) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      logStream(`${prefix} ${label} — complete in ${elapsedSec}s`);
    }
    return result;
  } catch (err) {
    if (emit) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      console.error(`${prefix} ${label} — failed after ${elapsedSec}s: ${formatError(err)}`);
    }
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
