/**
 * Centralized timer lifecycle management utility.
 * Provides safe scheduling of timeouts, intervals, and immediate callbacks
 * with automatic shutdown state checking and cleanup.
 */

export interface TimerManagerOptions {
  /** Function to check if shutdown is in progress */
  shuttingDown: () => boolean;
  /** Optional function to check if database is open */
  isDbOpen?: () => boolean;
  /** Optional logger for diagnostics */
  logger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

export interface TimerHandle {
  /** Unique identifier for this timer */
  readonly id: string;
  /** Type of timer */
  readonly type: "timeout" | "interval" | "immediate";
  /** Cancel this specific timer */
  cancel(): void;
}

interface TimerEntry {
  type: "timeout" | "interval" | "immediate";
  handle: NodeJS.Timeout | NodeJS.Immediate;
  callback: () => void | Promise<void>;
}

export interface TimerStats {
  /** Total number of active timers */
  active: number;
  /** Number of scheduled (one-time) timers */
  scheduled: number;
  /** Number of immediate callbacks */
  immediate: number;
  /** Number of interval (repeating) timers */
  interval: number;
}

/**
 * TimerManager provides centralized lifecycle management for all timers,
 * ensuring proper cleanup and preventing race conditions during shutdown.
 */
export class TimerManager {
  private timers = new Map<string, TimerEntry>();
  private nextId = 1;
  private readonly options: TimerManagerOptions;

  constructor(options: TimerManagerOptions) {
    this.options = options;
  }

  /**
   * Schedule a one-time callback after a delay.
   * The callback will be skipped if shutdown is in progress or database is closed.
   */
  schedule(callback: () => void | Promise<void>, delayMs: number): TimerHandle {
    const id = `timer-${this.nextId++}`;

    const wrappedCallback = () => {
      // Check shutdown state
      if (this.options.shuttingDown()) {
        this.options.logger?.debug?.(`Timer ${id} skipped (shutting down)`);
        this.timers.delete(id);
        return;
      }

      // Check database state if provided
      if (this.options.isDbOpen && !this.options.isDbOpen()) {
        this.options.logger?.debug?.(`Timer ${id} skipped (database closed)`);
        this.timers.delete(id);
        return;
      }

      // Execute callback with error handling
      try {
        const result = callback();
        if (result instanceof Promise) {
          result.catch((err) => {
            // Suppress expected shutdown errors
            if (!/database connection is not open/i.test(String(err))) {
              this.options.logger?.warn?.(`Timer ${id} callback failed: ${err}`);
            }
          });
        }
      } catch (err) {
        // Suppress expected shutdown errors
        if (!/database connection is not open/i.test(String(err))) {
          this.options.logger?.warn?.(`Timer ${id} callback failed: ${err}`);
        }
      } finally {
        this.timers.delete(id);
      }
    };

    const handle = setTimeout(wrappedCallback, delayMs);
    this.timers.set(id, { type: "timeout", handle, callback });

    return {
      id,
      type: "timeout",
      cancel: () => this.clear({ id, type: "timeout", cancel: () => {} }),
    };
  }

  /**
   * Schedule a repeating callback at a fixed interval.
   * The callback will be skipped if shutdown is in progress or database is closed.
   */
  scheduleInterval(callback: () => void | Promise<void>, intervalMs: number): TimerHandle {
    const id = `interval-${this.nextId++}`;

    const wrappedCallback = () => {
      // Check shutdown state
      if (this.options.shuttingDown()) {
        this.clear({ id, type: "interval", cancel: () => {} });
        return;
      }

      // Check database state if provided
      if (this.options.isDbOpen && !this.options.isDbOpen()) {
        this.clear({ id, type: "interval", cancel: () => {} });
        return;
      }

      // Execute callback with error handling
      try {
        const result = callback();
        if (result instanceof Promise) {
          result.catch((err) => {
            // Suppress expected shutdown errors
            if (!/database connection is not open/i.test(String(err))) {
              this.options.logger?.warn?.(`Interval ${id} callback failed: ${err}`);
            }
          });
        }
      } catch (err) {
        // Suppress expected shutdown errors
        if (!/database connection is not open/i.test(String(err))) {
          this.options.logger?.warn?.(`Interval ${id} callback failed: ${err}`);
        }
      }
    };

    const handle = setInterval(wrappedCallback, intervalMs);
    this.timers.set(id, { type: "interval", handle, callback });

    return {
      id,
      type: "interval",
      cancel: () => this.clear({ id, type: "interval", cancel: () => {} }),
    };
  }

  /**
   * Schedule a callback for the next event loop tick.
   * The callback will be skipped if shutdown is in progress or database is closed.
   */
  scheduleImmediate(callback: () => void | Promise<void>): TimerHandle {
    const id = `immediate-${this.nextId++}`;

    const wrappedCallback = () => {
      // Check shutdown state
      if (this.options.shuttingDown()) {
        this.options.logger?.debug?.(`Immediate ${id} skipped (shutting down)`);
        this.timers.delete(id);
        return;
      }

      // Check database state if provided
      if (this.options.isDbOpen && !this.options.isDbOpen()) {
        this.options.logger?.debug?.(`Immediate ${id} skipped (database closed)`);
        this.timers.delete(id);
        return;
      }

      // Execute callback with error handling
      try {
        const result = callback();
        if (result instanceof Promise) {
          result.catch((err) => {
            // Suppress expected shutdown errors
            if (!/database connection is not open/i.test(String(err))) {
              this.options.logger?.warn?.(`Immediate ${id} callback failed: ${err}`);
            }
          });
        }
      } catch (err) {
        // Suppress expected shutdown errors
        if (!/database connection is not open/i.test(String(err))) {
          this.options.logger?.warn?.(`Immediate ${id} callback failed: ${err}`);
        }
      } finally {
        this.timers.delete(id);
      }
    };

    const handle = setImmediate(wrappedCallback);
    this.timers.set(id, { type: "immediate", handle, callback });

    return {
      id,
      type: "immediate",
      cancel: () => this.clear({ id, type: "immediate", cancel: () => {} }),
    };
  }

  /**
   * Clear a specific timer by its handle.
   */
  clear(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (!timer) return;

    if (timer.type === "timeout" || timer.type === "interval") {
      clearTimeout(timer.handle as NodeJS.Timeout);
    } else {
      clearImmediate(timer.handle as NodeJS.Immediate);
    }

    this.timers.delete(handle.id);
  }

  /**
   * Clear all active timers.
   * Typically called during shutdown to ensure clean termination.
   */
  clearAll(): void {
    for (const [_id, timer] of this.timers) {
      if (timer.type === "timeout" || timer.type === "interval") {
        clearTimeout(timer.handle as NodeJS.Timeout);
      } else {
        clearImmediate(timer.handle as NodeJS.Immediate);
      }
    }
    this.timers.clear();
  }

  /**
   * Get statistics about active timers for monitoring.
   */
  getStats(): TimerStats {
    let scheduled = 0;
    let immediate = 0;
    let interval = 0;

    for (const timer of this.timers.values()) {
      if (timer.type === "timeout") scheduled++;
      else if (timer.type === "immediate") immediate++;
      else interval++;
    }

    return {
      active: this.timers.size,
      scheduled,
      immediate,
      interval,
    };
  }
}
