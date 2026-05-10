import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerManager } from "../utils/timer-manager.js";

describe("TimerManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("schedule (one-time timeout)", () => {
    it("executes callback after delay", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("skips callback when shuttingDown is true", async () => {
      vi.useFakeTimers();
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      shutdownFlag = true;
      vi.advanceTimersByTime(1000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips callback when database is closed", async () => {
      vi.useFakeTimers();
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const manager = new TimerManager({ shuttingDown, isDbOpen });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      dbOpen = false;
      vi.advanceTimersByTime(1000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("clears timer after execution", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      expect(manager.getStats().scheduled).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(manager.getStats().scheduled).toBe(0);
    });

    it("allows manual cancellation via handle.cancel()", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.schedule(callback, 1000);
      expect(manager.getStats().scheduled).toBe(1);

      handle.cancel();
      expect(manager.getStats().scheduled).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("allows manual cancellation via manager.clear()", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.schedule(callback, 1000);
      manager.clear(handle);

      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("handles async callback", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn(async () => {
        await Promise.resolve("done");
      });

      manager.schedule(callback, 1000);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("suppresses 'database connection is not open' errors", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("The database connection is not open");
      });

      manager.schedule(callback, 1000);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("logs other errors via logger.warn", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("Unexpected error");
      });

      manager.schedule(callback, 1000);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected error"));
    });

    it("suppresses async 'database connection is not open' errors", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(async () => {
        throw new Error("database connection is not open");
      });

      manager.schedule(callback, 1000);
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("logs debug message when skipped due to shutdown", async () => {
      vi.useFakeTimers();
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const debugSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { debug: debugSpy } });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      shutdownFlag = true;
      vi.advanceTimersByTime(1000);

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("skipped (shutting down)"));
    });

    it("logs debug message when skipped due to closed database", async () => {
      vi.useFakeTimers();
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const debugSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, isDbOpen, logger: { debug: debugSpy } });
      const callback = vi.fn();

      manager.schedule(callback, 1000);
      dbOpen = false;
      vi.advanceTimersByTime(1000);

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("skipped (database closed)"));
    });
  });

  describe("scheduleInterval (repeating timer)", () => {
    it("executes callback repeatedly at interval", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.scheduleInterval(callback, 1000);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("stops and clears interval when shuttingDown becomes true", async () => {
      vi.useFakeTimers();
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.scheduleInterval(callback, 1000);
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      shutdownFlag = true;
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
      expect(manager.getStats().interval).toBe(0); // Cleared
    });

    it("stops and clears interval when database closes", async () => {
      vi.useFakeTimers();
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const manager = new TimerManager({ shuttingDown, isDbOpen });
      const callback = vi.fn();

      manager.scheduleInterval(callback, 1000);
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      dbOpen = false;
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
      expect(manager.getStats().interval).toBe(0); // Cleared
    });

    it("allows manual cancellation via handle.cancel()", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.scheduleInterval(callback, 1000);
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      handle.cancel();
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    it("suppresses 'database connection is not open' errors", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("database connection is not open");
      });

      const handle = manager.scheduleInterval(callback, 1000);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();

      handle.cancel();
    });

    it("logs other errors via logger.warn", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("Unexpected error");
      });

      const handle = manager.scheduleInterval(callback, 1000);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected error"));

      handle.cancel();
    });
  });

  describe("scheduleImmediate (next tick)", () => {
    it("executes callback on next tick", async () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      expect(callback).not.toHaveBeenCalled();

      // Wait for immediate to execute
      await new Promise((resolve) => setImmediate(resolve));
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("skips callback when shuttingDown is true", async () => {
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      shutdownFlag = true;
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips callback when database is closed", async () => {
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const manager = new TimerManager({ shuttingDown, isDbOpen });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      dbOpen = false;
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).not.toHaveBeenCalled();
    });

    it("clears timer after execution", async () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      expect(manager.getStats().immediate).toBe(1);

      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.getStats().immediate).toBe(0);
    });

    it("allows manual cancellation via handle.cancel()", async () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.scheduleImmediate(callback);
      handle.cancel();

      await new Promise((resolve) => setImmediate(resolve));
      expect(callback).not.toHaveBeenCalled();
    });

    it("suppresses 'database connection is not open' errors", async () => {
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("The database connection is not open");
      });

      manager.scheduleImmediate(callback);
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("logs other errors via logger.warn", async () => {
      const shuttingDown = () => false;
      const warnSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { warn: warnSpy } });
      const callback = vi.fn(() => {
        throw new Error("Unexpected error");
      });

      manager.scheduleImmediate(callback);
      await new Promise((resolve) => setImmediate(resolve));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected error"));
    });

    it("logs debug message when skipped due to shutdown", async () => {
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const debugSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, logger: { debug: debugSpy } });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      shutdownFlag = true;
      await new Promise((resolve) => setImmediate(resolve));

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("skipped (shutting down)"));
    });

    it("logs debug message when skipped due to closed database", async () => {
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const debugSpy = vi.fn();
      const manager = new TimerManager({ shuttingDown, isDbOpen, logger: { debug: debugSpy } });
      const callback = vi.fn();

      manager.scheduleImmediate(callback);
      dbOpen = false;
      await new Promise((resolve) => setImmediate(resolve));

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("skipped (database closed)"));
    });
  });

  describe("clearAll", () => {
    it("clears all active timers", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      manager.schedule(callback1, 1000);
      manager.scheduleInterval(callback2, 1000);
      manager.scheduleImmediate(callback3);

      expect(manager.getStats().active).toBe(3);

      manager.clearAll();
      expect(manager.getStats().active).toBe(0);

      vi.advanceTimersByTime(2000);
      // Note: Can't test immediate with fake timers

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).not.toHaveBeenCalled();
    });

    it("handles empty timer registry", () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      expect(() => manager.clearAll()).not.toThrow();
      expect(manager.getStats().active).toBe(0);
    });

    it("can be called multiple times safely", () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      manager.schedule(() => {}, 1000);
      manager.clearAll();
      expect(manager.getStats().active).toBe(0);

      manager.clearAll();
      expect(manager.getStats().active).toBe(0);
    });
  });

  describe("getStats", () => {
    it("returns correct stats for empty manager", () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const stats = manager.getStats();
      expect(stats.active).toBe(0);
      expect(stats.scheduled).toBe(0);
      expect(stats.immediate).toBe(0);
      expect(stats.interval).toBe(0);
    });

    it("returns correct stats for mixed timers", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      manager.schedule(() => {}, 1000);
      manager.schedule(() => {}, 2000);
      manager.scheduleInterval(() => {}, 1000);
      manager.scheduleImmediate(() => {});
      manager.scheduleImmediate(() => {});
      manager.scheduleImmediate(() => {});

      const stats = manager.getStats();
      expect(stats.active).toBe(6);
      expect(stats.scheduled).toBe(2);
      expect(stats.interval).toBe(1);
      expect(stats.immediate).toBe(3);
    });

    it("updates stats after timer execution", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      manager.schedule(() => {}, 1000);
      expect(manager.getStats().scheduled).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(manager.getStats().scheduled).toBe(0);
    });

    it("updates stats after cancellation", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle = manager.schedule(() => {}, 1000);
      expect(manager.getStats().scheduled).toBe(1);

      handle.cancel();
      expect(manager.getStats().scheduled).toBe(0);
    });
  });

  describe("clear (individual timer)", () => {
    it("clears timeout timer", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.schedule(callback, 1000);
      manager.clear(handle);

      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("clears interval timer", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.scheduleInterval(callback, 1000);
      manager.clear(handle);

      vi.advanceTimersByTime(2000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("clears immediate callback", async () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });
      const callback = vi.fn();

      const handle = manager.scheduleImmediate(callback);
      manager.clear(handle);

      await new Promise((resolve) => setImmediate(resolve));
      expect(callback).not.toHaveBeenCalled();
    });

    it("handles clearing non-existent timer gracefully", () => {
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const fakeHandle = { id: "non-existent", type: "timeout" as const, cancel: () => {} };
      expect(() => manager.clear(fakeHandle)).not.toThrow();
    });

    it("handles clearing already-executed timer gracefully", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle = manager.schedule(() => {}, 1000);
      vi.advanceTimersByTime(1000);

      // Timer already executed and removed
      expect(() => manager.clear(handle)).not.toThrow();
    });
  });

  describe("TimerHandle", () => {
    it("has correct properties for timeout", () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle = manager.schedule(() => {}, 1000);
      expect(handle.id).toMatch(/^timer-\d+$/);
      expect(handle.type).toBe("timeout");
      expect(typeof handle.cancel).toBe("function");
    });

    it("has correct properties for interval", () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle = manager.scheduleInterval(() => {}, 1000);
      expect(handle.id).toMatch(/^interval-\d+$/);
      expect(handle.type).toBe("interval");
      expect(typeof handle.cancel).toBe("function");
    });

    it("has correct properties for immediate", () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle = manager.scheduleImmediate(() => {});
      expect(handle.id).toMatch(/^immediate-\d+$/);
      expect(handle.type).toBe("immediate");
      expect(typeof handle.cancel).toBe("function");
    });

    it("generates unique IDs", () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const handle1 = manager.schedule(() => {}, 1000);
      const handle2 = manager.schedule(() => {}, 1000);
      const handle3 = manager.scheduleInterval(() => {}, 1000);

      expect(handle1.id).not.toBe(handle2.id);
      expect(handle2.id).not.toBe(handle3.id);
    });
  });

  describe("integration scenarios", () => {
    it("simulates shutdown sequence", async () => {
      vi.useFakeTimers();
      let shutdownFlag = false;
      const shuttingDown = () => shutdownFlag;
      const manager = new TimerManager({ shuttingDown });

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      // Schedule timers (excluding immediate since it's hard to test with fake timers)
      manager.schedule(callback1, 1000);
      manager.scheduleInterval(callback2, 500);

      // Let some timers execute
      vi.advanceTimersByTime(500);
      expect(callback2).toHaveBeenCalledTimes(1);

      // Trigger shutdown
      shutdownFlag = true;
      manager.clearAll();

      // Verify no more callbacks execute
      vi.advanceTimersByTime(2000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1); // Only the one from before shutdown
    });

    it("simulates database connection loss", async () => {
      vi.useFakeTimers();
      let dbOpen = true;
      const shuttingDown = () => false;
      const isDbOpen = () => dbOpen;
      const manager = new TimerManager({ shuttingDown, isDbOpen });

      const callback = vi.fn();

      // Schedule interval that runs while DB is open
      manager.scheduleInterval(callback, 1000);

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2);

      // Database closes
      dbOpen = false;

      // Next execution should detect closed DB and stop
      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(2); // No new calls
      expect(manager.getStats().interval).toBe(0); // Timer cleared
    });

    it("handles mixed lifecycle states", async () => {
      vi.useFakeTimers();
      let shutdownFlag = false;
      let dbOpen = true;
      const shuttingDown = () => shutdownFlag;
      const isDbOpen = () => dbOpen;
      const manager = new TimerManager({ shuttingDown, isDbOpen });

      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      manager.schedule(callback1, 1000);
      manager.schedule(callback2, 2000);
      manager.schedule(callback3, 3000);

      // First timer executes normally
      vi.advanceTimersByTime(1000);
      expect(callback1).toHaveBeenCalledTimes(1);

      // DB closes before second timer
      dbOpen = false;
      vi.advanceTimersByTime(1000);
      expect(callback2).not.toHaveBeenCalled();

      // Shutdown before third timer
      shutdownFlag = true;
      vi.advanceTimersByTime(1000);
      expect(callback3).not.toHaveBeenCalled();
    });
  });

  describe("performance and cleanup", () => {
    it("clears native timer handles properly", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const clearImmediateSpy = vi.spyOn(globalThis, "clearImmediate");

      const handle1 = manager.schedule(() => {}, 1000);
      const handle2 = manager.scheduleImmediate(() => {});

      manager.clear(handle1);
      manager.clear(handle2);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(clearImmediateSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
      clearImmediateSpy.mockRestore();
    });

    it("does not leak memory after many timer cycles", async () => {
      vi.useFakeTimers();
      const shuttingDown = () => false;
      const manager = new TimerManager({ shuttingDown });

      // Schedule and execute many timers
      for (let i = 0; i < 100; i++) {
        manager.schedule(() => {}, 1000);
        vi.advanceTimersByTime(1000);
      }

      // All timers should be cleaned up
      expect(manager.getStats().active).toBe(0);
    });
  });
});
