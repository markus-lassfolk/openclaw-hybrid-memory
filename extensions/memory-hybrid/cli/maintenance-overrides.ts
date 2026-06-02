/**
 * Shared maintenance CLI override flags (issue: standardize --force / --full).
 *
 * Goal: one operator-facing contract for cron/QA reruns and manual catch-up.
 * Commands that support scan cooldowns and/or watermarks should register these options
 * via {@link registerScanMaintenanceOverrideOptions} and resolve with
 * {@link resolveScanMaintenanceOverrides}.
 */

/** Parsed override flags from Commander (both flags are accepted during migration). */
export type ScanMaintenanceOverrideInput = {
  force?: boolean;
  full?: boolean;
};

/** Normalized overrides for scan-style maintenance commands. */
export type ScanMaintenanceOverrides = {
  /** Skip acquireScanSlot (23h cooldown and in-process concurrency lock for this scan type). */
  bypassScanCooldown: boolean;
  /** Bypass incremental scan_cursors watermark (full re-scan within the command window). */
  bypassWatermark: boolean;
};

/**
 * `--full` is the legacy name for watermark + cooldown bypass on extraction commands.
 * `--force` is the preferred umbrella flag (same effect for scan commands).
 */
export function resolveScanMaintenanceOverrides(
  opts?: ScanMaintenanceOverrideInput | null,
): ScanMaintenanceOverrides {
  const forced = opts?.force === true || opts?.full === true;
  return {
    bypassScanCooldown: forced,
    bypassWatermark: forced,
  };
}

/** Register consistent --force / --full options on scan-style maintenance commands. */
export function registerScanMaintenanceOverrideOptions<
  T extends { option(flags: string, desc?: string, defaultValue?: unknown): T },
>(cmd: T): T {
  return cmd
    .option(
      "--force",
      "Bypass maintenance guards for this run (23h scan cooldown and incremental watermark)",
    )
    .option("--full", "Alias for --force on scan commands (legacy; prefer --force)");
}

/** Pass-through for runners that still accept `full` / `force` boolean opts. */
export function scanMaintenanceOverridePayload(opts?: ScanMaintenanceOverrideInput | null): {
  force: boolean;
  full: boolean;
} {
  const forced = opts?.force === true || opts?.full === true;
  return { force: forced, full: forced };
}
