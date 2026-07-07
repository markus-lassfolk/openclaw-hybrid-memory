/**
 * Regression test (loop iteration 72): runVerifyConfigCronSection's credentials-vault health
 * check test-decrypted only `items[0]` (the first stored credential) instead of every stored
 * credential. A vault with N>1 credentials where only a *later* row is corrupted (partial
 * disk/migration failure — the first row still decrypts fine) would be reported "OK" by verify,
 * silently missing real corruption an operator needs to know about.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsDB } from "../backends/credentials-db.js";
import { hybridConfigSchema } from "../config.js";

const TEST_KEY = "regression-test-vault-key-16plus-chars";

describe("runVerifyForCli — credentials vault partial corruption (loop iteration 72 regression)", () => {
  let homeDir: string | null = null;

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
    vi.unstubAllEnvs();
  });

  function setupHome(): string {
    homeDir = mkdtempSync(join(tmpdir(), "oc-verify-cred-corrupt-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(
      join(openclawDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } } }, null, 2),
    );
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    vi.stubEnv("HOME", homeDir);
    return openclawDir;
  }

  function buildCtx(credentialsDb: CredentialsDB | null) {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      llm: { default: ["openai/gpt-4.1-mini"] },
      credentials: { enabled: true },
    });
    return {
      cfg,
      factsDb: {
        count: () => 0,
        getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }),
      },
      vectorDb: {
        count: () => Promise.resolve(0),
        isLanceDbAvailable: () => true,
        ensureInitialized: () => Promise.resolve(),
        getVectorDim: () => 768,
        isMemoriesVectorSchemaValid: () => true,
      },
      embeddings: {
        dimensions: 768,
        embed: () => Promise.resolve(new Float32Array(768)),
        modelName: "nomic-embed-text",
      },
      credentialsDb,
      resolvedSqlitePath: ":memory:",
      resolvedLancePath: "/tmp/test-lance",
      openai: null,
    };
  }

  it("reports FAIL when a non-first credential row is corrupted", async () => {
    setupHome();
    const dbPath = join(homeDir!, "credentials.db");
    const db = new CredentialsDB(dbPath, TEST_KEY);
    // "aaa-good" sorts before "zzz-bad" per CredentialsDB.list()'s ORDER BY service, type —
    // so the corrupted row is guaranteed to land at a non-zero index.
    db.store({ service: "aaa-good", type: "api_key", value: "readable-secret" });
    db.store({ service: "zzz-bad", type: "api_key", value: "will-be-corrupted" });

    const rawDb = new DatabaseSync(dbPath);
    rawDb
      .prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = 'api_key'")
      .run(Buffer.from("not-valid-ciphertext-garbage-bytes"), "zzz-bad");
    rawDb.close();

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx(db) as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Credentials (vault): FAIL");
    db.close();
  });

  it("reports OK when every credential row decrypts fine", async () => {
    setupHome();
    const dbPath = join(homeDir!, "credentials.db");
    const db = new CredentialsDB(dbPath, TEST_KEY);
    db.store({ service: "aaa-good", type: "api_key", value: "readable-secret" });
    db.store({ service: "zzz-also-good", type: "api_key", value: "also-readable" });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx(db) as never, { fix: false }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Credentials (vault): OK (2 stored)");
    db.close();
  });
});
