import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api/plugin-runtime.js";
import type { HybridMemoryConfig } from "../config.js";
import {
  canReuseDatabasesOnReregister,
  evaluateReregisterReuse,
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
    parsedCfgSnapshot: cfg,
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

  it("reuse-databases treats missing encryptionKey same as empty string", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const parsedCfg = minimalCfg();
    const snapCfg = { ...parsedCfg, credentials: { enabled: false, store: "sqlite" as const } };
    const newCfg = minimalCfg();
    (newCfg as { credentials?: { enabled: boolean; encryptionKey?: string } }).credentials = {
      enabled: false,
      encryptionKey: "",
    };
    const old = {
      cfg: snapCfg,
      parsedCfgSnapshot: snapCfg,
      resolvedSqlitePath: api.resolvePath(parsedCfg.sqlitePath),
      resolvedLancePath: api.resolvePath(parsedCfg.lanceDbPath),
      bootstrapSettledRef: { value: true },
    } as PluginRuntime;
    expect(canReuseDatabasesOnReregister(old, newCfg, api)).toBe(true);
  });

  it("reuse-databases compares parse-time snapshot not bootstrap-mutated llm", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const parsedCfg = minimalCfg();
    delete (parsedCfg as { llm?: unknown }).llm;
    const bootstrapMutatedCfg = {
      ...parsedCfg,
      llm: { providers: {}, default: [], heavy: [], nano: [] },
    } as HybridMemoryConfig;
    const old = {
      cfg: bootstrapMutatedCfg,
      parsedCfgSnapshot: parsedCfg,
      resolvedSqlitePath: api.resolvePath(parsedCfg.sqlitePath),
      resolvedLancePath: api.resolvePath(parsedCfg.lanceDbPath),
      bootstrapSettledRef: { value: true },
    } as PluginRuntime;
    expect(canReuseDatabasesOnReregister(old, parsedCfg, api)).toBe(true);
  });

  it("reuse-databases treats missing cloned empty credential key as unchanged", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const cfg = minimalCfg();
    (cfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: false,
      encryptionKey: "",
    };
    Object.defineProperty(cfg.credentials, "encryptionKey", {
      value: "",
      enumerable: false,
      writable: false,
    });
    const clonedSnapshot = structuredClone(cfg);
    expect(clonedSnapshot.credentials?.encryptionKey).toBeUndefined();
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(cfg.sqlitePath),
        lance: api.resolvePath(cfg.lanceDbPath),
      },
      cfg,
    );
    old.parsedCfgSnapshot = clonedSnapshot;
    expect(canReuseDatabasesOnReregister(old, cfg, api)).toBe(true);
  });

  it("reuse-databases declines when cloned snapshot lost an old valid credential key", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const oldCfg = minimalCfg();
    (oldCfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: true,
      encryptionKey: "old-valid-key-1234567890",
    };
    Object.defineProperty(oldCfg.credentials, "encryptionKey", {
      value: "old-valid-key-1234567890",
      enumerable: false,
      writable: false,
    });
    const clonedSnapshot = structuredClone(oldCfg);
    expect(clonedSnapshot.credentials?.encryptionKey).toBeUndefined();

    const newCfg = minimalCfg();
    (newCfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: true,
      encryptionKey: "",
    };
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(oldCfg.sqlitePath),
        lance: api.resolvePath(oldCfg.lanceDbPath),
      },
      oldCfg,
    );
    old.parsedCfgSnapshot = clonedSnapshot;

    expect(canReuseDatabasesOnReregister(old, newCfg, api)).toBe(false);
  });

  it("reuse-databases declines when sqlite path changes", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = { resolvePath: (p: string) => `/data/${p}` };
    const cfg = minimalCfg("memory/other.db");
    const old = mockOldRuntime({ sqlite: "/data/memory/facts.db", lance: "/data/memory/lancedb" }, minimalCfg());
    expect(canReuseDatabasesOnReregister(old, cfg, api)).toBe(false);
  });

  it("reuse-databases declines when public route security settings change", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const oldCfg = minimalCfg();
    oldCfg.health = { enabled: true, authenticated: false } as HybridMemoryConfig["health"];
    const newCfg = minimalCfg();
    newCfg.health = { enabled: true, authenticated: true } as HybridMemoryConfig["health"];
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(oldCfg.sqlitePath),
        lance: api.resolvePath(oldCfg.lanceDbPath),
      },
      oldCfg,
    );
    expect(canReuseDatabasesOnReregister(old, newCfg, api)).toBe(false);
  });

  it("reuse-databases declines when public routes are disabled", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = {
      resolvePath: (p: string) => `/home/markus/.openclaw/${p}`,
    };
    const oldCfg = minimalCfg();
    oldCfg.health = { enabled: true, authenticated: false } as HybridMemoryConfig["health"];
    const newCfg = minimalCfg();
    newCfg.health = { enabled: false, authenticated: false } as HybridMemoryConfig["health"];
    const old = mockOldRuntime(
      {
        sqlite: api.resolvePath(oldCfg.sqlitePath),
        lance: api.resolvePath(oldCfg.lanceDbPath),
      },
      oldCfg,
    );
    expect(canReuseDatabasesOnReregister(old, newCfg, api)).toBe(false);
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

  it("reuse-databases declines when a conditionally-constructed store's enabled flag changes", () => {
    // Covers wal/personaProposals/identityReflection/identityPromotion/nightlyCycle/
    // graph.autoSupersede/passiveObserver/aliases/verification/provenance — each gates a store
    // instantiated in bootstrap-optional.ts, so flipping it must force a full teardown rather
    // than silently reusing a donor whose store handle doesn't match the new flag.
    const flagCases: Array<[key: string, oldVal: unknown, newVal: unknown]> = [
      ["wal", { enabled: false }, { enabled: true }],
      ["personaProposals", { enabled: false }, { enabled: true }],
      ["identityReflection", { enabled: false }, { enabled: true }],
      ["identityPromotion", { enabled: false }, { enabled: true }],
      ["nightlyCycle", { enabled: false }, { enabled: true }],
      ["passiveObserver", { enabled: false }, { enabled: true }],
      ["aliases", { enabled: false }, { enabled: true }],
      ["verification", { enabled: false }, { enabled: true }],
      ["provenance", { enabled: false }, { enabled: true }],
    ];
    for (const [key, oldVal, newVal] of flagCases) {
      vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
      const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
      const oldCfg = minimalCfg();
      (oldCfg as unknown as Record<string, unknown>)[key] = oldVal;
      const newCfg = minimalCfg();
      (newCfg as unknown as Record<string, unknown>)[key] = newVal;
      const old = mockOldRuntime(
        { sqlite: api.resolvePath(oldCfg.sqlitePath), lance: api.resolvePath(oldCfg.lanceDbPath) },
        oldCfg,
      );
      expect(canReuseDatabasesOnReregister(old, newCfg, api), `flag: ${key}`).toBe(false);
    }
  });

  it("reuse-databases declines when graph.autoSupersede changes", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const oldCfg = minimalCfg();
    (oldCfg as unknown as Record<string, unknown>).graph = { autoSupersede: false };
    const newCfg = minimalCfg();
    (newCfg as unknown as Record<string, unknown>).graph = { autoSupersede: true };
    const old = mockOldRuntime(
      { sqlite: api.resolvePath(oldCfg.sqlitePath), lance: api.resolvePath(oldCfg.lanceDbPath) },
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

  // #2136: a full teardown under reuse-databases must always name WHY. evaluateReregisterReuse
  // returns a stable reason code alongside the boolean so diagnostics can attribute each teardown.
  describe("evaluateReregisterReuse names the reason (#2136)", () => {
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const settledDonor = (cfg: HybridMemoryConfig) =>
      mockOldRuntime({ sqlite: api.resolvePath(cfg.sqlitePath), lance: api.resolvePath(cfg.lanceDbPath) }, cfg);

    beforeEach(() => vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases"));

    it("returns reuse:true with reason 'reusable' when nothing drifted", () => {
      const cfg = minimalCfg();
      expect(evaluateReregisterReuse(settledDonor(cfg), cfg, api)).toEqual({ reuse: true, reason: "reusable" });
    });

    it("names no_donor when there is no prior runtime", () => {
      expect(evaluateReregisterReuse(null, minimalCfg(), api)).toEqual({ reuse: false, reason: "no_donor" });
    });

    it("names bootstrap_not_settled when the donor bootstrap is still in flight", () => {
      const cfg = minimalCfg();
      const donor = settledDonor(cfg);
      (donor as { bootstrapSettledRef?: { value: boolean } }).bootstrapSettledRef = { value: false };
      expect(evaluateReregisterReuse(donor, cfg, api)).toEqual({ reuse: false, reason: "bootstrap_not_settled" });
    });

    it("names the drifted sqlite path", () => {
      const donor = settledDonor(minimalCfg());
      const decision = evaluateReregisterReuse(donor, minimalCfg("memory/other.db"), api);
      expect(decision).toEqual({ reuse: false, reason: "sqlite_path_changed" });
    });

    it("names the specific drifted config field", () => {
      const oldCfg = minimalCfg();
      const donor = settledDonor(oldCfg);
      const newCfg = minimalCfg();
      newCfg.embedding.model = "text-embedding-3-large";
      expect(evaluateReregisterReuse(donor, newCfg, api)).toEqual({
        reuse: false,
        reason: "config_drift:embedding.model",
      });
    });

    it("stays reusable across repeated re-registers with unchanged config (no phantom teardowns)", () => {
      const cfg = minimalCfg();
      const donor = settledDonor(cfg);
      for (let i = 0; i < 5; i++) {
        expect(evaluateReregisterReuse(donor, minimalCfg(), api).reuse).toBe(true);
      }
    });
  });

  it("recordReregisterFullTeardown tallies per-reason counters (#2136)", () => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    recordReregisterFullTeardown("config_drift:embedding.model");
    recordReregisterFullTeardown("config_drift:embedding.model");
    recordReregisterFullTeardown("bootstrap_not_settled");
    recordReregisterFullTeardown(); // unspecified
    expect(reregisterMetrics.fullTeardowns).toBe(4);
    expect(reregisterMetrics.fullTeardownReasons).toEqual({
      "config_drift:embedding.model": 2,
      bootstrap_not_settled: 1,
      unspecified: 1,
    });
  });
});

describe("reregister-policy closed donor handle guard", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_HYBRID_MEM_REREGISTER_POLICY", "reuse-databases");
    resetReregisterPolicyForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetReregisterPolicyForTests();
  });

  function store(open = true) {
    return { isOpen: () => open };
  }

  function vector(open = true) {
    return { isInitialized: () => open, isLanceDbAvailable: () => open };
  }

  function runtimeWithStores(cfg: HybridMemoryConfig, api: { resolvePath: (p: string) => string }, overrides = {}) {
    return {
      cfg,
      parsedCfgSnapshot: cfg,
      resolvedSqlitePath: api.resolvePath(cfg.sqlitePath),
      resolvedLancePath: api.resolvePath(cfg.lanceDbPath),
      bootstrapSettledRef: { value: true },
      factsDb: store(true),
      edictStore: store(true),
      vectorDb: vector(true),
      credentialsDb: store(true),
      wal: store(true),
      proposalsDb: store(true),
      narrativesDb: store(true),
      aliasDb: store(true),
      issueStore: store(true),
      workflowStore: store(true),
      crystallizationStore: store(true),
      toolProposalStore: store(true),
      verificationStore: store(true),
      apitapStore: store(true),
      ...overrides,
    } as unknown as PluginRuntime;
  }

  it("allows reuse when donor config and handles are still open", () => {
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const cfg = minimalCfg();
    expect(canReuseDatabasesOnReregister(runtimeWithStores(cfg, api), cfg, api)).toBe(true);
  });

  it("rejects reuse when the donor facts DB is closed", () => {
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const cfg = minimalCfg();
    expect(canReuseDatabasesOnReregister(runtimeWithStores(cfg, api, { factsDb: store(false) }), cfg, api)).toBe(false);
  });

  it("rejects reuse when the donor vector DB is closed", () => {
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const cfg = minimalCfg();
    expect(canReuseDatabasesOnReregister(runtimeWithStores(cfg, api, { vectorDb: vector(false) }), cfg, api)).toBe(
      false,
    );
  });

  it("rejects reuse when the enabled credentials vault is closed", () => {
    const api = { resolvePath: (p: string) => `/home/markus/.openclaw/${p}` };
    const cfg = minimalCfg();
    (cfg as { credentials?: { enabled: boolean; encryptionKey: string } }).credentials = {
      enabled: true,
      encryptionKey: "k",
    };
    expect(canReuseDatabasesOnReregister(runtimeWithStores(cfg, api, { credentialsDb: store(false) }), cfg, api)).toBe(
      false,
    );
  });
});
