type LoggerLike = {
  info?: (msg: string) => void;
};

type CheckpointTagValue = string | number | boolean | null | undefined;

export interface StartupMemoryCheckpointEntry {
  timestamp: string;
  owner: string;
  subsystem: string;
  operation: string;
  phase: string;
  rssBytes: number;
  rssDeltaBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  activeHandles: number;
  activeRequests: number;
  tags: Record<string, CheckpointTagValue>;
}

const MAX_STORED_ENTRIES = 64;
const emittedOnceKeys = new Set<string>();
const entries: StartupMemoryCheckpointEntry[] = [];
let baselineRssBytes: number | null = null;

function getActiveHandlesCount(): number {
  // Undocumented Node.js internals used for diagnostics-only attribution.
  // Return -1 when not available on the current runtime.
  const proc = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
  if (typeof proc._getActiveHandles !== "function") return -1;
  return proc._getActiveHandles()?.length ?? -1;
}

function getActiveRequestsCount(): number {
  // Undocumented Node.js internals used for diagnostics-only attribution.
  // Return -1 when not available on the current runtime.
  const proc = process as NodeJS.Process & { _getActiveRequests?: () => unknown[] };
  if (typeof proc._getActiveRequests !== "function") return -1;
  return proc._getActiveRequests()?.length ?? -1;
}

function stringifyTags(tags: Record<string, CheckpointTagValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function resetStartupMemoryAttributionForTests(): void {
  emittedOnceKeys.clear();
  entries.length = 0;
  baselineRssBytes = null;
}

export function getStartupMemoryAttributionEntries(): StartupMemoryCheckpointEntry[] {
  return [...entries];
}

export function recordStartupMemoryCheckpoint(opts: {
  logger?: LoggerLike;
  subsystem: string;
  operation: string;
  phase: string;
  owner?: string;
  onceKey?: string;
  tags?: Record<string, CheckpointTagValue>;
}): StartupMemoryCheckpointEntry | null {
  const onceKey = opts.onceKey ?? `${opts.subsystem}:${opts.operation}:${opts.phase}`;
  if (emittedOnceKeys.has(onceKey)) {
    return null;
  }
  emittedOnceKeys.add(onceKey);

  const usage = process.memoryUsage();
  if (baselineRssBytes === null) {
    baselineRssBytes = usage.rss;
  }

  const entry: StartupMemoryCheckpointEntry = {
    timestamp: new Date().toISOString(),
    owner: opts.owner ?? "hybrid-memory",
    subsystem: opts.subsystem,
    operation: opts.operation,
    phase: opts.phase,
    rssBytes: usage.rss,
    rssDeltaBytes: usage.rss - baselineRssBytes,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    activeHandles: getActiveHandlesCount(),
    activeRequests: getActiveRequestsCount(),
    tags: opts.tags ?? {},
  };

  entries.push(entry);
  if (entries.length > MAX_STORED_ENTRIES) {
    entries.shift();
  }

  opts.logger?.info?.(
    `memory-hybrid: startup-memory-checkpoint owner=${entry.owner} subsystem=${entry.subsystem} operation=${entry.operation} phase=${entry.phase} rssBytes=${entry.rssBytes} rssDeltaBytes=${entry.rssDeltaBytes} heapUsedBytes=${entry.heapUsedBytes} heapTotalBytes=${entry.heapTotalBytes} externalBytes=${entry.externalBytes} arrayBuffersBytes=${entry.arrayBuffersBytes} activeHandles=${entry.activeHandles} activeRequests=${entry.activeRequests}${stringifyTags(entry.tags)}`,
  );

  return entry;
}
