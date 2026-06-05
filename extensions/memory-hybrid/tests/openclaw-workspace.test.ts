import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ruleExistsInContent } from "../services/tools-md-section.js";
import { resolveAgentWorkspaceRoot, resolveOpenClawWorkspaceRoot } from "../utils/openclaw-workspace.js";
import { setEnv } from "../utils/env-manager.js";

describe("openclaw-workspace", () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-ws-"));
    prevEnv = process.env.OPENCLAW_WORKSPACE;
  });

  afterEach(() => {
    if (prevEnv !== undefined) setEnv("OPENCLAW_WORKSPACE", prevEnv);
    else setEnv("OPENCLAW_WORKSPACE", undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolveOpenClawWorkspaceRoot prefers explicit override", () => {
    expect(resolveOpenClawWorkspaceRoot({ workspace: tmpDir })).toBe(tmpDir);
  });

  it("resolveAgentWorkspaceRoot reads agents.defaults.workspace from config", () => {
    setEnv("OPENCLAW_WORKSPACE", undefined);
    const ws = join(tmpDir, "from-config");
    expect(resolveAgentWorkspaceRoot({ agents: { defaults: { workspace: ws } } })).toBe(ws);
  });
});

describe("ruleExistsInContent dedup", () => {
  it("does not treat substring matches in prose as duplicate bullets", () => {
    const content = "# TOOLS\n\n- Use curl fallback when API fails.\n";
    expect(ruleExistsInContent(content, "curl")).toBe(false);
    expect(ruleExistsInContent(content, "Use curl fallback when API fails.")).toBe(true);
  });
});
