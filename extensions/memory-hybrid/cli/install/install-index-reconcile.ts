/**
 * Legacy installed-plugin-index reconciliation (issue #2008).
 *
 * Background:
 *   OpenClaw core stores its "installed plugin index" in two layers:
 *     1. A legacy JSON file at `${stateDir}/plugins/installs.json`
 *     2. The current shared SQLite state DB
 *   On startup, core's state migrations try to merge the legacy file into SQLite.
 *   When a plugin has been upgraded and the runtime now loads it from
 *   `~/.openclaw/extensions/<plugin>/` but the legacy file still references an
 *   older npm-project install path/version, the merge sees conflicting metadata
 *   and emits the warning:
 *     "Left plugin install index in place because shared SQLite state has
 *      conflicting plugin install metadata for: codex, openclaw-hybrid-memory"
 *   The conflict is then reported on every subsequent startup until either the
 *   legacy file is removed or its records are reconciled.
 *
 * This helper:
 *   - Detects whether the legacy file has a stale record for the plugin whose
 *     path/version does not match the live extension path/version we can prove.
 *   - If the live path is reachable AND its version is >= the stale version,
 *     atomically rewrites the legacy file (after backing it up) to either drop
 *     the stale record or update it to match the live path/version. This stops
 *     core state migrations from re-emitting the conflict warning.
 *   - When reconciliation is not safe (live path missing or downgraded), returns
 *     an actionable warning that names both the stale and live paths and
 *     versions so operators can repair manually.
 *
 * The helpers in this file are intentionally pure: they do not call out to the
 * OpenClaw gateway, they only read and rewrite the legacy JSON sidecar that
 * core state migrations consult on startup.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import { PLUGIN_ID } from "../../utils/constants.js";
import { getEnv } from "../../utils/env-manager.js";
import { findPluginRoot } from "../../utils/plugin-root.js";
import {
  readPluginPackageVersion,
  isNpmProjectPluginLayout,
  resolveKnownNpmProjectPluginDir,
  resolveKnownNpmProjectRoot,
  resolveNpmProjectRootForPlugin,
} from "./workspace.js";
import { resolveOpenclawHomeDir } from "../../utils/openclaw-workspace.js";

/** Relative path of the legacy install-index sidecar under the OpenClaw state dir. */
const LEGACY_INSTALL_INDEX_REL_PATH = join("plugins", "installs.json");

/** Key under `installRecords` for a given plugin id in the legacy file. */
type LegacyRecord = Record<string, unknown> & {
  source?: unknown;
  spec?: unknown;
  installPath?: unknown;
  version?: unknown;
  resolvedName?: unknown;
  resolvedVersion?: unknown;
  resolvedSpec?: unknown;
  installedAt?: unknown;
};

/** Snapshot of what we know about a stale legacy install record for a single plugin. */
export type StaleLegacyInstallIndexDetection = {
  /** True when the legacy file exists and contains a record for the plugin id. */
  present: boolean;
  /** Absolute path to the legacy install-index file. */
  legacyPath: string;
  /** Stale installPath recorded in the legacy file (if present). */
  staleInstallPath?: string;
  /** Stale version recorded in the legacy file (if present). */
  staleVersion?: string;
  /** Stale record source, when present (e.g. "npm", "extensions"). */
  staleSource?: string;
  /** Absolute path to the live plugin root directory we are running from. */
  livePath: string;
  /** Live plugin version resolved from the running plugin's package.json. */
  liveVersion?: string;
  /** True when the livePath exists on disk and contains the plugin manifest. */
  livePathExists: boolean;
  /**
   * One of:
   *   - "no-conflict": legacy file has no entry for this plugin, nothing to do.
   *   - "matches-live": legacy record already points at the live path/version.
   *   - "safe-reconcile": live path exists with a >= version; safe to rewrite.
   *   - "unsafe-downgrade": live version is older than the stale version.
   *   - "unsafe-no-live-path": live path missing or not a valid plugin dir.
   *   - "unsafe-malformed-legacy": legacy record is malformed (missing path/version).
   *   - "unsafe-other-plugin-path": stale record points at a different plugin id.
   */
  verdict:
    | "no-conflict"
    | "matches-live"
    | "safe-reconcile"
    | "unsafe-downgrade"
    | "unsafe-no-live-path"
    | "unsafe-malformed-legacy"
    | "unsafe-other-plugin-path";
  /** Human-readable detail describing why the verdict was chosen. */
  detail?: string;
};

/** Result of an attempted reconciliation. */
export type ReconcileLegacyInstallIndexResult = {
  /** True when the legacy file was rewritten successfully. */
  ok: boolean;
  /** The verdict derived from the detection. */
  verdict: StaleLegacyInstallIndexDetection["verdict"];
  /** Action performed against the legacy file. */
  action: "removed" | "updated" | "skipped" | "noop";
  /** Absolute path to the backup file written before mutating, when applicable. */
  backupPath?: string;
  /** Optional error message when ok is false. */
  error?: string;
};

/** Default OpenClaw state directory used to locate the legacy install-index. */
function defaultOpenclawStateDir(): string {
  const fromEnv = getEnv("OPENCLAW_STATE_DIR");
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return resolveOpenclawHomeDir();
}

/**
 * Live plugin root for install-index comparison. Prefer the extensions copy under
 * OpenClaw home when present — Gateway loads from there even when the CLI runs
 * from an npm-project layout (#2008).
 */
export function resolveCanonicalLivePluginPathForInstallIndex(pluginId: string = PLUGIN_ID): string {
  const extensionsDir = join(resolveOpenclawHomeDir(), "extensions", pluginId);
  if (existsSync(join(extensionsDir, "openclaw.plugin.json"))) {
    return extensionsDir;
  }
  return findPluginRoot(import.meta.url);
}

export type RemoveRedundantNpmProjectTreeResult = {
  /** True when the guards passed and removal was actually tried. */
  attempted: boolean;
  /** True when the redundant npm-project tree is no longer at the canonical path. */
  removed: boolean;
  /** The npm-project root that was removed (its canonical path). */
  removedPath?: string;
  /** Populated when removal was tried but failed. */
  error?: string;
  /** Populated when removal was intentionally skipped (guard tripped). */
  skippedReason?:
    | "extensions-dir-is-npm-project-layout"
    | "no-npm-project-tree"
    | "extensions-not-installed"
    | "same-tree"
    | "npm-project-not-older"
    | "npm-project-version-unreadable";
};

/**
 * Remove the redundant `~/.openclaw/npm/projects/<plugin>` tree when the extensions
 * copy is canonical (#2021).
 *
 * On extensions-canonical hosts (Maeve/Doris) the gateway loads
 * `~/.openclaw/extensions/openclaw-hybrid-memory`. A second copy under
 * `npm/projects/openclaw-hybrid-memory` — typically left behind by
 * `openclaw plugins install`, which targets npm/projects rather than extensions —
 * makes the gateway emit "duplicate plugin id" / "plugin entry path escapes plugin
 * root" errors. Syncing the npm-project pin (the previous #2008 behaviour) keeps the
 * duplicate alive; the only durable fix is to remove the redundant tree, which the
 * issue confirms is safe when extensions is canonical.
 *
 * Guards (all must hold, else returns `attempted: false` with a `skippedReason`):
 * - the extensions dir is NOT itself an npm-project layout (i.e. extensions is canonical);
 * - a distinct npm-project tree actually exists;
 * - the extensions copy is installed with a readable version;
 * - the npm-project copy is not strictly newer than the extensions copy (never delete a
 *   newer install — the host may be mid-upgrade or npm/projects may actually be live).
 *
 * Removal is atomic-then-cleanup: the project root is renamed to a `.redundant-<ts>`
 * sibling (which immediately neutralises the duplicate, since gateway discovery only
 * matches the exact `openclaw-hybrid-memory` directory name) and then best-effort
 * deleted. If the final delete fails the duplicate is still gone from the canonical path.
 */
export function removeRedundantNpmProjectTreeWhenExtensionsCanonical(opts: {
  extensionsPluginDir: string;
  /** npm-project plugin dir detected by verify/upgrade (defaults to Maeve layout). */
  npmProjectPluginDir?: string;
}): RemoveRedundantNpmProjectTreeResult {
  if (isNpmProjectPluginLayout(opts.extensionsPluginDir)) {
    return { attempted: false, removed: false, skippedReason: "extensions-dir-is-npm-project-layout" };
  }
  const npmPluginDir = opts.npmProjectPluginDir ?? resolveKnownNpmProjectPluginDir();
  const projectRoot = npmPluginDir ? resolveNpmProjectRootForPlugin(npmPluginDir) : resolveKnownNpmProjectRoot();
  if (!npmPluginDir || !projectRoot) {
    return { attempted: false, removed: false, skippedReason: "no-npm-project-tree" };
  }
  if (!existsSync(join(opts.extensionsPluginDir, "openclaw.plugin.json"))) {
    return { attempted: false, removed: false, skippedReason: "extensions-not-installed" };
  }
  const extVer = readPluginPackageVersion(opts.extensionsPluginDir);
  if (!extVer) {
    return { attempted: false, removed: false, skippedReason: "extensions-not-installed" };
  }
  if (samePath(npmPluginDir, opts.extensionsPluginDir)) {
    return { attempted: false, removed: false, skippedReason: "same-tree" };
  }
  const npmVer = readPluginPackageVersion(npmPluginDir);
  if (!npmVer) {
    // Can't confirm the npm-project copy isn't newer — treat unreadable as unsafe to delete
    // rather than silently falling through to the unconditional, unrecoverable removal below.
    return { attempted: false, removed: false, skippedReason: "npm-project-version-unreadable" };
  }
  if (compareVersions(npmVer, extVer) > 0) {
    // npm-project copy is newer than extensions — refuse to delete a newer install.
    return { attempted: false, removed: false, skippedReason: "npm-project-not-older" };
  }
  try {
    const graveyard = `${projectRoot}.redundant-${Date.now()}`;
    renameSync(projectRoot, graveyard);
    try {
      rmSync(graveyard, { recursive: true, force: true });
    } catch {
      // Best-effort: the duplicate is already gone from the canonical path; leftover
      // `.redundant-*` dirs are ignored by gateway plugin discovery.
    }
    return { attempted: true, removed: true, removedPath: projectRoot };
  } catch (err) {
    return {
      attempted: true,
      removed: false,
      removedPath: projectRoot,
      error: `Could not remove redundant npm-project tree at ${projectRoot}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type QuarantineExtensionsTreeResult = {
  /** True when the guards passed and quarantine was actually tried. */
  attempted: boolean;
  /** True when the stale extensions copy was moved out of the discoverable path. */
  quarantined: boolean;
  /** The original extensions plugin dir that was quarantined. */
  quarantinedPath?: string;
  /** Where the stale copy was moved to (under ~/.openclaw/.cache). */
  destinationPath?: string;
  /** The canonical npm-project plugin dir that "won" (kept). */
  canonicalNpmProjectDir?: string;
  /** Populated when quarantine was tried but failed. */
  error?: string;
  /** Populated when quarantine was intentionally skipped (guard tripped). */
  skippedReason?:
    | "no-npm-project-tree"
    | "npm-project-not-loadable"
    | "npm-project-version-unreadable"
    | "extensions-not-installed"
    | "extensions-version-unreadable"
    | "extensions-dir-is-npm-project-layout"
    | "same-tree"
    | "npm-project-not-newer";
};

/**
 * Quarantine the stale legacy `~/.openclaw/extensions/<plugin>` copy when the
 * managed npm-project install is canonical (#2117).
 *
 * This is the mirror of {@link removeRedundantNpmProjectTreeWhenExtensionsCanonical}.
 * When a host migrates to OpenClaw's managed npm plugin path
 * (`~/.openclaw/npm/projects/<plugin>/node_modules/<plugin>`) but the older
 * extensions copy is left behind, the gateway emits "duplicate plugin id
 * detected; global plugin will be overridden by ... npm/projects/..." and reads
 * stale metadata from the losing copy. The managed copy is the one that loads, so
 * the durable fix is to move the stale extensions copy out of the discoverable
 * path (matching the manual remediation in #2117: `mv` it into `~/.openclaw/.cache`).
 *
 * The two directions are disjoint by version: this fires ONLY when the npm-project
 * copy is STRICTLY newer than the extensions copy, whereas the extensions-canonical
 * removal fires when the npm-project copy is not strictly newer. So an upgrade/verify
 * can safely try both — at most one acts.
 *
 * Guards (all must hold, else returns `attempted: false` with a `skippedReason`):
 * - a managed npm-project tree exists and is LOADABLE (has openclaw.plugin.json +
 *   dist/index.js) with a readable version;
 * - the extensions copy exists with a readable version and is not itself an
 *   npm-project layout;
 * - the two are distinct on-disk trees;
 * - the npm-project version is strictly newer than the extensions version (never
 *   quarantine a newer/equal extensions copy — the host may still load from it).
 *
 * The stale copy is PRESERVED (moved, not deleted) under
 * `~/.openclaw/.cache/<id>.removed-duplicate-<ts>` so operators can inspect/restore
 * it; a cross-filesystem rename falls back to copy-then-remove.
 */
export function removeRedundantExtensionsTreeWhenNpmProjectCanonical(opts: {
  extensionsPluginDir: string;
  /** npm-project plugin dir (defaults to the known Maeve/Doris layout). */
  npmProjectPluginDir?: string;
  pluginId?: string;
}): QuarantineExtensionsTreeResult {
  const pluginId = opts.pluginId ?? PLUGIN_ID;
  const npmPluginDir = opts.npmProjectPluginDir ?? resolveKnownNpmProjectPluginDir();
  if (!npmPluginDir) {
    return { attempted: false, quarantined: false, skippedReason: "no-npm-project-tree" };
  }
  // The managed copy must actually be loadable — never quarantine the extensions
  // copy in favour of a half-installed / broken npm-project tree.
  const npmLoadable =
    existsSync(join(npmPluginDir, "openclaw.plugin.json")) && existsSync(join(npmPluginDir, "dist", "index.js"));
  if (!npmLoadable) {
    return { attempted: false, quarantined: false, skippedReason: "npm-project-not-loadable" };
  }
  const npmVer = readPluginPackageVersion(npmPluginDir);
  if (!npmVer) {
    return { attempted: false, quarantined: false, skippedReason: "npm-project-version-unreadable" };
  }
  if (isNpmProjectPluginLayout(opts.extensionsPluginDir)) {
    return { attempted: false, quarantined: false, skippedReason: "extensions-dir-is-npm-project-layout" };
  }
  if (!existsSync(join(opts.extensionsPluginDir, "openclaw.plugin.json"))) {
    return { attempted: false, quarantined: false, skippedReason: "extensions-not-installed" };
  }
  const extVer = readPluginPackageVersion(opts.extensionsPluginDir);
  if (!extVer) {
    return { attempted: false, quarantined: false, skippedReason: "extensions-version-unreadable" };
  }
  if (samePath(npmPluginDir, opts.extensionsPluginDir)) {
    return { attempted: false, quarantined: false, skippedReason: "same-tree" };
  }
  if (compareVersions(npmVer, extVer) <= 0) {
    // Extensions copy is newer-or-equal — leave it; the extensions-canonical path
    // (removeRedundantNpmProjectTreeWhenExtensionsCanonical) handles that direction.
    return {
      attempted: false,
      quarantined: false,
      canonicalNpmProjectDir: npmPluginDir,
      skippedReason: "npm-project-not-newer",
    };
  }
  try {
    const cacheDir = join(resolveOpenclawHomeDir(), ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(cacheDir, `${basename(opts.extensionsPluginDir)}.removed-duplicate-${stamp}`);
    try {
      renameSync(opts.extensionsPluginDir, dest);
    } catch (err) {
      // Cross-device rename (EXDEV) or similar — copy then remove so the stale copy
      // is still gone from the discoverable extensions path.
      if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
        cpSync(opts.extensionsPluginDir, dest, { recursive: true });
        rmSync(opts.extensionsPluginDir, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    return {
      attempted: true,
      quarantined: true,
      quarantinedPath: opts.extensionsPluginDir,
      destinationPath: dest,
      canonicalNpmProjectDir: npmPluginDir,
    };
  } catch (err) {
    return {
      attempted: true,
      quarantined: false,
      quarantinedPath: opts.extensionsPluginDir,
      canonicalNpmProjectDir: npmPluginDir,
      error: `Could not quarantine stale extensions copy at ${opts.extensionsPluginDir}: ${err instanceof Error ? err.message : String(err)} (plugin=${pluginId})`,
    };
  }
}

/**
 * Resolve the absolute path of the legacy install-index file. Tests can override
 * the state directory by passing `stateDir`.
 */
export function resolveLegacyInstallIndexPath(opts: { stateDir?: string } = {}): string {
  const stateDir = opts.stateDir ?? defaultOpenclawStateDir();
  return join(stateDir, LEGACY_INSTALL_INDEX_REL_PATH);
}

/**
 * Walk the JSON shape that core state migrations parse and extract the per-plugin
 * record under `installRecords[pluginId]`. Tolerates both top-level and
 * embedded (`plugins[].installRecord`) shapes — see
 * `readLegacyTopLevelInstallRecords` / `readLegacyEmbeddedInstallRecords` in
 * `state-migrations` for the formats we mirror here.
 */
function extractLegacyInstallRecord(parsed: unknown, pluginId: string): LegacyRecord | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;

  const top = root.installRecords ?? root.records;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    const rec = (top as Record<string, unknown>)[pluginId];
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      return rec as LegacyRecord;
    }
  }

  const plugins = root.plugins;
  if (Array.isArray(plugins)) {
    for (const p of plugins) {
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      const entry = p as Record<string, unknown>;
      if (entry.pluginId === pluginId && entry.installRecord && typeof entry.installRecord === "object") {
        return entry.installRecord as LegacyRecord;
      }
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeRealpath(p: string): string {
  const resolved = isAbsolute(p) ? p : pathResolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return safeRealpath(a) === safeRealpath(b);
  } catch {
    return false;
  }
}

function compareVersions(a: string, b: string): number {
  // Date-based semver-like: 2026.6.290 vs 2026.6.291. We don't parse semver — we
  // segment on '.' and compare each segment numerically; falls back to
  // lexicographic for non-numeric suffixes (e.g. "-rc.1").
  const segsA = a.split(".");
  const segsB = b.split(".");
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const sa = segsA[i] ?? "0";
    const sb = segsB[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * Compare the legacy install record for `pluginId` with the live plugin path
 * we are currently running from. The detection is intentionally conservative:
 * "safe-reconcile" only fires when the live path exists on disk AND its version
 * is >= the stale version, so we never silently downgrade metadata.
 */
export function detectStaleLegacyInstallIndexEntry(
  opts: { pluginId?: string; livePath?: string; liveVersion?: string; legacyPath?: string } = {},
): StaleLegacyInstallIndexDetection {
  const pluginId = opts.pluginId ?? PLUGIN_ID;
  const legacyPath = opts.legacyPath ?? resolveLegacyInstallIndexPath();
  const livePath = opts.livePath ?? resolveCanonicalLivePluginPathForInstallIndex(pluginId);
  const liveVersion = opts.liveVersion ?? readPluginPackageVersion(livePath);

  const detection: StaleLegacyInstallIndexDetection = {
    present: false,
    legacyPath,
    livePath,
    liveVersion,
    livePathExists: false,
    verdict: "no-conflict",
  };

  if (!existsSync(legacyPath)) {
    detection.verdict = "no-conflict";
    return detection;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf-8"));
  } catch {
    detection.verdict = "unsafe-malformed-legacy";
    detection.detail = `Could not parse legacy install-index file ${legacyPath}`;
    return detection;
  }

  const record = extractLegacyInstallRecord(parsed, pluginId);
  if (!record) {
    detection.verdict = "no-conflict";
    return detection;
  }
  detection.present = true;
  detection.staleInstallPath = asString(record.installPath);
  detection.staleVersion = asString(record.version) ?? asString(record.resolvedVersion);
  detection.staleSource = asString(record.source);

  if (!detection.staleInstallPath || !detection.staleVersion) {
    detection.verdict = "unsafe-malformed-legacy";
    detection.detail = `Legacy install-index record for ${pluginId} is missing installPath or version`;
    return detection;
  }

  // Live path must exist on disk and contain an openclaw.plugin.json manifest.
  const liveManifest = join(livePath, "openclaw.plugin.json");
  detection.livePathExists = existsSync(livePath) && existsSync(liveManifest);
  if (!detection.livePathExists) {
    detection.verdict = "unsafe-no-live-path";
    detection.detail = `Live plugin manifest is missing at ${livePath}`;
    return detection;
  }
  if (!liveVersion) {
    detection.verdict = "unsafe-malformed-legacy";
    detection.detail = `Live plugin version could not be resolved from ${livePath}`;
    return detection;
  }

  const pathsMatch = samePath(detection.staleInstallPath, livePath);
  const versionsMatch = detection.staleVersion === liveVersion;
  if (pathsMatch && versionsMatch) {
    detection.verdict = "matches-live";
    return detection;
  }

  const cmp = compareVersions(liveVersion, detection.staleVersion);
  if (cmp < 0) {
    detection.verdict = "unsafe-downgrade";
    detection.detail = `Live version ${liveVersion} is older than stale version ${detection.staleVersion}`;
    return detection;
  }

  if (pathsMatch && !versionsMatch) {
    // Path matches live; only version differs and live is >= stale. Safe to drop/update.
    detection.verdict = "safe-reconcile";
    detection.detail = `Live path matches legacy; only version differs (stale=${detection.staleVersion}, live=${liveVersion})`;
    return detection;
  }

  detection.verdict = "safe-reconcile";
  detection.detail = `Stale record points at ${detection.staleInstallPath} (${detection.staleVersion}); live is ${livePath} (${liveVersion})`;
  return detection;
}

/**
 * Atomically rewrite the legacy install-index file so it no longer conflicts
 * with the live plugin path/version. The original file is preserved as
 * `${legacyPath}.bak-<ts>`; if rewriting fails we attempt to restore it from
 * the backup so the operator's state is never silently lost.
 */
export function reconcileLegacyInstallIndex(
  opts: { detection?: StaleLegacyInstallIndexDetection; legacyPath?: string; pluginId?: string; dryRun?: boolean } = {},
): ReconcileLegacyInstallIndexResult {
  const detection = opts.detection ?? detectStaleLegacyInstallIndexEntry({ legacyPath: opts.legacyPath });
  const pluginId = opts.pluginId ?? PLUGIN_ID;

  if (detection.verdict === "no-conflict" || detection.verdict === "matches-live") {
    return { ok: true, verdict: detection.verdict, action: "noop" };
  }

  if (detection.verdict !== "safe-reconcile") {
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: detection.detail ?? "Reconciliation not safe",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(detection.legacyPath, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: `Could not parse legacy install-index file ${detection.legacyPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: `Legacy install-index file ${detection.legacyPath} is not an object`,
    };
  }

  const root = parsed as Record<string, unknown>;
  const originalSerialized = JSON.stringify(parsed);
  let action: "removed" | "updated" = "updated";
  let mutated = false;

  if (root.installRecords && typeof root.installRecords === "object" && !Array.isArray(root.installRecords)) {
    const nextRecords = { ...(root.installRecords as Record<string, unknown>) };
    if (nextRecords[pluginId]) {
      // Drop the stale entry — core will re-derive it from the live plugin
      // discovery scan on the next startup. This is the safest outcome: the
      // legacy file no longer conflicts with SQLite.
      delete nextRecords[pluginId];
      action = "removed";
      mutated = true;
    }
    root.installRecords = nextRecords;
  }

  if (root.records && typeof root.records === "object" && !Array.isArray(root.records)) {
    const records = { ...(root.records as Record<string, unknown>) };
    if (records[pluginId]) {
      delete records[pluginId];
      action = "removed";
      mutated = true;
    }
    root.records = records;
  }

  if (Array.isArray(root.plugins)) {
    const plugins = root.plugins as Array<Record<string, unknown>>;
    const nextPlugins = plugins.filter((p) => !p || typeof p !== "object" || p.pluginId !== pluginId);
    if (nextPlugins.length < plugins.length) {
      root.plugins = nextPlugins;
      action = "removed";
      mutated = true;
    }
  }

  if (!mutated) {
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: `Legacy install-index file ${detection.legacyPath} has no ${pluginId} entry to reconcile`,
    };
  }

  const nextSerialized = JSON.stringify(parsed);

  if (opts.dryRun) {
    return { ok: true, verdict: detection.verdict, action };
  }

  // Backup the original sidecar to a sibling path before mutating. Colocated with the target
  // file (not os.tmpdir()): systemd-tmpfiles-clean and similar periodic cleanup on most Linux
  // distros deletes files under /tmp untouched for >10 days, which would silently make this
  // backup disappear — undermining the "operator's state is never silently lost" guarantee this
  // function documents.
  const backupDir = join(dirname(detection.legacyPath), "openclaw-hybrid-memory-install-index-backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${basename(detection.legacyPath)}.bak-${stamp}`);
  try {
    writeFileSync(backupPath, originalSerialized, "utf-8");
  } catch (err) {
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: `Failed to write backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const tmpPath = `${detection.legacyPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, nextSerialized, "utf-8");
    renameSync(tmpPath, detection.legacyPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort */
    }
    // Restore from backup so we don't leave a half-written file. Uses the same
    // write-to-temp-then-rename pattern as the primary write above (not a plain writeFileSync):
    // if the original failure was disk exhaustion, a second non-atomic write here could itself
    // fail partway and leave the file truncated even though a full backup still exists on disk.
    try {
      atomicWriteFile(detection.legacyPath, originalSerialized);
    } catch {
      /* if restore fails the operator still has the backup at backupPath */
    }
    return {
      ok: false,
      verdict: detection.verdict,
      action: "skipped",
      error: `Failed to rewrite ${detection.legacyPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    verdict: detection.verdict,
    action,
    backupPath,
  };
}

/**
 * Build the actionable warning string used by `verify` and upgrade flows when
 * a stale legacy install-index entry is detected but cannot be auto-rewritten.
 */
export function formatStaleInstallIndexWarning(detection: StaleLegacyInstallIndexDetection): string {
  const parts: string[] = [];
  if (detection.verdict === "matches-live" || detection.verdict === "no-conflict") {
    return "";
  }
  const stalePath = detection.staleInstallPath ?? "<unknown>";
  const staleVersion = detection.staleVersion ?? "<unknown>";
  parts.push(
    `Plugin install index drift: legacy ${detection.legacyPath} still references ${PLUGIN_ID} at ${stalePath} (${staleVersion}); live is ${detection.livePath} (${detection.liveVersion ?? "<unknown>"}).`,
  );
  parts.push(
    "OpenClaw state migrations will keep emitting 'Left plugin install index in place because shared SQLite state has conflicting plugin install metadata' until reconciled.",
  );
  switch (detection.verdict) {
    case "safe-reconcile":
      parts.push(
        `Repair: run 'openclaw hybrid-mem verify --fix' or 'openclaw hybrid-mem install-index reconcile' to drop the stale entry.`,
      );
      break;
    case "unsafe-downgrade":
      parts.push(
        `Repair: the live plugin version (${detection.liveVersion}) is older than the stale version (${staleVersion}); upgrade before reconciling, or remove ${stalePath} manually and run 'openclaw hybrid-mem install-index reconcile'.`,
      );
      break;
    case "unsafe-no-live-path":
      parts.push(
        `Repair: restore the plugin at ${detection.livePath} (missing manifest) or remove the stale entry from ${detection.legacyPath} before retrying.`,
      );
      break;
    case "unsafe-malformed-legacy":
      parts.push(
        `Repair: ${detection.detail ?? "legacy record is malformed"}; inspect ${detection.legacyPath} and remove the ${PLUGIN_ID} entry before retrying.`,
      );
      break;
    default:
      parts.push(
        `Repair: inspect ${detection.legacyPath} and remove the stale ${PLUGIN_ID} entry pointing at ${stalePath} (${staleVersion}).`,
      );
      break;
  }
  return parts.join(" ");
}

/**
 * Convenience wrapper used by verify/upgrade flows. Runs detection and applies
 * reconciliation only when safe; returns the structured result plus a
 * human-readable message.
 */
export function runInstallIndexReconcileForPlugin(
  opts: {
    pluginId?: string;
    legacyPath?: string;
    livePath?: string;
    liveVersion?: string;
    dryRun?: boolean;
    log?: (msg: string) => void;
  } = {},
): {
  detection: StaleLegacyInstallIndexDetection;
  result: ReconcileLegacyInstallIndexResult;
  message: string;
} {
  const detection = detectStaleLegacyInstallIndexEntry({
    pluginId: opts.pluginId,
    legacyPath: opts.legacyPath,
    livePath: opts.livePath,
    liveVersion: opts.liveVersion,
  });
  if (detection.verdict === "no-conflict" || detection.verdict === "matches-live") {
    return { detection, result: { ok: true, verdict: detection.verdict, action: "noop" }, message: "" };
  }
  const result = reconcileLegacyInstallIndex({ detection, dryRun: opts.dryRun });
  let message = "";
  if (result.ok) {
    if (result.action === "removed") {
      message = `install-index reconcile: dropped stale ${PLUGIN_ID} entry from ${detection.legacyPath} (backup at ${result.backupPath ?? "<unknown>"}).`;
    } else if (result.action === "updated") {
      message = `install-index reconcile: updated stale ${PLUGIN_ID} entry in ${detection.legacyPath} (backup at ${result.backupPath ?? "<unknown>"}).`;
    }
  } else {
    message = formatStaleInstallIndexWarning(detection);
  }
  if (opts.log) opts.log(message);
  return { detection, result, message };
}

/**
 * Returns the relative path of the legacy install-index file under the state
 * dir. Exposed for documentation and tests.
 */
export function legacyInstallIndexRelativePath(): string {
  return LEGACY_INSTALL_INDEX_REL_PATH;
}

/**
 * Helper used by callers that want to know whether two plugin install paths
 * refer to the same on-disk location. Exported so tests can stub it.
 */
export function areInstallPathsEquivalent(a: string, b: string): boolean {
  return samePath(a, b);
}

/**
 * Helper used to compare two date-based plugin versions. Exported for tests.
 * Returns negative if `a < b`, 0 if equal, positive if `a > b`.
 */
export function comparePluginVersions(a: string, b: string): number {
  return compareVersions(a, b);
}

/**
 * Visible for tests — clears any module-level cache (currently none, but kept
 * for symmetry with `plugin-root.ts`).
 */
export function _resetInstallIndexReconcileCache(): void {
  /* no-op */
}

/** Visible for tests — exposes the internal `extractLegacyInstallRecord` parser. */
export function _extractLegacyInstallRecordForTest(parsed: unknown, pluginId: string): LegacyRecord | undefined {
  return extractLegacyInstallRecord(parsed, pluginId);
}

/** Visible for tests — exposes the internal version comparator. */
export function _isVersionAtLeast(version: string, baseline: string): boolean {
  return compareVersions(version, baseline) >= 0;
}

/** Visible for tests — exposes the internal path equivalence helper. */
export function _normalizeInstallPathForTest(p: string): string {
  return safeRealpath(p);
}
