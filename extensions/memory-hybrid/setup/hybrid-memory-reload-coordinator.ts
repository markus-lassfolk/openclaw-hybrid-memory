import { capturePluginError } from "../services/error-reporter.js";

/** Max time to wait for superseded instance bootstrap before permanentClose (embedding verify can take minutes). */
export const BOOTSTRAP_DRAIN_MS = 3_000;

/** Brief wait for in-flight auto-recall before permanentClose (directives can run 20s+). */
export const RECALL_DRAIN_MS = 2_000;

/**
 * Max time register() blocks waiting for scheduled teardown before opening new DB handles.
 *
 * schedulePluginTeardown() serializes callbacks onto a single chain, so when a re-register has
 * a vault registry (#87), register-plugin.ts chains TWO teardowns back-to-back: a vault-registry
 * teardown (drainOldRecall, up to RECALL_DRAIN_MS) followed by the full-database teardown
 * (drainOldBootstrap + drainOldRecall, up to BOOTSTRAP_DRAIN_MS + RECALL_DRAIN_MS). The budget
 * must cover that worst-case sequential total, not just the full-database teardown alone.
 */
const TEARDOWN_MIN_WAIT_MS = RECALL_DRAIN_MS + BOOTSTRAP_DRAIN_MS + RECALL_DRAIN_MS + 1_000;
export const TEARDOWN_WAIT_MS = Math.max(6_000, TEARDOWN_MIN_WAIT_MS);

/**
 * Soft grace window: if teardown doesn't drain within this budget, callers that are about to
 * reuse donor handles (reuse-databases policy) should fall back to a fresh open instead of
 * inheriting indeterminate closed handles (#2058 / #2059 supplement).
 */
export const TEARDOWN_SOFT_WAIT_MS = Math.max(3_000, RECALL_DRAIN_MS + BOOTSTRAP_DRAIN_MS + 1_000);

/**
 * Tracks the registration generation each scheduled teardown belongs to. The new
 * registration wants to wait for teardowns scheduled by the **prior** generation
 * (the one it's about to supersede), not for teardowns scheduled by itself or
 * later generations. This prevents the gate from deadlocking when a re-register
 * overlap-queues another re-register (e.g. rapid voice-call config hot reloads).
 */
type ScheduledTeardown = {
  /** Registration generation that owns the donor runtime being torn down. */
  donorGeneration: number;
  /** Resolved when this individual teardown has finished (success or error). */
  done: Promise<void>;
};
let scheduledTeardowns: ScheduledTeardown[] = [];

/** Serializes plugin teardown (bootstrap settle → close DBs) across hot reloads (#1550 / reload race). */
let reloadTeardownChain: Promise<void> = Promise.resolve();
let reloadTeardownQueueDepth = 0;

export function schedulePluginTeardown(teardown: () => Promise<void>, options?: { donorGeneration?: number }): void {
  reloadTeardownQueueDepth += 1;
  const donorGeneration = options?.donorGeneration ?? -1;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const entry: ScheduledTeardown = { donorGeneration, done };
  scheduledTeardowns.push(entry);
  reloadTeardownChain = reloadTeardownChain
    .catch(() => {
      /* keep chain alive; next teardown still must run */
    })
    .then(async () => {
      try {
        await teardown();
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "reload-teardown",
          severity: "warning",
        });
      } finally {
        reloadTeardownQueueDepth = Math.max(0, reloadTeardownQueueDepth - 1);
        // Always resolve so awaiters can move on, regardless of teardown outcome.
        resolveDone();
      }
    });
  // Defensive: also resolve done when the chain itself settles, even if the
  // .then() above never runs (shouldn't happen, but belt-and-suspenders for
  // generation tracking — never leave an entry stuck "pending").
  void reloadTeardownChain.finally(() => resolveDone());
  // Auto-remove the entry once it's done so isTeardownDrainedForGeneration flips back to true.
  void done.then(() => {
    scheduledTeardowns = scheduledTeardowns.filter((e) => e !== entry);
  });
}

/**
 * Drop tracking entries for the given registration generation. Called by register-plugin
 * after the new runtime has been installed, so stale entries don't pile up.
 */
export function clearTeardownTrackingForGeneration(generation: number): void {
  if (generation < 0) return;
  scheduledTeardowns = scheduledTeardowns.filter((entry) => entry.donorGeneration !== generation);
}

/**
 * Returns true when no scheduled teardown for `donorGeneration` is still pending.
 * Used by register-plugin to detect the soft-drain timeout case: the chain may have
 * advanced past this generation's teardown already (good), or it may still be queued
 * behind a newer teardown (bad — donor handles would still be open during the wait).
 */
export function isTeardownDrainedForGeneration(donorGeneration: number): boolean {
  if (donorGeneration < 0) return reloadTeardownQueueDepth === 0;
  return !scheduledTeardowns.some((entry) => entry.donorGeneration === donorGeneration);
}

/**
 * Snapshot the current set of `done` promises for teardowns belonging to `donorGeneration`.
 * Used by callers that want to wait only on the teardowns they care about (the donor they're
 * about to supersede), not on teardowns queued by a later registration generation.
 */
export function listTeardownPromisesForGeneration(donorGeneration: number): Promise<void>[] {
  if (donorGeneration < 0) {
    return scheduledTeardowns.map((entry) => entry.done);
  }
  return scheduledTeardowns.filter((entry) => entry.donorGeneration === donorGeneration).map((entry) => entry.done);
}

/** Wait for superseded bootstrap work with a short cap; then close old handles regardless. */
export async function drainOldBootstrap(bootstrap: Promise<void>): Promise<void> {
  await Promise.race([
    bootstrap.catch(() => {
      /* embedding/vault init may fail; still close handles */
    }),
    new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_DRAIN_MS)),
  ]);
}

/** Let superseded auto-recall/directive probes finish before closing SQLite handles. */
export async function drainOldRecall(recallInFlightRef: { value: number } | undefined): Promise<void> {
  if (!recallInFlightRef || recallInFlightRef.value <= 0) return;
  const deadline = Date.now() + RECALL_DRAIN_MS;
  while (recallInFlightRef.value > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Block until scheduled teardowns finish before opening new DB handles (issue #802).
 * If timeoutMs is 0, waits indefinitely until teardown completes.
 * Returns a promise that resolves to false if teardown is still in flight after timeout.
 */
export async function awaitReloadTeardownBeforeOpen(timeoutMs = TEARDOWN_WAIT_MS): Promise<boolean> {
  if (timeoutMs < 0) return false;
  const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const chainSnapshot = reloadTeardownChain;
    const remainingMs = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
    if (Number.isFinite(deadline)) {
      await Promise.race([
        chainSnapshot.catch(() => {
          /* teardown error already logged */
        }),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    } else {
      await chainSnapshot.catch(() => {
        /* teardown error already logged */
      });
    }

    // Consider teardown drained only when both queue depth and chain identity are stable.
    if (reloadTeardownQueueDepth === 0 && chainSnapshot === reloadTeardownChain) {
      return true;
    }
    if (!Number.isFinite(deadline)) continue;
    if (Date.now() >= deadline) break;
  }
  return reloadTeardownQueueDepth === 0;
}

/** Shared buffer for Atomics.wait while synchronously blocking register(). */
const syncWaitBuffer = new SharedArrayBuffer(4);
const syncWaitArray = new Int32Array(syncWaitBuffer);

/**
 * Wait for scheduled teardowns belonging to `donorGeneration` (async — pumps the event loop).
 * Prefer this over {@link blockReloadTeardownBeforeOpen}, which cannot drain Promise-based
 * teardown because `Atomics.wait` blocks the event loop (#2181).
 */
export async function awaitDonorTeardown(donorGeneration: number, timeoutMs = TEARDOWN_WAIT_MS): Promise<boolean> {
  if (donorGeneration < 0) {
    return awaitReloadTeardownBeforeOpen(timeoutMs);
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const pending = listTeardownPromisesForGeneration(donorGeneration);
    if (pending.length === 0) return true;
    const remainingMs = Math.max(0, deadline - Date.now());
    await Promise.race([
      Promise.all(pending.map((p) => p.catch(() => undefined))),
      new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
    ]);
    if (isTeardownDrainedForGeneration(donorGeneration)) return true;
    if (Date.now() >= deadline) break;
  }
  return isTeardownDrainedForGeneration(donorGeneration);
}

/**
 * Synchronous variant of `awaitReloadTeardownBeforeOpen` for legacy callers.
 *
 * WARNING (#2181): `Atomics.wait` does **not** pump Node's event loop. Promise-chain teardown
 * scheduled via {@link schedulePluginTeardown} will not run while this function blocks. Prefer
 * {@link awaitDonorTeardown} / {@link awaitReloadTeardownBeforeOpen} from an async activation
 * path. Kept only for tests and non-Promise wait scenarios.
 */
export function blockReloadTeardownBeforeOpen(timeoutMs = TEARDOWN_WAIT_MS): boolean {
  if (timeoutMs < 0) return false;
  const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const chainSnapshot = reloadTeardownChain;
    if (reloadTeardownQueueDepth === 0 && chainSnapshot === reloadTeardownChain) {
      return true;
    }
    Atomics.wait(syncWaitArray, 0, 0, 50);
    if (!Number.isFinite(deadline)) continue;
    if (Date.now() >= deadline) break;
  }
  return reloadTeardownQueueDepth === 0;
}

/**
 * Decision for the register-time reload gate: after {@link blockReloadTeardownBeforeOpen}
 * returns, describe what the new registration should do with the donor's DB handles.
 *
 * - `reuse` — donor teardown drained (or the donor generation's teardown is done); the new
 *   registration may inherit the donor's still-open handles.
 * - `fresh` — no donor handles to inherit and teardown has drained; open fresh handles.
 * - `fresh-soft-timeout` — a donor was available but its teardown did not drain in time, so
 *   inheriting its handles risks a closed-DB race; fall back to a fresh open.
 * - `fresh-hard-timeout` — full-teardown path (no donor to inherit) where teardown has not
 *   drained. The donor's handles are being permanently closed on a **separate** teardown
 *   chain and the new registration opens its own fresh handles, so it is safe to proceed.
 *   Previously this case threw and failed plugin initialization outright (#2111); it now
 *   recovers to a fresh open and records the timeout for observability.
 */
export type ReloadTeardownGateDecision = "reuse" | "fresh" | "fresh-soft-timeout" | "fresh-hard-timeout";

/**
 * Pure gate-decision logic shared by register-plugin. Kept side-effect-free (no blocking, no
 * logging) so it can be unit-tested exhaustively; the caller performs the actual synchronous
 * teardown wait and acts on the returned decision.
 *
 * @param hasDonor    Whether a donor runtime whose handles could be reused is available.
 * @param drained     Result of the synchronous teardown wait (queue fully drained in time).
 * @param donorDrained Whether the specific donor generation's teardown has finished, even if
 *                     newer teardowns are still queued (overlap-queued re-register).
 */
export function decideReloadTeardownGate(params: {
  hasDonor: boolean;
  drained: boolean;
  donorDrained: boolean;
}): ReloadTeardownGateDecision {
  const { hasDonor, drained, donorDrained } = params;
  if (drained) return hasDonor ? "reuse" : "fresh";
  if (hasDonor) return donorDrained ? "reuse" : "fresh-soft-timeout";
  // No donor runtime to inherit (full-teardown path). The old handles are being closed on a
  // separate chain; opening fresh handles is safe. Never throw here (#2111) — a hard failure
  // repeats on every reload attempt and leaves the plugin unregistered.
  return "fresh-hard-timeout";
}

/** Current depth of the serialized reload teardown queue (diagnostics / #2181 logs). */
export function getReloadTeardownQueueDepth(): number {
  return reloadTeardownQueueDepth;
}

/** Reset chain for unit tests only. */
export function resetReloadTeardownChainForTests(): void {
  reloadTeardownChain = Promise.resolve();
  reloadTeardownQueueDepth = 0;
  scheduledTeardowns = [];
}
