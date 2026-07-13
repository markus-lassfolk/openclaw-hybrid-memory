/**
 * Regression tests for #2099's non-mutating migration-readiness preflight added to
 * `runRekeyVaultForCli`'s dry-run branch: is the backup directory writable, and — when
 * `credentials.encryptionKey` is a `file:` ref — is the target key file readable?
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRekeyVaultForCli } from "../cli/cmd-credentials.js";
import type { HandlerContext } from "../cli/handlers.js";

function makeCtx(overrides: {
  resolvedSqlitePath: string;
  encryptionKey?: string;
  encryptionKeyRef?: string;
}): HandlerContext {
  const credentials: Record<string, unknown> = { encryptionKey: overrides.encryptionKey ?? "x".repeat(32) };
  if (overrides.encryptionKeyRef) {
    Object.defineProperty(credentials, "encryptionKeyRef", {
      value: overrides.encryptionKeyRef,
      enumerable: false,
    });
  }
  return {
    resolvedSqlitePath: overrides.resolvedSqlitePath,
    cfg: { credentials } as unknown as HandlerContext["cfg"],
    credentialsDb: {
      getVaultStatus: () => ({ kdfVersion: 2, encryptedAtRest: true }),
    } as unknown as HandlerContext["credentialsDb"],
  } as unknown as HandlerContext;
}

describe("runRekeyVaultForCli dry-run preflight (#2099)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports backupPathWritable=true and targetKeyFileReadable=null for a plain (non file:) key", () => {
    dir = mkdtempSync(join(tmpdir(), "rekey-preflight-"));
    const ctx = makeCtx({ resolvedSqlitePath: join(dir, "facts.db") });

    const res = runRekeyVaultForCli(ctx, {});

    expect(res.ok).toBe(true);
    if (!res.ok || !res.dryRun) throw new Error("expected a dry-run result");
    expect(res.preflight.backupPathWritable).toBe(true);
    expect(res.preflight.targetKeyFileReadable).toBeNull();
  });

  it("reports targetKeyFileReadable=true when the configured file: ref exists and is readable", () => {
    dir = mkdtempSync(join(tmpdir(), "rekey-preflight-"));
    const keyFile = join(dir, "vault.key");
    writeFileSync(keyFile, "x".repeat(32), "utf-8");
    const ctx = makeCtx({ resolvedSqlitePath: join(dir, "facts.db"), encryptionKeyRef: `file:${keyFile}` });

    const res = runRekeyVaultForCli(ctx, {});

    expect(res.ok).toBe(true);
    if (!res.ok || !res.dryRun) throw new Error("expected a dry-run result");
    expect(res.preflight.targetKeyFileReadable).toBe(true);
  });

  it("reports targetKeyFileReadable=false when the configured file: ref does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "rekey-preflight-"));
    const missingKeyFile = join(dir, "does-not-exist.key");
    const ctx = makeCtx({ resolvedSqlitePath: join(dir, "facts.db"), encryptionKeyRef: `file:${missingKeyFile}` });

    const res = runRekeyVaultForCli(ctx, {});

    expect(res.ok).toBe(true);
    if (!res.ok || !res.dryRun) throw new Error("expected a dry-run result");
    expect(res.preflight.targetKeyFileReadable).toBe(false);
  });

  it("reports backupPathWritable=false when the vault directory does not exist", () => {
    const missingDir = join(tmpdir(), "rekey-preflight-missing-dir-that-does-not-exist");
    const ctx = makeCtx({ resolvedSqlitePath: join(missingDir, "facts.db") });

    const res = runRekeyVaultForCli(ctx, {});

    expect(res.ok).toBe(true);
    if (!res.ok || !res.dryRun) throw new Error("expected a dry-run result");
    expect(res.preflight.backupPathWritable).toBe(false);
  });
});
