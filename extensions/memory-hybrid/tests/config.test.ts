import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pluginLogger } from "../utils/logger.js";
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
  getLLMModelPreferenceUnfiltered,
  getProvidersWithKeys,
  resolveReflectionModelAndFallbacks,
  type DecayClass,
  type HybridMemoryConfig,
} from "../config.js";
import type { ConfigMode } from "../config.js";

// ---------------------------------------------------------------------------
// Decay classes & TTL defaults
// ---------------------------------------------------------------------------

describe("DECAY_CLASSES", () => {
  it("contains the nine expected classes (legacy + new salience classes)", () => {
    expect(DECAY_CLASSES).toEqual([
      "permanent",
      "durable",
      "normal",
      "short",
      "ephemeral",
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

  it("durable is ~3 months in seconds", () => {
    expect(TTL_DEFAULTS.durable).toBe(90 * 24 * 3600);
  });

  it("normal is 2 weeks in seconds", () => {
    expect(TTL_DEFAULTS.normal).toBe(14 * 24 * 3600);
  });

  it("short is 2 days in seconds", () => {
    expect(TTL_DEFAULTS.short).toBe(2 * 24 * 3600);
  });

  it("ephemeral is 4 hours in seconds", () => {
    expect(TTL_DEFAULTS.ephemeral).toBe(4 * 3600);
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
    expect(() => vectorDimsForModel("unknown-model")).toThrow(/Unsupported embedding model/);
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
  afterEach(() => vi.unstubAllEnvs());

  const validBase = {
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
  };

  it("parses minimal valid config", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.embedding.provider).toBe("openai"); // inferred: apiKey + OpenAI model
    expect(result.embedding.model).toBe("text-embedding-3-small");
    expect(result.autoCapture).toBe(true);
    expect(result.autoRecall.enabled).toBe(true);
  });

  it("parses retrieval directives config", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      autoRecall: {
        retrievalDirectives: {
          enabled: true,
          entityMentioned: false,
          keywords: ["oncall"],
          taskTypes: { debug: ["bug", "fix"] },
          sessionStart: true,
          limit: 5,
          maxPerPrompt: 6,
        },
      },
    });

    expect(result.autoRecall.retrievalDirectives.enabled).toBe(true);
    expect(result.autoRecall.retrievalDirectives.entityMentioned).toBe(false);
    expect(result.autoRecall.retrievalDirectives.keywords).toEqual(["oncall"]);
    expect(result.autoRecall.retrievalDirectives.taskTypes.debug).toEqual(["bug", "fix"]);
    expect(result.autoRecall.retrievalDirectives.sessionStart).toBe(true);
    expect(result.autoRecall.retrievalDirectives.limit).toBe(5);
    expect(result.autoRecall.retrievalDirectives.maxPerPrompt).toBe(6);
  });

  it("memoryTiering defaults when omitted (no mode → local: tiering off)", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.memoryTiering.enabled).toBe(false);
    expect(result.memoryTiering.hotMaxTokens).toBe(2000);
    expect(result.memoryTiering.compactionOnSessionEnd).toBe(true);
    expect(result.memoryTiering.inactivePreferenceDays).toBe(7);
    expect(result.memoryTiering.hotMaxFacts).toBe(50);
  });

  it("throws on missing embedding (model required when provider defaults to ollama)", () => {
    expect(() => hybridConfigSchema.parse({})).toThrow(/embedding\.model|embedding\.apiKey/);
  });

  it("throws on placeholder apiKey", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "openai", apiKey: "YOUR_OPENAI_API_KEY" },
      }),
    ).toThrow(/placeholder/);
  });

  it("throws on too-short apiKey", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "openai", apiKey: "short" },
      }),
    ).toThrow(/missing or a placeholder/);
  });

  // ── embedding.apiKey SecretRef (env:VAR) resolution — Issue #333 ─────────────

  it("resolves embedding.apiKey when set as env:VAR_NAME SecretRef (openai provider)", () => {
    vi.stubEnv("TEST_EMBED_API_KEY_333", "sk-resolved-key-that-is-long-enough");
    try {
      const result = hybridConfigSchema.parse({
        embedding: { provider: "openai", apiKey: "env:TEST_EMBED_API_KEY_333", model: "text-embedding-3-small" },
      });
      // Resolved value must be the actual key, not the literal "env:..." string
      expect(result.embedding.apiKey).toBe("sk-resolved-key-that-is-long-enough");
      expect(result.embedding.apiKey).not.toMatch(/^env:/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws when embedding.apiKey env: SecretRef references an unset env var", () => {
    delete process.env.TEST_EMBED_KEY_UNSET_333;
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "openai", apiKey: "env:TEST_EMBED_KEY_UNSET_333", model: "text-embedding-3-small" },
      }),
    ).toThrow(/could not be resolved/);
  });

  it("resolves embedding.apiKey env: SecretRef for non-openai provider fallback (ollama)", () => {
    vi.stubEnv("TEST_EMBED_FALLBACK_KEY_333", "sk-fallback-key-that-is-long-enough");
    try {
      const result = hybridConfigSchema.parse({
        embedding: { provider: "ollama", model: "nomic-embed-text", apiKey: "env:TEST_EMBED_FALLBACK_KEY_333" },
      });
      expect(result.embedding.apiKey).toBe("sk-fallback-key-that-is-long-enough");
      expect(result.embedding.apiKey).not.toMatch(/^env:/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Finding 1: resolved SecretRef value is re-validated for placeholder/length
  it("throws when embedding.apiKey SecretRef resolves to a placeholder value", () => {
    vi.stubEnv("TEST_EMBED_PLACEHOLDER_333", "YOUR_OPENAI_API_KEY");
    try {
      expect(() =>
        hybridConfigSchema.parse({
          embedding: { provider: "openai", apiKey: "env:TEST_EMBED_PLACEHOLDER_333", model: "text-embedding-3-small" },
        }),
      ).toThrow(/missing or a placeholder/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Finding 2: short env var names (raw string < 10 chars) must not be blocked by the raw-length check
  it("accepts env: SecretRef with a short env var name (raw string < 10 chars)", () => {
    vi.stubEnv("KEY", "sk-resolved-key-that-is-long-enough");
    try {
      const result = hybridConfigSchema.parse({
        embedding: { provider: "openai", apiKey: "env:KEY", model: "text-embedding-3-small" },
      });
      expect(result.embedding.apiKey).toBe("sk-resolved-key-that-is-long-enough");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Provider inference must recognize env:/file: SecretRef format as valid apiKey
  it("infers openai provider when apiKey is env: SecretRef with short env var name", () => {
    vi.stubEnv("KEY", "sk-resolved-key-that-is-long-enough");
    try {
      const result = hybridConfigSchema.parse({
        embedding: { apiKey: "env:KEY", model: "text-embedding-3-small" },
      });
      expect(result.embedding.provider).toBe("openai");
      expect(result.embedding.apiKey).toBe("sk-resolved-key-that-is-long-enough");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Finding 3: unresolvable SecretRef in fallback path warns instead of silently dropping
  it("warns when fallback embedding.apiKey SecretRef cannot be resolved", () => {
    delete process.env.TEST_EMBED_FALLBACK_UNSET_333;
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      const result = hybridConfigSchema.parse({
        embedding: { provider: "ollama", model: "nomic-embed-text", apiKey: "env:TEST_EMBED_FALLBACK_UNSET_333" },
      });
      // Should not throw — fallback apiKey is optional
      expect(result.embedding.apiKey).toBeUndefined();
      // Should have warned about the unresolvable SecretRef
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/could not be resolved/));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws on null/array/string config", () => {
    expect(() => hybridConfigSchema.parse(null)).toThrow();
    expect(() => hybridConfigSchema.parse([])).toThrow();
    expect(() => hybridConfigSchema.parse("string")).toThrow();
  });

  it("throws on invalid embedding.provider", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "foobar", model: "nomic-embed-text", dimensions: 768 },
      }),
    ).toThrow(/Invalid embedding\.provider/);
  });

  // ---------------------------------------------------------------------------
  // Local provider validation (#153 — plugin schema gap fix)
  // ---------------------------------------------------------------------------

  it("ONNX config without apiKey passes validation (provider='onnx', model set)", () => {
    const result = hybridConfigSchema.parse({
      embedding: { provider: "onnx", model: "all-MiniLM-L6-v2" },
    });
    expect(result.embedding.provider).toBe("onnx");
    expect(result.embedding.model).toBe("all-MiniLM-L6-v2");
    expect(result.embedding.apiKey).toBeUndefined();
    expect(result.embedding.dimensions).toBe(384);
  });

  it("ONNX config using onnxModelPath alias (no apiKey) passes validation", () => {
    const result = hybridConfigSchema.parse({
      embedding: { provider: "onnx", onnxModelPath: "bge-small-en-v1.5" },
    });
    expect(result.embedding.provider).toBe("onnx");
    expect(result.embedding.model).toBe("bge-small-en-v1.5");
    expect(result.embedding.apiKey).toBeUndefined();
  });

  it("Ollama config without apiKey passes validation (provider='ollama', model set)", () => {
    const result = hybridConfigSchema.parse({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
    });
    expect(result.embedding.provider).toBe("ollama");
    expect(result.embedding.model).toBe("nomic-embed-text");
    expect(result.embedding.apiKey).toBeUndefined();
    expect(result.embedding.dimensions).toBe(768);
  });

  it("Ollama config using ollamaModel alias (no apiKey) passes validation", () => {
    const result = hybridConfigSchema.parse({
      embedding: { provider: "ollama", ollamaModel: "mxbai-embed-large" },
    });
    expect(result.embedding.provider).toBe("ollama");
    expect(result.embedding.model).toBe("mxbai-embed-large");
    expect(result.embedding.apiKey).toBeUndefined();
    expect(result.embedding.dimensions).toBe(1024);
  });

  it("OpenAI config without apiKey fails validation with clear message", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "openai" },
      }),
    ).toThrow(/embedding\.apiKey/);
  });

  it("ONNX missing model fails with hint to use embedding.model or embedding.onnxModelPath", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "onnx" },
      }),
    ).toThrow(/embedding\.model.*embedding\.onnxModelPath/);
  });

  it("Ollama missing model fails with hint to use embedding.model or embedding.ollamaModel", () => {
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "ollama" },
      }),
    ).toThrow(/embedding\.model.*embedding\.ollamaModel/);
  });

  it("throws on invalid mode (e.g. typo)", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        mode: "ful",
      }),
    ).toThrow(/invalid mode "ful"/);
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        mode: "invalid",
      }),
    ).toThrow(/invalid mode "invalid"/);
  });

  it("warns when embedding section present but provider is not set", () => {
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      hybridConfigSchema.parse({
        embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "nomic-embed-text" },
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/embedding\.provider not set/));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn about provider when embedding section is absent", () => {
    // When no embedding section, default to ollama and throw model required; provider warn should NOT fire
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      expect(() => hybridConfigSchema.parse({})).toThrow(/embedding\.model|embedding\.apiKey/);
      const warnCalls = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("embedding.provider not set"),
      );
      expect(warnCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses default model when not specified", () => {
    const result = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough-to-pass" },
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

  it("no mode applies local preset: store.fuzzyDedupe is true", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.fuzzyDedupe).toBe(true);
  });

  it("no mode applies local preset: store.classifyBeforeWrite is false", () => {
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

  it("does not throw for short or unresolved encryption key; uses plaintext vault", () => {
    const shortKey = hybridConfigSchema.parse({
      ...validBase,
      credentials: { enabled: true, encryptionKey: "short" },
    });
    expect(shortKey.credentials.enabled).toBe(true);
    expect(shortKey.credentials.encryptionKey).toBe("");

    const envMissing = hybridConfigSchema.parse({
      ...validBase,
      credentials: { enabled: true, encryptionKey: "env:MISSING_ENV_VAR_XYZ" },
    });
    expect(envMissing.credentials.enabled).toBe(true);
    expect(envMissing.credentials.encryptionKey).toBe("");
  });

  it("errorReporting defaults to opt-out config (enabled+consent=true) when not provided", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.errorReporting).toBeDefined();
    expect(result.errorReporting.enabled).toBe(true);
    expect(result.errorReporting.consent).toBe(true);
    expect(result.errorReporting.mode).toBe("community");
    expect(result.errorReporting.dsn).toBe("https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1");
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
    expect(result.errorReporting?.dsn).toBe("https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1");
  });

  it("disables errorReporting when consent is false", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      errorReporting: {
        enabled: true,
        consent: false,
        mode: "community",
      },
    });
    expect(result.errorReporting?.enabled).toBe(false);
    expect(result.errorReporting?.consent).toBe(false);
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

  it("no mode applies local preset: autoClassify.enabled is false", () => {
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

  // ── Google embedding.googleApiKey SecretRef resolution — Issue #344 ──────────
  // distill.apiKey / llm.providers.google.apiKey stored as literal "env:VAR" or "file:/path"
  // when resolveEnvVars() was called — it only handles ${VAR} template syntax, not the env:/file:
  // SecretRef format. Fixed by using resolveSecretRef() so embedding.googleApiKey holds the
  // actual resolved key, not the literal SecretRef string.

  it("resolves embedding.googleApiKey when distill.apiKey is env:VAR SecretRef (Issue #344)", () => {
    vi.stubEnv("TEST_GEMINI_API_KEY_344", "test-google-key-resolved-long-enough-00000001");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      distill: { apiKey: "env:TEST_GEMINI_API_KEY_344", defaultModel: "gemini-2.0-flash" },
    });
    // embedding.googleApiKey must be the resolved value, not the literal "env:..." string
    expect(result.embedding.googleApiKey).toBe("test-google-key-resolved-long-enough-00000001");
    expect(result.embedding.googleApiKey).not.toMatch(/^env:/);
    // distill.apiKey stays raw (resolved at runtime by resolveApiKey() in init-databases)
    expect(result.distill?.apiKey).toBe("env:TEST_GEMINI_API_KEY_344");
  });

  it("throws when distill.apiKey env: SecretRef for google embedding references an unset env var (Issue #344)", () => {
    delete process.env.TEST_GEMINI_KEY_UNSET_344;
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
        distill: { apiKey: "env:TEST_GEMINI_KEY_UNSET_344" },
      }),
    ).toThrow(/SecretRef.*could not be resolved/);
  });

  it("resolves embedding.googleApiKey when llm.providers.google.apiKey is env:VAR SecretRef (Issue #344)", () => {
    vi.stubEnv("TEST_GEMINI_PROVIDER_KEY_344", "test-google-key-provider-long-enough-000000002");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      llm: {
        default: ["google/gemini-2.0-flash"],
        providers: { google: { apiKey: "env:TEST_GEMINI_PROVIDER_KEY_344" } },
      },
    });
    expect(result.embedding.googleApiKey).toBe("test-google-key-provider-long-enough-000000002");
    expect(result.embedding.googleApiKey).not.toMatch(/^env:/);
  });

  it("resolves short SecretRef like env:GKEY (9 chars) for google embedding (Issue #344 edge case)", () => {
    vi.stubEnv("GKEY", "test-google-key-short-ref-resolved-long-enough");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      distill: { apiKey: "env:GKEY" },
    });
    expect(result.embedding.googleApiKey).toBe("test-google-key-short-ref-resolved-long-enough");
    expect(result.embedding.googleApiKey).not.toMatch(/^env:/);
  });

  // ── ${VAR} template syntax for Google API key (Issue #373 review comment #15) ─────────────────

  it("resolves embedding.googleApiKey when distill.apiKey uses ${VAR} template syntax (Issue #373)", () => {
    vi.stubEnv("TEST_GEMINI_TMPL_KEY_373", "AIzaSy-template-key-that-is-long-enough-to-pass");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      distill: { apiKey: "${TEST_GEMINI_TMPL_KEY_373}", defaultModel: "gemini-2.0-flash" },
    });
    expect(result.embedding.googleApiKey).toBe("AIzaSy-template-key-that-is-long-enough-to-pass");
    expect(result.embedding.googleApiKey).not.toContain("${");
  });

  it("throws when distill.apiKey ${VAR} template references an unset env var (Issue #373)", () => {
    delete process.env.TEST_GEMINI_TMPL_UNSET_373;
    expect(() =>
      hybridConfigSchema.parse({
        embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
        distill: { apiKey: "${TEST_GEMINI_TMPL_UNSET_373}" },
      }),
    ).toThrow(/SecretRef.*could not be resolved/);
  });

  it("resolves embedding.googleApiKey when distill.apiKey is a file: SecretRef (Issue #373)", () => {
    const tmpFile = require("node:os").tmpdir() + "/test-gemini-key-373.txt";
    require("node:fs").writeFileSync(tmpFile, "AIzaSy-file-key-that-is-long-enough-to-pass\n");
    try {
      const result = hybridConfigSchema.parse({
        embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
        distill: { apiKey: `file:${tmpFile}`, defaultModel: "gemini-2.0-flash" },
      });
      expect(result.embedding.googleApiKey).toBe("AIzaSy-file-key-that-is-long-enough-to-pass");
      expect(result.embedding.googleApiKey).not.toMatch(/^file:/);
    } finally {
      require("node:fs").unlinkSync(tmpFile);
    }
  });

  // ── hasGoogleKey recognises ${VAR} template format (Issue #2921626583) ──────────────────────────

  it("hasGoogleKey: short ${VAR} template (< 10 chars) is recognised and key is resolved (Issue #2921626583)", () => {
    // "${KEY}" is only 6 chars — previously below the length threshold and incorrectly skipped.
    vi.stubEnv("KEY", "AIzaSy-short-template-key-long-enough-to-pass");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      distill: { apiKey: "${KEY}", defaultModel: "gemini-2.0-flash" },
    });
    expect(result.embedding.googleApiKey).toBe("AIzaSy-short-template-key-long-enough-to-pass");
  });

  // ── validity-based fallback: invalid distill.apiKey falls back to llm google key (#2921626579) ──

  it("falls back to llm.providers.google.apiKey when distill.apiKey is short/invalid (Issue #2921626579)", () => {
    vi.stubEnv("LLM_GOOGLE_KEY_373", "AIzaSy-llm-google-key-long-enough-to-pass");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      // distill.apiKey is 3 chars — not a valid key and not a SecretRef; should NOT win
      distill: { apiKey: "bad", defaultModel: "gemini-2.0-flash" },
      llm: { providers: { google: { apiKey: "env:LLM_GOOGLE_KEY_373" } } },
    });
    expect(result.embedding.googleApiKey).toBe("AIzaSy-llm-google-key-long-enough-to-pass");
  });

  it("malformed template distill.apiKey (no closing brace) falls back to llm.providers.google.apiKey (Issue #2921658704)", () => {
    vi.stubEnv("LLM_GOOGLE_FALLBACK_373", "AIzaSy-llm-fallback-key-long-enough-to-pass");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      // "${BROKEN" has ${ but no } — not a valid SecretRef, must not win over a valid llm key
      distill: { apiKey: "${BROKEN", defaultModel: "gemini-2.0-flash" },
      llm: { providers: { google: { apiKey: "env:LLM_GOOGLE_FALLBACK_373" } } },
    });
    expect(result.embedding.googleApiKey).toBe("AIzaSy-llm-fallback-key-long-enough-to-pass");
  });

  // ── resolveSecretRef: resolved value containing ${...} is not rejected (#2921445142) ──────────

  it("resolveSecretRef returns env var value even when it contains a literal ${ sequence (Issue #2921445142)", () => {
    // The env var's value contains "${" — this should NOT be treated as an unresolved template.
    vi.stubEnv("GEMINI_KEY_WITH_DOLLAR_BRACE", "AIzaSy-value-containing-${literal}-suffix-123456");
    const result = hybridConfigSchema.parse({
      embedding: { provider: "google", model: "text-embedding-004", dimensions: 768 },
      distill: { apiKey: "${GEMINI_KEY_WITH_DOLLAR_BRACE}", defaultModel: "gemini-2.0-flash" },
    });
    expect(result.embedding.googleApiKey).toBe("AIzaSy-value-containing-${literal}-suffix-123456");
  });

  it("no mode applies local preset: distill has extractDirectives true, extractReinforcement false", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.distill).toBeDefined();
    expect(result.distill?.extractDirectives).toBe(true);
    expect(result.distill?.extractReinforcement).toBe(false);
  });

  it("parses distill.extractionModelTier (nano | default | heavy)", () => {
    expect(
      hybridConfigSchema.parse({ ...validBase, distill: { extractionModelTier: "nano" } }).distill?.extractionModelTier,
    ).toBe("nano");
    expect(
      hybridConfigSchema.parse({ ...validBase, distill: { extractionModelTier: "default" } }).distill
        ?.extractionModelTier,
    ).toBe("default");
    expect(
      hybridConfigSchema.parse({ ...validBase, distill: { extractionModelTier: "heavy" } }).distill
        ?.extractionModelTier,
    ).toBe("heavy");
    expect(
      hybridConfigSchema.parse({ ...validBase, distill: { extractionModelTier: "other" } }).distill
        ?.extractionModelTier,
    ).toBeUndefined();
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

  it("getLLMModelPreference and getProvidersWithKeys exclude llm.disabledProviders", () => {
    const cfg = hybridConfigSchema.parse({
      ...validBase,
      llm: {
        default: ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
        heavy: ["anthropic/claude-opus-4-6"],
        disabledProviders: ["anthropic"],
      },
      distill: { apiKey: "google-key-10ch" },
      claude: { apiKey: "anthropic-key-10ch" },
      embedding: { provider: "openai", apiKey: "openai-key-10ch", model: "text-embedding-3-small" },
    });
    const cronCfg = getCronModelConfig(cfg);
    expect(getLLMModelPreferenceUnfiltered(cronCfg, "default")).toEqual([
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4.1-mini",
    ]);
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["google/gemini-2.5-flash", "openai/gpt-4.1-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual([]);
    expect(getProvidersWithKeys(cronCfg)).toEqual(expect.arrayContaining(["google", "openai"]));
    expect(getProvidersWithKeys(cronCfg)).not.toContain("anthropic");
  });

  it("getLLMModelPreference when llm is undefined uses legacy single model (OpenClaw provider/model IDs)", () => {
    const cronCfg = undefined;
    const defaultList = getLLMModelPreference(cronCfg, "default");
    const heavyList = getLLMModelPreference(cronCfg, "heavy");
    expect(defaultList).toHaveLength(1);
    expect(heavyList).toHaveLength(1);
    expect(defaultList[0]).toBe("openai/gpt-4.1-mini");
    expect(heavyList[0]).toBe("openai/gpt-5.4");
  });

  it("getLLMModelPreference when llm tier arrays are empty uses legacy (OpenClaw provider/model IDs)", () => {
    const cronCfg = { llm: { default: [], heavy: [] } };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["openai/gpt-4.1-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["openai/gpt-5.4"]);
  });

  it("getLLMModelPreference legacy path: Gemini first then OpenAI when both have keys (failover list)", () => {
    const cronCfg = {
      embedding: { apiKey: "sk-embed-key-that-is-long-enough" },
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345", defaultModel: "gemini-custom" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["gemini-custom", "openai/gpt-4.1-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["gemini-custom", "openai/gpt-5.4"]);
  });

  it("getLLMModelPreference legacy path: Gemini default model when distill.defaultModel unset", () => {
    const cronCfg = {
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["google/gemini-2.5-flash"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["google/gemini-3.1-pro-preview"]);
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
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("getLLMModelPreference legacy path: OpenAI third (embedding.apiKey, no distill/claude) returns OpenClaw model IDs", () => {
    const cronCfg = {
      embedding: { apiKey: "sk-embed-key-that-is-long-enough" },
    };
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["openai/gpt-4.1-mini"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["openai/gpt-5.4"]);
  });

  it("getLLMModelPreference legacy path: reflection.model does NOT override provider priority", () => {
    const cronCfg = {
      distill: { apiKey: "GEMINI_API_KEY_LONG_ENOUGH_12345" },
      reflection: { model: "gpt-4o-mini" },
    };
    // reflection.model should NOT override Gemini when distill.apiKey is configured
    expect(getLLMModelPreference(cronCfg, "default")).toEqual(["google/gemini-2.5-flash"]);
    expect(getLLMModelPreference(cronCfg, "heavy")).toEqual(["google/gemini-3.1-pro-preview"]);
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
        distill: {
          apiKey: "GEMINI_KEY_LONG_ENOUGH_12345",
          defaultModel: "gemini-custom",
          fallbackModels: ["openai/gpt-5.4", "gpt-4o"],
        },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultModel).toBe("gemini-custom");
      // Built-in OpenAI default (gpt-4.1-mini) is inserted before user-specified distill.fallbackModels
      expect(fallbackModels).toEqual(["openai/gpt-4.1-mini", "openai/gpt-5.4", "gpt-4o"]);
    });

    it("when no llm and no distill.fallbackModels, fallbackModels is slice of built-in list (second provider)", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        distill: { apiKey: "GEMINI_KEY_LONG_ENOUGH_12345", defaultModel: "gemini-custom" },
      });
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultModel).toBe("gemini-custom");
      expect(fallbackModels).toEqual(["openai/gpt-4.1-mini"]);
    });

    it("empty preference list falls back to gateway-safe default/heavy models", () => {
      const cfg = hybridConfigSchema.parse({
        ...validBase,
        llm: { default: [], heavy: [] },
      });
      const defaultTier = resolveReflectionModelAndFallbacks(cfg, "default");
      expect(defaultTier.defaultModel).toBe("openai/gpt-4.1-mini");
      const heavyTier = resolveReflectionModelAndFallbacks(cfg, "heavy");
      expect(heavyTier.defaultModel).toBe("openai/gpt-5.4");
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

  it("no mode applies local preset: selfCorrection set by preset", () => {
    const result = hybridConfigSchema.parse(validBase);
    // Local preset has reflection and graph disabled
    expect(result.reflection.enabled).toBe(false);
    expect(result.graph.enabled).toBe(false);
  });

  it("languageKeywords defaults when omitted (no mode → local preset: autoBuild false)", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.languageKeywords.autoBuild).toBe(false);
    expect(result.languageKeywords.weeklyIntervalDays).toBe(7);
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

  it("parses optional search config (HyDE) — 2026.3.140 baseline forces queryExpansion off", () => {
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
    expect(result.queryExpansion.enabled).toBe(false);
  });

  it("parses search with hydeEnabled true and no hydeModel — 2026.3.140 baseline forces queryExpansion off", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: { hydeEnabled: true },
    });
    expect(result.search).toBeDefined();
    expect(result.search?.hydeEnabled).toBe(true);
    expect(result.queryExpansion.enabled).toBe(false);
  });

  it("migration shim (#160): 2026.3.140 baseline overrides queryExpansion.enabled=true to false", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, model: "openai/gpt-4.1-nano" },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.search).toBeUndefined();
  });

  it("migration shim (#160): 2026.3.140 baseline overrides both search.hydeEnabled and queryExpansion to disabled", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: { hydeEnabled: true, hydeModel: "old-model" },
      queryExpansion: { enabled: true, model: "new-model" },
    });
    expect(result.queryExpansion.enabled).toBe(false);
  });

  it("migration shim (#160): queryExpansion disabled by default when no mode (Phase 1; local preset)", () => {
    const result = hybridConfigSchema.parse({ ...validBase });
    expect(result.queryExpansion.enabled).toBe(false);
  });

  it("migration shim (#160): explicit queryExpansion.enabled=false overrides search.hydeEnabled=true", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: { hydeEnabled: true, hydeModel: "old-model" },
      queryExpansion: { enabled: false },
    });
    // queryExpansion.enabled is explicitly false → it wins over legacy hydeEnabled=true
    expect(result.queryExpansion.enabled).toBe(false);
    // Model should not be inherited when queryExpansion is explicitly disabled
    expect(result.queryExpansion.model).toBeUndefined();
  });

  it("migration shim (#160): 2026.3.140 baseline overrides queryExpansion.enabled=true to false", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      search: { hydeEnabled: true, hydeModel: "legacy-hyde-model" },
      queryExpansion: { enabled: true },
    });
    expect(result.queryExpansion.enabled).toBe(false);
  });
  it("queryExpansion.timeoutMs (#384): 2026.3.140 baseline enabled false, user timeout preserved and floored", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, timeoutMs: 5000 },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBe(10000); // parser floor MIN_QE_TIMEOUT_MS
  });
  it("queryExpansion.timeoutMs (#384): 2026.3.140 baseline enabled false, user timeout preserved", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, timeoutMs: 20000 },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBe(20000);
  });
  it("queryExpansion.timeoutMs (#384): defaults to 15000ms when not configured", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBe(15000);
  });
  it("reranking.timeoutMs (#384): 2026.3.140 baseline enabled false, user timeout floored", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true, timeoutMs: 1000 },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBe(5000); // parser floor MIN_RERANK_TIMEOUT_MS
  });
  it("reranking.timeoutMs (#384): 2026.3.140 baseline enabled false, user timeout preserved", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true, timeoutMs: 15000 },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBe(15000);
  });
  it("queryExpansion.timeoutMs (#384): 2026.3.140 baseline enabled false, floor value preserved", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, timeoutMs: 10000 },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBe(10000);
  });
  it("reranking.timeoutMs (#384): 2026.3.140 baseline enabled false, floor value preserved", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true, timeoutMs: 5000 },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBe(5000);
  });
  it("reranking.timeoutMs (#384): defaults to 10000ms when omitted", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBe(10000);
  });
  it("queryExpansion.timeoutMs (#384): 2026.3.140 baseline timeoutMs 0 bypasses floor (undefined)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, timeoutMs: 0 },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBeUndefined();
  });
  it("reranking.timeoutMs (#384): 2026.3.140 baseline timeoutMs 0 bypasses floor (undefined)", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true, timeoutMs: 0 },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBeUndefined();
  });
  it("queryExpansion.timeoutMs (#384): 2026.3.140 baseline Infinity coerced to default", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      queryExpansion: { enabled: true, timeoutMs: Number.POSITIVE_INFINITY },
    });
    expect(result.queryExpansion.enabled).toBe(false);
    expect(result.queryExpansion.timeoutMs).toBe(15000); // parser uses default when not finite
  });
  it("reranking.timeoutMs (#384): 2026.3.140 baseline Infinity coerced to default", () => {
    const result = hybridConfigSchema.parse({
      ...validBase,
      reranking: { enabled: true, timeoutMs: Number.POSITIVE_INFINITY },
    });
    expect(result.reranking.enabled).toBe(false);
    expect(result.reranking.timeoutMs).toBe(10000); // parser uses default when not finite
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
    it("mode local: FTS-only retrieval (no embed/LLM), disables autoClassify, graph, procedures, reflection", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "local" as ConfigMode,
      });
      expect(result.mode).toBe("local");
      expect(result.retrieval.strategies).toEqual(["fts5"]);
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

    it("mode minimal: enables autoClassify, graph, procedures, ingest paths; disables reflection; distill uses default (flash) tier", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "minimal" as ConfigMode,
      });
      expect(result.mode).toBe("minimal");
      expect(result.autoClassify.enabled).toBe(true);
      expect(result.graph.enabled).toBe(true);
      expect(result.procedures.enabled).toBe(true);
      expect(result.reflection.enabled).toBe(false);
      expect(result.credentials.enabled).toBe(false);
      expect(result.graph.autoLink).toBe(false);
      expect(result.store.classifyBeforeWrite).toBe(false);
      expect(result.distill?.extractionModelTier).toBe("default");
      expect(result.ingest?.paths).toEqual(["skills/**/*.md", "TOOLS.md", "AGENTS.md"]);
    });

    it("mode enhanced: enables reflection, classifyBeforeWrite, graph.autoLink, credential sub-options when vault on", () => {
      process.env.OPENCLAW_CRED_KEY = "a-long-secret-key-at-least-16-chars";
      try {
        const result = hybridConfigSchema.parse({
          ...validBase,
          mode: "enhanced" as ConfigMode,
          credentials: {
            encryptionKey: "env:OPENCLAW_CRED_KEY",
          },
        });
        expect(result.mode).toBe("enhanced");
        expect(result.reflection.enabled).toBe(true);
        expect(result.store.classifyBeforeWrite).toBe(true);
        expect(result.graph.autoLink).toBe(true);
        expect(result.credentials.enabled).toBe(true);
        // Phase 1: credentials.autoDetect forced off (opt-in); user must set explicitly to enable
        expect(result.credentials.autoDetect).toBe(false);
        expect(result.credentials.autoCapture?.toolCalls).toBe(true);
      } finally {
        delete process.env.OPENCLAW_CRED_KEY;
      }
    });

    it("mode complete: queryExpansion off by default (Phase 1); ingest paths set", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "complete" as ConfigMode,
      });
      expect(result.mode).toBe("complete");
      // Phase 1: complete preset no longer enables query expansion by default
      expect(result.queryExpansion.enabled).toBe(false);
      expect(result.search?.hydeEnabled).toBeFalsy();
      expect(result.ingest?.paths).toEqual(["skills/**/*.md", "TOOLS.md", "AGENTS.md"]);
    });

    it("user overrides win over preset (mode local + graph.enabled true); mode becomes Custom for verify", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        mode: "local" as ConfigMode,
        graph: { enabled: true },
      });
      expect(result.mode).toBe("custom"); // overrides → show "Custom" in verify
      expect(result.graph.enabled).toBe(true);
      expect(result.autoClassify.enabled).toBe(false);
    });

    it("no mode: result.mode is 'local' (default)", () => {
      const result = hybridConfigSchema.parse(validBase);
      expect(result.mode).toBe("local");
    });

    it("deprecated mode name 'normal' is interpreted as local and warns", () => {
      const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
      try {
        const result = hybridConfigSchema.parse({
          ...validBase,
          mode: "normal",
        });
        expect(result.mode).toBe("local");
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("local"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("no mode but user overrides preset: result.mode is 'custom'", () => {
      const result = hybridConfigSchema.parse({
        ...validBase,
        graph: { enabled: true },
      });
      expect(result.mode).toBe("custom"); // overrides local preset (graph.enabled true)
      expect(result.graph.enabled).toBe(true);
    });
  });
});
