# Write-Ahead Log (WAL) for Crash Resilience

## Overview

The Write-Ahead Log (WAL) feature provides crash resilience for the OpenClaw Hybrid Memory system. It ensures that memory operations (decisions, user preferences, facts) are not lost if the agent crashes, times out, or the session is killed during generation.

## Problem

Previously, memory updates happened asynchronously or alongside the response generation. If the agent crashed during generation, critical context could be lost, including:

- User decisions and preferences
- Important facts discovered during conversation
- Entity relationships and structured data
- Auto-captured memories from long-running tasks

## Solution

The WAL implementation follows a **pre-flight commit** pattern:

1. **Before Storage**: Write pending memory operations to a durable WAL file
2. **Commit**: Store the memory to SQLite and LanceDB
3. **Cleanup**: Remove the WAL entry after successful commit
4. **Recovery**: On startup, replay any uncommitted operations from the WAL

## Architecture

### WAL Entry Structure

```typescript
type WALEntry = {
  id: string;              // Unique identifier for this operation
  timestamp: number;       // Unix timestamp (ms) when operation was logged
  operation: "store" | "delete" | "update";
  data: {
    text: string;
    category?: string;
    importance?: number;
    entity?: string | null;
    key?: string | null;
    value?: string | null;
    source?: string;
    decayClass?: DecayClass;
    summary?: string | null;
    tags?: string[];
    vector?: number[];     // Pre-computed embedding for faster recovery
  };
};
```

### File Format

The WAL is stored as a JSON array in `~/.openclaw/memory/memory.wal` (or custom path via config). Each entry represents a pending operation that has not yet been confirmed as committed.

### Recovery Process

On plugin startup, the system:

1. Reads all entries from the WAL file
2. Filters out stale entries (older than `maxAge`, default 5 minutes)
3. For each valid entry:
   - Checks if the memory already exists (idempotency)
   - If not, commits it to SQLite and LanceDB
   - Removes the entry from the WAL
4. Logs recovery statistics

## Configuration

### Enable/Disable WAL

WAL is **enabled by default** for crash resilience. To disable:

```json
{
  "plugins": {
    "entries": {
      "openclaw-hybrid-memory": {
        "config": {
          "wal": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

### Custom WAL Path

```json
{
  "wal": {
    "enabled": true,
    "walPath": "/custom/path/to/memory.wal"
  }
}
```

### Maximum Age

Control how long WAL entries are considered valid (default: 5 minutes):

```json
{
  "wal": {
    "enabled": true,
    "maxAge": 300000  // milliseconds (5 minutes)
  }
}
```

## Behavior

### Normal Operation

1. User/agent triggers memory storage (via `memory_store` tool or auto-capture)
2. System generates embedding vector
3. **WAL write** (synchronous, durable)
4. Commit to SQLite (synchronous)
5. Commit to LanceDB (async)
6. **WAL cleanup** (remove committed entry)

### Crash Scenario

1. User/agent triggers memory storage
2. System generates embedding vector
3. **WAL write** (synchronous, durable) ✓
4. Commit to SQLite starts...
5. **CRASH** (agent timeout, kill signal, system failure)
6. On next startup:
   - WAL recovery detects uncommitted entry
   - Replays the operation
   - Memory is restored

### Idempotency

The recovery process is idempotent:

- Before replaying a WAL entry, the system checks if the memory already exists (via fuzzy deduplication)
- If the memory was partially committed before the crash, it won't be duplicated
- This handles cases where the crash happened after SQLite commit but before WAL cleanup

## Performance Impact

### Write Path

- **Synchronous WAL write**: ~1-5ms per operation (local file I/O)
- **Minimal overhead**: Single JSON append operation
- **No network calls**: WAL is purely local

### Startup

- **Recovery check**: ~10-50ms for typical WAL sizes (<100 entries)
- **Replay**: Only uncommitted operations are replayed
- **Pruning**: Stale entries are automatically removed

### Storage

- **File size**: ~1-2KB per entry (including embedding vector)
- **Typical size**: <100KB for normal operation
- **Auto-cleanup**: Entries are removed after successful commit

## Logging

The WAL system logs the following events:

### Startup

```
memory-hybrid: WAL enabled (/home/user/.openclaw/memory/memory.wal)
memory-hybrid: WAL recovery starting — found 3 pending operation(s)
memory-hybrid: WAL recovery completed — recovered 3 operation(s), 0 failed
memory-hybrid: WAL pruned 2 stale entries
```

### Runtime

```
memory-hybrid: WAL write failed: <error>
memory-hybrid: WAL cleanup failed: <error>
memory-hybrid: auto-capture WAL write failed: <error>
```

### Errors

WAL failures are logged as warnings and do not block memory operations. The system degrades gracefully:

- If WAL write fails, the memory is still stored (but not crash-protected)
- If WAL cleanup fails, the entry will be pruned on next startup
- If recovery fails for an entry, it's logged and skipped

## Testing

### Simulated Crash Test

To test WAL recovery:

1. Enable WAL in config
2. Store a memory via `memory_store` tool
3. Kill the OpenClaw process immediately (before it completes)
4. Restart OpenClaw
5. Check logs for "WAL recovery" messages
6. Verify the memory was recovered via `memory_recall`

### Manual WAL Inspection

```bash
cat ~/.openclaw/memory/memory.wal | jq .
```

This shows all pending operations in the WAL.

### Force Recovery

To test recovery without a crash:

1. Manually create a WAL entry in `memory.wal`
2. Restart OpenClaw
3. Check logs for recovery messages

## Comparison to SQLite WAL Mode

This is **not** the same as SQLite's built-in WAL mode (though they serve similar purposes):

- **SQLite WAL**: Database-level crash recovery for transactions
- **Memory WAL**: Application-level crash recovery for the entire memory pipeline (SQLite + LanceDB + embeddings)

The Memory WAL protects against:

- Crashes during embedding generation (before SQLite write)
- Crashes during LanceDB write (after SQLite write)
- Crashes during multi-step operations (e.g., credential vault + memory pointer)

## Limitations

1. **Not a distributed log**: WAL is local to the machine running OpenClaw
2. **Not a transaction log**: Each operation is independent (no multi-operation transactions)
3. **Best-effort recovery**: If the WAL file is corrupted, recovery may fail
4. **Stale entries**: Entries older than `maxAge` are discarded (not recoverable)

## Future Enhancements

Potential improvements for future versions:

- **Batched writes**: Group multiple operations into a single WAL write
- **Compression**: Reduce WAL file size for large embeddings
- **Rotation**: Archive old WAL files instead of pruning
- **Distributed WAL**: Sync WAL across multiple instances
- **Transaction support**: Multi-operation atomic commits

## Related Features

- **Auto-capture**: Automatically protected by WAL
- **Credentials vault**: Credential storage operations are also WAL-protected
- **Session distillation**: Bulk imports can use WAL for resilience

## Troubleshooting

### WAL file growing too large

- Check for failed operations that aren't being cleaned up
- Verify `maxAge` is set appropriately
- Manually clear the WAL: `rm ~/.openclaw/memory/memory.wal`

### Recovery not working

- Check WAL file exists and is readable
- Verify `wal.enabled` is `true` in config
- Check logs for recovery errors
- Ensure entries are within `maxAge` window

### Performance issues

- If WAL writes are slow, check disk I/O
- Consider moving WAL to faster storage (SSD)
- Reduce `maxAge` to keep WAL smaller

## References

- [Elite Longterm Memory](https://github.com/example/elite-longterm-memory) - Inspiration for WAL pattern
- [SQLite WAL Mode](https://www.sqlite.org/wal.html) - Database-level WAL
- [Write-Ahead Logging](https://en.wikipedia.org/wiki/Write-ahead_logging) - General concept
