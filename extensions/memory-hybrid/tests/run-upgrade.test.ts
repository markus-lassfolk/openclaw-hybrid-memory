import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isNpmProjectPluginLayout,
  resolveNpmProjectRootForPlugin,
  resolveUpgradeExtensionsParentDir,
  UPGRADE_REQUIRED_BUNDLE_PATHS,
  verifyNpmProjectDependencyPin,
  verifyUpgradePluginBundle,
  snapshotNpmProjectPinBeforeUpgrade,
  restoreNpmProjectPinFiles,
} from "../cli/cmd-install.js";

const PLUGIN_ROOT = join(import.meta.dirname, "..");

describe("runUpgrade helpers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `mh-upgrade-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("resolveUpgradeExtensionsParentDir targets npm-project node_modules parent", () => {
    const pluginDir = join(tmp, "npm", "projects", "openclaw-hybrid-memory", "node_modules", "openclaw-hybrid-memory");
    expect(resolveUpgradeExtensionsParentDir(pluginDir)).toBe(join(tmp, "npm", "projects", "openclaw-hybrid-memory", "node_modules"));
  });

  it("resolveUpgradeExtensionsParentDir targets traditional extensions layout", () => {
    const pluginDir = join(tmp, ".openclaw", "extensions", "openclaw-hybrid-memory");
    expect(resolveUpgradeExtensionsParentDir(pluginDir)).toBe(join(tmp, ".openclaw", "extensions"));
  });

  it("verifyUpgradePluginBundle passes for the live plugin root", () => {
    expect(verifyUpgradePluginBundle(PLUGIN_ROOT)).toBeUndefined();
  });

  it("verifyUpgradePluginBundle fails when bundled skill is missing", () => {
    const partial = join(tmp, "partial-plugin");
    mkdirSync(join(partial, "dist"), { recursive: true });
    writeFileSync(join(partial, "dist", "index.js"), "// stub\n");
    writeFileSync(join(partial, "openclaw.plugin.json"), "{}");
    mkdirSync(join(partial, "workspace-snippets"), { recursive: true });
    writeFileSync(join(partial, "workspace-snippets", "TOOLS-hybrid-memory-body.md"), "# tools\n");

    const err = verifyUpgradePluginBundle(partial);
    expect(err).toMatch(/skills\/hybrid-memory\/SKILL\.md/);
  });

  it("UPGRADE_REQUIRED_BUNDLE_PATHS covers skill, tools snippet, dist entry, manifest", () => {
    expect(UPGRADE_REQUIRED_BUNDLE_PATHS).toContain("skills/hybrid-memory/SKILL.md");
    expect(UPGRADE_REQUIRED_BUNDLE_PATHS).toContain("workspace-snippets/TOOLS-hybrid-memory-body.md");
    expect(UPGRADE_REQUIRED_BUNDLE_PATHS).toContain("dist/index.js");
    expect(UPGRADE_REQUIRED_BUNDLE_PATHS).toContain("openclaw.plugin.json");
  });

  it("detects npm-project plugin layout (#1985)", () => {
    const pluginDir = join(tmp, "npm", "projects", "openclaw-hybrid-memory", "node_modules", "openclaw-hybrid-memory");
    const projectRoot = join(tmp, "npm", "projects", "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.271" } }),
    );
    expect(isNpmProjectPluginLayout(pluginDir)).toBe(true);
    expect(resolveNpmProjectRootForPlugin(pluginDir)).toBe(projectRoot);
  });

  it("verifyNpmProjectDependencyPin fails on mismatched version (#1985)", () => {
    const projectRoot = join(tmp, "npm-project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.261" } }),
    );
    expect(verifyNpmProjectDependencyPin(projectRoot, "2026.6.271")).toMatch(/expected 2026.6.271/);
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.271" } }),
    );
    expect(verifyNpmProjectDependencyPin(projectRoot, "2026.6.271")).toBeUndefined();
  });

  it("snapshotNpmProjectPinBeforeUpgrade restores package.json on rollback (#1985)", () => {
    const projectRoot = join(tmp, "npm-rollback");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.260" } }),
    );
    writeFileSync(join(projectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    const backup = snapshotNpmProjectPinBeforeUpgrade(projectRoot);
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.271" } }),
    );
    restoreNpmProjectPinFiles(backup);
    expect(verifyNpmProjectDependencyPin(projectRoot, "2026.6.260")).toBeUndefined();
  });
});
