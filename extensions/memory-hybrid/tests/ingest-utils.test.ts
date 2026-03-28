import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { gatherIngestFiles } from "../services/ingest-utils.js";

describe("gatherIngestFiles", () => {
  function makeTempDir(): string {
    const dir = join(tmpdir(), `ingest-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("returns empty array when no files match", () => {
    const root = makeTempDir();
    try {
      expect(gatherIngestFiles(root, ["nonexistent.md"])).toEqual([]);
      expect(gatherIngestFiles(root, ["skills/**/*.md"])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds single file by exact path", () => {
    const root = makeTempDir();
    const toolsPath = join(root, "TOOLS.md");
    writeFileSync(toolsPath, "# Tools\n", "utf-8");
    try {
      const result = gatherIngestFiles(root, ["TOOLS.md"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(toolsPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands skills/**/*.md recursively", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    mkdirSync(join(root, "skills", "bar", "nested"), { recursive: true });
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "skill", "utf-8");
    writeFileSync(join(root, "skills", "bar", "README.md"), "readme", "utf-8");
    writeFileSync(join(root, "skills", "bar", "nested", "inner.md"), "inner", "utf-8");
    try {
      const result = gatherIngestFiles(root, ["skills/**/*.md"]);
      expect(result).toHaveLength(3);
      expect(result.some((p) => p.endsWith("skills/foo/SKILL.md"))).toBe(true);
      expect(result.some((p) => p.endsWith("skills/bar/README.md"))).toBe(true);
      expect(result.some((p) => p.endsWith("skills/bar/nested/inner.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates when patterns overlap", () => {
    const root = makeTempDir();
    writeFileSync(join(root, "TOOLS.md"), "tools", "utf-8");
    try {
      const result = gatherIngestFiles(root, ["TOOLS.md", "TOOLS.md"]);
      expect(result).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("combines multiple patterns", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "TOOLS.md"), "tools", "utf-8");
    writeFileSync(join(root, "AGENTS.md"), "agents", "utf-8");
    writeFileSync(join(root, "skills", "x.md"), "x", "utf-8");
    try {
      const result = gatherIngestFiles(root, ["TOOLS.md", "AGENTS.md", "skills/**/*.md"]);
      expect(result).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores non-markdown files", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "a.md"), "a", "utf-8");
    writeFileSync(join(root, "skills", "b.txt"), "b", "utf-8");
    try {
      const result = gatherIngestFiles(root, ["skills/**/*.md"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("a.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
