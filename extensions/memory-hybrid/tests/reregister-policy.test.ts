import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  canReuseDatabasesOnReregister,
  recordReregisterDatabaseReuse,
  recordReregisterFullTeardown,
  resetReregisterPolicyForTests,
  resolveReregisterPolicy,
  reregisterMetrics,
  shouldFullTeardownOnReregister,
} from "../setup/reregister-policy.js";

function minimalCfg(sqlite = "memory/facts.db", lance = "memory/lancedb"): HybridMemoryConfig {
  return {
    sqlitePath: sqlite,
    lanceDbPath: lance,
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
      deployment: undefined,
    },
    llm: {
      default: ["openai/gpt-4.1"],
      heavy: [],
      nano: [],
      providers: {},
    },
  } as unknown as HybridMemoryConfig;
}

function mockOldRuntime(paths: { sqlite: string; lance: string }, cfg: HybridMemoryConfig): PluginRuntime {
  return {
    cfg,
    resolvedSqlitePath: paths.sqlite,
    resolvedLancePath: paths.lance,
    bootstrapSettledRef: { value: true },
  } as PluginRuntime;
}

describe("reregister-policy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetReregisterPolicyForTests();
  });

  it("defaults to full teardown behavior", () => {
    expect(resolveReregisterPolicy()).toBe("default");
    expect(shouldFullTeardownOnReregister()).toBe(true);
  });

  it("reuse-databases skips teardown when paths match", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const cfg = minimalCfg();
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(cfg.sqlitePath),
        lance: api.resolvePath(cfg.lanceDbPath),
      },
      cfg,
    );
    expect(canReuseDatabasesOnReregister(old, cfg, api)).toBe(true);
    expect(shouldFullTeardownOnReregister()).toBe(false);
  });

  it("reuse-databases declines when sqlite path changes", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = { resolvePath: (p: string) => `/data/${p}` };
    const cfg = minimalCfg("memory/other.db");
    const old = mockOldRuntime({ sqlite: "/data/memory/facts.db", lance: "/data/memory/lancedb" }, minimalCfg());
    expect(canReuseDatabasesOnReregister(old, cfg, api)).toBe(false);
  });

  it("reuse-databases declines when encryption key changes", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const oldCfg = minimalCfg();
    (oldCfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: true,
      encryptionKey: "old-key",
    };
    const newCfg = minimalCfg();
    (newCfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: true,
      encryptionKey: "new-key",
    };
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(oldCfg.sqlitePath),
        lance: api.resolvePath(oldCfg.lanceDbPath),
      },
      oldCfg,
    );
    expect(canReuseDatabasesOnReregister(old, newCfg, api)).toBe(false);
  });

  it("records metrics counters", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "full");
    expect(resolveReregisterPolicy()).toBe("full");
    recordReregisterFullTeardown();
    recordReregisterDatabaseReuse();
    expect(reregisterMetrics.fullTeardowns).toBe(1);
    expect(reregisterMetrics.databaseReuses).toBe(1);
  });
});
