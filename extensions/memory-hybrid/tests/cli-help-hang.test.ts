import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hybridConfigSchema } from "../config.js";
import memoryHybridPlugin from "../index.js";

function makeMockApi() {
  return {
    registerCli: vi.fn(),
    registerTool: vi.fn(),
    registerService: vi.fn(),
    registerLifecycleHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session", agentId: "test-agent" },
    config: {},
  };
}

describe("hybrid-mem help invocations", () => {
  let tmpDir: string;
  let oldArgv: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hybrid-mem-help-"));
    oldArgv = process.argv;
  });

  afterEach(() => {
    process.argv = oldArgv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("openclaw hybrid-mem --help registers CLI only (no DB bootstrap, no tools/services)", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "--help"];
    const api = makeMockApi();
    const sqlitePath = join(tmpDir, "facts.db");
    const lanceDbPath = join(tmpDir, "lancedb");
    const pluginConfig = hybridConfigSchema.parse({
      sqlitePath,
      lanceDbPath,
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
    });
    const mockApi = {
      ...api,
      pluginConfig,
      registrationMode: "full" as const,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };

    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();
    expect(existsSync(sqlitePath)).toBe(false);
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("openclaw hybrid-mem verify --help registers CLI only (no DB bootstrap, no tools/services)", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "verify", "--help"];
    const api = makeMockApi();
    const sqlitePath = join(tmpDir, "facts.db");
    const lanceDbPath = join(tmpDir, "lancedb");
    const pluginConfig = hybridConfigSchema.parse({
      sqlitePath,
      lanceDbPath,
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
    });
    const mockApi = {
      ...api,
      pluginConfig,
      registrationMode: "full" as const,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };

    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();
    expect(existsSync(sqlitePath)).toBe(false);
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("help is deterministic even with invalid/unresolvable plugin config", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "--help"];
    const api = makeMockApi();
    const mockApi = {
      ...api,
      pluginConfig: {
        embedding: { provider: "openai", apiKey: "env:THIS_IS_NOT_SET", model: "text-embedding-3-small" },
      },
      registrationMode: "full" as const,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };

    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });
});
