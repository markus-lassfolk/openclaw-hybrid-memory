/**
 * Tests for the legacy install-index reconciliation helpers (issue #2008).
 *
 * The legacy install-index file is the JSON sidecar at
 * `${stateDir}/plugins/installs.json` that OpenClaw core's state migrations
 * merge into SQLite on startup. When a plugin's runtime path/version
 * diverges from what the sidecar records, core emits the
 * "Left plugin install index in place because shared SQLite state has
 * conflicting plugin install metadata" warning on every startup.
 *
 * These tests verify the hybrid-memory side detector + reconciler:
 *   - detectStaleLegacyInstallIndexEntry: returns the right verdict for the
 *     six supported scenarios (no-conflict, matches-live, safe-reconcile,
 *     unsafe-downgrade, unsafe-no-live-path, unsafe-malformed-legacy).
 *   - reconcileLegacyInstallIndex: when safe, atomically removes the stale
 *     entry, leaves a backup, and preserves the rest of the sidecar; when
 *     unsafe, returns an error and leaves the sidecar untouched.
 *   - formatStaleInstallIndexWarning: produces actionable guidance including
 *     both stale and live paths and versions.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _extractLegacyInstallRecordForTest,
  _isVersionAtLeast,
  _normalizeInstallPathForTest,
  areInstallPathsEquivalent,
  comparePluginVersions,
  detectStaleLegacyInstallIndexEntry,
  formatStaleInstallIndexWarning,
  reconcileLegacyInstallIndex,
  resolveLegacyInstallIndexPath,
  runInstallIndexReconcileForPlugin,
} from "../cli/install/install-index-reconcile.js";

function makeLivePluginDir(stateDir: string, version: string): string {
  const liveDir = join(stateDir, "live", "openclaw-hybrid-memory");
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, "openclaw.plugin.json"), "{}");
  writeFileSync(join(liveDir, "package.json"), JSON.stringify({ version }));
  return liveDir;
}

function writeLegacySidecar(stateDir: string, record: Record<string, unknown> | null): string {
  const pluginsDir = join(stateDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const path = join(pluginsDir, "installs.json");
  if (record === null) {
    writeFileSync(path, "{}");
  } else {
    writeFileSync(path, JSON.stringify({ version: 1, installRecords: record }));
  }
  return path;
}

describe("install-index reconciliation (#2008)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mh-install-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("default legacy sidecar path uses OpenClaw state root (#2008)", () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      expect(resolveLegacyInstallIndexPath()).toBe(join(homedir(), ".openclaw", "plugins", "installs.json"));
    } finally {
      if (prev !== undefined) process.env.OPENCLAW_STATE_DIR = prev;
      else delete process.env.OPENCLAW_STATE_DIR;
    }
  });

  it("returns no-conflict when legacy sidecar does not exist", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const detection = detectStaleLegacyInstallIndexEntry({
      legacyPath: resolveLegacyInstallIndexPath({ stateDir }),
      livePath: liveDir,
    });
    expect(detection.present).toBe(false);
    expect(detection.verdict).toBe("no-conflict");
    expect(detection.livePath).toBe(liveDir);
    expect(detection.liveVersion).toBe("2026.6.291");
  });

  it("returns no-conflict when legacy sidecar exists but has no entry for the plugin", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, { "other-plugin": { installPath: "/x", version: "1.0" } });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.present).toBe(false);
    expect(detection.verdict).toBe("no-conflict");
  });

  it("returns matches-live when legacy record already matches live path/version", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: liveDir,
        version: "2026.6.291",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.present).toBe(true);
    expect(detection.verdict).toBe("matches-live");
  });

  it("returns safe-reconcile when stale path differs but live version is newer (#2008)", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.261" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.261",
        resolvedName: "openclaw-hybrid-memory",
        resolvedVersion: "2026.6.261",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.present).toBe(true);
    expect(detection.staleVersion).toBe("2026.6.261");
    expect(detection.verdict).toBe("safe-reconcile");
  });

  it("returns safe-reconcile when paths match but only the version differs (#2008)", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "extensions",
        installPath: liveDir,
        version: "2026.6.290",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("safe-reconcile");
    expect(detection.staleVersion).toBe("2026.6.290");
    expect(detection.liveVersion).toBe("2026.6.291");
  });

  it("returns unsafe-downgrade when live version is older than stale version", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.300" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.300",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("unsafe-downgrade");
    expect(formatStaleInstallIndexWarning(detection)).toMatch(/older than/);
  });

  it("returns unsafe-no-live-path when live plugin manifest is missing", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.270" }));
    const missingLive = join(stateDir, "missing-live");
    mkdirSync(missingLive, { recursive: true });
    // Intentionally do NOT write openclaw.plugin.json here.
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.270",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: missingLive });
    expect(detection.verdict).toBe("unsafe-no-live-path");
  });

  it("returns unsafe-malformed-legacy when the sidecar is unparseable JSON", () => {
    const pluginsDir = join(stateDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const legacyPath = join(pluginsDir, "installs.json");
    writeFileSync(legacyPath, "{ this is not valid JSON");
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("unsafe-malformed-legacy");
  });

  it("returns unsafe-malformed-legacy when the stale record lacks installPath", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": { source: "npm", version: "2026.6.270" },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("unsafe-malformed-legacy");
  });

  it("reconciles a safe-reconcile case by removing the stale entry and writing a backup", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.261" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.261",
        resolvedName: "openclaw-hybrid-memory",
        resolvedVersion: "2026.6.261",
      },
      codex: {
        source: "npm",
        installPath: "/usr/lib/node_modules/codex",
        version: "1.2.3",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("safe-reconcile");

    const result = reconcileLegacyInstallIndex({ detection });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("removed");
    expect(result.backupPath).toBeDefined();
    if (result.backupPath) expect(existsSync(result.backupPath)).toBe(true);

    const next = JSON.parse(readFileSync(legacyPath, "utf-8")) as { installRecords: Record<string, unknown> };
    expect(next.installRecords["openclaw-hybrid-memory"]).toBeUndefined();
    expect(next.installRecords.codex).toBeDefined();
  });

  it("dry-run does not mutate the sidecar but still reports the verdict", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.270" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.270",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    const before = readFileSync(legacyPath, "utf-8");

    const result = reconcileLegacyInstallIndex({ detection, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("removed");
    expect(result.backupPath).toBeUndefined();

    const after = readFileSync(legacyPath, "utf-8");
    expect(after).toBe(before);
  });

  it("skips unsafe verdicts without mutating the sidecar", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.300" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.300",
      },
    });
    const before = readFileSync(legacyPath, "utf-8");
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("unsafe-downgrade");

    const result = reconcileLegacyInstallIndex({ detection });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("skipped");
    expect(readFileSync(legacyPath, "utf-8")).toBe(before);
  });

  it("returns noop for matches-live without writing anything", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "extensions",
        installPath: liveDir,
        version: "2026.6.291",
      },
    });
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    const result = reconcileLegacyInstallIndex({ detection });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("noop");
  });

  it("runInstallIndexReconcileForPlugin logs guidance for unsafe verdicts", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.300" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "npm",
        installPath: staleDir,
        version: "2026.6.300",
      },
    });
    const logged: string[] = [];
    const result = runInstallIndexReconcileForPlugin({
      legacyPath,
      livePath: liveDir,
      log: (msg) => logged.push(msg),
    });
    expect(result.result.ok).toBe(false);
    expect(result.message).toMatch(/older than|Plugin install index drift/);
  });

  it("formatStaleInstallIndexWarning returns empty string for no-conflict and matches-live", () => {
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const noConflict = detectStaleLegacyInstallIndexEntry({
      legacyPath: resolveLegacyInstallIndexPath({ stateDir }),
      livePath: liveDir,
    });
    expect(formatStaleInstallIndexWarning(noConflict)).toBe("");

    const legacyPath = writeLegacySidecar(stateDir, {
      "openclaw-hybrid-memory": {
        source: "extensions",
        installPath: liveDir,
        version: "2026.6.291",
      },
    });
    const matches = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(formatStaleInstallIndexWarning(matches)).toBe("");
  });

  it("extractLegacyInstallRecordForTest tolerates the embedded plugins[] shape", () => {
    const legacyPath = join(stateDir, "plugins", "installs.json");
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        plugins: [
          {
            pluginId: "openclaw-hybrid-memory",
            installRecord: {
              source: "npm",
              installPath: "/x",
              version: "2026.6.270",
            },
          },
          { pluginId: "codex", installRecord: { source: "npm", installPath: "/y", version: "1.0" } },
        ],
      }),
    );
    const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as unknown;
    const rec = _extractLegacyInstallRecordForTest(parsed, "openclaw-hybrid-memory");
    expect(rec?.installPath).toBe("/x");
    expect(rec?.version).toBe("2026.6.270");
  });

  it("reconciles embedded plugins[] shape when installRecords is absent", () => {
    const staleDir = join(stateDir, "stale");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "package.json"), JSON.stringify({ version: "2026.6.261" }));
    const liveDir = makeLivePluginDir(stateDir, "2026.6.291");
    const legacyPath = join(stateDir, "plugins", "installs.json");
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        plugins: [
          {
            pluginId: "openclaw-hybrid-memory",
            installRecord: {
              source: "npm",
              installPath: staleDir,
              version: "2026.6.261",
            },
          },
          { pluginId: "codex", installRecord: { source: "npm", installPath: "/y", version: "1.0" } },
        ],
      }),
    );
    const detection = detectStaleLegacyInstallIndexEntry({ legacyPath, livePath: liveDir });
    expect(detection.verdict).toBe("safe-reconcile");

    const result = reconcileLegacyInstallIndex({ detection });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("removed");

    const next = JSON.parse(readFileSync(legacyPath, "utf-8")) as {
      plugins: Array<{ pluginId: string }>;
    };
    expect(next.plugins.some((p) => p.pluginId === "openclaw-hybrid-memory")).toBe(false);
    expect(next.plugins.some((p) => p.pluginId === "codex")).toBe(true);
  });

  it("compares date-based plugin versions numerically", () => {
    expect(comparePluginVersions("2026.6.291", "2026.6.290")).toBeGreaterThan(0);
    expect(comparePluginVersions("2026.6.290", "2026.6.291")).toBeLessThan(0);
    expect(comparePluginVersions("2026.6.291", "2026.6.291")).toBe(0);
    expect(_isVersionAtLeast("2026.6.291", "2026.6.290")).toBe(true);
    expect(_isVersionAtLeast("2026.6.290", "2026.6.291")).toBe(false);
  });

  it("treats realpath-equivalent paths as the same install path", () => {
    const a = makeLivePluginDir(stateDir, "2026.6.291");
    expect(areInstallPathsEquivalent(a, a)).toBe(true);
    expect(_normalizeInstallPathForTest(a)).toBeTruthy();
  });
});
