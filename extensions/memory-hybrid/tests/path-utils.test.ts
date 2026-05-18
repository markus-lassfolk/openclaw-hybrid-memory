import { describe, expect, it } from "vitest";
import { toWorkspaceRelativePath } from "../utils/path.js";

describe("toWorkspaceRelativePath", () => {
  it("returns a downward POSIX-style relative path for files inside an explicit workspace", () => {
    expect(toWorkspaceRelativePath("/tmp/workspace/skills/auto/demo/SKILL.md", "/tmp/workspace")).toBe(
      "skills/auto/demo/SKILL.md",
    );
  });

  it("normalizes dot segments before computing the relative path", () => {
    expect(toWorkspaceRelativePath("/tmp/workspace/skills/../skills/demo/SKILL.md", "/tmp/workspace")).toBe(
      "skills/demo/SKILL.md",
    );
  });

  it("returns a normalized absolute path when the target is the workspace root", () => {
    expect(toWorkspaceRelativePath("/tmp/workspace", "/tmp/workspace")).toBe("/tmp/workspace");
  });

  it("returns a normalized absolute path for siblings outside the workspace", () => {
    expect(toWorkspaceRelativePath("/tmp/workspace-sibling/SKILL.md", "/tmp/workspace")).toBe(
      "/tmp/workspace-sibling/SKILL.md",
    );
  });

  it("resolves relative inputs against the explicit workspace root", () => {
    expect(toWorkspaceRelativePath("skills/demo/SKILL.md", "/tmp/workspace")).toBe("skills/demo/SKILL.md");
  });
});
