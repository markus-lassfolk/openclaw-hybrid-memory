/**
 * OpenClaw version compatibility checks.
 *
 * Parses and compares version strings in YYYY.M.N format
 * to enforce minimum gateway version requirements at startup.
 */

/**
 * Minimum OpenClaw **gateway** version we warn below (CLI subcommands, `api.version`, SIGUSR1 reload).
 * Kept in sync with `package.json` `peerDependencies.openclaw`. This is a soft check (`checkOpenClawVersion` logs a warning; it does not block load).
 *
 * Pinned to the 2026.5.x line to avoid the open-ended peer range that
 * previously let npm resolve to an intermediate `openclaw` build whose
 * transitive `@duckflux/core@^0.1.0` constraint had no published versions
 * (issue #1172).
 */
export const MIN_OPENCLAW_VERSION = "2026.5.0";

/**
 * Recommended OpenClaw **gateway** version for full platform integration (Skill Workshop,
 * skills snapshot hot-reload, Dreaming tab). Soft check only — features are feature-detected
 * at runtime and degrade gracefully below this version.
 */
export const RECOMMENDED_OPENCLAW_VERSION = "2026.6.1";

/** Human-readable list of integrations gated behind {@link RECOMMENDED_OPENCLAW_VERSION}. */
export const RECOMMENDED_OPENCLAW_FEATURES =
  "Skill Workshop integration, skills snapshot hot-reload, Dreaming tab visibility";

export type OpenClawVersionLogger = {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
};

/**
 * Parses a version string into a numeric tuple.
 * Handles optional leading `v`, pre-release suffixes (e.g. `2026.3.8-beta`),
 * and build metadata. Rejects empty segments like `2026..8`.
 * Returns null if three non-negative integers cannot be found.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns true if `current` is >= `minimum`.
 * If either version is unparseable, returns true to avoid false positives.
 */
export function isVersionAtLeast(current: string, minimum: string): boolean {
  const cur = parseVersion(current);
  const min = parseVersion(minimum);
  if (!cur || !min) return true;
  for (let i = 0; i < 3; i++) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true; // equal
}

/**
 * Compare two version strings numerically.
 * Returns -1 when `a < b`, 1 when `a > b`, and 0 when equal or unparseable.
 */
export function compareVersions(a: string, b: string): number {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);
  if (!versionA || !versionB) return 0;

  for (let i = 0; i < 3; i++) {
    if (versionA[i] < versionB[i]) return -1;
    if (versionA[i] > versionB[i]) return 1;
  }

  return 0;
}

/**
 * Checks the running OpenClaw gateway version against minimum and recommended tiers.
 * Logs warnings/info only — does not hard-fail plugin load.
 *
 * @param currentVersion - The `api.version` string passed by the gateway (may be undefined)
 * @param logger - Plugin logger for emitting warnings (and optional info for the recommended tier)
 */
export function checkOpenClawVersion(currentVersion: string | undefined, logger: OpenClawVersionLogger): void {
  if (!currentVersion) {
    logger.warn(
      `memory-hybrid: WARNING — OpenClaw version is undefined (gateway likely < v${MIN_OPENCLAW_VERSION}). Minimum required is v${MIN_OPENCLAW_VERSION}; recommended is v${RECOMMENDED_OPENCLAW_VERSION}. Some features (CLI subcommands, SIGUSR1 reload) may not work.`,
    );
    return;
  }
  if (!isVersionAtLeast(currentVersion, MIN_OPENCLAW_VERSION)) {
    logger.warn(
      `memory-hybrid: WARNING — OpenClaw v${currentVersion} detected, minimum required is v${MIN_OPENCLAW_VERSION}. Some features (CLI subcommands, SIGUSR1 reload, contracts.tools) may not work. Upgrade to v${RECOMMENDED_OPENCLAW_VERSION} for ${RECOMMENDED_OPENCLAW_FEATURES}.`,
    );
    return;
  }
  if (!isVersionAtLeast(currentVersion, RECOMMENDED_OPENCLAW_VERSION)) {
    const msg =
      `memory-hybrid: OpenClaw v${currentVersion} meets the minimum (v${MIN_OPENCLAW_VERSION}) ` +
      `but is below the recommended v${RECOMMENDED_OPENCLAW_VERSION}. ` +
      `Some integrations are feature-detected and may be limited: ${RECOMMENDED_OPENCLAW_FEATURES}.`;
    if (logger.info) {
      logger.info(msg);
    } else {
      logger.warn(msg);
    }
  }
}
