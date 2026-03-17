/**
 * Tests for migrateCredentialsToVault (services/credential-migration.ts).
 * All backends are mocked — no real SQLite / LanceDB / filesystem required.
 */

import { describe, it, expect, vi } from "vitest";
import { migrateCredentialsToVault, type MigrateCredentialsOptions } from "../services/credential-migration.js";
import { VAULT_POINTER_PREFIX } from "../services/auto-capture.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockFactsDB = {
  lookup: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  setEmbeddingModel: ReturnType<typeof vi.fn>;
};

type MockVectorDB = {
  delete: ReturnType<typeof vi.fn>;
  hasDuplicate: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
};

type MockCredentialsDB = {
  store: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

type MockEmbeddings = {
  modelName: string;
  dimensions: number;
  embed: ReturnType<typeof vi.fn>;
};

/** A valid GitHub PAT — ghp_ + 36 alphanumeric chars = passes extractCredentialMatch + validateCredentialValue. */
const TOKEN_VALUE = "ghp_" + "A".repeat(36);

function makeFactsDB(overrides: Partial<MockFactsDB> = {}): MockFactsDB {
  return {
    lookup: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    store: vi.fn().mockReturnValue({ id: "pointer-id-1", text: "", category: "technical" }),
    setEmbeddingModel: vi.fn(),
    ...overrides,
  };
}

function makeVectorDB(overrides: Partial<MockVectorDB> = {}): MockVectorDB {
  return {
    delete: vi.fn().mockResolvedValue(true),
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue("ok"),
    ...overrides,
  };
}

function makeCredentialsDB(overrides: Partial<MockCredentialsDB> = {}): MockCredentialsDB {
  return {
    store: vi.fn(),
    get: vi.fn().mockReturnValue({ service: "github", type: "api_key", value: TOKEN_VALUE }),
    ...overrides,
  };
}

function makeEmbeddings(overrides: Partial<MockEmbeddings> = {}): MockEmbeddings {
  return {
    modelName: "test-model",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    ...overrides,
  };
}

function makeCredentialFact(
  overrides: Partial<{ id: string; text: string; entity: string; key: string; value: string | null }> = {},
) {
  return {
    entry: {
      id: overrides.id ?? "fact-id-1",
      text: overrides.text ?? `GitHub token: ${TOKEN_VALUE}`,
      category: "technical" as const,
      importance: 0.8,
      entity: overrides.entity ?? "Credentials",
      key: overrides.key ?? "github",
      value: Object.hasOwn(overrides, "value") ? overrides.value : TOKEN_VALUE,
      source: "conversation",
      createdAt: Math.floor(Date.now() / 1000),
      decayClass: "permanent" as const,
      expiresAt: null,
      lastConfirmedAt: Math.floor(Date.now() / 1000),
      confidence: 1.0,
    },
    score: 1.0,
  };
}

function makeOpts(
  overrides: Partial<MigrateCredentialsOptions> & {
    factsDb?: MockFactsDB;
    vectorDb?: MockVectorDB;
    credentialsDb?: MockCredentialsDB;
    embeddings?: MockEmbeddings;
  } = {},
): MigrateCredentialsOptions {
  return {
    factsDb: (overrides.factsDb ?? makeFactsDB()) as unknown as MigrateCredentialsOptions["factsDb"],
    vectorDb: (overrides.vectorDb ?? makeVectorDB()) as unknown as MigrateCredentialsOptions["vectorDb"],
    embeddings: (overrides.embeddings ?? makeEmbeddings()) as unknown as MigrateCredentialsOptions["embeddings"],
    credentialsDb: (overrides.credentialsDb ??
      makeCredentialsDB()) as unknown as MigrateCredentialsOptions["credentialsDb"],
    migrationFlagPath: "/tmp/test-migration-flag",
    markDone: false,
    writeFn: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateCredentialsToVault", () => {
  describe("happy path — fact migrated to vault pointer", () => {
    it("migrates a credential fact, deletes original, stores pointer, deletes vector", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const vectorDb = makeVectorDB();
      const credentialsDb = makeCredentialsDB();
      const embeddings = makeEmbeddings();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, vectorDb, credentialsDb, embeddings }));

      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Original fact deleted
      expect(factsDb.delete).toHaveBeenCalledWith("fact-id-1");

      // Vault store called with correct fields
      expect(credentialsDb.store).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "github",
          type: "api_key",
          value: TOKEN_VALUE,
        }),
      );

      // Pointer fact stored in factsDb with vault: prefix value
      expect(factsDb.store).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.stringMatching(/^vault:/),
          entity: "Credentials",
          key: "github",
        }),
      );

      // Vector for original fact deleted
      expect(vectorDb.delete).toHaveBeenCalledWith("fact-id-1");

      // Embedding generated for pointer text
      expect(embeddings.embed).toHaveBeenCalled();

      // Pointer vector stored
      expect(vectorDb.store).toHaveBeenCalled();
    });

    it("stores pointer text containing service name and retrieve instructions", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB();

      await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      const storeCall = (factsDb.store as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(storeCall.text).toContain("github");
      expect(storeCall.text).toContain("stored in secure vault");
      expect(storeCall.value).toBe(`${VAULT_POINTER_PREFIX}github:api_key`);
    });
  });

  describe("idempotency — running twice does not create duplicate vault entries", () => {
    it("skips facts whose text already contains 'stored in secure vault'", async () => {
      const pointerFact = makeCredentialFact({
        text: `Credential for github (api_key) — stored in secure vault. Use credential_get(service="github", type="api_key") to retrieve.`,
        value: `${VAULT_POINTER_PREFIX}github:api_key`,
      });
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([pointerFact]) });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0); // filtered before even counting as skipped
      expect(credentialsDb.store).not.toHaveBeenCalled();
    });

    it("skips facts whose value already starts with vault: prefix", async () => {
      const pointerFact = makeCredentialFact({
        // Text doesn't mention "stored in secure vault" but value already has vault: prefix
        text: `GitHub token: ${TOKEN_VALUE}`,
        value: `${VAULT_POINTER_PREFIX}github:api_key`,
      });
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([pointerFact]) });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.migrated).toBe(0);
      expect(credentialsDb.store).not.toHaveBeenCalled();
    });
  });

  describe("unparseable fact — skipped counter incremented", () => {
    it("skips fact with no credential pattern and no usable secret value", async () => {
      // value=null means secretFromParam=null, no pattern in text → tryParseCredentialForVault returns null
      const unparseable = makeCredentialFact({
        text: "User note: dark mode preferred",
        entity: "Credentials",
        key: "preference",
        value: null,
      });
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([unparseable]) });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.skipped).toBe(1);
      expect(result.migrated).toBe(0);
      expect(credentialsDb.store).not.toHaveBeenCalled();
    });

    it("handles mix of parseable and unparseable facts", async () => {
      const credFact = makeCredentialFact({ id: "fact-cred" });
      // value=null and text without patterns → skipped
      const unparseable = makeCredentialFact({
        id: "fact-plain",
        text: "Generic storage note with no token",
        entity: "Credentials",
        key: "note",
        value: null,
      });
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([credFact, unparseable]) });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe("markDone=true — flag file written after successful migration", () => {
    it("calls writeFn with the migration flag path when markDone=true and no errors", async () => {
      const writeFn = vi.fn();
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB();

      await migrateCredentialsToVault(
        makeOpts({ factsDb, credentialsDb, markDone: true, migrationFlagPath: "/tmp/mig-flag", writeFn }),
      );

      expect(writeFn).toHaveBeenCalledWith("/tmp/mig-flag", "1", "utf8");
    });

    it("does not call writeFn when markDone=false", async () => {
      const writeFn = vi.fn();
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB();

      await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb, markDone: false, writeFn }));

      expect(writeFn).not.toHaveBeenCalled();
    });
  });

  describe("partial failure — vault-store throws, migration continues, flag NOT written", () => {
    it("collects error and continues when credentialsDb.store throws on first item", async () => {
      // Two facts: first fails to store, second succeeds
      const fact1 = makeCredentialFact({ id: "fact-1", key: "github" });
      const TOKEN2 = "sk-" + "B".repeat(48);
      const fact2 = makeCredentialFact({
        id: "fact-2",
        key: "openai",
        text: `OpenAI API key: ${TOKEN2}`,
        value: TOKEN2,
      });
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact1, fact2]) });
      const credentialsDb = makeCredentialsDB({
        store: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("vault write failed");
          })
          .mockReturnValue(undefined),
        get: vi.fn().mockReturnValue({ service: "openai", type: "api_key", value: TOKEN2 }),
      });
      const writeFn = vi.fn();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb, markDone: true, writeFn }));

      // Error collected from fact-1 failure
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("vault write failed");

      // Second fact still migrated
      expect(result.migrated).toBe(1);

      // Flag NOT written because there are errors
      expect(writeFn).not.toHaveBeenCalled();
    });

    it("does not write flag when all items fail", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB({
        store: vi.fn().mockImplementation(() => {
          throw new Error("storage failure");
        }),
      });
      const writeFn = vi.fn();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb, markDone: true, writeFn }));

      expect(result.errors.length).toBeGreaterThan(0);
      expect(writeFn).not.toHaveBeenCalled();
    });
  });

  describe("vector delete failure — migration continues", () => {
    it("does not fail migration when vectorDb.delete throws a non-'not found' error", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const vectorDb = makeVectorDB({
        delete: vi.fn().mockRejectedValue(new Error("lancedb connection timeout")),
      });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, vectorDb, credentialsDb }));

      // Migration still counted as success (vector delete failure is non-fatal)
      expect(result.migrated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("tolerates vectorDb.delete throwing 'not found' silently", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const vectorDb = makeVectorDB({
        delete: vi.fn().mockRejectedValue(new Error("row not found in table")),
      });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, vectorDb, credentialsDb }));

      expect(result.migrated).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("vault verification failure — error collected", () => {
    it("adds error when credentialsDb.get returns null after store", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB({
        store: vi.fn(),
        get: vi.fn().mockReturnValue(null),
      });

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.migrated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("vault verification failed");
    });

    it("adds error when stored value does not match expected secretValue", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB({
        store: vi.fn(),
        get: vi.fn().mockReturnValue({ service: "github", type: "api_key", value: "wrong-value" }),
      });

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb }));

      expect(result.migrated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("vault verification failed");
    });
  });

  describe("aliasDb — deleteByFactId called when provided", () => {
    it("calls aliasDb.deleteByFactId for migrated facts", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB();
      const aliasDb = { deleteByFactId: vi.fn() };

      await migrateCredentialsToVault(
        makeOpts({ factsDb, credentialsDb, aliasDb: aliasDb as unknown as MigrateCredentialsOptions["aliasDb"] }),
      );

      expect(aliasDb.deleteByFactId).toHaveBeenCalledWith("fact-id-1");
    });

    it("works without aliasDb (aliasDb=null)", async () => {
      const fact = makeCredentialFact();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([fact]) });
      const credentialsDb = makeCredentialsDB();

      const result = await migrateCredentialsToVault(makeOpts({ factsDb, credentialsDb, aliasDb: null }));

      expect(result.migrated).toBe(1);
    });
  });

  describe("empty input — no facts to migrate", () => {
    it("returns zero counts when there are no credential facts", async () => {
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([]) });

      const result = await migrateCredentialsToVault(makeOpts({ factsDb }));

      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("calls writeFn when markDone=true even with nothing to migrate", async () => {
      const writeFn = vi.fn();
      const factsDb = makeFactsDB({ lookup: vi.fn().mockReturnValue([]) });

      await migrateCredentialsToVault(makeOpts({ factsDb, markDone: true, writeFn }));

      // No errors, markDone=true, so flag IS written (migration completed cleanly with 0 items)
      expect(writeFn).toHaveBeenCalledWith("/tmp/test-migration-flag", "1", "utf8");
    });
  });
});
