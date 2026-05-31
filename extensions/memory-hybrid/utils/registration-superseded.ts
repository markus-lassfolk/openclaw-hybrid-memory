import { getHybridMemoryRegistrationState } from "../setup/hybrid-memory-generation-state.js";

export function isDbClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /database connection is not open/i.test(msg);
}

/** True when a newer plugin registration replaced this bootstrap / hook generation. */
export function isRegistrationSuperseded(bootRegistrationGeneration: number): boolean {
  if (bootRegistrationGeneration < 0) return false;
  return getHybridMemoryRegistrationState().registrationGenerationRef.value !== bootRegistrationGeneration;
}

/** Lifecycle / recall work tied to a specific plugin registration generation. */
export function isRecallContextSuperseded(ctx: {
  registrationGeneration?: number;
  currentRegistrationGenerationRef?: { value: number };
}): boolean {
  const ownerGeneration = ctx.registrationGeneration ?? -1;
  if (ownerGeneration < 0) return false;
  const liveGeneration = ctx.currentRegistrationGenerationRef?.value;
  if (liveGeneration !== undefined && liveGeneration !== ownerGeneration) return true;
  return isRegistrationSuperseded(ownerGeneration);
}

/** Suppress noisy errors when reload closed DBs under in-flight recall (not a user-facing outage). */
export function shouldSuppressStaleRecallError(
  ctx: {
    registrationGeneration?: number;
    currentRegistrationGenerationRef?: { value: number };
  },
  err: unknown,
): boolean {
  return isRecallContextSuperseded(ctx) && isDbClosedError(err);
}
