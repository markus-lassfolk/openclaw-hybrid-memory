import type { BootstrapPhase, BootstrapPhaseConfig } from "../config.js";
import { BOOTSTRAP_PHASES } from "../config/types/bootstrap.js";

/** Explicit startup ordering so core subsystems are always installed first. */
export const BOOTSTRAP_PHASE_ORDER: readonly BootstrapPhase[] = BOOTSTRAP_PHASES;

const BOOTSTRAP_PHASE_PRIORITY = new Map<BootstrapPhase, number>(
  BOOTSTRAP_PHASE_ORDER.map((phase, index) => [phase, index]),
);

export function compareBootstrapPhase(a: BootstrapPhase, b: BootstrapPhase): number {
  return (
    (BOOTSTRAP_PHASE_PRIORITY.get(a) ?? Number.MAX_SAFE_INTEGER) -
    (BOOTSTRAP_PHASE_PRIORITY.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function orderByBootstrapPhase<T extends BootstrapPhaseConfig>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => compareBootstrapPhase(left.bootstrapPhase, right.bootstrapPhase));
}
