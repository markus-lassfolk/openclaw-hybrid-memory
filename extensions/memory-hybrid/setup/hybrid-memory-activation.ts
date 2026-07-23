/**
 * Two-phase registration activation (#2181).
 *
 * OpenClaw requires `register()` to return synchronously. Donor teardown runs on a Promise
 * chain and cannot be drained with `Atomics.wait` (that blocks the event loop and starves the
 * teardown it is waiting for). Instead:
 *   Phase A — sync register: schedule teardown, publish tool stubs, return.
 *   Phase B — async activate: await generation-scoped teardown, open/attach DBs, bind live tools.
 */

export type ActivationPhase = "idle" | "activating" | "ready" | "failed";

export type ActivationState = {
  phase: ActivationPhase;
  generation: number;
  donorGeneration: number;
  startedAtMs: number;
  readyAtMs: number | null;
  error: string | null;
  /** Resolves when this generation reaches ready or failed (or is superseded). */
  settled: Promise<void>;
};

type ActivationInternal = ActivationState & {
  resolveSettled: () => void;
  aborted: boolean;
};

let current: ActivationInternal | null = null;

function createSettledPair(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function getActivationState(): ActivationState | null {
  if (!current) return null;
  const { resolveSettled: _r, aborted: _a, ...publicState } = current;
  return publicState;
}

export function isActivationReady(generation: number): boolean {
  return current?.generation === generation && current.phase === "ready";
}

export function isActivationInFlight(): boolean {
  return current?.phase === "activating";
}

/** True when tools for `generation` should return the initializing/reloading safe result. */
export function shouldReturnInitializingToolResult(generation: number): boolean {
  if (!current) return false;
  if (current.generation !== generation) return false;
  return current.phase === "activating";
}

export function beginActivation(params: {
  generation: number;
  donorGeneration: number;
}): ActivationState {
  // Supersede any in-flight activation from a prior re-register.
  if (current && current.phase === "activating") {
    current.aborted = true;
    current.phase = "failed";
    current.error = "superseded_by_newer_registration";
    current.resolveSettled();
  }

  const { promise, resolve } = createSettledPair();
  current = {
    phase: "activating",
    generation: params.generation,
    donorGeneration: params.donorGeneration,
    startedAtMs: Date.now(),
    readyAtMs: null,
    error: null,
    settled: promise,
    resolveSettled: resolve,
    aborted: false,
  };
  const { resolveSettled: _r, aborted: _a, ...publicState } = current;
  return publicState;
}

export function markActivationReady(generation: number): void {
  if (!current || current.generation !== generation) return;
  if (current.aborted) return;
  current.phase = "ready";
  current.readyAtMs = Date.now();
  current.error = null;
  current.resolveSettled();
}

export function markActivationFailed(generation: number, error: unknown): void {
  if (!current || current.generation !== generation) return;
  current.phase = "failed";
  current.error = error instanceof Error ? error.message : String(error);
  current.resolveSettled();
}

export function isActivationAborted(generation: number): boolean {
  return Boolean(current && current.generation === generation && current.aborted);
}

/** Wait until the current activation for `generation` is ready, failed, or superseded. */
export async function awaitActivationReady(
  generation: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  if (isActivationReady(generation)) return true;
  if (!current || current.generation !== generation) return false;
  if (current.phase === "failed") return false;

  let timedOut = false;
  await Promise.race([
    current.settled,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timedOut) return isActivationReady(generation);
  return isActivationReady(generation);
}

export function resetActivationStateForTests(): void {
  if (current?.phase === "activating") {
    current.aborted = true;
    current.phase = "failed";
    current.error = "reset_for_tests";
    current.resolveSettled();
  }
  current = null;
}
