import { afterEach, describe, expect, it } from "vitest";
import { emitMemoryEvent, type MemoryEventMap, onMemoryEvent, resetMemoryEventBus } from "../services/memory-events.js";

/** Flush the microtask + macrotask queues so deferred emits are delivered. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetMemoryEventBus();
});

describe("memory-events bus", () => {
  it("delivers a payload to a subscriber (deferred)", async () => {
    const received: Array<MemoryEventMap["factStored"]> = [];
    onMemoryEvent("factStored", (p) => received.push(p));

    // deferred: nothing synchronously yet
    const entry = { id: "f1", text: "hi", category: "fact" } as MemoryEventMap["factStored"]["entry"];
    emitMemoryEvent("factStored", { entry });
    expect(received).toHaveLength(0);

    await flush();
    expect(received).toHaveLength(1);
    expect(received[0].entry.id).toBe("f1");
  });

  it("isolates subscriber throws — a bad listener breaks neither the emit path nor siblings", async () => {
    let goodRan = false;
    onMemoryEvent("linkCreated", () => {
      throw new Error("subscriber blew up");
    });
    onMemoryEvent("linkCreated", () => {
      goodRan = true;
    });

    // Must not throw synchronously (the emit is deferred + wrapped).
    expect(() =>
      emitMemoryEvent("linkCreated", {
        link: { id: "l1", sourceId: "a", targetId: "b", linkType: "RELATED_TO", strength: 1, createdAt: 1 },
      }),
    ).not.toThrow();

    await flush();
    // The throwing listener is isolated: the sibling listener still runs.
    expect(goodRan).toBe(true);
  });

  it("unsubscribe stops further delivery", async () => {
    let count = 0;
    const off = onMemoryEvent("recallOccurred", () => {
      count++;
    });
    emitMemoryEvent("recallOccurred", {
      query: "q",
      source: "tool",
      sessionKey: null,
      agentId: null,
      occurredAt: 1,
      hits: [],
    });
    await flush();
    expect(count).toBe(1);

    off();
    emitMemoryEvent("recallOccurred", {
      query: "q2",
      source: "tool",
      sessionKey: null,
      agentId: null,
      occurredAt: 2,
      hits: [],
    });
    await flush();
    expect(count).toBe(1);
  });
});
