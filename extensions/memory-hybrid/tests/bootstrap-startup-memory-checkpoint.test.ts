import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { closeOldDatabases, initializeDatabases } from "../setup/init-databases.js";
import { resetStartupMemoryAttributionForTests } from "../services/startup-memory-attribution.js";

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
