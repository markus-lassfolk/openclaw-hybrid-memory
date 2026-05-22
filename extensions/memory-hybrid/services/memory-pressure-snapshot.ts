/**
 * Memory Pressure Snapshot — Issue #1551
 *
 * When gateway memory pressure crosses a critical threshold, emit a compact diagnostic bundle
 * to distinguish JS heap, native addon memory, SQLite handles, LanceDB/Arrow buffers,
 * and stale plugin generations.
 *
 * Safety: lightweight, synchronous-first, safe to call from the gateway process.
 * Output: compact JSON blob (log-friendly) + optional JSON artifact written to
 * ~/.openclaw/diagnostics/memory-pressure/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { capturePluginError } from "./error-reporter.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { getEnv } from "../utils/env-manager.js";
import { parseDuration } from "../utils/duration.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryPressureSnapshot {
  /** Wall-clock timestamp ISO-8601 */
  timestamp: string;
  /** process.memoryUsage() — rss, heapTotal, heapUsed, external, arrayBuffers (bytes) */
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  /** Active Node.js handle/request counts */
  activeHandles: number;
  activeRequests: number;
  /** /proc/self/status memory fields on Linux (null on other platforms) */
  linuxProcMem: LinuxProcMem | null;
  /** File descriptors grouped by target path category */
  fdGroups: FdGroup[];
  /** LanceDB + SQLite paths discovered from process fd list */
  dbPaths: {
    sqlite: string[];
    lancedb: string[];
    wal: string[];
    shm: string[];
  };
  /** Plugin runtime generation / registration counts */
  pluginGenerations: {
    lancedbInitGeneration: number;
    lancedbStoreCount: number;
    lancedbOptimizing: boolean;
  };
  /** Hybrid-memory state snapshot */
  hybridMemory: HybridMemorySnapshot;
  /** Cooldown remaining before next snapshot is allowed (seconds) */
  cooldownRemainingSec: number;
}

export type LinuxProcMem = Record<string, string>;

export interface FdGroup {
  /** "sqlite" | "lancedb" | "wal" | "shm" | "socket" | "anon" | "device" | "other" */
  category: string;
  /** Example paths in this group */
  samplePaths: string[];
  count: number;
}

export interface HybridMemorySnapshot {
  /** Resolved SQLite DB path */
  sqlitePath: string | null;
  /** Resolved LanceDB base path */
  lancedbPath: string | null;
  /** Whether LanceDB has been initialised */
  lancedbInitialized: boolean;
  /** Whether LanceDB is currently running an optimize pass */
  lancedbOptimizing: boolean;
  /** Number of open LanceDB table readers (estimated from session count) */
  lancedbOpenReaders: number;
  /** Number of active recall operations in-flight (from LifecycleContext) */
  recallInFlight: number;
  /** Active task entries marked stale */
  staleTaskCount: number;
  /** Total active task entries */
  activeTaskCount: number;
  /** Snapshot of process uptime seconds */
  uptimeSec: number;
  /** Node.js version */
  nodeVersion: string;
  /** Platform */
  platform: string;
}

interface DiagnosticSnapshotConfig {
  /** Enable memory pressure snapshots (default: true) */
  enabled: boolean;
  /** Write JSON artifact to ~/.openclaw/diagnostics/memory-pressure/ (default: false) */
  writeArtifact: boolean;
  /** Minimum seconds between snapshots (rate-limit / cooldown, default: 300) */
  cooldownSec: number;
  /** Include full /proc/self/status fields (default: true on Linux) */
  includeLinuxProcMem: boolean;
  /** Max sample paths per FD group (default: 5) */
  fdGroupSampleLimit: number;
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DiagnosticSnapshotConfig = {
  enabled: true,
  writeArtifact: false,
  cooldownSec: 300,
  includeLinuxProcMem: true,
  fdGroupSampleLimit: 5,
};

// ---------------------------------------------------------------------------
// Rate-limit tracker (module-level, lives for gateway process lifetime)
// ---------------------------------------------------------------------------

let lastSnapshotMs = 0;
let snapshotInProgress = false;

// ---------------------------------------------------------------------------
// Linux /proc/self/status parser
// ---------------------------------------------------------------------------

export function parseLinuxProcMem(): LinuxProcMem | null {
  if (process.platform !== "linux") return null;
  try {
    const content = readFileSync("/proc/self/status", "utf-8");
    const entries = content
      .split("\n")
      .map((line): [string, string] | null => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) return null;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        return key.length > 0 && value.length > 0 ? [key, value] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null);
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FD grouping by path category
// ---------------------------------------------------------------------------

export interface OpenFd {
  fd: number;
  path: string;
}

export function getOpenFds(): OpenFd[] {
  const fds: OpenFd[] = [];
  const procFdDir = `/proc/self/fd`;
  if (!existsSync(procFdDir)) return fds;
  try {
    const entries = readdirSync(procFdDir);
    for (const entry of entries) {
      const num = Number(entry);
      if (Number.isNaN(num)) continue;
      try {
        const target = readlinkSync(join(procFdDir, entry));
        fds.push({ fd: num, path: target });
      } catch {
        // closed or inaccessible
      }
    }
  } catch {
    // /proc not available
  }
  return fds;
}

export function classifyFdPath(path: string): string {
  if (!path) return "anon";
  const lc = path.toLowerCase();
  if (/\.wal[_-]?\d*$/.test(lc) || lc.endsWith("-wal") || lc.includes("/.wal-")) return "wal";
  if (/\.shm[-_]?\d*$/.test(lc) || lc.endsWith("-shm") || lc.includes("/.shm-")) return "shm";
  if (/\.lance\//i.test(lc) || lc.includes("/.lance/") || lc.includes("/.lancedb/")) return "lancedb";
  if (
    /\.sqlite/i.test(lc) ||
    lc.endsWith(".db") ||
    lc.includes(".db-") ||
    (lc.includes("/.openclaw/") && (lc.endsWith(".db") || lc.includes(".db-")))
  )
    return "sqlite";
  if (lc.startsWith("socket:") || lc.startsWith("[socket:")) return "socket";
  if (lc.startsWith("pipe:") || lc.startsWith("[pipe:")) return "anon";
  if (lc.startsWith("/dev/")) return "device";
  if (lc.startsWith("/")) return "other";
  return "anon";
}

function groupFds(fds: OpenFd[], sampleLimit: number): FdGroup[] {
  const groups = new Map<string, OpenFd[]>();
  for (const fd of fds) {
    const cat = classifyFdPath(fd.path);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(fd);
  }
  const result: FdGroup[] = [];
  for (const [category, entries] of groups) {
    const samplePaths = [...new Set(entries.map((e) => e.path))].slice(0, sampleLimit);
    result.push({ category, samplePaths, count: entries.length });
  }
  return result.sort((a, b) => b.count - a.count);
}

function extractDbPaths(fds: OpenFd[]): MemoryPressureSnapshot["dbPaths"] {
  const sqlite = new Set<string>();
  const lancedb = new Set<string>();
  const wal = new Set<string>();
  const shm = new Set<string>();

  for (const fd of fds) {
    const cat = classifyFdPath(fd.path);
    if (cat === "sqlite" && fd.path) sqlite.add(fd.path);
    if (cat === "lancedb" && fd.path) {
      // Strip table name to get base path
      const base = fd.path.replace(/\/[^/]+\.(tbl|arrow|lance)$/i, "");
      lancedb.add(base);
    }
    if (cat === "wal" && fd.path) wal.add(fd.path);
    if (cat === "shm" && fd.path) shm.add(fd.path);
  }

  return {
    sqlite: [...sqlite],
    lancedb: [...lancedb],
    wal: [...wal],
    shm: [...shm],
  };
}

// ---------------------------------------------------------------------------
// Active task state (sourced from LifecycleContext / active-task service)
// ---------------------------------------------------------------------------

async function getActiveTaskCounts(
  activeTaskPath: string | undefined,
  staleMinutes: number,
  factsDb: FactsDB | undefined,
  ledger: "markdown" | "facts",
): Promise<{ stale: number; active: number }> {
  try {
    if (ledger === "facts" && factsDb) {
      const { readActiveTaskRowsFromFacts } = await import("./task-ledger-facts.js");
      const { active } = readActiveTaskRowsFromFacts(factsDb, staleMinutes);
      const stale = active.filter((t) => t.stale).length;
      return { stale, active: active.length };
    }
    if (!activeTaskPath) return { stale: 0, active: 0 };
    const { readActiveTaskFile } = await import("./active-task.js");
    const file = await readActiveTaskFile(activeTaskPath, staleMinutes);
    if (!file) return { stale: 0, active: 0 };
    const active = file.active ?? [];
    const stale = active.filter((t) => t.stale).length;
    return { stale, active: active.length };
  } catch {
    return { stale: 0, active: 0 };
  }
}

// ---------------------------------------------------------------------------
// JSON artifact writer
// ---------------------------------------------------------------------------

function writeJsonArtifact(snapshot: MemoryPressureSnapshot): void {
  try {
    const openclawHome = getEnv("OPENCLAW_HOME")?.trim() || join(homedir(), ".openclaw");
    const diagDir = join(openclawHome, "diagnostics", "memory-pressure");
    mkdirSync(diagDir, { recursive: true });
    const filename = `snapshot-${Date.now()}.json`;
    writeFileSync(join(diagDir, filename), JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "write-memory-snapshot-artifact",
      subsystem: "memory-pressure",
    });
  }
}

// ---------------------------------------------------------------------------
// Main snapshot function
// ---------------------------------------------------------------------------

export async function captureMemoryPressureSnapshot(
  ctx: Pick<LifecycleContext, "factsDb" | "vectorDb" | "recallInFlightRef" | "resolvedSqlitePath" | "cfg"> & {
    activeTaskPath?: string;
  },
  opts?: Partial<DiagnosticSnapshotConfig>,
): Promise<MemoryPressureSnapshot | null> {
  const config: DiagnosticSnapshotConfig = { ...DEFAULT_CONFIG, ...ctx.cfg?.diagnostics, ...opts };
  if (!config.enabled) return null;

  const nowMs = Date.now();
  const cooldownMs = config.cooldownSec * 1000;
  const elapsedMs = nowMs - lastSnapshotMs;

  // Rate-limit: skip if within cooldown window or if another snapshot is in progress
  if (elapsedMs < cooldownMs || snapshotInProgress) {
    return null;
  }

  // Mark snapshot as in progress to prevent concurrent calls
  snapshotInProgress = true;
  lastSnapshotMs = nowMs;

  try {
    const mem = process.memoryUsage();
    const memSnapshot = {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers ?? 0,
    };

    const fds = getOpenFds();
    const fdGroups = groupFds(fds, config.fdGroupSampleLimit ?? 5);
    const dbPaths = extractDbPaths(fds);
    const linuxProcMem = config.includeLinuxProcMem ? parseLinuxProcMem() : null;

    // LanceDB plugin state from VectorDB instance
    const vd = ctx.vectorDb;
    // These are the actual public VectorDB method names
    const lancedbInitGen = typeof vd.getInitGeneration === "function" ? vd.getInitGeneration() : -1;
    const lancedbStoreCount = typeof vd.getStoreCount === "function" ? vd.getStoreCount() : -1;
    const lancedbOptimizing = typeof vd.isOptimizing === "function" ? vd.isOptimizing() : false;
    const lancedbInitialized = typeof vd.isInitialized === "function" ? (vd.isInitialized() ?? false) : false;
    const lancedbOpenReaders = typeof vd.getOpenReaderCount === "function" ? (vd.getOpenReaderCount() ?? 0) : 0;
    const lancedbPath = typeof vd.getPath === "function" ? (vd.getPath() ?? null) : null;

    // Active task counts (wrapped in try-catch to prevent parseDuration throws from skipping cooldown update)
    let taskCounts = { stale: 0, active: 0 };
    try {
      const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
      const ledger = ctx.cfg.activeTask.ledger ?? "markdown";
      taskCounts = await getActiveTaskCounts(ctx.activeTaskPath, staleMinutes, ctx.factsDb, ledger);
    } catch {
      // If parseDuration or getActiveTaskCounts fails, use defaults
    }

    // Hybrid memory snapshot
    const hybridMemory: HybridMemorySnapshot = {
      sqlitePath: ctx.resolvedSqlitePath || null,
      lancedbPath,
      lancedbInitialized,
      lancedbOptimizing,
      lancedbOpenReaders,
      recallInFlight: ctx.recallInFlightRef?.value ?? 0,
      staleTaskCount: taskCounts.stale,
      activeTaskCount: taskCounts.active,
      uptimeSec: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
    };

    const snapshot: MemoryPressureSnapshot = {
      timestamp: new Date().toISOString(),
      memory: memSnapshot,
      activeHandles:
        typeof (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles === "function"
          ? ((process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()?.length ?? -1)
          : -1,
      activeRequests:
        typeof (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests === "function"
          ? ((process as unknown as { _getActiveRequests: () => unknown[] })._getActiveRequests()?.length ?? -1)
          : -1,
      linuxProcMem,
      fdGroups,
      dbPaths,
      pluginGenerations: {
        lancedbInitGeneration: lancedbInitGen,
        lancedbStoreCount: lancedbStoreCount,
        lancedbOptimizing,
      },
      hybridMemory,
      cooldownRemainingSec: 0,
    };

    if (config.writeArtifact) {
      writeJsonArtifact(snapshot);
    }

    return snapshot;
  } finally {
    // Always reset the in-progress flag, even if an error occurs
    snapshotInProgress = false;
  }
}

/**
 * Format snapshot as a compact single-line string for log output.
 */
export function formatMemoryPressureLogLine(snapshot: MemoryPressureSnapshot): string {
  const { memory, hybridMemory, fdGroups } = snapshot;
  const heapPct = memory.heapTotal > 0 ? ((memory.heapUsed / memory.heapTotal) * 100).toFixed(1) : "0.0";
  const rssMb = (memory.rss / 1024 / 1024).toFixed(0);
  const topFdGroups = fdGroups
    .slice(0, 3)
    .map((g) => `${g.category}=${g.count}`)
    .join(",");
  const recallInflight = hybridMemory.recallInFlight;
  const staleTasks = hybridMemory.staleTaskCount;
  const activeTasks = hybridMemory.activeTaskCount;
  return (
    `[memory-pressure] rss=${rssMb}MB heap=${heapPct}% ` +
    `fd=[${topFdGroups}] recall_inflight=${recallInflight} ` +
    `tasks=active:${activeTasks}+stale:${staleTasks}`
  );
}
