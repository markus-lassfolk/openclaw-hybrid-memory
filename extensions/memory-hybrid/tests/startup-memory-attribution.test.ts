import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getStartupMemoryAttributionEntries,
  recordStartupMemoryCheckpoint,
  resetStartupMemoryAttributionForTests,
} from "../services/startup-memory-attribution.js";

describe("startup memory attribution", () => {
  beforeEach(() => {
    resetStartupMemoryAttributionForTests();
  });

  it("records owner-attributed checkpoints with RSS deltas", () => {
    const logger = { info: vi.fn() };

    const first = recordStartupMemoryCheckpoint({
      logger,
      subsystem: "bootstrap",
      operation: "plugin-registration",
      phase: "startup.plugin-registration.begin",
      tags: { plugin: "memory-hybrid" },
    });
    const second = recordStartupMemoryCheckpoint({
      logger,
      subsystem: "auto-recall",
      operation: "first-recall",
      phase: "startup.first-recall.after",
      tags: { resultKind: "full" },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.rssDeltaBytes).toBe(0);
    expect(Number.isFinite(second?.rssDeltaBytes)).toBe(true);
    expect(getStartupMemoryAttributionEntries()).toHaveLength(2);
    const bootstrapLog = logger.info.mock.calls
      .reduce<unknown[]>((acc, args) => {
        acc.push(...args);
        return acc;
      }, [])
      .find(
        (value): value is string =>
          typeof value === "string" && value.includes("phase=startup.plugin-registration.begin"),
      );
    expect(bootstrapLog).toBeDefined();
    expect(bootstrapLog).toContain("owner=hybrid-memory");
    expect(bootstrapLog).toContain(`subsystem=${first?.subsystem}`);
    expect(bootstrapLog).toContain(`operation=${first?.operation}`);
    expect(bootstrapLog).toContain(`rssDeltaBytes=${first?.rssDeltaBytes}`);
  });

  it("deduplicates by onceKey", () => {
    const logger = { info: vi.fn() };
    const onceKey = "startup.first-active-task-projection";
    const first = recordStartupMemoryCheckpoint({
      logger,
      subsystem: "active-task",
      operation: "first-projection",
      phase: "startup.first-active-task-projection.after",
      onceKey,
    });
    const second = recordStartupMemoryCheckpoint({
      logger,
      subsystem: "active-task",
      operation: "first-projection",
      phase: "startup.first-active-task-projection.after",
      onceKey,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(getStartupMemoryAttributionEntries()).toHaveLength(1);
  });
});
