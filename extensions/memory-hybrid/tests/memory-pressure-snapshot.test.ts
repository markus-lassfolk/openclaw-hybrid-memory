import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleContext } from "../lifecycle/types.js";

type SnapshotContext = Pick<
  LifecycleContext,
  "factsDb" | "vectorDb" | "recallInFlightRef" | "resolvedSqlitePath" | "cfg"
> & {
  activeTaskPath?: string;
};

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => [] as string[]),
  readlinkSync: vi.fn((path: string) => path),
  writeFileSync: vi.fn(),
}));

const mockErrorReporter = vi.hoisted(() => ({
  capturePluginError: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockFs.existsSync,
    mkdirSync: mockFs.mkdirSync,
    readFileSync: mockFs.readFileSync,
    readdirSync: mockFs.readdirSync,
    readlinkSync: mockFs.readlinkSync,
    writeFileSync: mockFs.writeFileSync,
  };
});

vi.mock("../services/error-reporter.js", () => mockErrorReporter);

const setPlatform = (platform: NodeJS.Platform): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
};

async function loadModule() {
  vi.resetModules();
  return import("../services/memory-pressure-snapshot.js");
}

function makeCtx(overrides?: Partial<SnapshotContext>): SnapshotContext {
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
      activeTask: {
        staleThreshold: "24h",
        ledger: "markdown" as const,
      },
      diagnostics: {
        enabled: true,
        writeArtifact: false,
        cooldownSec: 300,
        includeLinuxProcMem: true,
        fdGroupSampleLimit: 5,
      },
    },
    ...overrides,
  } as unknown as SnapshotContext;
}

describe("memory-pressure snapshot helpers", () => {
  const proc = process as typeof process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };

  let restorePlatform: (() => void) | undefined;
  let originalGetActiveHandles: (() => unknown[]) | undefined;
  let originalGetActiveRequests: (() => unknown[]) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("");
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.readlinkSync.mockImplementation((path: string) => path);
    originalGetActiveHandles = proc._getActiveHandles;
    originalGetActiveRequests = proc._getActiveRequests;
  });

  afterEach(() => {
    restorePlatform?.();
    restorePlatform = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalGetActiveHandles) {
      proc._getActiveHandles = originalGetActiveHandles;
    } else {
      delete proc._getActiveHandles;
    }
    if (originalGetActiveRequests) {
      proc._getActiveRequests = originalGetActiveRequests;
    } else {
      delete proc._getActiveRequests;
    }
  });

  it("parseLinuxProcMem preserves full /proc values with units", async () => {
    restorePlatform = setPlatform("linux");
    mockFs.readFileSync.mockReturnValue(
      ["Name:\tnode", "VmRSS:\t1234 kB", "VmSwap:\t0 kB", "Threads:\t7", ""].join("\n"),
    );

    const { parseLinuxProcMem } = await loadModule();

    expect(parseLinuxProcMem()).toEqual({
      Name: "node",
      VmRSS: "1234 kB",
      VmSwap: "0 kB",
      Threads: "7",
    });
  });

  it("getOpenFds resolves fd symlink targets and skips unreadable entries", async () => {
    mockFs.readdirSync.mockReturnValue(["7", "bad", "8"]);
    mockFs.readlinkSync.mockImplementation((path: string) => {
      if (path.endsWith("/7")) return "/tmp/facts.db";
      throw new Error("closed");
    });

    const { getOpenFds } = await loadModule();

    expect(getOpenFds()).toEqual([{ fd: 7, path: "/tmp/facts.db" }]);
  });

  it("classifyFdPath recognizes device, sqlite, wal, shm, lancedb, socket, and anon paths", async () => {
    const { classifyFdPath } = await loadModule();

    expect(classifyFdPath("/dev/null")).toBe("device");
    expect(classifyFdPath("/tmp/facts.db")).toBe("sqlite");
    expect(classifyFdPath("/tmp/facts.db-wal")).toBe("wal");
    expect(classifyFdPath("/tmp/facts.db-shm")).toBe("shm");
    expect(classifyFdPath("/tmp/lancedb/.lance/data.arrow")).toBe("lancedb");
    expect(classifyFdPath("socket:[123]")).toBe("socket");
    expect(classifyFdPath("pipe:[456]")).toBe("anon");
  });

  it("captureMemoryPressureSnapshot returns a snapshot and dedupes within cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    mockFs.readdirSync.mockReturnValue(["10", "11", "12"]);
    mockFs.readlinkSync.mockImplementation((path: string) => {
      if (path.endsWith("/10")) return "/tmp/facts.db";
      if (path.endsWith("/11")) return "/tmp/facts.db-wal";
      return "/tmp/lancedb/.lance/data.arrow";
    });
    proc._getActiveHandles = () => [{}, {}];
    proc._getActiveRequests = () => [{}];

    const { captureMemoryPressureSnapshot } = await loadModule();

    const snapshot = await captureMemoryPressureSnapshot(makeCtx(), {
      includeLinuxProcMem: false,
      cooldownSec: 60,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.dbPaths.sqlite).toEqual(["/tmp/facts.db"]);
    expect(snapshot?.dbPaths.wal).toEqual(["/tmp/facts.db-wal"]);
    expect(snapshot?.dbPaths.lancedb).toEqual(["/tmp/lancedb/.lance"]);
    expect(snapshot?.activeHandles).toBe(2);
    expect(snapshot?.activeRequests).toBe(1);
    expect(snapshot?.cooldownRemainingSec).toBe(0);

    const duplicate = await captureMemoryPressureSnapshot(makeCtx(), {
      includeLinuxProcMem: false,
      cooldownSec: 60,
    });

    expect(duplicate).toBeNull();
  });

  it("starts cooldown even when snapshot capture fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));

    const { captureMemoryPressureSnapshot } = await loadModule();

    await expect(
      captureMemoryPressureSnapshot(
        makeCtx({
          vectorDb: {
            getInitGeneration() {
              throw new Error("boom");
            },
            getStoreCount: () => 0,
            isOptimizing: () => false,
            isInitialized: () => true,
            getOpenReaderCount: () => 0,
            getPath: () => null,
          },
        }),
        {
          includeLinuxProcMem: false,
          cooldownSec: 60,
        },
      ),
    ).rejects.toThrow("boom");

    const secondAttempt = await captureMemoryPressureSnapshot(makeCtx(), {
      includeLinuxProcMem: false,
      cooldownSec: 60,
    });

    expect(secondAttempt).toBeNull();
  });
});
