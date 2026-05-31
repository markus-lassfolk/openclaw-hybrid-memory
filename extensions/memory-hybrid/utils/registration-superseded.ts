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
