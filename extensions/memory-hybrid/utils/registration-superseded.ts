import { getHybridMemoryRegistrationState } from "../setup/hybrid-memory-generation-state.js";

export function isDbClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not open|connection is not open|database is not open/i.test(msg);
}

/** True when a newer plugin registration replaced this bootstrap / hook generation. */
export function isRegistrationSuperseded(bootRegistrationGeneration: number): boolean {
  if (bootRegistrationGeneration < 0) return false;
  return getHybridMemoryRegistrationState().registrationGenerationRef.value !== bootRegistrationGeneration;
}

export type LifecycleGenerationContext = {
  registrationGeneration?: number;
  currentRegistrationGenerationRef?: { value: number };
};

/** Lifecycle / recall work tied to a specific plugin registration generation. */
export function isRecallContextSuperseded(ctx: LifecycleGenerationContext): boolean {
  const ownerGeneration = ctx.registrationGeneration ?? -1;
  if (ownerGeneration < 0) return false;
  const liveGeneration = ctx.currentRegistrationGenerationRef?.value;
  if (liveGeneration !== undefined && liveGeneration !== ownerGeneration) return true;
  return isRegistrationSuperseded(ownerGeneration);
}

/** Suppress noisy errors when reload closed DBs under in-flight work (not a user-facing outage). */
export function shouldSuppressStaleLifecycleError(ctx: LifecycleGenerationContext, err: unknown): boolean {
  return isRecallContextSuperseded(ctx) && isDbClosedError(err);
}

/** @deprecated Use shouldSuppressStaleLifecycleError */
export const shouldSuppressStaleRecallError = shouldSuppressStaleLifecycleError;

/**
 * Log at debug and return true when err is a superseded-generation DB close.
 * Callers should return early without capturePluginError / logger.warn.
 */
export function suppressStaleLifecycleDbError(
  ctx: LifecycleGenerationContext,
  err: unknown,
  logger: { debug?: (msg: string) => void },
  debugMessage: string,
): boolean {
  if (!shouldSuppressStaleLifecycleError(ctx, err)) return false;
  logger.debug?.(debugMessage);
  return true;
}
