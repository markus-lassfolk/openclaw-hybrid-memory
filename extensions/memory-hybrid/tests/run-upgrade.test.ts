import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isNpmProjectPluginLayout,
  resolveNpmProjectRootForPlugin,
  resolveUpgradeExtensionsParentDir,
  resolveInstalledPluginDir,
  readPluginPackageVersion,
  detectDualPluginInstallVersionMismatch,
  buildDualInstallReconciliationGuidance,
  syncKnownNpmProjectPinWhenExtensionsCanonical,
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

  it("resolveUpgradeExtensionsParentDir migrates npm-project upgrades to ~/.openclaw/extensions when present (#1989)", () => {
    const projectRoot = join(tmp, "npm", "projects", "openclaw-hybrid-memory");
    const pluginDir = join(projectRoot, "node_modules", "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.272" } }),
    );
    const stateExtensions = join(homedir(), ".openclaw", "extensions");
    if (existsSync(stateExtensions)) {
      expect(resolveUpgradeExtensionsParentDir(pluginDir)).toBe(stateExtensions);
    } else {
      expect(resolveUpgradeExtensionsParentDir(pluginDir)).toBe(join(projectRoot, "node_modules"));
    }
  });

  it("resolveUpgradeExtensionsParentDir targets traditional extensions layout", () => {
    const pluginDir = join(tmp, ".openclaw", "extensions", "openclaw-hybrid-memory");
    expect(resolveUpgradeExtensionsParentDir(pluginDir)).toBe(join(tmp, ".openclaw", "extensions"));
  });

  it("resolveInstalledPluginDir points at package under extensions parent (#1989)", () => {
    const parent = join(tmp, ".openclaw", "extensions");
    mkdirSync(parent, { recursive: true });
    expect(resolveInstalledPluginDir(parent)).toBe(join(parent, "openclaw-hybrid-memory"));
  });

  it("readPluginPackageVersion reads package.json version", () => {
    const pluginDir = join(tmp, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ version: "2026.6.273" }));
    expect(readPluginPackageVersion(pluginDir)).toBe("2026.6.273");
  });

  it("detectDualPluginInstallVersionMismatch reports version skew (#1989)", () => {
    const npmDir = join(tmp, "npm-copy");
    const extDir = join(tmp, "ext-copy");
    for (const dir of [npmDir, extDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "openclaw.plugin.json"), "{}");
    }
    writeFileSync(join(npmDir, "package.json"), JSON.stringify({ version: "2026.6.270" }));
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ version: "2026.6.273" }));
    const msg = detectDualPluginInstallVersionMismatch(npmDir, extDir);
    expect(msg).toMatch(/version mismatch/i);
    expect(msg).toMatch(/2026\.6\.270/);
    expect(msg).toMatch(/2026\.6\.273/);
  });

  it("detectDualPluginInstallVersionMismatch warns when both copies exist at same version (#1989)", () => {
    const npmDir = join(tmp, "npm-copy");
    const extDir = join(tmp, "ext-copy");
    for (const dir of [npmDir, extDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "openclaw.plugin.json"), "{}");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.6.273" }));
    }
    const msg = detectDualPluginInstallVersionMismatch(npmDir, extDir);
    expect(msg).toMatch(/Dual plugin install/i);
  });

  it("buildDualInstallReconciliationGuidance includes repair commands (#2008)", () => {
    const npmDir = join(tmp, "npm-copy");
    const extDir = join(tmp, "ext-copy");
    for (const dir of [npmDir, extDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "openclaw.plugin.json"), "{}");
    }
    writeFileSync(join(npmDir, "package.json"), JSON.stringify({ version: "2026.6.261" }));
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ version: "2026.6.291" }));
    const guidance = buildDualInstallReconciliationGuidance(npmDir, extDir);
    expect(guidance).toMatch(/openclaw plugins install openclaw-hybrid-memory@2026\.6\.291/);
    expect(guidance).toMatch(/verify --fix/);
  });

  it("syncKnownNpmProjectPinWhenExtensionsCanonical skips npm-project layout (#2008)", () => {
    const projectRoot = join(tmp, "npm", "projects", "openclaw-hybrid-memory");
    const pluginDir = join(projectRoot, "node_modules", "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.291" } }));
    writeFileSync(join(pluginDir, "openclaw.plugin.json"), "{}");
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ version: "2026.6.291" }));
    const res = syncKnownNpmProjectPinWhenExtensionsCanonical({
      extensionsPluginDir: pluginDir,
      version: "2026.6.291",
    });
    expect(res.attempted).toBe(false);
    expect(res.updated).toBe(false);
  });

  it("verifyUpgradePluginBundle passes for the live plugin root", () => {
    if (!existsSync(join(PLUGIN_ROOT, "dist/index.js"))) return;
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
