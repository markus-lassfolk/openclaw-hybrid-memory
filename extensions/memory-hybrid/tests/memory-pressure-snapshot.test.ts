import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMemoryPressureSnapshot,
  classifyFdPath,
  extractDbPaths,
  groupFds,
  resetMemoryPressureSnapshotCooldownForTests,
  writeJsonArtifact,
  type MemoryPressureSnapshot,
  type OpenFd,
} from "../services/memory-pressure-snapshot.js";

const originalOpenclawHome = process.env.OPENCLAW_HOME;

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalSnapshot(): MemoryPressureSnapshot {
  return {
    timestamp: "2026-05-22T00:00:00.000Z",
    memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
    activeHandles: 0,
    activeRequests: 0,
    linuxProcMem: null,
    fdGroups: [],
    dbPaths: { sqlite: [], lancedb: [], wal: [], shm: [] },
    pluginGenerations: { lancedbInitGeneration: -1, lancedbStoreCount: -1, lancedbOptimizing: false },
    hybridMemory: {
      sqlitePath: null,
      lancedbPath: null,
      lancedbInitialized: false,
      lancedbOptimizing: false,
      lancedbOpenReaders: 0,
      recallInFlight: 0,
      staleTaskCount: 0,
      activeTaskCount: 0,
      uptimeSec: 0,
      nodeVersion: process.version,
      platform: process.platform,
    },
    cooldownRemainingSec: 0,
  };
}

function makeCtx() {
  return {
    factsDb: undefined,
    vectorDb: {
      getInitGeneration: () => 7,
      getStoreCount: () => 11,
      isOptimizing: () => false,
      isInitialized: () => true,
      getOpenReaderCount: () => 2,
      getPath: () => "/tmp/lancedb",
    },
    recallInFlightRef: { value: 3 },
    resolvedSqlitePath: "/tmp/facts.db",
    cfg: {
      diagnostics: { enabled: true, writeArtifact: false, cooldownSec: 60 },
      activeTask: { staleThreshold: "30m", ledger: "markdown" },
    },
  };
}

beforeEach(() => {
  resetMemoryPressureSnapshotCooldownForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetMemoryPressureSnapshotCooldownForTests();
  if (originalOpenclawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenclawHome;
  }
});

describe("memory pressure snapshot fd classification", () => {
  it("groups file descriptors by classified symlink target path", () => {
    const fds: OpenFd[] = [
      { fd: 1, path: "/tmp/facts.db" },
      { fd: 2, path: "/tmp/facts.db-wal" },
      { fd: 3, path: "/tmp/facts.db-shm" },
      { fd: 4, path: "/tmp/vector/.lance/table.arrow" },
      { fd: 5, path: "socket:[123]" },
      { fd: 6, path: "pipe:[456]" },
      { fd: 7, path: "/dev/null" },
      { fd: 8, path: "/tmp/ordinary.log" },
      { fd: 9, path: "/tmp/ordinary.log" },
    ];

    expect(classifyFdPath("/tmp/facts.db")).toBe("sqlite");
    expect(classifyFdPath("/tmp/facts.db-wal")).toBe("wal");
    expect(classifyFdPath("/tmp/facts.db-shm")).toBe("shm");
    expect(classifyFdPath("/tmp/vector/.lance/table.arrow")).toBe("lancedb");

    const groups = groupFds(fds, 1);
    expect(groups).toContainEqual({ category: "other", count: 2, samplePaths: ["/tmp/ordinary.log"] });
    expect(groups).toContainEqual({ category: "sqlite", count: 1, samplePaths: ["/tmp/facts.db"] });
    expect(groups).toContainEqual({ category: "wal", count: 1, samplePaths: ["/tmp/facts.db-wal"] });
    expect(groups).toContainEqual({ category: "shm", count: 1, samplePaths: ["/tmp/facts.db-shm"] });
    expect(groups).toContainEqual({ category: "lancedb", count: 1, samplePaths: ["/tmp/vector/.lance/table.arrow"] });
  });

  it("extracts sqlite, wal, shm, and LanceDB paths from classified descriptors", () => {
    const paths = extractDbPaths([
      { fd: 1, path: "/tmp/facts.db" },
      { fd: 2, path: "/tmp/facts.db-wal" },
      { fd: 3, path: "/tmp/facts.db-shm" },
      { fd: 4, path: "/tmp/vector/.lance/table.arrow" },
      { fd: 5, path: "/tmp/vector/.lance/table.arrow" },
    ]);

    expect(paths.sqlite).toEqual(["/tmp/facts.db"]);
    expect(paths.wal).toEqual(["/tmp/facts.db-wal"]);
    expect(paths.shm).toEqual(["/tmp/facts.db-shm"]);
    expect(paths.lancedb).toEqual(["/tmp/vector/.lance"]);
  });
});

describe("memory pressure snapshot artifact writing", () => {
  it("writes a pretty JSON artifact using ESM fs imports", () => {
    const home = makeTmpDir("memory-pressure-home");
    process.env.OPENCLAW_HOME = home;

    writeJsonArtifact(minimalSnapshot());

    const diagDir = join(home, "diagnostics", "memory-pressure");
    expect(existsSync(diagDir)).toBe(true);
    const files = readdirSorted(diagDir);
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(diagDir, files[0]), "utf-8");
    expect(raw).toContain('\n  "timestamp": "2026-05-22T00:00:00.000Z"');
    expect(JSON.parse(raw)).toMatchObject({ timestamp: "2026-05-22T00:00:00.000Z" });

    rmSync(home, { recursive: true, force: true });
  });
});

describe("memory pressure snapshot cooldown", () => {
  it("rate-limits snapshots within the configured cooldown window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00.000Z"));

    const first = await captureMemoryPressureSnapshot(makeCtx() as never);
    expect(first).not.toBeNull();

    vi.setSystemTime(new Date("2026-05-22T00:00:30.000Z"));
    const second = await captureMemoryPressureSnapshot(makeCtx() as never);
    expect(second).toBeNull();

    vi.setSystemTime(new Date("2026-05-22T00:01:01.000Z"));
    const third = await captureMemoryPressureSnapshot(makeCtx() as never);
    expect(third).not.toBeNull();
  });

  it("stays disabled unless diagnostics snapshots are explicitly enabled", async () => {
    const disabled = await captureMemoryPressureSnapshot({
      ...makeCtx(),
      cfg: {
        diagnostics: { enabled: false, writeArtifact: false, cooldownSec: 60 },
        activeTask: { staleThreshold: "30m", ledger: "markdown" },
      },
    } as never);

    expect(disabled).toBeNull();
  });
});

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}
