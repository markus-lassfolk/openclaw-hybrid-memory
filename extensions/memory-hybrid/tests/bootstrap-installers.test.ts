// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import {
  bootstrapInstallers,
  installCoreBootstrapServices,
  installOptionalBootstrapServices,
} from "../services/index.js";

describe("bootstrap installers", () => {
  it("orders core storage before optional adjacent services", () => {
    expect(bootstrapInstallers.map((installer) => `${installer.bootstrapPhase}:${installer.id}`)).toEqual([
      "core:memoryCore",
      "optional:adjacentFeatures",
    ]);
  });

  it("can install optional services after core bootstrap with minimal config", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bootstrap-installers-"));
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough-to-pass", model: "text-embedding-3-small" },
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
      passiveObserver: { enabled: false },
      aliases: { enabled: false },
    });
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };

    const core = installCoreBootstrapServices({
      cfg,
      api: api as never,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      resolvedLancePath: join(tmpDir, "lancedb"),
    });
    const optional = installOptionalBootstrapServices({
      cfg,
      api: api as never,
      factsDb: core.factsDb, edictStore: null as any,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
    });

    expect(optional.issueStore).toBeDefined();
    expect(optional.workflowStore).toBeDefined();
    expect(optional.apitapStore).toBeDefined();

    optional.apitapStore.close();
    optional.provenanceService?.close();
    optional.verificationStore?.close();
    optional.toolProposalStore.close();
    optional.crystallizationStore.close();
    optional.workflowStore.close();
    optional.issueStore.close();
    optional.aliasDb?.close();
    optional.eventLog?.close();
    optional.proposalsDb?.close();
    optional.identityReflectionStore?.close();
    optional.personaStateStore?.close();
    optional.credentialsDb?.close();
    core.vectorDb.close();
    core.factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps failed FTS5 probes with an actionable startup error", () => {
    const exec = vi.fn((sql: string) => {
      if (sql.includes("CREATE VIRTUAL TABLE")) {
        throw new Error("no such module: fts5");
      }
    });

    expect(() => FactsDB.verifyFts5Support({ exec } as never)).toThrow(/FTS5|vector-only|startup/i);
    expect(exec).toHaveBeenCalled();
  });

  it("fails core bootstrap loudly when SQLite FTS5 support is unavailable", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bootstrap-installers-fts5-"));
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough-to-pass", model: "text-embedding-3-small" },
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
      nightlyCycle: { enabled: false },
      passiveObserver: { enabled: false },
      aliases: { enabled: false },
    });
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    const verifySpy = vi.spyOn(FactsDB, "verifyFts5Support").mockImplementation(() => {
      throw new Error(
        "memory-hybrid: SQLite FTS5 capability check failed during startup. " +
          "Hybrid search would silently degrade to vector-only, so plugin initialization is aborted. " +
          "Use a Node.js/SQLite runtime with FTS5 enabled. Original error: no such module: fts5",
      );
    });

    try {
      expect(() =>
        installCoreBootstrapServices({
          cfg,
          api: api as never,
          resolvedSqlitePath: join(tmpDir, "facts.db"),
          resolvedLancePath: join(tmpDir, "lancedb"),
        }),
      ).toThrow(/SQLite FTS5 capability check failed during startup/);
      expect(verifySpy).toHaveBeenCalledOnce();
      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/SQLite FTS5 capability check failed during startup/),
      );
    } finally {
      verifySpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
