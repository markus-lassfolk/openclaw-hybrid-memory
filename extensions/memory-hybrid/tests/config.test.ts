import { describe, it, expect, beforeEach } from "vitest";
import {
  DECAY_CLASSES,
  TTL_DEFAULTS,
  DEFAULT_MEMORY_CATEGORIES,
  getMemoryCategories,
  setMemoryCategories,
  isValidCategory,
  vectorDimsForModel,
  hybridConfigSchema,
  CREDENTIAL_TYPES,
  getDefaultCronModel,
  getCronModelConfig,
  getLLMModelPreference,
  resolveReflectionModelAndFallbacks,
  type DecayClass,
  type HybridMemoryConfig,
} from "../config.js";
import type { ConfigMode } from "../config.js";

// ---------------------------------------------------------------------------
// Decay classes & TTL defaults
// ---------------------------------------------------------------------------

describe("DECAY_CLASSES", () => {
  it("contains exactly the five expected classes", () => {
    expect(DECAY_CLASSES).toEqual([
      "permanent",
      "stable",
      "active",
      "session",
      "checkpoint",
    ]);
  });
});

describe("TTL_DEFAULTS", () => {
  it("permanent has null TTL (never expires)", () => {
    expect(TTL_DEFAULTS.permanent).toBeNull();
  });

  it("stable is 90 days in seconds", () => {
    expect(TTL_DEFAULTS.stable).toBe(90 * 24 * 3600);
  });

  it("active is 14 days in seconds", () => {
    expect(TTL_DEFAULTS.active).toBe(14 * 24 * 3600);
  });

  it("session is 24 hours in seconds", () => {
    expect(TTL_DEFAULTS.session).toBe(24 * 3600);
  });

  it("checkpoint is 4 hours in seconds", () => {
    expect(TTL_DEFAULTS.checkpoint).toBe(4 * 3600);
  });

  it("every decay class has a TTL entry", () => {
    for (const dc of DECAY_CLASSES) {
      expect(dc in TTL_DEFAULTS).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Category management
// ---------------------------------------------------------------------------

describe("Category management", () => {
  beforeEach(() => {
    setMemoryCategories([]);
  });

  it("default categories are present", () => {
    const cats = getMemoryCategories();
    for (const c of DEFAULT_MEMORY_CATEGORIES) {
      expect(cats).toContain(c);
    }
  });

  it("setMemoryCategories merges custom with defaults", () => {
    setMemoryCategories(["workflow", "recipe"]);
    const cats = getMemoryCategories();
    expect(cats).toContain("workflow");
    expect(cats).toContain("recipe");
    for (const c of DEFAULT_MEMORY_CATEGORIES) {
      expect(cats).toContain(c);
    }
  });

  it("setMemoryCategories deduplicates", () => {
    setMemoryCategories(["fact", "fact", "custom"]);
    const cats = getMemoryCategories();
    const factCount = cats.filter((c) => c === "fact").length;
    expect(factCount).toBe(1);
  });

  it("isValidCategory returns true for defaults", () => {
    for (const c of DEFAULT_MEMORY_CATEGORIES) {
      expect(isValidCategory(c)).toBe(true);
    }
  });

  it("isValidCategory returns false for unknown category", () => {
    expect(isValidCategory("nonexistent-category-xyz")).toBe(false);
  });

  it("isValidCategory recognizes custom categories after set", () => {
    setMemoryCategories(["devops"]);
    expect(isValidCategory("devops")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vectorDimsForModel
// ---------------------------------------------------------------------------

describe("vectorDimsForModel", () => {
  it("returns 1536 for text-embedding-3-small", () => {
    expect(vectorDimsForModel("text-embedding-3-small")).toBe(1536);
  });

  it("returns 3072 for text-embedding-3-large", () => {
    expect(vectorDimsForModel("text-embedding-3-large")).toBe(3072);
  });

  it("throws for unsupported model", () => {
    expect(() => vectorDimsForModel("unknown-model")).toThrow(
      /Unsupported embedding model/,
    );
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL_TYPES
// ---------------------------------------------------------------------------

describe("CREDENTIAL_TYPES", () => {
  it("contains expected types", () => {
    expect(CREDENTIAL_TYPES).toContain("token");
    expect(CREDENTIAL_TYPES).toContain("password");
    expect(CREDENTIAL_TYPES).toContain("api_key");
    expect(CREDENTIAL_TYPES).toContain("ssh");
    expect(CREDENTIAL_TYPES).toContain("bearer");
    expect(CREDENTIAL_TYPES).toContain("other");
  });
});

// ---------------------------------------------------------------------------
// hybridConfigSchema.parse
// ---------------------------------------------------------------------------

describe("hybridConfigSchema.parse", () => {
  const validBase = {
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
  };

  it("parses minimal valid config", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.embedding.provider).toBe("openai");
    expect(result.embedding.model).toBe("text-embedding-3-small");
    expect(result.autoCapture).toBe(true);
    expect(result.autoRecall.enabled).toBe(true);
  });

  it("memoryTiering defaults when omitted", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.memoryTiering.enabled).toBe(true);
    expect(result.memoryTiering.hotMaxTokens).toBe(2000);
    expect(result.memoryTiering.compactionOnSessionEnd).toBe(true);
    expect(result.memoryTiering.inactivePreferenceDays).toBe(7);
    expect(result.memoryTiering.hotMaxFacts).toBe(50);
  });

  it("throws on missing embedding.apiKey", () => {
    expect(() => hybridConfigSchema.parse({})).toThrow(/apiKey/);
  });

  it("throws on placeholder apiKey", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { apiKey: "YOUR_OPENAI_API_KEY" },
      }),
    ).toThrow(/placeholder/);
  });

  it("throws on too-short apiKey", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { apiKey: "short" },
      }),
    ).toThrow(/missing or a placeholder/);
  });

  it("throws on null/array/string config", () => {
    expect(() => hybridConfigSchema.parse(null)).toThrow();
    expect(() => hybridConfigSchema.parse([])).toThrow();
    expect(() => hybridConfigSchema.parse("string")).toThrow();
  });

  it("uses default model when not specified", () => {
    const result = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass" },
    });
    expect(result.embedding.model).toBe("text-embedding-3-small");
  });

  it("parses embedding.models when same dimension", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
        models: ["text-embedding-3-small"],
      },
    });
    expect(result.embedding.models).toEqual(["text-embedding-3-small"]);
    expect(result.embedding.model).toBe("text-embedding-3-small");
  });

  it("rejects embedding.models when mixed dimensions", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
        models: ["text-embedding-3-small", "text-embedding-3-large"],
      },
    });
    expect(result.embedding.models).toBeUndefined();
    expect(result.embedding.model).toBe("text-embedding-3-small");
  });

  it("respects autoCapture = false", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoCapture: false,
    });
    expect(result.autoCapture).toBe(false);
  });

  it("parses autoRecall object config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        enabled: true,
        maxTokens: 500,
        injectionFormat: "short",
        limit: 10,
        minScore: 0.5,
      },
    });
    expect(result.autoRecall.maxTokens).toBe(500);
    expect(result.autoRecall.injectionFormat).toBe("short");
    expect(result.autoRecall.limit).toBe(10);
    expect(result.autoRecall.minScore).toBe(0.5);
  });

  it("parses autoRecall.scopeFilter", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        scopeFilter: {
          userId: "alice",
          agentId: "support-bot",
          sessionId: "sess-xyz",
        },
      },
    });
    expect(result.autoRecall.scopeFilter).toBeDefined();
    expect(result.autoRecall.scopeFilter?.userId).toBe("alice");
    expect(result.autoRecall.scopeFilter?.agentId).toBe("support-bot");
    expect(result.autoRecall.scopeFilter?.sessionId).toBe("sess-xyz");
  });

  it("uses defaults for autoRecall when boolean false", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: false,
    });
    expect(result.autoRecall.enabled).toBe(false);
    expect(result.autoRecall.maxTokens).toBe(800);
    expect(result.autoRecall.injectionFormat).toBe("full");
    expect(result.autoRecall.limit).toBe(10);
  });

  it("defaults autoRecall.limit to 10 when not specified", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        enabled: true,
      },
    });
    expect(result.autoRecall.limit).toBe(10);
  });

  it("defaults autoRecall.limit to 10 when autoRecall is boolean", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.autoRecall.limit).toBe(10);
  });

  it("defaults captureMaxChars to 5000", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.captureMaxChars).toBe(5000);
  });

  it("respects custom captureMaxChars", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      captureMaxChars: 10000,
    });
    expect(result.captureMaxChars).toBe(10000);
  });

  it("defaults store.fuzzyDedupe to false", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.fuzzyDedupe).toBe(false);
  });

  it("defaults store.classifyBeforeWrite to false", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.classifyBeforeWrite).toBe(false);
  });

  it("defaults store.classifyModel to undefined", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.classifyModel).toBeUndefined();
  });

  it("respects store.classifyBeforeWrite and store.classifyModel when set", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      store: { fuzzyDedupe: false, classifyBeforeWrite: true, classifyModel: "gpt-4.1-nano" },
    });
    expect(result.store.classifyBeforeWrite).toBe(true);
    expect(result.store.classifyModel).toBe("gpt-4.1-nano");
  });

  it("WAL is enabled by default", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.wal.enabled).toBe(true);
    expect(result.wal.maxAge).toBe(5 * 60 * 1000);
  });

  it("credentials disabled by default", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.credentials.enabled).toBe(false);
  });

  it("credentials auto-enable with valid key", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      credentials: {
        encryptionKey: "abcdefghij1234567890",
      },
    });
    expect(result.credentials.enabled).toBe(true);
    expect(result.credentials.encryptionKey).toBe("abcdefghij1234567890");
  });

  it("allows credentials enabled without key (vault plaintext)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      credentials: {
        enabled: true,
        // No encryptionKey → vault in plaintext (user secures by other means)
      },
    });
    expect(result.credentials.enabled).toBe(true);
    expect(result.credentials.encryptionKey).toBe("");
  });

  it("throws when credentials enabled with short or unresolved encryption key", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        credentials: { enabled: true, encryptionKey: "short" },
      }),
    ).toThrow(/encryptionKey must be at least 16 characters/);
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        credentials: { enabled: true, encryptionKey: "env:MISSING_ENV_VAR_XYZ" },
      }),
    ).toThrow(/Credentials encryption key env var MISSING_ENV_VAR_XYZ is not set/);
  });

  it("errorReporting defaults to undefined when not provided", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.errorReporting).toBeUndefined();
  });

  it("parses errorReporting in community mode", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        mode: "community",
      },
    });
    expect(result.errorReporting).toBeDefined();
    expect(result.errorReporting?.enabled).toBe(true);
    expect(result.errorReporting?.consent).toBe(true);
    expect(result.errorReporting?.mode).toBe("community");
    expect(result.errorReporting?.dsn).toBeUndefined();
  });

  it("parses errorReporting in self-hosted mode with DSN", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        mode: "self-hosted",
        dsn: "https://abc123@glitchtip.example.com/1",
      },
    });
    expect(result.errorReporting).toBeDefined();
    expect(result.errorReporting?.mode).toBe("self-hosted");
    expect(result.errorReporting?.dsn).toBe("https://abc123@glitchtip.example.com/1");
  });

  it("throws when self-hosted mode enabled without DSN", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        errorReporting: {
          enabled: true,
          consent: true,
          mode: "self-hosted",
        },
      }),
    ).toThrow(/mode is "self-hosted" but dsn is empty or missing/);
  });

  it("throws when DSN contains placeholders", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        errorReporting: {
          enabled: true,
          consent: true,
          mode: "self-hosted",
          dsn: "https://<key>@<host>/<project-id>",
        },
      }),
    ).toThrow(/dsn contains placeholder values/);
  });

  it("defaults mode to community when not specified", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
      },
    });
    expect(result.errorReporting?.mode).toBe("community");
  });

  it("parses errorReporting.botId when valid UUID", () => {
    const botId = "550e8400-e29b-41d4-a716-446655440000";
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        botId,
      },
    });
    expect(result.errorReporting?.botId).toBe(botId);
  });

  it("ignores errorReporting.botId when not a valid UUID", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        botId: "not-a-uuid",
      },
    });
    expect(result.errorReporting?.botId).toBeUndefined();
  });

  it("parses errorReporting.botName (friendly name)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        botName: "Maeve",
      },
    });
    expect(result.errorReporting?.botName).toBe("Maeve");
  });

  it("truncates errorReporting.botName to 64 chars", () => {
    const longName = "a".repeat(100);
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: true,
        botName: longName,
      },
    });
    expect(result.errorReporting?.botName).toHaveLength(64);
    expect(result.errorReporting?.botName).toBe("a".repeat(64));
  });

  it("parses custom categories", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      categories: ["workflow", "recipe"],
    });
    expect(result.categories).toContain("workflow");
    expect(result.categories).toContain("recipe");
    expect(result.categories).toContain("fact");
  });

  it("autoClassify defaults to disabled", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.autoClassify.enabled).toBe(false);
    expect(result.autoClassify.model).toBeUndefined();
    expect(result.autoClassify.batchSize).toBe(20);
  });

  it("parses entity lookup config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        entityLookup: {
          enabled: true,
          entities: ["user", "owner"],
          maxFactsPerEntity: 3,
        },
      },
    });
    expect(result.autoRecall.entityLookup.enabled).toBe(true);
    expect(result.autoRecall.entityLookup.entities).toEqual(["user", "owner"]);
    expect(result.autoRecall.entityLookup.maxFactsPerEntity).toBe(3);
  });

  it("parses progressive disclosure config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        injectionFormat: "progressive",
        progressiveMaxCandidates: 20,
        progressiveIndexMaxTokens: 400,
        progressiveGroupByCategory: true,
      },
    });
    expect(result.autoRecall.injectionFormat).toBe("progressive");
    expect(result.autoRecall.progressiveMaxCandidates).toBe(20);
    expect(result.autoRecall.progressiveIndexMaxTokens).toBe(400);
    expect(result.autoRecall.progressiveGroupByCategory).toBe(true);
  });

  it("defaults progressiveIndexMaxTokens to 300 when injectionFormat is progressive", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        injectionFormat: "progressive",
      },
    });
    expect(result.autoRecall.injectionFormat).toBe("progressive");
    expect(result.autoRecall.progressiveIndexMaxTokens).toBe(300);
    expect(result.autoRecall.progressiveMaxCandidates).toBe(15);
  });

  it("defaults progressiveIndexMaxTokens to 300 when injectionFormat is progressive_hybrid", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        injectionFormat: "progressive_hybrid",
      },
    });
    expect(result.autoRecall.progressiveIndexMaxTokens).toBe(300);
  });

  it("respects explicit progressiveIndexMaxTokens when format is progressive", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        injectionFormat: "progressive",
        progressiveIndexMaxTokens: 500,
      },
    });
    expect(result.autoRecall.progressiveIndexMaxTokens).toBe(500);
  });

  it("parses optional distill config (Gemini for session distillation)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      distill: {
        apiKey: "env:GOOGLE_API_KEY",
        defaultModel: "gemini-2.0-flash",
      },
    });
    expect(result.distill).toBeDefined();
    expect(result.distill?.apiKey).toBe("env:GOOGLE_API_KEY");
    expect(result.distill?.defaultModel).toBe("gemini-2.0-flash");
  });

  it("distill is undefined when omitted", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.distill).toBeUndefined();
  });

  it("parses llm config when default and heavy arrays are non-empty", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      llm: {
        default: ["gemini-2.0-flash", "gpt-4o-mini"],
        heavy: ["gemini-2.0-flash-thinking", "gpt-4o"],
        fallbackToDefault: true,
        fallbackModel: "gpt-4o-mini",
      },
    });
    expect(result.llm).toBeDefined();
    expect(result.llm!.default).toEqual(["gemini-2.0-flash", "gpt-4o-mini"]);
    expect(result.llm!.heavy).toEqual(["gemini-2.0-flash-thinking", "gpt-4o"]);
    expect(result.llm!.fallbackToDefault).toBe(true);
    expect(result.llm!.fallbackModel).toBe("gpt-4o-mini");
  });

  it("allows single-tier llm (only default or only heavy)", () => {
    const withHeavyOnly = hybridConfigSchema.parse({
      ...validBase,
      llm: { default: [], heavy: ["gpt-4o"] },
    });
    expect(withHeavyOnly.llm).toBeDefined();
    expect(withHeavyOnly.llm!.default).toEqual([]);
    expect(withHeavyOnly.llm!.heavy).toEqual(["gpt-4o"]);
    const withDefaultOnly = hybridConfigSchema.parse({
      ...validBase,
      llm: { default: ["gpt-4o-mini"], heavy: [] },
    });
    expect(withDefaultOnly.llm).toBeDefined();
    expect(withDefaultOnly.llm!.default).toEqual(["gpt-4o-mini"]);
    expect(withDefaultOnly.llm!.heavy).toEqual([]);
  });

  it("getLLMModelPreference does not append fallback when fallbackModel is unset", () => {
    const cfg = hybridConfigSchema.parse({
      ...validBase,
      llm: {
        default: ["gemini-2.0-flash"],
        heavy: ["gpt-4o"],
        fallbackToDefault: true,
        fallbackModel: undefined,
      },
    });
    const cronCfg = getCronModelConfig(cfg);
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-2.0-flash"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gpt-4o"]);
  });

  it("getLLMModelPreference returns list and fallback when llm configured", () => {
    const cfg = hybridConfigSchema.parse({
      ...validBase,
      llm: {
        default: ["gemini-2.0-flash", "gpt-4o-mini"],
        heavy: ["gpt-4o"],
        fallbackToDefault: true,
        fallbackModel: "gpt-4o-mini",
      },
    });
    const cronCfg = getCronModelConfig(cfg);
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-2.0-flash", "gpt-4o-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(getDefaultCronModel(cronCfg, "default")).toBe("gemini-2.0-flash");
    expect(getDefaultCronModel(cronCfg, "heavy")).toBe("gpt-4o");
  });

  it("getLLMModelPreference when llm is undefined uses legacy single model (valid OpenAI IDs for direct client)", () => {
    const cronCfg = undefined;
    const defaultList = getLLMModelPreference(cronCfg, "default");
    const heavyList = getLLMModelPreference(cronCfg, "heavy");
    expect(defaultList).toHaveLength(1);
    expect(heavyList).toHaveLength(1);
    expect(defaultList[0]).toBe("gpt-4o-mini");
    expect(heavyList[0]).toBe("gpt-4o");
  });

  it("getLLMModelPreference when llm tier arrays are empty uses legacy (valid OpenAI IDs)", () => {
    const cronCfg = { llm: { default: [], heavy: [] } };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gpt-4o-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gpt-4o"]);
  });

  it("getLLMModelPreference legacy path: Gemini first (distill.apiKey set)", () => {
    const cronCfg = {
      embedding: { apiKey: "sk-embed-key-that-is-long-enough" },
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345", defaultModel: "gemini-custom" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-custom"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gemini-custom"]);
  });

  it("getLLMModelPreference legacy path: Gemini default model when distill.defaultModel unset", () => {
    const cronCfg = {
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-2.0-flash"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gemini-2.0-flash-thinking-exp-01-21"]);
  });

  it("getLLMModelPreference legacy path: Claude second (claude.apiKey set, no distill)", () => {
    const cronCfg = {
      claude: { apiKey: "sk-claude-key-that-is-long-enough", defaultModel: "claude-custom" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["claude-custom"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["claude-custom"]);
  });

  it("getLLMModelPreference legacy path: Claude defaults when claude.defaultModel unset", () => {
    const cronCfg = {
      claude: { apiKey: "sk-claude-key-that-is-long-enough" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["claude-sonnet-4-20250514"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["claude-opus-4-20250514"]);
  });

  it("getLLMModelPreference legacy path: OpenAI third (embedding.apiKey, no distill/claude) returns valid OpenAI model IDs", () => {
    const cronCfg = {
      embedding: { apiKey: "sk-embed-key-that-is-long-enough" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gpt-4o-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gpt-4o"]);
  });

  it("getLLMModelPreference legacy path: reflection.model does NOT override provider priority", () => {
    const cronCfg = {
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345" },
      reflection: { model: "gpt-4o-mini" },
    };
    // reflection.model should NOT override Gemini when distill.apiKey is configured
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-2.0-flash"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gemini-2.0-flash-thinking-exp-01-21"]);
  });

  describe("resolveReflectionModelAndFallbacks", () => {
    it("returns default tier from llm.default with fallbacks when multiple models", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        llm: { default: ["gemini-2.0-flash", "gpt-4o-mini"], heavy: ["gpt-4o"] },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultModel).toBe("gemini-2.0-flash");
      expect(fallbackModels).toEqual(["gpt-4o-mini"]);
    });

    it("returns heavy tier from llm.heavy with fallbacks when multiple models", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        llm: { default: ["gpt-4o-mini"], heavy: ["gpt-4o", "gpt-4o-mini"] },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "heavy");
      expect(defaultModel).toBe("gpt-4o");
      expect(fallbackModels).toEqual(["gpt-4o-mini"]);
    });

    it("when llm set and single model in tier, fallbackModels is undefined", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        llm: { default: ["gemini-2.0-flash"], heavy: ["gpt-4o"] },
      });
      const defaultTier = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultTier.defaultModel).toBe("gemini-2.0-flash");
      expect(defaultTier.fallbackModels).toBeUndefined();
      const heavyTier = resolveReflectionModelAndFallbacks(cfg, "heavy");
      expect(heavyTier.defaultModel).toBe("gpt-4o");
      expect(heavyTier.fallbackModels).toBeUndefined();
    });

    it("when no llm config, uses legacy single model and distill.fallbackModels for fallbacks", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        distill: { apiKey: "GEMINI_KEY_LONG_ENOUGH_12345", defaultModel: "gemini-custom", fallbackModels: ["gpt-4o-mini", "gpt-4o"] },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultModel).toBe("gemini-custom");
      expect(fallbackModels).toEqual(["gpt-4o-mini", "gpt-4o"]);
    });

    it("when no llm and no distill.fallbackModels, fallbackModels is undefined", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        distill: { apiKey: "GEMINI_KEY_LONG_ENOUGH_12345", defaultModel: "gemini-custom" },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultModel).toBe("gemini-custom");
      expect(fallbackModels).toBeUndefined();
    });

    it("empty preference list falls back to gateway-safe default/heavy models", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        llm: { default: [], heavy: [] },
      });
      const defaultTier = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultTier.defaultModel).toBe("gpt-4o-mini");
      const heavyTier = resolveReflectionModelAndFallbacks(cfg, "heavy");
      expect(heavyTier.defaultModel).toBe("gpt-4o");
    });
  });

  it("parses optional selfCorrection config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      selfCorrection: {
        semanticDedup: false,
        semanticDedupThreshold: 0.88,
        toolsSection: "My rules",
        autoRewriteTools: true,
        analyzeViaSpawn: true,
        spawnThreshold: 20,
        spawnModel: "gemini-1.5-pro",
      },
    });
    expect(result.selfCorrection).toBeDefined();
    expect(result.selfCorrection?.semanticDedup).toBe(false);
    expect(result.selfCorrection?.semanticDedupThreshold).toBe(0.88);
    expect(result.selfCorrection?.toolsSection).toBe("My rules");
    expect(result.selfCorrection?.applyToolsByDefault).toBe(true);
    expect(result.selfCorrection?.autoRewriteTools).toBe(true);
    expect(result.selfCorrection?.analyzeViaSpawn).toBe(true);
    expect(result.selfCorrection?.spawnThreshold).toBe(20);
    expect(result.selfCorrection?.spawnModel).toBe("gemini-1.5-pro");
  });

  it("selfCorrection applyToolsByDefault defaults to true when block present", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      selfCorrection: { toolsSection: "Rules" },
    });
    expect(result.selfCorrection?.applyToolsByDefault).toBe(true);
  });

  it("selfCorrection applyToolsByDefault can be set false to opt out", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      selfCorrection: { applyToolsByDefault: false },
    });
    expect(result.selfCorrection?.applyToolsByDefault).toBe(false);
  });

  it("selfCorrection is undefined when omitted", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.selfCorrection).toBeUndefined();
  });

  it("languageKeywords defaults when omitted", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.languageKeywords).toEqual({ autoBuild: true, weeklyIntervalDays: 7 });
  });

  it("parses languageKeywords when provided", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      languageKeywords: { autoBuild: false, weeklyIntervalDays: 14 },
    });
    expect(result.languageKeywords.autoBuild).toBe(false);
    expect(result.languageKeywords.weeklyIntervalDays).toBe(14);
  });

  it("parses optional ingest config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      ingest: {
        paths: ["skills/**/*.md", "TOOLS.md"],
        chunkSize: 800,
        overlap: 100,
      },
    });
    expect(result.ingest).toBeDefined();
    expect(result.ingest?.paths).toEqual(["skills/**/*.md", "TOOLS.md"]);
    expect(result.ingest?.chunkSize).toBe(800);
    expect(result.ingest?.overlap).toBe(100);
  });

  it("ingest uses defaults for chunkSize and overlap", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      ingest: { paths: ["docs/*.md"] },
    });
    expect(result.ingest?.chunkSize).toBe(800);
    expect(result.ingest?.overlap).toBe(100);
  });

  it("parses optional search config (HyDE)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: {
        hydeEnabled: true,
        hydeModel: "gpt-4o-mini",
      },
    });
    expect(result.search).toBeDefined();
    expect(result.search?.hydeEnabled).toBe(true);
    expect(result.search?.hydeModel).toBe("gpt-4o-mini");
  });

  it("parses search with hydeEnabled true and no hydeModel (runtime uses llm/default, issue #92)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: { hydeEnabled: true },
    });
    expect(result.search).toBeDefined();
    expect(result.search?.hydeEnabled).toBe(true);
    expect(result.search?.hydeModel).toBeUndefined();
  });

  it("multiAgent defaults to orchestratorId='main' and defaultStoreScope='global' (backward compatible)", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.multiAgent).toBeDefined();
    expect(result.multiAgent.orchestratorId).toBe("main");
    expect(result.multiAgent.defaultStoreScope).toBe("global");
  });

  it("parses multiAgent config with custom orchestratorId", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      multiAgent: {
        orchestratorId: "maeve",
        defaultStoreScope: "global",
      },
    });
    expect(result.multiAgent.orchestratorId).toBe("maeve");
    expect(result.multiAgent.defaultStoreScope).toBe("global");
  });

  it("parses multiAgent config with defaultStoreScope='agent'", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      multiAgent: {
        orchestratorId: "main",
        defaultStoreScope: "agent",
      },
    });
    expect(result.multiAgent.defaultStoreScope).toBe("agent");
  });

  it("parses multiAgent config with defaultStoreScope='auto'", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      multiAgent: {
        orchestratorId: "main",
        defaultStoreScope: "auto",
      },
    });
    expect(result.multiAgent.defaultStoreScope).toBe("auto");
  });

  it("multiAgent.orchestratorId trims whitespace", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      multiAgent: {
        orchestratorId: "  maeve  ",
      },
    });
    expect(result.multiAgent.orchestratorId).toBe("maeve");
  });

  it("multiAgent.defaultStoreScope defaults to 'global' for invalid values", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      multiAgent: {
        orchestratorId: "main",
        defaultStoreScope: "invalid" as any,
      },
    });
    expect(result.multiAgent.defaultStoreScope).toBe("global");
  });

  describe("config mode presets", () => {
    it("mode essential: disables autoClassify, graph, procedures, reflection, credentials", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "essential" as ConfigMode,
      });
      expect(result.mode).toBe("essential");
      expect(result.autoClassify.enabled).toBe(false);
      expect(result.graph.enabled).toBe(false);
      expect(result.procedures.enabled).toBe(false);
      expect(result.reflection.enabled).toBe(false);
      expect(result.credentials.enabled).toBe(false);
      expect(result.autoCapture).toBe(true);
      expect(result.autoRecall.enabled).toBe(true);
      expect(result.wal.enabled).toBe(true);
      expect(result.languageKeywords.autoBuild).toBe(false);
      expect(result.personaProposals.enabled).toBe(false);
      expect(result.memoryTiering.enabled).toBe(false);
      expect(result.autoRecall.entityLookup.enabled).toBe(false);
      expect(result.autoRecall.authFailure.enabled).toBe(false);
    });

    it("mode normal: enables autoClassify, graph, procedures; disables reflection", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "normal" as ConfigMode,
      });
      expect(result.mode).toBe("normal");
      expect(result.autoClassify.enabled).toBe(true);
      expect(result.graph.enabled).toBe(true);
      expect(result.procedures.enabled).toBe(true);
      expect(result.reflection.enabled).toBe(false);
      expect(result.credentials.enabled).toBe(false);
      expect(result.graph.autoLink).toBe(false);
      expect(result.store.classifyBeforeWrite).toBe(false);
    });

    it("mode expert: enables reflection, classifyBeforeWrite, graph.autoLink, credential sub-options when vault on", () => {
      process.env.OPENCLAW_CRED_KEY = "a-long-secret-key-at-least-16-chars";
      try {
        const result = hybridConfigSchema.parse({
          ...validBase,
          mode: "expert" as ConfigMode,
          credentials: {
            encryptionKey: "env:OPENCLAW_CRED_KEY",
          },
        });
        expect(result.mode).toBe("expert");
        expect(result.reflection.enabled).toBe(true);
        expect(result.store.classifyBeforeWrite).toBe(true);
        expect(result.graph.autoLink).toBe(true);
        expect(result.credentials.enabled).toBe(true);
        expect(result.credentials.autoDetect).toBe(true);
        expect(result.credentials.autoCapture?.toolCalls).toBe(true);
      } finally {
        delete process.env.OPENCLAW_CRED_KEY;
      }
    });

    it("mode full: enables search.hydeEnabled when search block present", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "full" as ConfigMode,
        search: {},
      });
      expect(result.mode).toBe("full");
      expect(result.search).toBeDefined();
      expect(result.search!.hydeEnabled).toBe(true);
    });

    it("user overrides win over preset (mode essential + graph.enabled true); mode becomes Custom for verify", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "essential" as ConfigMode,
        graph: { enabled: true },
      });
      expect(result.mode).toBe("custom"); // overrides → show "Custom" in verify
      expect(result.graph.enabled).toBe(true);
      expect(result.autoClassify.enabled).toBe(false);
    });

    it("no mode: result.mode is undefined", () => {
      const result = hybridConfigSchema.parse(validBase);
      expect(result.mode).toBeUndefined();
    });
  });
});
