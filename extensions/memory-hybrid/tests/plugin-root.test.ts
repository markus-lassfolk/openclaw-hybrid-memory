/**
 * Tests for utils/plugin-root.ts (issue #1174).
 *
 * Validates the walk-up resolver works regardless of how deep below the
 * plugin root the caller is (mimicking source-mode `cli/foo.ts` and
 * compiled-mode `dist/cli/foo.js`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearPluginRootCache, findPluginRoot, readPluginPackageJson } from "../utils/plugin-root.js";

describe("plugin-root resolver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hm-plugin-root-"));
    _clearPluginRootCache();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    _clearPluginRootCache();
  });

  function setupFakePlugin(version = "2026.99.0"): string {
    const pluginRoot = join(tmpRoot, "fake-plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({ id: "fake" }));
    writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "fake-plugin", version }));
    return pluginRoot;
  }

  it("finds the plugin root from a top-level module (mimics source mode index.ts)", () => {
    const pluginRoot = setupFakePlugin();
    const fakeModule = join(pluginRoot, "index.ts");
    writeFileSync(fakeModule, "");
    expect(findPluginRoot(pathToFileURL(fakeModule).href)).toBe(pluginRoot);
  });

  it("finds the plugin root from a nested source module (cli/foo.ts)", () => {
    const pluginRoot = setupFakePlugin();
    mkdirSync(join(pluginRoot, "cli"));
    const fakeModule = join(pluginRoot, "cli", "foo.ts");
    writeFileSync(fakeModule, "");
    expect(findPluginRoot(pathToFileURL(fakeModule).href)).toBe(pluginRoot);
  });

  it("finds the plugin root from a compiled multi-level dist module (dist/cli/foo.js)", () => {
    const pluginRoot = setupFakePlugin();
    mkdirSync(join(pluginRoot, "dist", "cli"), { recursive: true });
    const fakeModule = join(pluginRoot, "dist", "cli", "foo.js");
    writeFileSync(fakeModule, "");
    expect(findPluginRoot(pathToFileURL(fakeModule).href)).toBe(pluginRoot);
  });

  it("finds the plugin root from the bundled dist/index.js (issue #1174 reproduction)", () => {
    const pluginRoot = setupFakePlugin();
    mkdirSync(join(pluginRoot, "dist"));
    const distEntry = join(pluginRoot, "dist", "index.js");
    writeFileSync(distEntry, "");
    expect(findPluginRoot(pathToFileURL(distEntry).href)).toBe(pluginRoot);
  });

  it("throws a precise error when no openclaw.plugin.json is found above the module", () => {
    const isolated = mkdtempSync(join(tmpdir(), "hm-no-manifest-"));
    try {
      const fakeModule = join(isolated, "index.js");
      writeFileSync(fakeModule, "");
      expect(() => findPluginRoot(pathToFileURL(fakeModule).href)).toThrow(/could not locate openclaw\.plugin\.json/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("readPluginPackageJson returns parsed { name, version } from the resolved root", () => {
    const pluginRoot = setupFakePlugin("2026.5.99");
    mkdirSync(join(pluginRoot, "dist"));
    const distEntry = join(pluginRoot, "dist", "index.js");
    writeFileSync(distEntry, "");

    const pkg = readPluginPackageJson(pathToFileURL(distEntry).href);
    expect(pkg.name).toBe("fake-plugin");
    expect(pkg.version).toBe("2026.5.99");
  });

  it("readPluginPackageJson rejects a package.json without a version", () => {
    const pluginRoot = join(tmpRoot, "no-version-plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "openclaw.plugin.json"), "{}");
    writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "broken" }));
    const fakeModule = join(pluginRoot, "index.js");
    writeFileSync(fakeModule, "");
    expect(() => readPluginPackageJson(pathToFileURL(fakeModule).href)).toThrow(/missing version/);
  });

  it("caches resolved roots across calls (idempotent)", () => {
    const pluginRoot = setupFakePlugin();
    const fakeModule = join(pluginRoot, "index.ts");
    writeFileSync(fakeModule, "");
    const first = findPluginRoot(pathToFileURL(fakeModule).href);
    // Even if the manifest is removed after the first call, the cached value
    // should still be returned.
    rmSync(join(pluginRoot, "openclaw.plugin.json"));
    const second = findPluginRoot(pathToFileURL(fakeModule).href);
    expect(second).toBe(first);
  });
});
