/**
 * `credentials migrate-to-vault` must set a non-zero exit code when migration reports errors,
 * and `scope prune` must clean up vectors for the facts it actually deleted (not a pre-delete
 * snapshot) and must set a non-zero exit code when that vector cleanup fails.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageCredentialsAndScope } from "../cli/commands/manage/register-credentials-scope.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(bindings: Record<string, unknown>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageCredentialsAndScope(mem, bindings as unknown as ManageBindings);
  return mem;
}

describe("credentials migrate-to-vault exit code", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets process.exitCode when migration reports errors", async () => {
    const runMigrateToVault = vi.fn().mockResolvedValue({ migrated: 2, skipped: 0, errors: ["boom"] });
    const mem = makeProgram({ runMigrateToVault, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "migrate-to-vault"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("leaves process.exitCode unset when migration has no errors", async () => {
    const runMigrateToVault = vi.fn().mockResolvedValue({ migrated: 2, skipped: 0, errors: [] });
    const mem = makeProgram({ runMigrateToVault, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "migrate-to-vault"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("credentials vault-status legacy key surfacing (#2099)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("prints the legacy-key warning and remediation in human-readable output", async () => {
    const runVaultStatus = vi.fn().mockReturnValue({
      dbPath: "/tmp/creds.db",
      kdfVersion: 2,
      encryptedAtRest: true,
      configuredKeyPresent: true,
      keyIgnored: false,
      migrationRequired: false,
      entryCount: 3,
      legacyLiteralFileKey: true,
      legacyLiteralFileKeyRemediation: "openclaw hybrid-mem credentials rekey-vault --backup --verify --yes",
    });
    const mem = makeProgram({ runVaultStatus, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["credentials", "vault-status"], { from: "user" });

    expect(lines.some((l) => l.includes("Legacy key material"))).toBe(true);
    expect(lines.some((l) => l.includes("rekey-vault"))).toBe(true);
  });

  it("includes legacyLiteralFileKey in --json output", async () => {
    const runVaultStatus = vi.fn().mockReturnValue({
      dbPath: "/tmp/creds.db",
      kdfVersion: 2,
      encryptedAtRest: true,
      configuredKeyPresent: true,
      keyIgnored: false,
      migrationRequired: false,
      entryCount: 3,
      legacyLiteralFileKey: true,
      legacyLiteralFileKeyRemediation: "openclaw hybrid-mem credentials rekey-vault --backup --verify --yes",
    });
    const mem = makeProgram({ runVaultStatus, factsDb: {}, vectorDb: {} });
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });

    await mem.parseAsync(["credentials", "vault-status", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut);
    expect(parsed.legacyLiteralFileKey).toBe(true);
    expect(parsed.legacyLiteralFileKeyRemediation).toContain("rekey-vault");
  });

  it("says nothing about legacy key material when legacyLiteralFileKey is false", async () => {
    const runVaultStatus = vi.fn().mockReturnValue({
      dbPath: "/tmp/creds.db",
      kdfVersion: 2,
      encryptedAtRest: true,
      configuredKeyPresent: true,
      keyIgnored: false,
      migrationRequired: false,
      entryCount: 3,
      legacyLiteralFileKey: false,
      legacyLiteralFileKeyRemediation: null,
    });
    const mem = makeProgram({ runVaultStatus, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["credentials", "vault-status"], { from: "user" });

    expect(lines.some((l) => l.includes("Legacy key material"))).toBe(false);
  });
});

describe("credentials rekey-vault dry-run preflight (#2099)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("prints backup-path and target-key-file readiness, and a warning line when either is not ready", async () => {
    const runRekeyVault = vi.fn().mockReturnValue({
      ok: true,
      dryRun: true,
      vaultPath: "/tmp/creds.db",
      status: { kdfVersion: 2, encryptedAtRest: true },
      preflight: { backupPathWritable: false, targetKeyFileReadable: false },
    });
    const mem = makeProgram({ runRekeyVault, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["credentials", "rekey-vault"], { from: "user" });

    expect(lines.some((l) => l.includes("backup path writable=false"))).toBe(true);
    expect(lines.some((l) => l.includes("target key file readable=false"))).toBe(true);
    expect(lines.some((l) => l.includes("Backup directory is not writable"))).toBe(true);
    expect(lines.some((l) => l.includes("file: ref could not be read"))).toBe(true);
  });

  it("omits the target-key-file line entirely when the configured key is not a file: ref", async () => {
    const runRekeyVault = vi.fn().mockReturnValue({
      ok: true,
      dryRun: true,
      vaultPath: "/tmp/creds.db",
      status: { kdfVersion: 2, encryptedAtRest: true },
      preflight: { backupPathWritable: true, targetKeyFileReadable: null },
    });
    const mem = makeProgram({ runRekeyVault, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["credentials", "rekey-vault"], { from: "user" });

    expect(lines.some((l) => l.includes("backup path writable=true"))).toBe(true);
    expect(lines.some((l) => l.includes("target key file readable"))).toBe(false);
    expect(lines.some((l) => l.includes("Backup directory is not writable"))).toBe(false);
    expect(lines.some((l) => l.includes("file: ref could not be read"))).toBe(false);
  });
});

describe("credentials revisions (#2104)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects an invalid --type before calling the handler", async () => {
    const runCredentialRevisionList = vi.fn();
    const mem = makeProgram({ runCredentialRevisionList, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "revisions", "list", "--service", "svc", "--type", "bogus"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(runCredentialRevisionList).not.toHaveBeenCalled();
  });

  it("list prints revision metadata and never the value", async () => {
    const runCredentialRevisionList = vi.fn().mockReturnValue([
      {
        id: "rev-1",
        service: "doris-gateway",
        type: "other",
        url: "http://192.168.1.195",
        notes: null,
        created: 1000,
        credExpires: null,
        replacedAt: 2000,
        expiresAt: 2000 + 30 * 86400,
        pinnedAt: null,
        replacedBy: null,
      },
    ]);
    const mem = makeProgram({ runCredentialRevisionList, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await mem.parseAsync(["credentials", "revisions", "list", "--service", "doris-gateway", "--type", "other"], {
      from: "user",
    });

    expect(runCredentialRevisionList).toHaveBeenCalledWith({ service: "doris-gateway", type: "other" });
    expect(lines.some((l) => l.includes("rev-1"))).toBe(true);
  });

  it("get masks the value by default and reveals it with --show-value", async () => {
    const runCredentialRevisionGet = vi.fn().mockReturnValue({
      id: "rev-1",
      service: "svc",
      type: "token",
      value: "old-secret",
      url: null,
      notes: null,
      created: 1000,
      credExpires: null,
      replacedAt: 2000,
      expiresAt: null,
      pinnedAt: 3000,
      replacedBy: null,
    });
    const mem = makeProgram({ runCredentialRevisionGet, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await mem.parseAsync(
      ["credentials", "revisions", "get", "--service", "svc", "--type", "token", "--revision", "rev-1"],
      { from: "user" },
    );
    expect(lines.some((l) => l.includes("old-secret"))).toBe(false);

    lines.length = 0;
    await mem.parseAsync(
      [
        "credentials",
        "revisions",
        "get",
        "--service",
        "svc",
        "--type",
        "token",
        "--revision",
        "rev-1",
        "--show-value",
      ],
      { from: "user" },
    );
    expect(lines.some((l) => l.includes("old-secret"))).toBe(true);
  });

  it("restore previews without applying, then applies with --yes", async () => {
    const runCredentialRevisionList = vi.fn().mockReturnValue([
      {
        id: "rev-1",
        service: "svc",
        type: "token",
        url: null,
        notes: null,
        created: 1000,
        credExpires: null,
        replacedAt: 2000,
        expiresAt: null,
        pinnedAt: null,
        replacedBy: null,
      },
    ]);
    const runCredentialRevisionRestore = vi.fn().mockReturnValue({
      service: "svc",
      type: "token",
      value: "[redacted]",
      url: null,
      notes: null,
      created: 1000,
      updated: 3000,
      expires: null,
    });
    const mem = makeProgram({ runCredentialRevisionList, runCredentialRevisionRestore, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await mem.parseAsync(
      ["credentials", "revisions", "restore", "--service", "svc", "--type", "token", "--revision", "rev-1"],
      { from: "user" },
    );
    expect(runCredentialRevisionRestore).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("Would restore"))).toBe(true);

    lines.length = 0;
    await mem.parseAsync(
      ["credentials", "revisions", "restore", "--service", "svc", "--type", "token", "--revision", "rev-1", "--yes"],
      { from: "user" },
    );
    expect(runCredentialRevisionRestore).toHaveBeenCalledWith({ service: "svc", type: "token", revision: "rev-1" });
    expect(lines.some((l) => l.includes("Restored revision rev-1"))).toBe(true);
  });

  it("purge requires --revision or --all", async () => {
    const runCredentialRevisionPurge = vi.fn();
    const mem = makeProgram({ runCredentialRevisionPurge, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "revisions", "purge", "--service", "svc", "--type", "token"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(runCredentialRevisionPurge).not.toHaveBeenCalled();
  });

  it("purge previews without applying, then applies with --yes", async () => {
    const runCredentialRevisionList = vi.fn().mockReturnValue([
      {
        id: "rev-1",
        service: "svc",
        type: "token",
        url: null,
        notes: null,
        created: 1000,
        credExpires: null,
        replacedAt: 2000,
        expiresAt: null,
        pinnedAt: null,
        replacedBy: null,
      },
    ]);
    const runCredentialRevisionPurge = vi.fn().mockReturnValue({ purged: 1 });
    const mem = makeProgram({ runCredentialRevisionList, runCredentialRevisionPurge, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await mem.parseAsync(
      ["credentials", "revisions", "purge", "--service", "svc", "--type", "token", "--revision", "rev-1"],
      { from: "user" },
    );
    expect(runCredentialRevisionPurge).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("Would purge 1"))).toBe(true);

    lines.length = 0;
    await mem.parseAsync(
      ["credentials", "revisions", "purge", "--service", "svc", "--type", "token", "--revision", "rev-1", "--yes"],
      { from: "user" },
    );
    expect(runCredentialRevisionPurge).toHaveBeenCalledWith({
      service: "svc",
      type: "token",
      revision: "rev-1",
      all: undefined,
    });
    expect(lines.some((l) => l.includes("Purged 1 revision"))).toBe(true);
  });

  it("pin applies immediately (no --yes gate) and reports unpinned with --unpin", async () => {
    const runCredentialRevisionPin = vi.fn().mockReturnValue({ changed: true });
    const mem = makeProgram({ runCredentialRevisionPin, factsDb: {}, vectorDb: {} });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await mem.parseAsync(
      ["credentials", "revisions", "pin", "--service", "svc", "--type", "token", "--revision", "rev-1", "--unpin"],
      { from: "user" },
    );

    expect(runCredentialRevisionPin).toHaveBeenCalledWith({
      service: "svc",
      type: "token",
      revision: "rev-1",
      pinned: false,
    });
    expect(lines.some((l) => l.includes("now unpinned"))).toBe(true);
  });
});

describe("scope prune vector cleanup", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function storeGlobalFact(text: string) {
    return db.store({
      text,
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });
  }

  it("cleans up vectors for the facts actually deleted, not a stale pre-delete snapshot", async () => {
    db = new FactsDB(":memory:");
    const fact = storeGlobalFact("existing global fact");

    // listScopedFactIdsPendingPrune (used only for --dry-run) is spied to prove the actual,
    // non-dry-run delete path no longer depends on it for vector cleanup — a stale snapshot from
    // this helper could otherwise miss a fact added between listing and the real delete.
    const staleSnapshotSpy = vi.spyOn(db, "listScopedFactIdsPendingPrune");
    const deleteSpy = vi.fn().mockResolvedValue(true);

    const mem = makeProgram({ factsDb: db, vectorDb: { delete: deleteSpy } });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["scope", "prune", "--scope", "global", "--yes"], { from: "user" });

    expect(staleSnapshotSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(fact.id);
    expect(db.getById(fact.id)).toBeNull();
  });

  it("sets process.exitCode when post-delete vector cleanup fails", async () => {
    db = new FactsDB(":memory:");
    storeGlobalFact("fact to prune");

    const mem = makeProgram({
      factsDb: db,
      vectorDb: {
        delete: vi.fn().mockRejectedValue(new Error("lance down")),
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["scope", "prune", "--scope", "global", "--yes"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });
});

describe("scope promote validation exit code (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets process.exitCode instead of killing the host process on invalid --threshold-days", async () => {
    const mem = makeProgram({ factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A raw process.exit(1) here (instead of process.exitCode = 1; return;) would previously
    // terminate the entire embedding host process -- not just this command -- since it bypasses
    // withExit's isStandaloneCliProcess() guard entirely. If this test doesn't hang/crash the
    // worker, the guard held.
    await mem.parseAsync(["scope", "promote", "--threshold-days", "not-a-number"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode instead of killing the host process on invalid --min-importance", async () => {
    const mem = makeProgram({ factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["scope", "promote", "--min-importance", "1.5"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });
});

describe("scope promote --verbose heartbeat", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function storeOldSessionFact(text: string, scopeTarget: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400;
    const fact = db.store({
      text,
      category: "fact",
      importance: 0.85,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget,
    });
    db.getRawDb().prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, fact.id);
    return fact;
  }

  it("emits start/complete heartbeat lines when --verbose is passed, and still promotes", async () => {
    db = new FactsDB(":memory:");
    const fact = storeOldSessionFact("Session insight to promote (verbose)", "sess-verbose");

    const mem = makeProgram({ factsDb: db, vectorDb: {} });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await mem.parseAsync(["scope", "promote", "--verbose"], { from: "user" });

    expect(logs.some((l) => l.includes("scope-promote — start"))).toBe(true);
    expect(logs.some((l) => l.includes("scope-promote — complete in"))).toBe(true);
    expect(db.getById(fact.id)?.scope).toBe("global");
  });

  it("stays silent (no heartbeat lines) without --verbose, and still promotes", async () => {
    db = new FactsDB(":memory:");
    const fact = storeOldSessionFact("Session insight to promote (quiet)", "sess-quiet");

    const mem = makeProgram({ factsDb: db, vectorDb: {} });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await mem.parseAsync(["scope", "promote"], { from: "user" });

    expect(logs.some((l) => l.includes("scope-promote — start"))).toBe(false);
    expect(logs.some((l) => l.includes("scope-promote — complete in"))).toBe(false);
    expect(db.getById(fact.id)?.scope).toBe("global");
    expect(logs.some((l) => l.includes("scope-promote promoted=1/1"))).toBe(true);
  });
});
