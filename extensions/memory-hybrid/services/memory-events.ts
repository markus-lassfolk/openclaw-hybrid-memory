/**
 * In-process memory event bus for the live Memory Graph overlay.
 *
 * A tiny, dependency-free emitter that the `backends/` write paths publish to and the
 * `routes/` GraphQL pubsub bridge subscribes from. It deliberately lives in `services/`
 * so `backends/` never has to import `routes/` (which would create a cycle) — `backends/`
 * already imports leaf services such as `error-reporter`.
 *
 * Design guarantees:
 * - **Deferred:** every emit is scheduled on a microtask, so subscribers never run
 *   synchronously inside a caller's SQLite transaction/critical section.
 * - **Isolated:** subscriber throws are swallowed — a visualization subscriber can never
 *   break, slow, or roll back a memory write.
 * - **Snapshot payloads:** payloads are plain data captured at emit time, never live cursors,
 *   so deferring is always safe.
 */
import { EventEmitter } from "node:events";
import type { MemoryEntry } from "../types/memory.js";

/**
 * Self-contained link shape carried on link events. Includes `createdAt` so the pubsub bridge can
 * republish a canonical GraphQL link WITHOUT re-querying the database — a DB lookup there would
 * resolve against whichever FactsDB wired the (process-global) bridge last, not the vault the write
 * actually came from, in a multi-vault process.
 */
export type MemoryLinkEventPayload = {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  strength: number;
  /** Epoch seconds the link row was created (stable across strengthen/type updates). */
  createdAt: number;
};

/** One recalled fact and the score it was ranked with. */
export type RecallHitPayload = { factId: string; score: number };

/** A recall (auto-recall injection or explicit `memory_recall`) that just happened. */
export type RecallOccurredPayload = {
  query: string | null;
  /** Origin of the recall — mirrors `RecallEventSource` (`tool` | `auto-recall` | `backfill`). */
  source: string;
  sessionKey: string | null;
  agentId: string | null;
  /** Epoch seconds. */
  occurredAt: number;
  hits: RecallHitPayload[];
};

export type MemoryEventMap = {
  factStored: { entry: MemoryEntry };
  factUpdated: { entry: MemoryEntry };
  factDeleted: { id: string; category?: string; scope?: string; scopeTarget?: string | null };
  linkCreated: { link: MemoryLinkEventPayload };
  linkUpdated: { link: MemoryLinkEventPayload };
  recallOccurred: RecallOccurredPayload;
};

export type MemoryEventType = keyof MemoryEventMap;

const bus = new EventEmitter();
// The bridge registers one listener per event type; allow generous headroom so tests that
// spin up multiple servers never trip the default max-listeners warning.
bus.setMaxListeners(100);

/**
 * Subscribe to a memory event. Returns an unsubscribe function. Listener bodies should be
 * cheap and must tolerate being called after the originating write has fully committed.
 */
export function onMemoryEvent<K extends MemoryEventType>(
  type: K,
  listener: (payload: MemoryEventMap[K]) => void,
): () => void {
  bus.on(type, listener as (payload: unknown) => void);
  return () => {
    bus.off(type, listener as (payload: unknown) => void);
  };
}

/**
 * Publish a memory event. Fire-and-forget: deferred to a microtask and fully isolated. Each
 * subscriber is invoked in its own try/catch so a throwing (or missing) subscriber can neither
 * affect the caller's write path nor prevent other subscribers from receiving the event.
 */
export function emitMemoryEvent<K extends MemoryEventType>(type: K, payload: MemoryEventMap[K]): void {
  queueMicrotask(() => {
    for (const listener of bus.listeners(type)) {
      try {
        (listener as (payload: MemoryEventMap[K]) => void)(payload);
      } catch {
        // A visualization subscriber must never affect memory writes or sibling subscribers.
      }
    }
  });
}

/** Remove all listeners — test hygiene only. */
export function resetMemoryEventBus(): void {
  bus.removeAllListeners();
}
