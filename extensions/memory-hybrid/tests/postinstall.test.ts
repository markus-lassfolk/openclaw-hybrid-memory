import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("postinstall", () => {
  it("package.json postinstall runs scripts/postinstall-rebuild.cjs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.scripts?.postinstall).toBe("node scripts/postinstall-rebuild.cjs");
  });

  it("postinstall-rebuild.cjs exists and references both native modules", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).not.toContain("better-sqlite3");
    expect(content).toContain("@lancedb/lancedb");
  });

  it("scripts folder is in package files for publish", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.files).toContain("scripts");
  });

  it("pack/publish generates npm-shrinkwrap.json from package-lock.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.files).toContain("npm-shrinkwrap.json");
    expect(pkg.scripts?.prepack).toContain("manage-shrinkwrap.cjs create");
    expect(pkg.scripts?.postpack).toContain("manage-shrinkwrap.cjs clean");
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
    expect(existsSync(join(root, "scripts", "manage-shrinkwrap.cjs"))).toBe(true);
  });

  it("postinstall-rebuild.cjs has guard to skip rebuild when bindings are functional", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("needsRebuild");
    expect(content).toContain("skipping rebuild");
  });

  it("needsRebuild guard returns false on successful require, true on failure", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("return false");
    expect(content).toContain("return true");
  });

  it("shrinkwrap helper copies package-lock and removes generated shrinkwrap", () => {
    const scriptPath = join(root, "scripts", "manage-shrinkwrap.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain('fs.copyFileSync(packageLockPath, shrinkwrapPath)');
    expect(content).toContain('fs.rmSync(shrinkwrapPath, { force: true })');
  });

  it("standalone installer verifies @lancedb/lancedb after npm install", () => {
    const installerPath = join(root, "..", "..", "packages", "openclaw-hybrid-memory-install", "install.js");
    expect(existsSync(installerPath)).toBe(true);
    const content = readFileSync(installerPath, "utf-8");
    expect(content).toContain('const requiredRuntimeDependencies = ["@lancedb/lancedb"]');
    expect(content).toContain("ensureRuntimeDependenciesInstalled");
    expect(content).toContain('npm", ["install", "--no-save", "--omit=dev", ...missing]');
  });
});
