/**
 * Tests for CLI credential store rollback behavior.
 * Verifies compensating delete when vault write succeeds but pointer write fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStoreForCli } from "../cli/handlers.js";
import { FactsDB } from "../backends/facts-db.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import type { StoreCliOpts, StoreCliResult } from "../cli/types.js";
import type { HandlerContext } from "../cli/handlers.js";

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars";

let tmpDir: string;
let factsDb: FactsDB;
let credentialsDb: CredentialsDB;
let mockCtx: HandlerContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-store-rollback-"));
  const factsDbPath = join(tmpDir, "facts.db");
  const credsDbPath = join(tmpDir, "creds.db");

  factsDb = new FactsDB(factsDbPath);
  credentialsDb = new CredentialsDB(credsDbPath, TEST_ENCRYPTION_KEY);

  // Mock HandlerContext with minimal required fields
  mockCtx = {
    factsDb,
    credentialsDb,
    cfg: {
      credentials: { enabled: true, store: "sqlite" as const },
      store: { classifyBeforeWrite: false },
    },
    vectorDb: {
      hasDuplicate: vi.fn().mockResolvedValue(false),
      store: vi.fn().mockResolvedValue(undefined),
    },
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    },
  } as any;
});

afterEach(() => {
  factsDb.close();
  credentialsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path: both writes succeed
// ---------------------------------------------------------------------------

describe("runStoreForCli credential happy path", () => {
  it("stores credential in vault and pointer in factsDb", async () => {
    const opts: StoreCliOpts = {
      text: "OpenAI API Key: sk-testAbCdEfGh1234IjKlMnOpQrSt",
      category: "technical",
    };

    const result: StoreCliResult = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });

    expect(result.outcome).toBe("credential");
    if (result.outcome === "credential") {
      expect(result.service).toBe("openai");
      expect(result.type).toBe("api_key");
      expect(result.id).toBeTruthy();

      // Verify vault entry exists
      const vaultEntry = credentialsDb.get("openai", "api_key");
      expect(vaultEntry).not.toBeNull();
      expect(vaultEntry!.value).toBe("sk-testAbCdEfGh1234IjKlMnOpQrSt");

      // Verify pointer entry exists with correct format
      const pointerEntry = factsDb.getById(result.id);
      expect(pointerEntry).not.toBeNull();
      expect(pointerEntry!.value).toBe("vault:openai:api_key");
      expect(pointerEntry!.entity).toBe("Credentials");
    }
  });
});

// ---------------------------------------------------------------------------
// Vault write fails
// ---------------------------------------------------------------------------

describe("runStoreForCli vault write failure", () => {
  it("returns credential_vault_error when vault write fails", async () => {
    // Mock vault store to throw
    const originalStore = credentialsDb.store.bind(credentialsDb);
    credentialsDb.store = vi.fn().mockImplementation(() => {
      throw new Error("Vault storage failed");
    });

    const opts: StoreCliOpts = {
      text: "GitHub Token: ghp_test1234567890abcdefghijklmnopqrstuvwxy",
      category: "technical",
    };

    const result: StoreCliResult = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });

    expect(result.outcome).toBe("credential_vault_error");

    // Verify no orphaned pointer in factsDb
    const allFacts = factsDb.getAll();
    expect(allFacts.length).toBe(0);

    // Restore
    credentialsDb.store = originalStore;
  });
});

// ---------------------------------------------------------------------------
// Pointer write fails (compensating delete)
// ---------------------------------------------------------------------------

describe("runStoreForCli pointer write failure with compensating delete", () => {
  it("deletes vault entry when pointer write fails", async () => {
    // Mock factsDb.store to throw after vault write
    const originalFactsStore = factsDb.store.bind(factsDb);
    factsDb.store = vi.fn().mockImplementation(() => {
      throw new Error("FactsDB storage failed");
    });

    const opts: StoreCliOpts = {
      text: "Slack bot token: xoxb-test1234567890abcdefghijklmnopqrstuvwxyz",
      category: "technical",
    };

    const warnSpy = vi.fn();
    const result: StoreCliResult = await runStoreForCli(mockCtx, opts, { warn: warnSpy });

    expect(result.outcome).toBe("credential_db_error");

    // Verify vault entry was deleted (compensating delete)
    const vaultEntry = credentialsDb.get("slack", "bearer");
    expect(vaultEntry).toBeNull();

    // Verify no orphaned pointer
    const allFacts = factsDb.getAll();
    expect(allFacts.length).toBe(0);

    // Restore
    factsDb.store = originalFactsStore;
  });

  it("logs warning when compensating delete fails", async () => {
    // Mock factsDb.store to throw
    const originalFactsStore = factsDb.store.bind(factsDb);
    factsDb.store = vi.fn().mockImplementation(() => {
      throw new Error("FactsDB storage failed");
    });

    // Mock credentialsDb.delete to throw during cleanup
    const originalDelete = credentialsDb.delete.bind(credentialsDb);
    credentialsDb.delete = vi.fn().mockImplementation(() => {
      throw new Error("Delete failed");
    });

    const opts: StoreCliOpts = {
      text: "Twilio API Key: sk-test-1234567890abcdefghijklmnopqrstuvwxyz",
      category: "technical",
    };

    const warnSpy = vi.fn();
    const result: StoreCliResult = await runStoreForCli(mockCtx, opts, { warn: warnSpy });

    expect(result.outcome).toBe("credential_db_error");

    // Verify warning was logged for compensating delete failure
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to clean up orphaned credential")
    );

    // Restore
    factsDb.store = originalFactsStore;
    credentialsDb.delete = originalDelete;
  });
});

// ---------------------------------------------------------------------------
// Parse failure
// ---------------------------------------------------------------------------

describe("runStoreForCli credential parse failure", () => {
  it("returns credential_parse_error when credential-like text cannot be parsed to vault format", async () => {
    // This text matches isCredentialLike but tryParseCredentialForVault returns null
    // because the secret value is too short or doesn't match patterns
    const opts: StoreCliOpts = {
      text: "API Key: xyz",  // Too short to be a valid credential
      category: "technical",
      entity: "TestService",
      key: "api_key",
      value: "xyz",  // Too short
    };

    const result: StoreCliResult = await runStoreForCli(mockCtx, opts, { warn: vi.fn() });

    expect(result.outcome).toBe("credential_parse_error");

    // Verify nothing stored in vault
    const vaultList = credentialsDb.list();
    expect(vaultList.length).toBe(0);
  });
});
