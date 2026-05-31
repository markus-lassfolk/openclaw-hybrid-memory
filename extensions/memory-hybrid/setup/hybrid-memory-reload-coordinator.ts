import { capturePluginError } from "../services/error-reporter.js";

/** Max time to wait for superseded instance bootstrap before permanentClose (embedding verify can take minutes). */
export const BOOTSTRAP_DRAIN_MS = 3_000;

/** Brief wait for in-flight auto-recall before permanentClose (directives can run 20s+). */
export const RECALL_DRAIN_MS = 2_000;

/** Max time register() blocks waiting for scheduled teardown before opening new DB handles. */
const TEARDOWN_MIN_WAIT_MS = BOOTSTRAP_DRAIN_MS + RECALL_DRAIN_MS + 1_000;
export const TEARDOWN_WAIT_MS = Math.max(6_000, TEARDOWN_MIN_WAIT_MS);

/** Serializes plugin teardown (bootstrap settle → close DBs) across hot reloads (#1550 / reload race). */
let reloadTeardownChain: Promise<void> = Promise.resolve();
let reloadTeardownQueueDepth = 0;

export function schedulePluginTeardown(teardown: () => Promise<void>): void {
  reloadTeardownQueueDepth += 1;
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
      }
    });
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

/** Reset chain for unit tests only. */
export function resetReloadTeardownChainForTests(): void {
  reloadTeardownChain = Promise.resolve();
  reloadTeardownQueueDepth = 0;
}
