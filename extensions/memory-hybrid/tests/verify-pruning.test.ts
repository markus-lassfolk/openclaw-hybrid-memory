/**
 * Tests for verify --fix pruning detection and removal (#105 / PR #138)
 *
 * Covers:
 * - agents.defaults.pruning is detected when present (truthy, falsy, null, false)
 * - verify --fix removes the pruning key from the config file
 * - verify --fix does NOT remove unrelated config keys
 * - issues and fixes arrays are cleared after a successful fix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helper: inline re-implementation of the pruning check/fix logic
// (mirrors the code in cli/handlers.ts so we can unit test it)
// ---------------------------------------------------------------------------

interface VerifyPruningResult {
  detected: boolean;
  fixApplied: boolean;
  issues: string[];
  fixes: string[];
}

function runPruningCheck(
  rawConfig: Record<string, unknown>,
  configPath: string,
  opts: { fix: boolean }
): VerifyPruningResult {
  const issues: string[] = [];
  const fixes: string[] = [];
  let detected = false;
  let fixApplied = false;

  const agentsDefaults = (rawConfig.agents as Record<string, unknown> | undefined)
    ?.defaults as Record<string, unknown> | undefined;

  if (agentsDefaults != null && "pruning" in agentsDefaults) {
    detected = true;
    issues.push("agents.defaults.pruning is set but unsupported (has no effect)");
    fixes.push(
      'Remove "pruning" from agents.defaults in openclaw.json. Memory pruning is handled automatically by the plugin (every 60 min).'
    );

    if (opts.fix) {
      delete agentsDefaults.pruning;
      writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), "utf-8");
      fixes.pop();
      issues.pop();
      fixApplied = true;
    }
  }

  return { detected, fixApplied, issues, fixes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify --fix: pruning detection and removal", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oc-pruning-test-"));
    configPath = join(tmpDir, "openclaw.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects agents.defaults.pruning when set to a truthy value", () => {
    const config = {
      agents: { defaults: { pruning: { interval: 3600 } } },
      other: "preserved",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: false });

    expect(result.detected).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("pruning");
    expect(result.fixes).toHaveLength(1);
    expect(result.fixApplied).toBe(false);
  });

  it("detects agents.defaults.pruning when set to false (key exists with falsy value)", () => {
    const config = {
      agents: { defaults: { pruning: false } },
    } as unknown as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: false });

    expect(result.detected).toBe(true);
  });

  it("detects agents.defaults.pruning when set to null (key exists with null value)", () => {
    const config = {
      agents: { defaults: { pruning: null } },
    } as unknown as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: false });

    expect(result.detected).toBe(true);
  });

  it("does NOT detect pruning when agents.defaults.pruning is absent", () => {
    const config = { agents: { defaults: { maxHistory: 100 } } };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: false });

    expect(result.detected).toBe(false);
    expect(result.issues).toHaveLength(0);
    expect(result.fixes).toHaveLength(0);
  });

  it("does NOT detect pruning when agents.defaults is absent", () => {
    const config = { agents: {} };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: false });

    expect(result.detected).toBe(false);
  });

  it("verify --fix removes agents.defaults.pruning from the config file", () => {
    const config = {
      agents: { defaults: { pruning: { interval: 3600 }, maxHistory: 100 } },
      other: "preserved",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const result = runPruningCheck(config, configPath, { fix: true });

    expect(result.fixApplied).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.fixes).toHaveLength(0);

    // Read back and verify pruning is gone
    const written = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const defaults = (written.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect("pruning" in defaults).toBe(false);
  });

  it("verify --fix preserves unrelated config keys", () => {
    const config = {
      agents: { defaults: { pruning: true, maxHistory: 100 } },
      plugins: { foo: "bar" },
      other: "preserved",
    } as unknown as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    runPruningCheck(config, configPath, { fix: true });

    const written = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const defaults = (written.agents as Record<string, unknown>).defaults as Record<string, unknown>;

    expect("pruning" in defaults).toBe(false);
    expect(defaults.maxHistory).toBe(100);
    expect((written.plugins as Record<string, unknown>).foo).toBe("bar");
    expect(written.other).toBe("preserved");
  });

  it("written config file is valid JSON with no extra trailing newline", () => {
    const config = {
      agents: { defaults: { pruning: true } },
    } as unknown as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    runPruningCheck(config, configPath, { fix: true });

    const raw = readFileSync(configPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});
