# Enhancement Issue: Centralized Timer Lifecycle Management

**To file this as a GitHub issue, copy the content below into a new issue on the repository.**

---

**Title:** Enhancement: Centralized Timer Lifecycle Management

**Labels:** enhancement, refactoring, technical-debt

**Priority:** Medium

**Effort:** 6-8 weeks

---

## Summary

Create a centralized `TimerManager` utility class to consolidate timer lifecycle management across the plugin, preventing race conditions and ensuring consistent cleanup patterns.

## Motivation

The codebase currently has 150+ timer call sites (`setTimeout`, `setInterval`, `setImmediate`) scattered across multiple files with inconsistent lifecycle management patterns. Recent fixes (see branch `claude/identify-critical-bug-scope`) addressed critical race conditions where timers accessed closed database connections during shutdown, but each component still manages timers independently, making the code error-prone and difficult to audit.

### Current Problems

1. **Inconsistent Patterns**: Each component implements its own timer management with varying levels of safety
2. **Error-Prone**: Easy to forget database connection checks or cleanup handlers
3. **Hard to Audit**: No centralized view of active timers
4. **Shutdown Complexity**: Each timer requires manual `clearInterval`/`clearTimeout` calls
5. **Race Conditions**: Deferred operations can execute after databases close

### Current Workarounds

After recent fixes, most timers now have:
- Manual `shuttingDown` checks
- Manual `factsDb.isOpen()` checks
- Manual cleanup in shutdown handlers
- Error suppression for "database connection is not open"

This works but is repetitive and maintenance-heavy.

## Proposed Solution

Create a `TimerManager` class that:

### Core Features

1. **Tracks Active Timers**: Maintains a registry of all scheduled operations
2. **Lifecycle-Aware**: Checks database connection state before executing callbacks
3. **Automatic Cleanup**: Clears all timers on shutdown
4. **Type-Safe APIs**: Provides TypeScript-friendly scheduling methods
5. **Graceful Degradation**: Handles shutdown gracefully without errors

### API Design

```typescript
interface TimerManagerOptions {
  shuttingDown: () => boolean;
  isDbOpen?: () => boolean;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

class TimerManager {
  constructor(options: TimerManagerOptions);

  // Schedule a one-time callback
  schedule(callback: () => void | Promise<void>, delayMs: number): TimerHandle;

  // Schedule a repeating callback
  scheduleInterval(callback: () => void | Promise<void>, intervalMs: number): TimerHandle;

  // Schedule for next event loop tick
  scheduleImmediate(callback: () => void | Promise<void>): TimerHandle;

  // Clear a specific timer
  clear(handle: TimerHandle): void;

  // Clear all timers (called during shutdown)
  clearAll(): void;

  // Get stats for monitoring
  getStats(): { active: number; scheduled: number; immediate: number; interval: number };
}

interface TimerHandle {
  readonly id: string;
  readonly type: 'timeout' | 'interval' | 'immediate';
  cancel(): void;
}
```

## Migration Strategy

### Phase 1: Create Utility (Week 1)

1. Create `extensions/memory-hybrid/utils/timer-manager.ts`
2. Add comprehensive unit tests
3. Document API and usage patterns

### Phase 2: Migrate High-Risk Sites (Week 2-3)

Priority order based on risk:
1. `lifecycle/stage-injection.ts` - Hebbian link strengthening
2. `index.ts` - Cron verification
3. `services/python-bridge.ts` - Request timers
4. `lifecycle/stage-cleanup.ts` - Stale session sweep

### Phase 3: Migrate Plugin Service Timers (Week 4-5)

1. `setup/plugin-service.ts` - Prune timer
2. `setup/plugin-service.ts` - Classify timer
3. `setup/plugin-service.ts` - Language keywords timer
4. `setup/plugin-service.ts` - Passive observer timer
5. `setup/plugin-service.ts` - Watchdog timer

### Phase 4: Migrate Remaining Sites (Week 6-8)

1. Auto-classifier delays
2. Embedding migration delays
3. CLI command timeouts
4. Test utilities (if beneficial)

## Benefits

### For Developers

- **Single Source of Truth**: One place to understand timer behavior
- **Reduced Boilerplate**: No need to manually check shutdown state
- **Type Safety**: TypeScript ensures correct usage
- **Easy Testing**: Mock the TimerManager for tests

### For Operations

- **Better Observability**: `getStats()` shows active timer count
- **Cleaner Shutdown**: Automatic cleanup prevents orphaned timers
- **Reduced Errors**: Fewer "database connection is not open" errors in logs

### For Maintenance

- **Easier Audits**: All timer call sites use the same API
- **Consistent Patterns**: Same error handling everywhere
- **Future-Proof**: Easy to add features (e.g., rate limiting, retry logic)

## Testing Requirements

1. **Unit Tests**:
   - Timer creation and cleanup
   - Shutdown state checks
   - Database connection checks
   - Error handling and suppression
   - Stats reporting

2. **Integration Tests**:
   - Plugin reload with active timers
   - Graceful shutdown scenarios
   - Database connection loss during timer execution

3. **Performance Tests**:
   - Overhead of wrapped callbacks
   - Memory usage with many timers
   - Cleanup performance

## Success Metrics

- [ ] Zero "database connection is not open" errors from timer callbacks
- [ ] All timers cleared within 5 seconds of shutdown initiation
- [ ] <1ms overhead per timer callback
- [ ] 100% test coverage for TimerManager
- [ ] All high-risk timer sites migrated

## Related

- Timer race condition fixes in branch `claude/identify-critical-bug-scope`
- See `TIMER_RACE_CONDITIONS_ANALYSIS.md` for complete technical analysis
- Builds on fixes for race conditions in Hebbian links, cron verification, Python bridge, etc.

## Out of Scope

- Changing Node.js timer behavior
- Replacing `async`/`await` patterns
- Modifying test utilities (separate effort)

## Questions for Discussion

1. Should TimerManager be a singleton or per-context instance?
2. Should it integrate with GlitchTip for timer telemetry?
3. Should it support priority scheduling?
4. Should it provide timer coalescing for performance?

---

**Implementation Note:** This is an optional enhancement that builds on the immediate race condition fixes. The current fixes work well, but this consolidation would make the codebase more maintainable long-term.
