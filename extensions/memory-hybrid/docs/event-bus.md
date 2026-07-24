# Event Bus — Sensor Event Pipeline

## What Is the Event Bus?

The Event Bus is an append-only SQLite table (`memory_events`) that decouples **sensor sweeps** (producers) from **downstream consumers**. Sensors write raw observations; maintenance and Dream paths read, promote status, and archive them. No direct coupling between producers and consumers is required.

> **Architecture note (#2178):** Earlier docs referred to a single “Rumination Engine” consumer. That module was never shipped as a discrete service. Actual consumers today are **sensor-aware maintenance steps**, **Dream Cycle / Autonomous Dreaming**, and ad-hoc status updates via `EventBus.updateStatus`. The status lifecycle API remains; there is no separate rumination process. See [AUTONOMOUS-DREAMING.md](./AUTONOMOUS-DREAMING.md) for the continual-learning control plane.

## Schema

```sql
CREATE TABLE memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  source      TEXT NOT NULL,
  payload     TEXT NOT NULL,           -- JSON
  importance  REAL NOT NULL DEFAULT 0.5
                CHECK(importance >= 0.0 AND importance <= 1.0),
  status      TEXT NOT NULL DEFAULT 'raw'
                CHECK(status IN ('raw','processed','surfaced','pushed','archived')),
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  fingerprint  TEXT
);
```

Indexed columns: `status`, `event_type`, `created_at`, `fingerprint`.

## Status Lifecycle

```
raw → processed → surfaced → pushed → archived
```

| Status | Meaning |
|--------|---------|
| `raw` | Just written by a sensor; not yet examined |
| `processed` | Examined by a consumer (maintenance / dream / other) |
| `surfaced` | Promoted to agent context or memory |
| `pushed` | Delivered to an external sink |
| `archived` | Eligible for pruning |

`processed_at` is set the first time an event leaves `raw` status and is never overwritten by subsequent transitions.

## API Reference

### `new EventBus(dbPath: string)`

Opens (or creates) the SQLite database at `dbPath`, applies WAL mode, and runs the schema migration.

### `appendEvent(type, source, payload, importance?, fingerprint?): number`

Insert a new event. Returns the auto-generated row `id`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | `string` | required | Event category (e.g. `"context_shift"`) |
| `source` | `string` | required | Originating sensor or subsystem |
| `payload` | `Record<string, unknown>` | required | Arbitrary JSON data |
| `importance` | `number` | `0.5` | Salience score in `[0, 1]` |
| `fingerprint` | `string` | `undefined` | SHA-256 hash for dedup; use `computeFingerprint()` |

Throws `RangeError` if `importance` is outside `[0, 1]` or is `NaN`.

### `queryEvents(filter?): MemoryEvent[]`

Return events matching all supplied filters, ordered by `id ASC`.

```typescript
interface QueryFilter {
  status?: EventStatus;   // exact match
  type?:   string;        // exact match on event_type
  since?:  string;        // ISO 8601 — created_at >= since
  limit?:  number;        // default 100
}
```

### `updateStatus(id: number, newStatus: EventStatus): void`

Transition one event to a new status. Sets `processed_at` on the first non-`raw` transition (subsequent calls leave it unchanged). Throws if no row with `id` exists.

### `dedup(fingerprint: string, cooldownHours?: number): boolean`

Returns `true` if an event with the same fingerprint was written within `cooldownHours` (default `6`). Callers should skip `appendEvent` when `dedup` returns `true`.

### `pruneArchived(olderThanDays?: number): number`

Delete archived events older than `olderThanDays` (default `30`). Returns the count of deleted rows.

### `isOpen(): boolean` / `close(): void`

Connection helpers. `close()` is idempotent.

## Integration Example

```typescript
const bus = new EventBus("~/.openclaw/memory-events.db");

const fp = computeFingerprint(`context_shift:proj-42:switched to testing`);
if (!bus.dedup(fp)) {
  const id = bus.appendEvent(
    "context_shift",
    "passive-observer",
    { project: "proj-42", detail: "switched to testing" },
    0.8,
    fp,
  );

  // A maintenance / dream consumer examines raw events:
  const [event] = bus.queryEvents({ status: "raw", type: "context_shift" });
  bus.updateStatus(event.id, "processed");
  // ... promote to memory, then:
  bus.updateStatus(event.id, "surfaced");
}

bus.pruneArchived(30);
bus.close();
```

## Storage

`memory_events` lives in its own SQLite file, separate from `memory.db` and `event-log.db`.

```
~/.openclaw/
  memory.db          ← Layer 2: long-term facts
  event-log.db       ← Layer 1: session episodic log
  memory-events.db   ← Event Bus: sensor → consumer pipeline
  memory-vectors/    ← Layer 3: semantic index
```

## Relation to the Event Log

| | Event Log (`event-log.ts`) | Event Bus (`event-bus.ts`) |
|--|---|---|
| Producer | Agent conversation hooks | Sensor sweeps |
| Consumer | Dream Cycle / consolidation / Autonomous Dreaming | Maintenance steps, Dream paths, ad-hoc `updateStatus` |
| Scope | Session-scoped episodes | Cross-session observations |
| Key field | `sessionId` | `fingerprint`, `status` |
| Dedup | No | Yes (cooldown window) |
