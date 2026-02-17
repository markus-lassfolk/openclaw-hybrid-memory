import { describe, it, expect } from "vitest";
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
    expect(content).toContain("better-sqlite3");
    expect(content).toContain("@lancedb/lancedb");
  });

  it("scripts folder is in package files for publish", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.files).toContain("scripts");
  });
});
