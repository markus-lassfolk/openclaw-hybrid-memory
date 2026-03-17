import { describe, it, expect, beforeEach, vi } from "vitest";
import { walWrite, walRemove, _resetWalCircuitBreakerForTesting } from "../services/wal-helpers.js";
import type { WriteAheadLog } from "../backends/wal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { warn: vi.fn() };
}

function makeWal(overrides: Partial<{ write: () => void; remove: () => void }> = {}): WriteAheadLog {
  return {
    write: vi.fn(),
    remove: vi.fn(),
    readAll: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    compact: vi.fn(),
    ...overrides,
  } as unknown as WriteAheadLog;
}

beforeEach(() => {
  _resetWalCircuitBreakerForTesting();
});

// ---------------------------------------------------------------------------
// walWrite — happy path
// ---------------------------------------------------------------------------

describe("walWrite — happy path", () => {
  it("calls wal.write and returns a UUID-shaped id", () => {
    const wal = makeWal();
    const logger = makeLogger();

    const id = walWrite(wal, "store", { text: "hello" }, logger);

    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(wal.write).toHaveBeenCalledOnce();
    const arg = (wal.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.id).toBe(id);
    expect(arg.operation).toBe("store");
    expect(arg.data).toEqual({ text: "hello" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still returns an id when wal is null", () => {
    const logger = makeLogger();
    const id = walWrite(null, "store", {}, logger);

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resets failure count to 0 after a successful write", () => {
    // Phase 1: cause some failures (below the 10-failure threshold)
    const failingWal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("disk full");
      }),
    });
    const logger = makeLogger();
    for (let i = 0; i < 3; i++) {
      walWrite(failingWal, "store", {}, logger);
    }

    // Phase 2: a successful write resets the counter to 0
    const goodWal = makeWal();
    walWrite(goodWal, "store", {}, logger);
    expect(goodWal.write).toHaveBeenCalledOnce(); // write reached the WAL
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("WAL disabled")); // counter reset, not tripped

    // Phase 3: verify a fresh 10-failure cycle is needed to re-trip the breaker
    const newFailingWal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    // 9 more failures still shouldn't disable (threshold is 10 from zero)
    for (let i = 0; i < 9; i++) {
      walWrite(newFailingWal, "store", {}, logger);
    }
    // The 10th failure trips the breaker; subsequent calls are silenced
    walWrite(newFailingWal, "store", {}, logger);
    const disabledLogger = makeLogger();
    walWrite(newFailingWal, "store", {}, disabledLogger);
    // After breaker trips, no more write attempts
    expect(newFailingWal.write).toHaveBeenCalledTimes(10);
  });
});

// ---------------------------------------------------------------------------
// walWrite — failure accumulation
// ---------------------------------------------------------------------------

describe("walWrite — failure accumulation", () => {
  it("logs a warning on each failure", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("io error");
      }),
    });
    const logger = makeLogger();

    walWrite(wal, "store", {}, logger);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain("WAL write failed");
  });

  it("does not disable WAL before 10 consecutive failures", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("io error");
      }),
    });
    const logger = makeLogger();

    for (let i = 0; i < 9; i++) {
      walWrite(wal, "store", {}, logger);
    }

    // Still calling write on the 9th attempt (not disabled yet)
    expect(wal.write).toHaveBeenCalledTimes(9);
    const disableWarning = logger.warn.mock.calls.some(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("WAL disabled"),
    );
    expect(disableWarning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// walWrite — circuit breaker trip at threshold 10
// ---------------------------------------------------------------------------

describe("walWrite — circuit breaker trips at 10 consecutive failures", () => {
  it("disables WAL and logs a disable warning after the 10th consecutive failure", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("persistent failure");
      }),
    });
    const logger = makeLogger();

    for (let i = 0; i < 10; i++) {
      walWrite(wal, "store", {}, logger);
    }

    expect(wal.write).toHaveBeenCalledTimes(10);
    const disableWarning = logger.warn.mock.calls.some(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("WAL disabled"),
    );
    expect(disableWarning).toBe(true);
  });

  it("silences subsequent write attempts after breaker is tripped", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("persistent failure");
      }),
    });
    const logger = makeLogger();

    for (let i = 0; i < 10; i++) {
      walWrite(wal, "store", {}, logger);
    }

    // Additional calls should NOT invoke wal.write
    const callsBefore = (wal.write as ReturnType<typeof vi.fn>).mock.calls.length;
    walWrite(wal, "store", { extra: true }, logger);
    walWrite(wal, "update", { extra: true }, logger);

    expect((wal.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it("still returns a valid id even when WAL is disabled", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    const logger = makeLogger();

    for (let i = 0; i < 10; i++) {
      walWrite(wal, "store", {}, logger);
    }

    const id = walWrite(wal, "store", {}, logger);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// _resetWalCircuitBreakerForTesting — reset recovery
// ---------------------------------------------------------------------------

describe("_resetWalCircuitBreakerForTesting — reset recovery", () => {
  it("re-enables WAL writes after a breaker trip", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    const logger = makeLogger();

    // Trip the breaker
    for (let i = 0; i < 10; i++) {
      walWrite(wal, "store", {}, logger);
    }

    // Reset and verify writes are accepted again
    _resetWalCircuitBreakerForTesting();

    const goodWal = makeWal();
    const freshLogger = makeLogger();
    walWrite(goodWal, "store", { after: "reset" }, freshLogger);

    expect(goodWal.write).toHaveBeenCalledOnce();
    expect(freshLogger.warn).not.toHaveBeenCalled();
  });

  it("allows a fresh 10-failure cycle after reset", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    const logger = makeLogger();

    // Trip
    for (let i = 0; i < 10; i++) walWrite(wal, "store", {}, logger);

    // Reset
    _resetWalCircuitBreakerForTesting();

    // 9 new failures should NOT re-trip
    const wal2 = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    const logger2 = makeLogger();
    for (let i = 0; i < 9; i++) walWrite(wal2, "store", {}, logger2);

    const disabled = logger2.warn.mock.calls.some(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("WAL disabled"),
    );
    expect(disabled).toBe(false);
    expect(wal2.write).toHaveBeenCalledTimes(9);
  });
});

// ---------------------------------------------------------------------------
// walRemove — happy path
// ---------------------------------------------------------------------------

describe("walRemove — happy path", () => {
  it("calls wal.remove with the given id", () => {
    const wal = makeWal();
    const logger = makeLogger();

    walRemove(wal, "some-uuid", logger);

    expect(wal.remove).toHaveBeenCalledOnce();
    expect(wal.remove).toHaveBeenCalledWith("some-uuid");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when wal is null", () => {
    const logger = makeLogger();
    // Should not throw
    expect(() => walRemove(null, "some-uuid", logger)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when wal.remove throws", () => {
    const wal = makeWal({
      remove: vi.fn().mockImplementation(() => {
        throw new Error("remove failed");
      }),
    });
    const logger = makeLogger();

    walRemove(wal, "bad-id", logger);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain("WAL cleanup failed");
  });
});

// ---------------------------------------------------------------------------
// Test isolation — breaker state does not leak between tests
// ---------------------------------------------------------------------------

describe("test isolation — breaker state resets between tests", () => {
  it("first test: trip the breaker", () => {
    const wal = makeWal({
      write: vi.fn().mockImplementation(() => {
        throw new Error("fail");
      }),
    });
    const logger = makeLogger();
    for (let i = 0; i < 10; i++) walWrite(wal, "store", {}, logger);
    const disabled = logger.warn.mock.calls.some(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("WAL disabled"),
    );
    expect(disabled).toBe(true);
  });

  it("second test: breaker is reset — write succeeds cleanly", () => {
    const wal = makeWal();
    const logger = makeLogger();
    walWrite(wal, "store", { isolation: "verified" }, logger);
    expect(wal.write).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
