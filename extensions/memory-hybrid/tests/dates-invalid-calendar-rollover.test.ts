import { describe, expect, it } from "vitest";
import { parseSourceDate, parseTimestamp } from "../utils/dates.js";

/**
 * Regression coverage (#2067-followup): parseTimestamp's isoDateOnly branch, parseSourceDate's
 * ISO branch, and their shared parseCompactDateDigits() helper built a UTC timestamp directly via
 * Date.UTC(year, month-1, day) with no validation that month/day are in range. Date.UTC silently
 * normalizes an out-of-range component (rolling "2026-02-30" into March, or "2026-00-10" into the
 * *previous* year) instead of returning NaN, and nothing checked for that rollover. Both functions
 * are fed LLM tool-call input (register-recall-tools.ts's `asOf` param) and CLI flags
 * (cmd-store.ts's --source-date), so a malformed-but-date-shaped string was silently accepted as a
 * different, valid-looking date instead of being rejected.
 */
describe("dates.ts rejects calendar-invalid dates instead of silently rolling over (#2067-followup)", () => {
  it("parseSourceDate rejects an out-of-range month", () => {
    expect(parseSourceDate("2026-13-05")).toBeNull();
  });

  it("parseSourceDate rejects a day that doesn't exist in the given month", () => {
    expect(parseSourceDate("2026-02-30")).toBeNull();
  });

  it("parseSourceDate rejects month 00, which would otherwise roll back into the previous year", () => {
    expect(parseSourceDate("2026-00-10")).toBeNull();
  });

  it("parseSourceDate still accepts a genuinely valid date", () => {
    const sec = parseSourceDate("2026-02-14");
    expect(sec).not.toBeNull();
    expect(new Date((sec as number) * 1000).toISOString().slice(0, 10)).toBe("2026-02-14");
  });

  it("parseTimestamp (isoDateOnly branch) rejects an out-of-range month/day the same way", () => {
    expect(parseTimestamp("2026-13-45")).toBeNull();
    expect(parseTimestamp("2026-02-30")).toBeNull();
  });

  it("parseTimestamp (compact-digit branch) no longer reinterprets an invalid calendar date as the silently-rolled-over date", () => {
    // "20261399" is calendar-invalid (month 13). Before the fix, Date.UTC(2026, 12, 99) rolled
    // this into a specific *wrong* future date (2027-04-09). The compact-date branch must no
    // longer produce that value -- it may fall through to this codebase's separate, pre-existing
    // raw-numeric-epoch-seconds interpretation for an all-digit string (a defined, different
    // behavior), but it must not silently masquerade as a rolled-over calendar date.
    const wrongRolledOverDateSec = Math.floor(Date.UTC(2027, 3, 9) / 1000);
    expect(parseTimestamp("20261399")).not.toBe(wrongRolledOverDateSec);
  });

  it("parseTimestamp (compact-digit branch) still accepts a genuinely valid date", () => {
    const sec = parseTimestamp("20260214");
    expect(sec).not.toBeNull();
    expect(new Date((sec as number) * 1000).toISOString().slice(0, 10)).toBe("2026-02-14");
  });
});
