import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  restoreNpmProjectPinFiles,
  snapshotNpmProjectPinBeforeUpgrade,
  verifyNpmProjectDependencyPin,
  verifyUpgradePluginBundle,
} from "../cli/cmd-install.js";

const PLUGIN_ROOT = join(import.meta.dirname, "..");

describe("upgrade integration (npm-project layout)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `mh-upgrade-int-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("npm-project layout: pin snapshot survives failed pin mutation rollback", () => {
    const projectRoot = join(tmp, "openclaw-hybrid-memory");
    const pluginDir = join(projectRoot, "node_modules", "openclaw-hybrid-memory");
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(PLUGIN_ROOT, "skills"), join(pluginDir, "skills"), { recursive: true });
    cpSync(join(PLUGIN_ROOT, "workspace-snippets"), join(pluginDir, "workspace-snippets"), { recursive: true });
    mkdirSync(join(pluginDir, "dist"), { recursive: true });
    writeFileSync(join(pluginDir, "dist", "index.js"), "// stub\n");
    writeFileSync(join(pluginDir, "openclaw.plugin.json"), readFileSync(join(PLUGIN_ROOT, "openclaw.plugin.json")));

    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.260" } }),
    );
    writeFileSync(join(projectRoot, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');

    expect(verifyUpgradePluginBundle(pluginDir)).toBeUndefined();
    const backup = snapshotNpmProjectPinBeforeUpgrade(projectRoot);

    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { "openclaw-hybrid-memory": "2026.6.272" } }),
    );
    expect(verifyNpmProjectDependencyPin(projectRoot, "2026.6.260")).toMatch(/expected 2026.6.260/);

    restoreNpmProjectPinFiles(backup);
    expect(verifyNpmProjectDependencyPin(projectRoot, "2026.6.260")).toBeUndefined();
    expect(readFileSync(join(projectRoot, "package-lock.json"), "utf-8")).toContain("lockfileVersion");
  });
});
