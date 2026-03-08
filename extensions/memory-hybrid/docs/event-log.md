# Event Log — Episodic Memory Layer (Layer 1)

## What Is the Event Log?

The event log is the first layer of the three-layer memory architecture. It is a high-fidelity journal of everything that happens during a session: facts learned, decisions made, actions taken, entities mentioned, preferences expressed, and corrections.

Raw episodic events are cheap to write and cheap to store. They are the raw material that later layers refine. Rather than immediately deciding whether something is worth remembering long-term, the event log captures it first and asks questions later.

## Three-Layer Architecture

```
Layer 1 — Event Log      (this file)
  Raw episodic events. Append-only. Session-scoped. High volume.
  → gets consolidated into →

Layer 2 — Facts (SQLite + FTS5)
  Structured long-term memory. Deduplicated. Decayed. Searchable.
  → gets distilled into →

Layer 3 — Vector Index (LanceDB)
  Semantic embeddings. Approximate similarity search.
```

Layers 2 and 3 already exist. The event log adds a pre-consolidation buffer that gives future subsystems (Passive Observer, Dream Cycle) something to work with.

## Event Types

| Type | When to use |
|------|-------------|
| `fact_learned` | The agent or user stated a new piece of information |
| `decision_made` | A choice was made (tool selection, approach, preference) |
| `action_taken` | Something was done: a file was edited, a command was run |
| `entity_mentioned` | A person, project, tool, or concept was referenced |
| `preference_expressed` | The user stated a like, dislike, or habit |
| `correction` | A previous statement was corrected or contradicted |

## Data Model

```typescript
interface EventLogEntry {
  id: string;                          // UUID v4
  sessionId: string;                   // Which conversation/session
  timestamp: string;                   // ISO 8601 — when it happened
  eventType: EventType;                // See table above
  content: Record<string, unknown>;    // Free-form payload
  entities?: string[];                 // Named entities involved
  consolidatedInto?: string;           // Set when merged into a fact (Layer 2)
  metadata?: Record<string, unknown>;  // Provenance, confidence, etc.
  createdAt: string;                   // ISO 8601 — when the row was written
}
```

`content` is intentionally untyped. Different event types can store different shapes. The important thing is that something was captured; the Dream Cycle will interpret it later.

## Lifecycle: Capture → Consolidate → Archive

```
CAPTURE   append() / appendBatch()
            ↓
CONSOLIDATE markConsolidated(eventIds, factId)
              → fact is written to Layer 2
              → event_log.consolidated_into = factId
            ↓
ARCHIVE   archiveConsolidated(days, archiveDir)
            → consolidated rows older than N days are written to
              `~/.openclaw/event-archive/YYYY-MM.jsonl.gz` and deleted
```

Events should be consolidated by the Dream Cycle process (issue #143) and archived after consolidation is confirmed. Unconsolidated events older than a configurable threshold are the primary input to the Dream Cycle.

## Storage

The event log lives in `event-log.db` alongside the main `memory.db` SQLite file. It is an independent database so that it can be vacuumed, archived, or wiped without touching long-term memory.

```
~/.openclaw/
  memory.db         ← Layer 2: long-term facts
  event-log.db      ← Layer 1: episodic events  (this)
  memory-vectors/   ← Layer 3: semantic index
```

## Querying Events

```typescript
// All events in a session
const events = eventLog.getBySession(sessionId);

// Events in a time window, optionally filtered by type
const decisions = eventLog.getByTimeRange(from, to, "decision_made");

// Events not yet consolidated (input for Dream Cycle)
const pending = eventLog.getUnconsolidated(olderThanDays: 1);

// Events involving a specific entity
const aliceEvents = eventLog.getByEntity("Alice");

// Summary statistics
const stats = eventLog.getStats();
// { total, unconsolidated, byType: { fact_learned: 12, ... }, oldestUnconsolidated }
```

## API Reference

### `append(entry): string`
Write a single event. Returns the generated UUID.

### `appendBatch(entries): string[]`
Write multiple events atomically in a single SQLite transaction. Returns UUIDs in input order.

### `getBySession(sessionId, limit?): EventLogEntry[]`
Retrieve events for a session, ordered by timestamp ascending.

### `getByTimeRange(from, to, eventType?): EventLogEntry[]`
Retrieve events whose timestamp falls within `[from, to]` (ISO strings). Optional `eventType` filter.

### `getUnconsolidated(olderThanDays?): EventLogEntry[]`
Retrieve events where `consolidated_into` is null. When `olderThanDays` is given, only returns events older than that threshold.

### `getByEntity(entityName, limit?): EventLogEntry[]`
Retrieve events whose `entities` array contains the exact entity name.

### `markConsolidated(eventIds, factId): void`
Mark a batch of events as consolidated into the given fact id. Runs atomically.

### `archiveConsolidated(olderThanDays, archiveDir): Promise<{ archived, files }>`
Archive consolidated events older than N days into compressed JSONL files and delete them from SQLite.

### `archiveOld(olderThanDays): number`
Delete events whose timestamp is older than N days. Returns the count deleted. (Legacy helper; does not write archives.)

### `getStats(): { total, unconsolidated, byType, oldestUnconsolidated }`
Return aggregate statistics without scanning the whole table.

## Migration Safety

The schema uses `CREATE TABLE IF NOT EXISTS` so it is safe to add on top of existing databases. The event log is a new, separate SQLite file and makes no changes to `memory.db`.
