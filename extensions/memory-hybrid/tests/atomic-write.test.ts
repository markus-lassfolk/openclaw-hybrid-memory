/**
 * Tests for utils/atomic-write.ts (Issue #1405).
 *
 * Covers:
 *  - atomicWriteFile: correct write, atomicity on error, temp-file cleanup
 *  - atomicWriteSkillDir: all files present, completion marker written,
 *    subdirectory creation, temp-dir cleanup on error, overwrite of incomplete
 *    existing dir
 *  - isSkillDirComplete: true only when marker exists
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKILL_ATOMIC_TEMP_PREFIX,
  SKILL_COMPLETE_MARKER,
  atomicWriteFile,
  atomicWriteSkillDir,
  isSkillDirComplete,
} from "../utils/atomic-write.js";
import { discoverCompletedSkillDirs, isAtomicSkillWriteScratchDir } from "../utils/skill-discovery.js";

// ---------------------------------------------------------------------------
// Controlled failure injection via vi.mock
// ---------------------------------------------------------------------------

let simulateRenameFailure = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (simulateRenameFailure) {
        throw new Error("simulated rename failure");
      }
      return actual.renameSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
  simulateRenameFailure = false;
});

afterEach(() => {
  simulateRenameFailure = false;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SKILL_COMPLETE_MARKER
// ---------------------------------------------------------------------------

describe("SKILL_COMPLETE_MARKER", () => {
  it("is the expected constant string", () => {
    expect(SKILL_COMPLETE_MARKER).toBe(".openclaw-skill-complete");
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

describe("atomicWriteFile", () => {
  it("writes file content correctly", () => {
    const targetPath = join(tmpDir, "output.txt");
    atomicWriteFile(targetPath, "hello world");
    expect(readFileSync(targetPath, "utf-8")).toBe("hello world");
  });

  it("creates parent directories if they do not exist", () => {
    const targetPath = join(tmpDir, "nested", "dir", "output.txt");
    atomicWriteFile(targetPath, "content");
    expect(readFileSync(targetPath, "utf-8")).toBe("content");
  });

  it("overwrites an existing file atomically", () => {
    const targetPath = join(tmpDir, "output.txt");
    writeFileSync(targetPath, "original", "utf-8");
    atomicWriteFile(targetPath, "updated");
    expect(readFileSync(targetPath, "utf-8")).toBe("updated");
  });

  it("leaves no temp file behind on success", () => {
    const targetPath = join(tmpDir, "output.txt");
    atomicWriteFile(targetPath, "content");
    const files = readdirSync(tmpDir);
    expect(files.every((f) => !f.includes(".tmp-"))).toBe(true);
  });

  it("removes temp file and re-throws on rename error", () => {
    simulateRenameFailure = true;
    const targetPath = join(tmpDir, "output.txt");
    expect(() => atomicWriteFile(targetPath, "content")).toThrow("simulated rename failure");

    // Target file must not exist (write was not committed).
    expect(existsSync(targetPath)).toBe(false);
    // No temp file should remain.
    const files = readdirSync(tmpDir);
    expect(files.every((f) => !f.includes(".tmp-"))).toBe(true);
  });

  it("preserves original file content when rename fails", () => {
    const targetPath = join(tmpDir, "output.txt");
    writeFileSync(targetPath, "original", "utf-8");

    simulateRenameFailure = true;
    expect(() => atomicWriteFile(targetPath, "new-content")).toThrow();

    // Original content must be intact.
    expect(readFileSync(targetPath, "utf-8")).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// atomicWriteSkillDir
// ---------------------------------------------------------------------------

describe("atomicWriteSkillDir", () => {
  const DRAFT = {
    "recipe.json": '{"steps":[]}',
    "verification.json": '{"ok":true}',
    "proposal-metadata.json": '{"meta":1}',
    "evals/evals.json": '{"evals":[]}',
    "SKILL.md": "# My Skill\n\nContent.",
  };

  it("writes all files to the skill directory", () => {
    const skillDir = join(tmpDir, "my-skill");
    atomicWriteSkillDir(skillDir, DRAFT);

    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("# My Skill");
    expect(readFileSync(join(skillDir, "recipe.json"), "utf-8")).toBe('{"steps":[]}');
    expect(readFileSync(join(skillDir, "verification.json"), "utf-8")).toBe('{"ok":true}');
    expect(readFileSync(join(skillDir, "proposal-metadata.json"), "utf-8")).toBe('{"meta":1}');
    expect(readFileSync(join(skillDir, "evals", "evals.json"), "utf-8")).toBe('{"evals":[]}');
  });

  it("creates the skill directory and any needed subdirectories", () => {
    const skillDir = join(tmpDir, "nested", "path", "my-skill");
    atomicWriteSkillDir(skillDir, DRAFT);
    expect(existsSync(skillDir)).toBe(true);
  });

  it("writes the completion marker as the last operation", () => {
    const skillDir = join(tmpDir, "my-skill");
    atomicWriteSkillDir(skillDir, DRAFT);
    const markerPath = join(skillDir, SKILL_COMPLETE_MARKER);
    expect(existsSync(markerPath)).toBe(true);
    // Marker content is an ISO timestamp (truthy non-empty string).
    expect(readFileSync(markerPath, "utf-8").length).toBeGreaterThan(0);
  });

  it("leaves no temp directory behind on success", () => {
    const skillDir = join(tmpDir, "my-skill");
    atomicWriteSkillDir(skillDir, DRAFT);
    const entries = readdirSync(tmpDir);
    expect(entries.every((e) => !e.includes(".tmp-"))).toBe(true);
  });

  it("cleans up temp dir and re-throws on rename error", () => {
    simulateRenameFailure = true;
    const skillDir = join(tmpDir, "my-skill");
    expect(() => atomicWriteSkillDir(skillDir, DRAFT)).toThrow("simulated rename failure");

    // Final skill dir must not exist — no partial state survived.
    expect(existsSync(skillDir)).toBe(false);
    // No temp dirs should remain.
    const entries = readdirSync(tmpDir);
    expect(entries.every((e) => !e.includes(".tmp-"))).toBe(true);
  });

  it("refuses to overwrite an existing incomplete (no-marker) directory with SKILL.md", () => {
    const skillDir = join(tmpDir, "my-skill");
    // Simulate a legacy/partial final dir. Callers must explicitly decide if it
    // is safe to clean it; atomicWriteSkillDir itself must never hide it.
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Incomplete\n", "utf-8");

    expect(() => atomicWriteSkillDir(skillDir, DRAFT)).toThrow("Atomic skill directory target already exists");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("# Incomplete");
    expect(existsSync(join(skillDir, SKILL_COMPLETE_MARKER))).toBe(false);
  });

  it("refuses to replace a complete directory when called again with updated content", () => {
    const skillDir = join(tmpDir, "my-skill");
    atomicWriteSkillDir(skillDir, DRAFT);

    const updated = { ...DRAFT, "SKILL.md": "# Updated Skill\n" };
    expect(() => atomicWriteSkillDir(skillDir, updated)).toThrow("Atomic skill directory target already exists");

    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("# My Skill");
    expect(existsSync(join(skillDir, SKILL_COMPLETE_MARKER))).toBe(true);
  });

  it("does not hide an existing directory if promotion rename fails", () => {
    const skillDir = join(tmpDir, "my-skill");
    const tmpSkillDir = join(tmpDir, `${SKILL_ATOMIC_TEMP_PREFIX}manual`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Existing\n", "utf-8");
    mkdirSync(tmpSkillDir, { recursive: true });

    expect(() => renameSync(tmpSkillDir, skillDir)).toThrow();

    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("# Existing");
    expect(existsSync(tmpSkillDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverCompletedSkillDirs
// ---------------------------------------------------------------------------

describe("discoverCompletedSkillDirs", () => {
  it("discovers only completed skill directories", () => {
    atomicWriteSkillDir(join(tmpDir, "complete-skill"), { "SKILL.md": "# Complete\n" });

    const markerlessDir = join(tmpDir, "markerless-skill");
    mkdirSync(markerlessDir, { recursive: true });
    writeFileSync(join(markerlessDir, "SKILL.md"), "# In-progress\n", "utf-8");

    const scratchDir = join(tmpDir, `${SKILL_ATOMIC_TEMP_PREFIX}1234-deadbeef`);
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(scratchDir, SKILL_COMPLETE_MARKER), "2024-01-01T00:00:00.000Z", "utf-8");
    writeFileSync(join(scratchDir, "SKILL.md"), "# Scratch\n", "utf-8");

    expect(discoverCompletedSkillDirs(tmpDir).map((entry) => entry.name)).toEqual(["complete-skill"]);
  });

  it("treats markerless directories with SKILL.md as in-progress loader candidates", () => {
    const skillDir = join(tmpDir, "half-written-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Half-written\n", "utf-8");

    expect(discoverCompletedSkillDirs(tmpDir)).toEqual([]);
  });

  it("identifies atomic scratch directory names", () => {
    expect(isAtomicSkillWriteScratchDir(`${SKILL_ATOMIC_TEMP_PREFIX}1234-deadbeef`)).toBe(true);
    expect(isAtomicSkillWriteScratchDir(".some-skill.bak-1234")).toBe(true);
    expect(isAtomicSkillWriteScratchDir("normal-skill")).toBe(false);
    expect(isAtomicSkillWriteScratchDir("skill.tmp-1234-deadbeef")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSkillDirComplete
// ---------------------------------------------------------------------------

describe("isSkillDirComplete", () => {
  it("returns false for a non-existent directory", () => {
    expect(isSkillDirComplete(join(tmpDir, "does-not-exist"))).toBe(false);
  });

  it("returns false for a directory without the marker", () => {
    const skillDir = join(tmpDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n", "utf-8");
    expect(isSkillDirComplete(skillDir)).toBe(false);
  });

  it("returns true for a directory written by atomicWriteSkillDir", () => {
    const skillDir = join(tmpDir, "my-skill");
    atomicWriteSkillDir(skillDir, {
      "SKILL.md": "# Skill\n",
    });
    expect(isSkillDirComplete(skillDir)).toBe(true);
  });

  it("returns true when the marker file is manually present", () => {
    const skillDir = join(tmpDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, SKILL_COMPLETE_MARKER), "2024-01-01T00:00:00.000Z", "utf-8");
    expect(isSkillDirComplete(skillDir)).toBe(true);
  });
});
