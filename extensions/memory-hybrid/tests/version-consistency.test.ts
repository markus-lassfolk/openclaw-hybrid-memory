/**
 * Version consistency gate (issue #2115).
 *
 * `package.json#version` is the single source of truth for the release version.
 * These places must always match it, or operators get contradictory version
 * output after an install:
 *   - openclaw.plugin.json#version   → read by the OpenClaw host (`plugins inspect`)
 *   - the standalone installer package → published in lockstep at the same tag
 *   - versionInfo.pluginVersion       → runtime/CLI version reporting
 *
 * Historically nothing wrote openclaw.plugin.json / the installer version, so
 * they silently drifted (2026.7.212 / 2026.7.208 vs package.json 2026.7.217).
 * This test fails CI on any drift; `npm run sync:version` repairs it.
 *
 * SDK (`sdk/openclaw-memory-js`) and the bundled graph-app are intentionally
 * versioned independently and are deliberately NOT checked here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { versionInfo } from "../versionInfo.js";

const pluginRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..", "..");

function readVersion(...segments: string[]): string {
  const raw = readFileSync(join(...segments), "utf8");
  return JSON.parse(raw).version;
}

describe("version consistency (#2115)", () => {
  const pkgVersion = readVersion(pluginRoot, "package.json");

  it("package.json has a non-empty version", () => {
    expect(typeof pkgVersion).toBe("string");
    expect(pkgVersion.trim().length).toBeGreaterThan(0);
  });

  it("openclaw.plugin.json version matches package.json (host `plugins inspect` source)", () => {
    expect(readVersion(pluginRoot, "openclaw.plugin.json")).toBe(pkgVersion);
  });

  it("standalone installer package version matches package.json (lockstep publish)", () => {
    expect(readVersion(repoRoot, "packages", "openclaw-hybrid-memory-install", "package.json")).toBe(pkgVersion);
  });

  it("versionInfo.pluginVersion matches package.json (runtime/CLI reporting source)", () => {
    expect(versionInfo.pluginVersion).toBe(pkgVersion);
  });
});
