import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsDB } from "../backends/facts-db.js";
import { runExport } from "../services/export-memory.js";

describe("export-memory", () => {
  let db: FactsDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "export-mem-"));
    db = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("exports facts to MEMORY.md + memory/ layout", () => {
    db.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "theme",
      value: "dark",
      source: "conversation",
    });
    db.store({
      text: "Decided to use SQLite for storage",
      category: "decision",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
    });

    const outDir = join(tmpDir, "export");
    const result = runExport(
      db,
      { outputPath: outDir, mode: "replace" },
      { pluginVersion: "1.0.0", schemaVersion: 3 },
    );

    expect(result.factsExported).toBe(2);
    expect(result.filesWritten).toBeGreaterThanOrEqual(4); // MEMORY.md, manifest.json, 2 fact files
    expect(result.outputPath).toBe(outDir);

    const memPath = join(outDir, "MEMORY.md");
    const mem = readFileSync(memPath, "utf-8");
    expect(mem).toContain("Long-Term Memory Index");
    expect(mem).toContain("preference");
    expect(mem).toContain("decision");

    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.factsExported).toBe(2);
    expect(manifest.filters.mode).toBe("replace");

    const memDir = join(outDir, "memory");
    const prefDir = join(memDir, "preference");
    const decDir = join(memDir, "decision");
    expect(readdirSync(prefDir).length).toBe(1);
    expect(readdirSync(decDir).length).toBe(1);

    const prefFile = readdirSync(prefDir)[0];
    const prefContent = readFileSync(join(prefDir, prefFile), "utf-8");
    expect(prefContent).toContain("dark");
  });

  it("excludes credential pointer facts by default", () => {
    db.store({
      text: "Credential for myapi (api-key) — stored in vault",
      category: "technical",
      importance: 0.7,
      entity: "Credentials",
      key: "myapi",
      value: null,
      source: "conversation",
    });
    db.store({
      text: "User prefers TypeScript",
      category: "preference",
      importance: 0.8,
      entity: "user",
      key: "language",
      value: "TypeScript",
      source: "conversation",
    });

    const outDir = join(tmpDir, "export");
    const result = runExport(db, { outputPath: outDir, mode: "replace" }, { pluginVersion: "1.0.0", schemaVersion: 3 });

    expect(result.factsExported).toBe(1);
  });

  it("includes credential pointers with --include-credentials", () => {
    db.store({
      text: "Credential for myapi (api-key) — stored in vault",
      category: "technical",
      importance: 0.7,
      entity: "Credentials",
      key: "myapi",
      value: null,
      source: "conversation",
    });

    const outDir = join(tmpDir, "export");
    const result = runExport(
      db,
      { outputPath: outDir, mode: "replace", includeCredentials: true },
      { pluginVersion: "1.0.0", schemaVersion: 3 },
    );

    expect(result.factsExported).toBe(1);
  });

  it("filters by source", () => {
    db.store({
      text: "From conversation",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    db.store({
      text: "From distillation",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "distillation",
    });

    const outDir = join(tmpDir, "export");
    const result = runExport(
      db,
      { outputPath: outDir, mode: "replace", sources: ["distillation"] },
      { pluginVersion: "1.0.0", schemaVersion: 3 },
    );

    expect(result.factsExported).toBe(1);
  });
});
