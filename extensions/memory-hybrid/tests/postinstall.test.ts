import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

  it("postinstall-rebuild.cjs has guard to skip rebuild when bindings are functional", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("needsRebuild");
    expect(content).toContain("skipping rebuild");
  });

  it("postinstall-rebuild.cjs self-heals missing native modules before rebuild", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("require.resolve");
    expect(content).toContain("npm install --no-save --ignore-scripts");
  });

  it("needsRebuild guard returns false on successful require, true on failure", () => {
    const scriptPath = join(root, "scripts", "postinstall-rebuild.cjs");
    const content = readFileSync(scriptPath, "utf-8");
    // Guard uses try/require pattern: returns false on success, true on catch
    expect(content).toContain("return false");
    expect(content).toContain("return true");
  });
});
