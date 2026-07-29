import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANCE_PATH, DEFAULT_SQLITE_PATH } from "../config/parsers/core.js";
import { hybridConfigSchema } from "../config.js";
import { resetStartupMemoryAttributionForTests } from "../services/startup-memory-attribution.js";
import { closeOldDatabases, initializeDatabases } from "../setup/init-databases.js";

describe("bootstrap startup memory checkpoints", () => {
  let tmpDir: string;
  let dbCtx: ReturnType<typeof initializeDatabases> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bootstrap-startup-memory-"));
    dbCtx = undefined;
  });

  afterEach(() => {
    if (dbCtx) {
      closeOldDatabases(dbCtx);
      dbCtx = undefined;
    }
    resetStartupMemoryAttributionForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to documented paths before resolvePath when a deferred handoff omits DB paths", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-embed-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
    });
    const resolvePath = vi.fn((path: string) => {
      if (typeof path !== "string") throw new TypeError('The "path" argument must be of type string.');
      return join(tmpDir, path.replaceAll("/", "_"));
    });
    const api = {
      resolvePath,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      config: {},
      context: { sessionId: "session-1", agentId: "agent-1" },
    };
    const deferredHandoffCfg = { ...cfg, sqlitePath: undefined, lanceDbPath: "  " };

    dbCtx = initializeDatabases(deferredHandoffCfg as never, api as never);

    expect(resolvePath.mock.calls.flat()).toEqual([DEFAULT_LANCE_PATH, DEFAULT_SQLITE_PATH]);
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing or invalid lanceDbPath"));
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing or invalid sqlitePath"));
  });

  it("falls back to the unresolved path when api.resolvePath() itself returns a non-string value (GlitchTip #33 recurrence)", () => {
    // #2203 and #2216 guarded every known caller's *input* to api.resolvePath(), but GlitchTip
    // #33 kept recurring afterward — the plugin host's resolvePath is an external boundary this
    // repo doesn't control, so its return value needs the same defense-in-depth as its input.
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-embed-key-that-is-long-enough", model: "text-embedding-3-small" },
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
    });
    const api = {
      // Simulates a host resolvePath() that misbehaves under a hot-reload race and hands back
      // undefined even though it was called with a guaranteed-valid, non-empty string.
      resolvePath: vi.fn(() => undefined as unknown as string),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      config: {},
      context: { sessionId: "session-1", agentId: "agent-1" },
    };

    expect(() => {
      dbCtx = initializeDatabases(cfg, api as never);
    }).not.toThrow();

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("api.resolvePath() returned an invalid value for lanceDbPath"),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("api.resolvePath() returned an invalid value for sqlitePath"),
    );
  });

  it("emits plugin registration memory checkpoints with attribution", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-embed-key-that-is-long-enough",
        model: "text-embedding-3-small",
      },
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
    });
    const api = {
      resolvePath: (path: string) => path,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      config: {},
      context: { sessionId: "session-1", agentId: "agent-1" },
    };

    dbCtx = initializeDatabases(cfg, api as never);

    const startupLogs = api.logger.info.mock.calls
      .reduce<unknown[]>((acc, args) => {
        acc.push(...args);
        return acc;
      }, [])
      .filter((value): value is string => typeof value === "string")
      .filter((msg) => msg.includes("startup-memory-checkpoint") && msg.includes("subsystem=bootstrap"));

    expect(startupLogs.some((msg) => msg.includes("phase=startup.plugin-registration.begin"))).toBe(true);
    expect(startupLogs.some((msg) => msg.includes("phase=startup.plugin-registration.after-bootstrap"))).toBe(true);
  });
});
