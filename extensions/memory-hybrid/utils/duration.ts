/**
 * Duration string parser for human-friendly time thresholds.
 *
 * Converts strings like "1d12h30m", "2h", "45m" to total minutes.
 * Used for active task stale detection and other configurable time windows.
 */

/**
 * Parse a human-friendly duration string into total minutes.
 *
 * Supported components (combined in d → h → m order):
 * - `d` — days   (1d = 1440 min)
 * - `h` — hours  (1h = 60 min)
 * - `m` — minutes
 *
 * Examples:
 * ```
 * parseDuration("30m")      // → 30
 * parseDuration("2h")       // → 120
 * parseDuration("1d")       // → 1440
 * parseDuration("1d12h")    // → 2160
 * parseDuration("1d12h30m") // → 2190
 * parseDuration("1440")     // → 1440  (plain number = minutes, backward compat)
 * ```
 *
 * @param input Duration string or plain integer string (treated as minutes).
 * @returns Total number of minutes (always > 0).
 * @throws {Error} If input is empty, unrecognised, or resolves to zero/negative minutes.
 */
export function parseDuration(input: string): number {
  const trimmed = (input ?? "").trim().toLowerCase();

  if (!trimmed) {
    throw new Error(
      "parseDuration: empty input. Expected a duration like \"1d12h30m\", \"2h\", \"45m\", or a plain number (minutes).",
    );
  }

  // Plain integer: treat as minutes (backward compat for staleHours migration)
  if (/^\d+$/.test(trimmed)) {
    const minutes = parseInt(trimmed, 10);
    if (minutes <= 0) {
      throw new Error(
        `parseDuration: duration must be > 0 minutes (got "${input}").`,
      );
    }
    return minutes;
  }

  // Duration string: optional d / h / m components in strict d→h→m order.
  // Regex: at least one component must be present; each component is \d+<unit>.
  const durationRegex = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/;
  const match = durationRegex.exec(trimmed);

  if (!match) {
    throw new Error(
      `parseDuration: unrecognised duration "${input}". ` +
      `Expected format like "1d12h30m", "2h", "45m", "1d", or a plain number (minutes). ` +
      `Components must appear in d→h→m order.`,
    );
  }

  const [, daysStr, hoursStr, minutesStr] = match;

  // The regex matches the empty string too — reject that case explicitly.
  if (!daysStr && !hoursStr && !minutesStr) {
    throw new Error(
      `parseDuration: unrecognised duration "${input}". ` +
      `Expected at least one component: d (days), h (hours), or m (minutes).`,
    );
  }

  const totalMinutes =
    (daysStr ? parseInt(daysStr, 10) * 1440 : 0) +
    (hoursStr ? parseInt(hoursStr, 10) * 60 : 0) +
    (minutesStr ? parseInt(minutesStr, 10) : 0);

  if (totalMinutes <= 0) {
    throw new Error(
      `parseDuration: duration must be > 0 minutes (got "${input}").`,
    );
  }

  return totalMinutes;
}

/**
 * Format a minute count back to a compact human-friendly string.
 * Used in warning messages so we show "24h" not "1440min".
 *
 * Examples:
 * ```
 * formatDuration(30)   // "30m"
 * formatDuration(60)   // "1h"
 * formatDuration(90)   // "1h30m"
 * formatDuration(1440) // "1d"
 * formatDuration(1500) // "1d1h"
 * formatDuration(2190) // "1d12h30m"
 * ```
 */
export function formatDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return "0m";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join("") || "0m";
}
