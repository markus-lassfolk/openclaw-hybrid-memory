/**
 * Tests for known-stale-install-root detection/quarantine (#2125).
 *
 * Beyond the extensions/npm-project duplicate handled by #2117's directional reconcile
 * functions, a live host can retain a root `~/.openclaw/node_modules/<id>` copy (which plain
 * Node `require.resolve` from state/workspace-adjacent code still resolves to) or an accidental
 * nested `~/.openclaw/.openclaw/...` state dir. These tests cover detection (read-only) and
 * quarantine (move to `.cache`, never delete) of those specific known locations.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectKnownStaleInstallRoots,
  knownStaleInstallRootCandidates,
  quarantineKnownStaleInstallRoots,
} from "../cli/install/install-index-reconcile.js";
import { PLUGIN_ID } from "../utils/constants.js";

function writePluginDir(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
}

describe("known stale install roots (#2125)", () => {
  let openclawHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    openclawHome = join(tmpdir(), `mh-stale-roots-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(openclawHome, { recursive: true });
    prevHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.OPENCLAW_HOME = prevHome;
    else delete process.env.OPENCLAW_HOME;
    try {
      rmSync(openclawHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("enumerates the root node_modules and nested-state-dir candidate paths", () => {
    const candidates = knownStaleInstallRootCandidates(PLUGIN_ID);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("root-node-modules");
    expect(ids).toContain("nested-state-dir-npm-project");
    expect(ids).toContain("nested-state-dir-node-modules");
    expect(candidates.find((c) => c.id === "root-node-modules")?.path).toBe(
      join(openclawHome, "node_modules", PLUGIN_ID),
    );
  });

  it("detects a stale root node_modules copy distinct from the canonical live path", () => {
    const canonical = join(openclawHome, "extensions", PLUGIN_ID);
    writePluginDir(canonical, "2026.7.218");
    const staleRoot = join(openclawHome, "node_modules", PLUGIN_ID);
    writePluginDir(staleRoot, "2026.7.215");

    const detections = detectKnownStaleInstallRoots({ canonicalLivePath: canonical, pluginId: PLUGIN_ID });
    const rootDetection = detections.find((d) => d.id === "root-node-modules");

    expect(rootDetection?.present).toBe(true);
    expect(rootDetection?.version).toBe("2026.7.215");
  });

  it("does not flag a candidate that does not exist on disk", () => {
    const canonical = join(openclawHome, "extensions", PLUGIN_ID);
    writePluginDir(canonical, "2026.7.218");

    const detections = detectKnownStaleInstallRoots({ canonicalLivePath: canonical, pluginId: PLUGIN_ID });
    expect(detections.every((d) => !d.present)).toBe(true);
  });

  it("does not flag a candidate that happens to equal the canonical live path", () => {
    // Pathological but defensive: if the canonical path itself resolves to one of the known
    // candidate locations, it must never be quarantined as "stale".
    const canonical = join(openclawHome, "node_modules", PLUGIN_ID);
    writePluginDir(canonical, "2026.7.218");

    const detections = detectKnownStaleInstallRoots({ canonicalLivePath: canonical, pluginId: PLUGIN_ID });
    expect(detections.find((d) => d.id === "root-node-modules")).toBeUndefined();
  });

  it("quarantines a present stale root by moving (not deleting) it under .cache", () => {
    const canonical = join(openclawHome, "extensions", PLUGIN_ID);
    writePluginDir(canonical, "2026.7.218");
    const staleRoot = join(openclawHome, "node_modules", PLUGIN_ID);
    writePluginDir(staleRoot, "2026.7.215");
    const nestedNpmProject = join(openclawHome, ".openclaw", "npm", "projects", PLUGIN_ID, "node_modules", PLUGIN_ID);
    writePluginDir(nestedNpmProject, "2026.6.290");

    const results = quarantineKnownStaleInstallRoots({ canonicalLivePath: canonical, pluginId: PLUGIN_ID });

    const rootResult = results.find((r) => r.id === "root-node-modules");
    expect(rootResult?.quarantined).toBe(true);
    expect(existsSync(staleRoot)).toBe(false);
    const destinationPath = rootResult?.destinationPath;
    expect(destinationPath).toBeDefined();
    expect(existsSync(destinationPath ?? "")).toBe(true);
    const preserved = JSON.parse(readFileSync(join(destinationPath ?? "", "package.json"), "utf-8"));
    expect(preserved.version).toBe("2026.7.215");

    const nestedResult = results.find((r) => r.id === "nested-state-dir-npm-project");
    expect(nestedResult?.quarantined).toBe(true);
    expect(existsSync(nestedNpmProject)).toBe(false);

    // Canonical install must be left completely untouched.
    expect(existsSync(canonical)).toBe(true);
  });

  it("skips candidates that are not present without attempting anything", () => {
    const canonical = join(openclawHome, "extensions", PLUGIN_ID);
    writePluginDir(canonical, "2026.7.218");

    const results = quarantineKnownStaleInstallRoots({ canonicalLivePath: canonical, pluginId: PLUGIN_ID });

    expect(results.every((r) => !r.attempted && !r.quarantined)).toBe(true);
  });
});
