import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageAndStats } from "../cli/commands/manage/register-storage-and-stats.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

const SYNC_PREFIX = "hybrid-mem-sync-";

function listSyncTempDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(SYNC_PREFIX)));
}

describe("sync-export cleanup", () => {
  const originalPassphrase = process.env.HYBRID_MEM_SYNC_PASSPHRASE;
  const createdRoots: string[] = [];

  afterEach(() => {
    if (originalPassphrase === undefined) process.env.HYBRID_MEM_SYNC_PASSPHRASE = undefined;
    else process.env.HYBRID_MEM_SYNC_PASSPHRASE = originalPassphrase;
    process.exitCode = undefined;
    for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("removes the plaintext temporary export directory after writing the encrypted bundle", async () => {
    process.env.HYBRID_MEM_SYNC_PASSPHRASE = "test-passphrase-with-at-least-twenty-chars";
    const root = mkdtempSync(join(tmpdir(), "hm-sync-export-test-"));
    createdRoots.push(root);
    const outPath = join(root, "bundle.hm-sync");
    const before = listSyncTempDirs();

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageStorageAndStats(mem, {
      factsDb: {},
      vectorDb: {},
      aliasDb: null,
      versionInfo: { pluginVersion: "test", memoryManagerVersion: "test", schemaVersion: 1 },
      embeddings: {},
      mergeResults: vi.fn(),
      getMemoryCategories: () => ["fact"],
      cfg: {
        memory: { categories: ["fact"] },
        errorReporting: { enabled: false, consent: false, mode: "community" },
      },
      runCompaction: vi.fn(),
      tieringEnabled: false,
      ctx: { resolvedSqlitePath: null },
      listCommands: undefined,
      auditStore: null,
      merge: vi.fn(),
      BACKFILL_DECAY_MARKER: ".backfill-decay-done",
      runExport: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        mkdirSync(join(outputPath, "memory", "fact"), { recursive: true });
        writeFileSync(join(outputPath, "MEMORY.md"), "plaintext export marker", "utf-8");
        writeFileSync(join(outputPath, "memory", "fact", "one.md"), "secret fact", "utf-8");
        return { factsExported: 1, proceduresExported: 0, filesWritten: 2, outputPath };
      }),
    } as unknown as ManageBindings);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await mem.parseAsync(["sync-export", "--out", outPath], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(`Encrypted sync bundle written to ${outPath}`);
    expect(existsSync(outPath)).toBe(true);
    const envelope = JSON.parse(readFileSync(outPath, "utf-8")) as { type?: string; ciphertext?: string };
    expect(envelope.type).toBe("hybrid-memory-sync-bundle");
    expect(envelope.ciphertext).toEqual(expect.any(String));

    const after = listSyncTempDirs();
    for (const name of before) after.delete(name);
    expect([...after]).toEqual([]);
  });
});
