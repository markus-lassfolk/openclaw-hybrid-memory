import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hybridConfigSchema } from "../config.js";
import memoryHybridPlugin, { isHybridMemVersionOnlyInvocation } from "../index.js";
import { resetPluginRegistrationStateForTests } from "../setup/register-plugin.js";

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

describe("isHybridMemVersionOnlyInvocation (#2012)", () => {
  it("matches --version as a leading flag before any subcommand", () => {
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "--version"])).toBe(true);
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "--version", "--json"])).toBe(true);
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "--json", "--version"])).toBe(true);
  });

  it("does not match when a subcommand is selected first (PR #2013 review)", () => {
    // `--version` after a subcommand name must not be silently swallowed by a root option —
    // it is left for that subcommand's own parser to accept or reject.
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "upgrade", "--version"])).toBe(false);
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "list", "--json"])).toBe(false);
  });

  it("does not match other hybrid-mem commands", () => {
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "verify"])).toBe(false);
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem"])).toBe(false);
  });

  it("stops at -- separator", () => {
    expect(isHybridMemVersionOnlyInvocation(["node", "openclaw", "hybrid-mem", "--", "--version"])).toBe(false);
  });
});

describe("hybrid-mem --version invocations", () => {
  let tmpDir: string;
  let oldArgv: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hybrid-mem-version-only-"));
    oldArgv = process.argv;
  });

  afterEach(() => {
    process.argv = oldArgv;
    rmSync(tmpDir, { recursive: true, force: true });
    resetPluginRegistrationStateForTests();
  });

  it("openclaw hybrid-mem --version registers CLI only (no DB bootstrap, no tools/services)", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "--version"];
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

    expect(memoryHybridPlugin.register(mockApi as never)).toBeUndefined();
    expect(existsSync(sqlitePath)).toBe(false);
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("openclaw hybrid-mem --version works even with an invalid embedding config (no bootstrap)", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "--version"];
    const api = makeMockApi();
    const mockApi = {
      ...api,
      // Deliberately invalid/incomplete plugin config — the version-only fast path must not
      // need a valid config at all (issue #2012 acceptance criteria).
      pluginConfig: {},
      registrationMode: "full" as const,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };

    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();
    expect(api.registerCli).toHaveBeenCalled();
  });
});
