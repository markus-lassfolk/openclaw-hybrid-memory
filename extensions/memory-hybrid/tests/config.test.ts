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
  type DecayClass,
  type HybridMemoryConfig,
} from "../config.js";

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

  it("FR-004: memoryTiering defaults when omitted", () => {
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

  it("parses autoRecall.scopeFilter (FR-006)", () => {
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

  it("defaults store.classifyBeforeWrite to false (FR-008)", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.classifyBeforeWrite).toBe(false);
  });

  it("defaults store.classifyModel to gpt-4o-mini (FR-008)", () => {
    const result = hybridConfigSchema.parse(validBase);
    expect(result.store.classifyModel).toBe("gpt-4o-mini");
  });

  it("respects store.classifyBeforeWrite and store.classifyModel when set (FR-008)", () => {
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

  it("throws when credentials enabled but key too short", () => {
    expect(() =>
      hybridConfigSchema.parse({
        ...validBase,
        credentials: {
          enabled: true,
          encryptionKey: "short",
        },
      }),
    ).toThrow(/encryptionKey must be at least 16 characters/);
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
    expect(result.autoClassify.model).toBe("gpt-4o-mini");
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

  it("parses progressive disclosure config (FR-009)", () => {
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
});
