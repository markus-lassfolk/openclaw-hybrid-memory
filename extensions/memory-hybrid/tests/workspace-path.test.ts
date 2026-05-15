import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv, setEnv } from "../utils/env-manager.js";
import { toWorkspaceRelativePath } from "../utils/path.js";

let tmpDir: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "workspace-path-"));
  previousWorkspace = getEnv("OPENCLAW_WORKSPACE");
  setEnv("OPENCLAW_WORKSPACE", tmpDir);
});

afterEach(() => {
  if (previousWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", previousWorkspace);
  else setEnv("OPENCLAW_WORKSPACE", undefined);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("toWorkspaceRelativePath", () => {
  it("keeps valid workspace children that start with dot-dot-like names relative", () => {
    expect(toWorkspaceRelativePath(join(tmpDir, "..cache", "file.json"))).toBe("..cache/file.json");
    expect(toWorkspaceRelativePath(join(tmpDir, "...", "file.json"))).toBe(".../file.json");
  });

  it("returns an absolute path only for paths that traverse outside the workspace", () => {
    expect(toWorkspaceRelativePath(join(tmpDir, "..", "outside.json"))).toBe(join(tmpDir, "..", "outside.json"));
  });
});
