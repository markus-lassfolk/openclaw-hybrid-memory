import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerHybridMemCli } from "../cli/register.js";
import { cleanupClassificationArtifacts } from "../services/classification-artifact-cleanup.js";

describe("cleanupClassificationArtifacts", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "classification-artifact-cleanup-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supersedes matching facts and deletes their vectors", async () => {
    const artifact = factsDb.store({
      text: "legacy artifact placeholder",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    factsDb
      .getRawDb()
      .prepare("UPDATE facts SET text = ? WHERE id = ?")
      .run("NOOP | some classification decision text", artifact.id);
    artifact.text = "NOOP | some classification decision text";
    const normal = factsDb.store({
      text: "Markus prefers practical answers",
      category: "preference",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    const vectorDb = { deleteMany: vi.fn(async () => 1), delete: vi.fn(async () => true) };

    const result = await cleanupClassificationArtifacts(factsDb, vectorDb as never);

    expect(result).toMatchObject({ scanned: 2, matched: 1, superseded: 1, vectorAttempted: 1, vectorDeleted: 1 });
    expect(result.matchedIds).toEqual([artifact.id]);
    expect(factsDb.getById(artifact.id)?.supersededAt).toBeTruthy();
    expect(factsDb.getById(normal.id)?.text).toBe(normal.text);
    expect(vectorDb.deleteMany).toHaveBeenCalledWith([artifact.id]);
  });

  it("supports dry-run without superseding or deleting vectors", async () => {
    const artifact = factsDb.store({
      text: "legacy json placeholder",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    const artifactText = '{"action":"NOOP","targetId":null,"reason":"duplicate"}';
    factsDb.getRawDb().prepare("UPDATE facts SET text = ? WHERE id = ?").run(artifactText, artifact.id);
    artifact.text = artifactText;
    const vectorDb = { deleteMany: vi.fn(async () => 1), delete: vi.fn(async () => true) };

    const result = await cleanupClassificationArtifacts(factsDb, vectorDb as never, { dryRun: true });

    expect(result).toMatchObject({
      scanned: 1,
      matched: 1,
      superseded: 0,
      vectorAttempted: 0,
      vectorDeleted: 0,
      dryRun: true,
    });
    expect(factsDb.getById(artifact.id)?.text).toBe(artifact.text);
    expect(vectorDb.deleteMany).not.toHaveBeenCalled();
  });
});

describe("cleanup classification-artifacts CLI", () => {
  it("wires the cleanup command and reports counts", async () => {
    const runCleanupClassificationArtifacts = vi.fn(async () => ({
      scanned: 3,
      matched: 1,
      superseded: 1,
      vectorAttempted: 1,
      vectorDeleted: 1,
      vectorFailed: 0,
      dryRun: true,
      matchedIds: ["fact-id"],
    }));
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerHybridMemCli(
      program as never,
      {
        cfg: hybridConfigSchema.parse({ embedding: { provider: "ollama", model: "nomic-embed-text" } }),
        factsDb: {},
        vectorDb: {},
        embeddings: {},
        versionInfo: { pluginVersion: "test", memoryManagerVersion: "test", schemaVersion: 1 },
        mergeResults: () => [],
        parseSourceDate: () => null,
        getMemoryCategories: () => ["fact", "other"],
        runStore: async () => ({ outcome: "duplicate" }),
        runInstall: async () => ({ ok: true }),
        runVerify: async () => {},
        runDistillWindow: async () => ({ windowStart: 0, windowEnd: 0, sessions: [] }),
        runRecordDistill: async () => ({ recorded: 0 }),
        runExtractDaily: async () => ({ sessionsScanned: 0, factsExtracted: 0, stored: 0, skipped: 0 }),
        runExtractProcedures: async () => ({ sessionsScanned: 0, proceduresExtracted: 0, stored: 0 }),
        runGenerateAutoSkills: async () => ({ generated: 0, written: 0, skipped: 0 }),
        runSkillsSuggest: async () => ({ proposed: 0, skipped: 0, reasons: [] }),
        runBackfill: async () => ({ scanned: 0, stored: 0, skipped: 0 }),
        runIngestFiles: async () => ({ filesScanned: 0, filesIngested: 0, factsStored: 0 }),
        runDistill: async () => ({ sessionsScanned: 0, narrativesStored: 0 }),
        runMigrateToVault: async () => null,
        runCredentialsList: () => [],
        runCredentialsGet: () => null,
        runCredentialsAudit: () => ({ total: 0, flagged: 0, items: [] }),
        runCredentialsPrune: () => ({ scanned: 0, pruned: 0, dryRun: true, items: [] }),
        runUninstall: async () => ({ removed: [] }),
        runUpgrade: async () => ({ ok: true }),
        runConfigMode: () => ({ ok: true }),
        runConfigSet: () => ({ ok: true }),
        runConfigSetHelp: () => ({ ok: true }),
        runFindDuplicates: async () => ({ clusters: [], scanned: 0 }),
        runConsolidate: async () => ({ clustersFound: 0, merged: 0, deleted: 0 }),
        runReflection: async () => ({ factsAnalyzed: 0, patternsExtracted: 0, patternsStored: 0, window: 0 }),
        runReflectionRules: async () => ({ rulesExtracted: 0, rulesStored: 0 }),
        runReflectionMeta: async () => ({ metaExtracted: 0, metaStored: 0 }),
        reflectionConfig: { enabled: false, defaultWindow: 7, minObservations: 2, model: "test" },
        runDreamCycle: async () => ({ ok: true }),
        runContinuousVerification: async () => ({ checked: 0, confirmed: 0, stale: 0, uncertain: 0, errors: 0 }),
        runCleanupClassificationArtifacts,
        runResolveContradictions: async () => ({ autoResolved: [], ambiguous: [] }),
        runClassify: async () => ({ reclassified: 0, total: 0 }),
        autoClassifyConfig: { model: "test", batchSize: 10 },
        runCompaction: async () => ({ hot: 0, warm: 0, cold: 0, structural: 0 }),
        runBuildLanguageKeywords: async () => ({ ok: true, path: "", topLanguages: [], languagesAdded: 0 }),
        runEntityEnrichment: async () => ({ pending: 0, processed: 0, factsEnriched: 0 }),
        runSelfCorrectionExtract: async () => ({ incidents: [], sessionsScanned: 0 }),
        runSelfCorrectionRun: async () => ({ applied: 0, skipped: 0 }),
        runAnalyzeFeedbackPhrases: async () => ({ phrases: [], sessionsScanned: 0 }),
        runExtractDirectives: async () => ({ incidents: [], sessionsScanned: 0 }),
        runExtractReinforcement: async () => ({ incidents: [], sessionsScanned: 0 }),
        runExport: async () => ({ factsExported: 0, proceduresExported: 0, filesWritten: 0, outputPath: "" }),
        tieringEnabled: false,
      } as never,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["cleanup", "classification-artifacts", "--dry-run"], { from: "user" });
    } finally {
      // restored after assertions below
    }

    expect(runCleanupClassificationArtifacts).toHaveBeenCalledWith({ dryRun: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Classification-artifacts cleanup dry-run"));
    log.mockRestore();
  });
});
