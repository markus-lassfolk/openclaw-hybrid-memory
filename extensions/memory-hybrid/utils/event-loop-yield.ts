/**
 * Yield to the Node.js event loop so I/O and WebSocket handlers (e.g. gateway health RPCs) can run.
 * Use after heavy synchronous SQLite / merge work on the auto-recall path (#931).
 */
export async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
