import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialsDB } from "../backends/credentials-db.js";
import { FactsDB } from "../backends/facts-db.js";
import {
  abortCredentialVaultWriteOnPointerDedupe,
  buildCredentialPointerStoreInput,
  credentialPointerValue,
  deleteCredentialPointerFacts,
  ensureCredentialVaultPointer,
  findCredentialPointerFactIds,
} from "../services/credential-vault-pointer.js";

const TEST_KEY = "test-encryption-key-for-unit-tests-32chars";

let tmpDir: string;
let factsDb: FactsDB;
let credentialsDb: CredentialsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cred-vault-pointer-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  credentialsDb = new CredentialsDB(join(tmpDir, "creds.db"), TEST_KEY);
});

afterEach(() => {
  factsDb.close();
  credentialsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("credential-vault-pointer helpers", () => {
  it("builds stable vault pointer values", () => {
    expect(credentialPointerValue("github", "api_key")).toBe("vault:github:api_key");
    const input = buildCredentialPointerStoreInput("github", "api_key", "test");
    expect(input.entity).toBe("Credentials");
    expect(input.key).toBe("github");
    expect(input.value).toBe("vault:github:api_key");
  });

  it("dedupes pointer facts without creating duplicates", () => {
    const first = ensureCredentialVaultPointer(factsDb, "openai", "api_key", "test");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.newlyStored).toBe(true);

    const second = ensureCredentialVaultPointer(factsDb, "openai", "api_key", "test");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.newlyStored).toBe(false);
    expect(findCredentialPointerFactIds(factsDb, "openai", "api_key")).toHaveLength(1);
  });

  it("rolls back vault write when pointer is a pure dedupe", () => {
    ensureCredentialVaultPointer(factsDb, "orphan", "api_key", "test");
    credentialsDb.store({ service: "orphan", type: "api_key", value: "orphan-secret" });

    const pointer = ensureCredentialVaultPointer(factsDb, "orphan", "api_key", "test");
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;

    const shouldSkip = abortCredentialVaultWriteOnPointerDedupe(
      true,
      pointer,
      credentialsDb,
      "orphan",
      "api_key",
    );
    expect(shouldSkip).toBe(true);
    expect(credentialsDb.get("orphan", "api_key")).toBeNull();
  });

  it("deletes pointer facts for credential_delete cleanup", async () => {
    const pointer = ensureCredentialVaultPointer(factsDb, "slack", "token", "test");
    expect(pointer.ok).toBe(true);
    credentialsDb.store({ service: "slack", type: "token", value: "x".repeat(12) });

    const removed = await deleteCredentialPointerFacts(factsDb, null, "slack", "token");
    expect(removed).toBe(1);
    expect(findCredentialPointerFactIds(factsDb, "slack", "token")).toHaveLength(0);
    expect(credentialsDb.get("slack", "token")).not.toBeNull();
  });
});
