/**
 * OpenClaw version compatibility checks.
 *
 * Parses and compares version strings in YYYY.M.N format
 * to enforce minimum gateway version requirements at startup.
 */

/** Minimum OpenClaw version required for full feature support (CLI subcommands, SIGUSR1 reload). */
export const MIN_OPENCLAW_VERSION = "2026.3.8";

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
 * Checks the running OpenClaw gateway version against the minimum requirement.
 * Logs a clear warning if the version is below the minimum — does not hard-fail.
 *
 * @param currentVersion - The `api.version` string passed by the gateway (may be undefined)
 * @param logger - Plugin logger for emitting the warning
 */
export function checkOpenClawVersion(
  currentVersion: string | undefined,
  logger: { warn: (msg: string) => void },
): void {
  if (!currentVersion) {
    logger.warn(
      `memory-hybrid: WARNING — OpenClaw version is undefined (gateway likely < v${MIN_OPENCLAW_VERSION}). Minimum recommended is v${MIN_OPENCLAW_VERSION}. Some features (CLI subcommands, SIGUSR1 reload) may not work.`,
    );
    return;
  }
  if (!isVersionAtLeast(currentVersion, MIN_OPENCLAW_VERSION)) {
    logger.warn(
      `memory-hybrid: WARNING — OpenClaw v${currentVersion} detected, minimum recommended is v${MIN_OPENCLAW_VERSION}. Some features (CLI subcommands, SIGUSR1 reload) may not work.`,
    );
  }
}
