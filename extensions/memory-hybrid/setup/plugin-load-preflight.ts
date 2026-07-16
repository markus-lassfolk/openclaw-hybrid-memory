/**
 * Plugin-load preflight & diagnostics (#2135).
 *
 * The Gateway crashed with a native SIGBUS immediately after starting to load
 * `openclaw-hybrid-memory` from a hot-upgrade *staging* directory
 * (`…/.openclaw-hybrid-memory-staging-<n>/dist/index.js`). A native abort inside the LanceDB
 * binding or an mmapped data file cannot be caught by a JS `try/catch` once execution enters
 * native code, so the only safe defense is to (a) reject a structurally incomplete staging copy
 * *before* the first native touch, and (b) record enough load context up front that any residual
 * crash is diagnosable ("openclaw-hybrid-memory failed to initialize", with version + staging path
 * + last-successful path + reload state) instead of an opaque `status=7/BUS`.
 *
 * This module is intentionally free of native/DB imports and side-effect-free (apart from the
 * small module-scoped "last successful extension path" record) so it can run — and be tested —
 * before any store is opened.
 *
 * Scope / limits: this is a *necessary but not sufficient* guard. It catches an interrupted staging
 * copy whose manifests or compiled entry are missing/truncated/corrupt — the states that reliably
 * precede a native abort. It cannot detect a native binding (`@lancedb/lancedb`'s `.node`) or an
 * mmapped Lance data file that is present-but-internally-corrupt; a truncated-but-loadable binding
 * can still SIGBUS at `lancedb.connect()`. A non-loadable binding, by contrast, throws a catchable
 * error at the static ESM import long before this runs. Extending coverage to the native binding
 * would require child-process isolation and is intentionally out of scope here.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Files that MUST be present and well-formed at the plugin root for a load to be safe to continue. */
const CRITICAL_MANIFEST_FILES = ["openclaw.plugin.json", "package.json"] as const;

export type ExtensionLoadContext = {
  /** Absolute plugin-root directory the running module resolved from, or "unknown". */
  extensionPath: string;
  /** True when the extension is loaded from an OpenClaw hot-upgrade staging directory. */
  isStaging: boolean;
  /** Plugin version read from package.json, or "unknown" if unreadable. */
  packageVersion: string;
};

export type PreflightResult = { ok: true } | { ok: false; reason: string; detail: string };

/**
 * True when a resolved extension path is an OpenClaw hot-upgrade staging directory. Matches any
 * path segment that looks like `…-staging-<digits>` (e.g. `.openclaw-hybrid-memory-staging-856831`),
 * which is how the loader names the temporary directory it copies a new version into before swap.
 */
export function isStagingExtensionPath(extensionPath: string): boolean {
  if (!extensionPath) return false;
  return /[\\/][^\\/]*-staging-\d+(?:[\\/]|$)/.test(extensionPath) || /-staging-\d+$/.test(extensionPath);
}

/**
 * Build the load context for diagnostics. `extensionPath` should be the resolved plugin root
 * (from findPluginRoot); pass "unknown" when it could not be resolved. Never throws.
 */
export function buildExtensionLoadContext(extensionPath: string): ExtensionLoadContext {
  let packageVersion = "unknown";
  if (extensionPath && extensionPath !== "unknown") {
    try {
      const pkgRaw = readFileSync(join(extensionPath, "package.json"), "utf-8");
      const parsed = JSON.parse(pkgRaw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) packageVersion = parsed.version;
    } catch {
      // Leave "unknown" — a missing/corrupt package.json is itself caught by the preflight below.
    }
  }
  return {
    extensionPath: extensionPath || "unknown",
    isStaging: isStagingExtensionPath(extensionPath),
    packageVersion,
  };
}

/**
 * Validate that the plugin root is a *complete* copy before continuing into native DB init. A
 * partially copied / interrupted staging swap leaves a manifest missing, zero-byte, or truncated —
 * exactly the state that precedes a native abort — so we fail closed with a recoverable, named
 * error instead of proceeding into `lancedb.connect()`. Pure filesystem checks only; no native code.
 */
export function preflightExtensionIntegrity(extensionPath: string): PreflightResult {
  if (!extensionPath || extensionPath === "unknown") {
    return {
      ok: false,
      reason: "plugin_root_unresolved",
      detail: "could not resolve the plugin root directory from the running module",
    };
  }
  for (const file of CRITICAL_MANIFEST_FILES) {
    const full = join(extensionPath, file);
    if (!existsSync(full)) {
      return { ok: false, reason: "missing_manifest", detail: `${file} is missing at ${extensionPath}` };
    }
    let size: number;
    try {
      size = statSync(full).size;
    } catch (err) {
      return { ok: false, reason: "stat_failed", detail: `${file} could not be stat()'d: ${errText(err)}` };
    }
    if (size === 0) {
      return {
        ok: false,
        reason: "empty_manifest",
        detail: `${file} is zero bytes at ${extensionPath} (partial/interrupted staging copy)`,
      };
    }
    try {
      JSON.parse(readFileSync(full, "utf-8"));
    } catch (err) {
      return { ok: false, reason: "corrupt_manifest", detail: `${file} is not valid JSON: ${errText(err)}` };
    }
  }

  // When loaded from a compiled build (prod / hot-upgrade staging), the host imports
  // `<root>/dist/index.js`; a staging copy that finished the small manifests but truncated the
  // compiled entry would still crash. Validate the entry is present and non-empty when a `dist/`
  // build exists. Skipped for a source/TS run (no dist/), which imports `index.ts` directly.
  const distDir = join(extensionPath, "dist");
  if (dirExists(distDir)) {
    const entry = join(distDir, "index.js");
    if (!existsSync(entry)) {
      return { ok: false, reason: "missing_entry", detail: `dist/index.js is missing at ${extensionPath}` };
    }
    let entrySize: number;
    try {
      entrySize = statSync(entry).size;
    } catch (err) {
      return { ok: false, reason: "stat_failed", detail: `dist/index.js could not be stat()'d: ${errText(err)}` };
    }
    if (entrySize === 0) {
      return {
        ok: false,
        reason: "empty_entry",
        detail: `dist/index.js is zero bytes at ${extensionPath} (partial/interrupted staging copy)`,
      };
    }
  }
  return { ok: true };
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Last-successful extension path tracking (for crash diagnostics) ---------------------------
// Recorded only after a registration completes far enough to be considered healthy, so a later
// crashing staging load can report the path that last worked. Module-scoped on purpose: it must
// survive across re-registrations within the same process.
let lastSuccessfulExtensionPath: string | null = null;

export function recordSuccessfulExtensionLoad(extensionPath: string): void {
  if (extensionPath && extensionPath !== "unknown") lastSuccessfulExtensionPath = extensionPath;
}

export function getLastSuccessfulExtensionPath(): string | null {
  return lastSuccessfulExtensionPath;
}

/** Test-only reset for the module-scoped last-successful path. */
export function _resetLastSuccessfulExtensionPathForTests(): void {
  lastSuccessfulExtensionPath = null;
}

/** Error thrown when the preflight rejects a load; carries the structured reason for diagnostics. */
export class PluginLoadPreflightError extends Error {
  readonly reason: string;
  readonly loadContext: ExtensionLoadContext;
  constructor(result: Extract<PreflightResult, { ok: false }>, loadContext: ExtensionLoadContext) {
    super(
      `memory-hybrid: plugin load preflight failed (${result.reason}): ${result.detail}. ` +
        `version=${loadContext.packageVersion} staging=${loadContext.isStaging} path=${loadContext.extensionPath}`,
    );
    this.name = "PluginLoadPreflightError";
    this.reason = result.reason;
    this.loadContext = loadContext;
  }
}
