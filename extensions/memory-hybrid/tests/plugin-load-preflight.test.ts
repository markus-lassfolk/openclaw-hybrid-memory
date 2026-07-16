/**
 * Regression tests for #2135: the Gateway SIGBUS'd while loading openclaw-hybrid-memory from a
 * hot-upgrade staging directory. A native abort can't be caught once execution enters native code,
 * so the defense is to reject a structurally incomplete staging copy BEFORE the first native touch
 * and to record enough load context that any residual crash is attributable. These tests cover the
 * pure preflight/diagnostics seam (no native/DB code).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLastSuccessfulExtensionPathForTests,
  buildExtensionLoadContext,
  getLastSuccessfulExtensionPath,
  isStagingExtensionPath,
  PluginLoadPreflightError,
  preflightExtensionIntegrity,
  recordSuccessfulExtensionLoad,
} from "../setup/plugin-load-preflight.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "load-preflight-"));
  _resetLastSuccessfulExtensionPathForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _resetLastSuccessfulExtensionPathForTests();
});

function writeHealthyPlugin(dir: string, version = "2026.7.220"): void {
  writeFileSync(join(dir, "openclaw.plugin.json"), JSON.stringify({ name: "openclaw-hybrid-memory" }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "openclaw-hybrid-memory", version }));
}

describe("isStagingExtensionPath (#2135)", () => {
  it("recognizes an OpenClaw staging directory", () => {
    expect(isStagingExtensionPath("/mnt/openclaw/.openclaw/extensions/.openclaw-hybrid-memory-staging-856831")).toBe(
      true,
    );
    expect(
      isStagingExtensionPath("/mnt/openclaw/.openclaw/extensions/.openclaw-hybrid-memory-staging-856831/dist"),
    ).toBe(true);
  });

  it("does not flag a normal install path", () => {
    expect(isStagingExtensionPath("/home/user/.openclaw/extensions/openclaw-hybrid-memory")).toBe(false);
    expect(isStagingExtensionPath("")).toBe(false);
  });
});

describe("buildExtensionLoadContext (#2135)", () => {
  it("reads the package version and flags staging", () => {
    writeHealthyPlugin(root, "2026.7.220");
    const ctx = buildExtensionLoadContext(root);
    expect(ctx.packageVersion).toBe("2026.7.220");
    expect(ctx.extensionPath).toBe(root);
    expect(ctx.isStaging).toBe(false);
  });

  it("never throws and degrades to 'unknown' for an unresolved path", () => {
    const ctx = buildExtensionLoadContext("unknown");
    expect(ctx).toEqual({ extensionPath: "unknown", isStaging: false, packageVersion: "unknown" });
  });
});

describe("preflightExtensionIntegrity (#2135)", () => {
  it("passes for a complete plugin directory", () => {
    writeHealthyPlugin(root);
    expect(preflightExtensionIntegrity(root)).toEqual({ ok: true });
  });

  it("fails (recoverably) when the plugin root cannot be resolved", () => {
    const result = preflightExtensionIntegrity("unknown");
    expect(result).toMatchObject({ ok: false, reason: "plugin_root_unresolved" });
  });

  it("fails when a manifest is missing (interrupted staging copy)", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    // openclaw.plugin.json intentionally absent
    const result = preflightExtensionIntegrity(root);
    expect(result).toMatchObject({ ok: false, reason: "missing_manifest" });
  });

  it("fails when a manifest is zero bytes (truncated copy)", () => {
    writeFileSync(join(root, "openclaw.plugin.json"), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const result = preflightExtensionIntegrity(root);
    expect(result).toMatchObject({ ok: false, reason: "empty_manifest" });
  });

  it("fails when a manifest is not valid JSON (partial write)", () => {
    writeFileSync(join(root, "openclaw.plugin.json"), '{ "name": "x"'); // truncated JSON
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const result = preflightExtensionIntegrity(root);
    expect(result).toMatchObject({ ok: false, reason: "corrupt_manifest" });
  });

  it("fails when package.json specifically is the corrupt manifest", () => {
    writeFileSync(join(root, "openclaw.plugin.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(root, "package.json"), "not json at all");
    const result = preflightExtensionIntegrity(root);
    expect(result).toMatchObject({ ok: false, reason: "corrupt_manifest" });
    if (!result.ok) expect(result.detail).toContain("package.json");
  });

  it("validates the compiled dist/index.js entry when a dist build is present", () => {
    writeHealthyPlugin(root);
    mkdirSync(join(root, "dist"));
    // dist/ exists but the compiled entry is missing (interrupted staging copy).
    expect(preflightExtensionIntegrity(root)).toMatchObject({ ok: false, reason: "missing_entry" });

    // Zero-byte entry (truncated copy).
    writeFileSync(join(root, "dist", "index.js"), "");
    expect(preflightExtensionIntegrity(root)).toMatchObject({ ok: false, reason: "empty_entry" });

    // Complete entry → passes.
    writeFileSync(join(root, "dist", "index.js"), "export const register = () => {};\n");
    expect(preflightExtensionIntegrity(root)).toEqual({ ok: true });
  });

  it("skips the dist entry check for a source (no-dist) layout", () => {
    writeHealthyPlugin(root);
    // No dist/ directory — a TS/source run imports index.ts directly; preflight must not require dist.
    expect(preflightExtensionIntegrity(root)).toEqual({ ok: true });
  });

  it("a corrupt staging load surfaces as a recoverable error, and a healthy retry then passes (#2135)", () => {
    // Simulate a staging dir with a half-written manifest — the crash scenario from the issue.
    writeFileSync(join(root, "openclaw.plugin.json"), '{ "name":');
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const bad = preflightExtensionIntegrity(root);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      // The error is a normal, throwable JS error (recoverable) — not a native abort.
      const err = new PluginLoadPreflightError(bad, buildExtensionLoadContext(root));
      expect(err).toBeInstanceOf(Error);
      expect(err.reason).toBe("corrupt_manifest");
      expect(err.message).toContain("preflight failed");
    }

    // Repair (finished copy) → the very next load passes without any lingering failure state.
    writeHealthyPlugin(root);
    expect(preflightExtensionIntegrity(root)).toEqual({ ok: true });
  });
});

describe("last-successful extension path tracking (#2135)", () => {
  it("records the last-known-good path and resets for tests", () => {
    expect(getLastSuccessfulExtensionPath()).toBeNull();
    recordSuccessfulExtensionLoad("/opt/openclaw/extensions/openclaw-hybrid-memory");
    expect(getLastSuccessfulExtensionPath()).toBe("/opt/openclaw/extensions/openclaw-hybrid-memory");
    // "unknown" must never overwrite a real last-known-good path.
    recordSuccessfulExtensionLoad("unknown");
    expect(getLastSuccessfulExtensionPath()).toBe("/opt/openclaw/extensions/openclaw-hybrid-memory");
  });
});
