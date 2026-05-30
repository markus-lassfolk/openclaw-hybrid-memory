/**
 * Shared utility for lifecycle generation staleness checks.
 * Used across hooks.ts and stage-recall/run-recall.ts to avoid duplication.
 */

import type { LifecycleContext } from "../lifecycle/types.js";

/**
 * Returns true if the lifecycle generation is stale (plugin has been re-registered).
 * This prevents stale in-flight work from writing to databases that are being torn down.
 */
export function isStaleLifecycleGeneration(ctx: LifecycleContext): boolean {
  return (
    typeof ctx.registrationGeneration === "number" &&
    ctx.currentRegistrationGenerationRef !== undefined &&
    ctx.currentRegistrationGenerationRef.value !== ctx.registrationGeneration
  );
}
