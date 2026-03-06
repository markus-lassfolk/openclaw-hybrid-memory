/**
 * Tests for future-date decay freeze protection (#144).
 *
 * Covers:
 * - detectFutureDate: ISO dates, natural language, relative offsets, multiple dates, vague dates
 * - decayFreezeUntil set correctly on factsDb.store()
 * - decayConfidence() skips frozen facts
 * - decayConfidence() resumes after freeze expires
 * - maxFreezeDays cap
 * - No freeze for past dates
 * - Schema migration (column added correctly)
 * - Disabled config (no freeze)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFutureDate, type FutureDateProtectionConfig } from "../utils/date-detector.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Reference "today" pinned to 2026-03-05 UTC so tests are deterministic
// ---------------------------------------------------------------------------
const TODAY_UTC = Date.UTC(2026, 2, 5); // 2026-03-05T00:00:00Z
const NOW_MS = TODAY_UTC;

const ENABLED_CFG: FutureDateProtectionConfig = { enabled: true, maxFreezeDays: 365 };
const DISABLED_CFG: FutureDateProtectionConfig = { enabled: false, maxFreezeDays: 365 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysSince(epochSec: number): number {
  return (epochSec * 1000 - NOW_MS) / 86400_000;
}

// ---------------------------------------------------------------------------
// Section 1: detectFutureDate — date detection unit tests
// ---------------------------------------------------------------------------

describe("detectFutureDate — disabled config", () => {
  it("returns null when enabled: false", () => {
    const result = detectFutureDate("Deadline 2026-03-20", DISABLED_CFG, NOW_MS);
    expect(result).toBeNull();
  });
});

describe("detectFutureDate — ISO dates", () => {
  it("detects a future ISO date", () => {
    const result = detectFutureDate("Meeting on 2026-03-20", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    // 2026-03-20 is 15 days after 2026-03-05
    expect(daysSince(result!)).toBeCloseTo(15, 0);
  });

  it("ignores a past ISO date", () => {
    // 2026-03-01 is in the past relative to 2026-03-05
    const result = detectFutureDate("Meeting was 2026-03-01", ENABLED_CFG, NOW_MS);
    expect(result).toBeNull();
  });

  it("ignores today's ISO date (not future)", () => {
    const result = detectFutureDate("Today is 2026-03-05", ENABLED_CFG, NOW_MS);
    expect(result).toBeNull();
  });

  it("detects ISO date with time component", () => {
    const result = detectFutureDate("2026-03-20T14:00:00 appointment", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(15, 0);
  });
});

describe("detectFutureDate — month-name dates", () => {
  it("detects 'March 20' as future date", () => {
    const result = detectFutureDate("Reminder: March 20 meeting", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    // March 20 2026 is ~15 days ahead
    expect(daysSince(result!)).toBeCloseTo(15, 0);
  });

  it("detects 'Mar 20th' as future date", () => {
    const result = detectFutureDate("Due Mar 20th", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
  });

  it("detects '20 March' (day-month format) as future date", () => {
    const result = detectFutureDate("Deadline is 20 March", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(15, 0);
  });

  it("detects 'April 10' using next year if month already passed in year", () => {
    // Apr 10 is future from Mar 5 (same year)
    const result = detectFutureDate("April 10 deadline", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeGreaterThan(30);
  });

  it("uses next year for a month that has already passed (January)", () => {
    // January 15 is before March 5, so should use 2027-01-15
    const result = detectFutureDate("January 15 renewal", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    // 2027-01-15 is ~316 days ahead
    expect(daysSince(result!)).toBeGreaterThan(300);
  });
});

describe("detectFutureDate — 'tomorrow'", () => {
  it("detects 'tomorrow' as 1 day ahead", () => {
    const result = detectFutureDate("Remind me tomorrow", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(1, 0);
  });
});

describe("detectFutureDate — 'next <weekday>'", () => {
  // 2026-03-05 is a Thursday (weekday 4)
  it("detects 'next Tuesday' as 2 weeks from now (Thursday → at least 8 days)", () => {
    const result = detectFutureDate("Let's meet next Tuesday", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    // "next Tuesday" from Thursday: Tuesday is 5 days ahead normally, but "next" adds another 7
    expect(daysSince(result!)).toBeGreaterThan(7);
  });

  it("detects 'next Monday'", () => {
    const result = detectFutureDate("Call me next Monday", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeGreaterThan(7);
  });

  it("detects 'next Thursday' on a Thursday as 7 days (same-day consistency)", () => {
    const result = detectFutureDate("Call me next Thursday", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBe(7);
  });
});

describe("detectFutureDate — 'next week/month/year'", () => {
  it("detects 'next week' as ~7 days", () => {
    const result = detectFutureDate("Review next week", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(7, 0);
  });

  it("detects 'next month' as ~30 days", () => {
    const result = detectFutureDate("Check-in next month", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(30, 0);
  });

  it("detects 'next year' as ~365 days", () => {
    const result = detectFutureDate("Budget review next year", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(365, 0);
  });
});

describe("detectFutureDate — offset phrases", () => {
  it("detects 'in 3 days'", () => {
    const result = detectFutureDate("Expires in 3 days", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(3, 0);
  });

  it("detects 'in 2 weeks'", () => {
    const result = detectFutureDate("Follow up in 2 weeks", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(14, 0);
  });

  it("detects 'in 1 month'", () => {
    const result = detectFutureDate("Re-evaluate in 1 month", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(30, 0);
  });

  it("detects 'in 6 months'", () => {
    const result = detectFutureDate("Contract renewal in 6 months", ENABLED_CFG, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(180, 0);
  });
});

describe("detectFutureDate — multiple dates: uses the latest", () => {
  it("picks the latest of two future dates", () => {
    const result = detectFutureDate(
      "Kickoff 2026-03-10, deadline 2026-04-15",
      ENABLED_CFG,
      NOW_MS,
    );
    expect(result).not.toBeNull();
    // 2026-04-15 is ~41 days ahead; 2026-03-10 is 5 days ahead
    expect(daysSince(result!)).toBeGreaterThan(30);
  });

  it("ignores past dates when combined with future dates", () => {
    const result = detectFutureDate(
      "Last done 2025-12-01, next due 2026-05-01",
      ENABLED_CFG,
      NOW_MS,
    );
    expect(result).not.toBeNull();
    // Should pick 2026-05-01 (~57 days ahead)
    expect(daysSince(result!)).toBeGreaterThan(50);
  });
});

describe("detectFutureDate — vague dates: no freeze", () => {
  it("returns null for 'soon'", () => {
    expect(detectFutureDate("I'll do it soon", ENABLED_CFG, NOW_MS)).toBeNull();
  });

  it("returns null for 'eventually'", () => {
    expect(detectFutureDate("Will handle eventually", ENABLED_CFG, NOW_MS)).toBeNull();
  });

  it("returns null for 'someday'", () => {
    expect(detectFutureDate("Maybe someday", ENABLED_CFG, NOW_MS)).toBeNull();
  });

  it("returns null for text with no date at all", () => {
    expect(detectFutureDate("User prefers dark mode", ENABLED_CFG, NOW_MS)).toBeNull();
  });
});

describe("detectFutureDate — maxFreezeDays cap", () => {
  it("caps at maxFreezeDays when date is beyond the limit", () => {
    const cfgWith30Days: FutureDateProtectionConfig = { enabled: true, maxFreezeDays: 30 };
    // 2027-01-01 is ~300 days away
    const result = detectFutureDate("Contract ends 2027-01-01", cfgWith30Days, NOW_MS);
    expect(result).not.toBeNull();
    // Should be capped at 30 days
    expect(daysSince(result!)).toBeCloseTo(30, 0);
  });

  it("does not cap when date is within maxFreezeDays", () => {
    const cfgWith365Days: FutureDateProtectionConfig = { enabled: true, maxFreezeDays: 365 };
    const result = detectFutureDate("Deadline in 10 days", cfgWith365Days, NOW_MS);
    expect(result).not.toBeNull();
    expect(daysSince(result!)).toBeCloseTo(10, 0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: FactsDB integration tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  // Fix #6: pin Date.now() to NOW_MS so FactsDB internals (decayConfidence, pruneExpired,
  // store) use the same clock as the test assertions.
  vi.useFakeTimers({ now: NOW_MS });
  tmpDir = mkdtempSync(join(tmpdir(), "future-date-decay-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("FactsDB — decay_freeze_until column migration", () => {
  it("column exists after constructor (migration)", () => {
    // If migration didn't run, store() or getById() would throw on the column
    const entry = db.store({
      text: "Test migration",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayFreezeUntil: null,
    });
    expect(entry.id).toBeDefined();
    const retrieved = db.getById(entry.id);
    // decayFreezeUntil should be null (or undefined) when not set
    expect(retrieved?.decayFreezeUntil ?? null).toBeNull();
  });
});

describe("FactsDB — store with decayFreezeUntil", () => {
  it("persists decayFreezeUntil timestamp when provided", () => {
    const freezeUntil = Math.floor(NOW_MS / 1000) + 15 * 86400; // 15 days ahead
    const entry = db.store({
      text: "Deadline in 15 days",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayFreezeUntil: freezeUntil,
    });
    const retrieved = db.getById(entry.id);
    expect(retrieved?.decayFreezeUntil).toBe(freezeUntil);
  });

  it("stores null decayFreezeUntil by default", () => {
    const entry = db.store({
      text: "Regular fact no date",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const retrieved = db.getById(entry.id);
    expect(retrieved?.decayFreezeUntil ?? null).toBeNull();
  });
});

describe("FactsDB — store() extends expiresAt to cover freeze period (fix #1)", () => {
  it("extends expiresAt to decayFreezeUntil when freeze outlasts the TTL-based expiry", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    // session TTL = 24 hours; freeze = 30 days ahead
    const freezeUntil = nowSec + 30 * 86400;
    const entry = db.store({
      text: "Meeting in 30 days",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "session", // TTL = 24h (< 30 days)
      decayFreezeUntil: freezeUntil,
    });
    // expiresAt should be extended to at least decayFreezeUntil
    expect(entry.expiresAt).not.toBeNull();
    expect(entry.expiresAt!).toBeGreaterThanOrEqual(freezeUntil);
    const retrieved = db.getById(entry.id);
    expect(retrieved?.expiresAt).toBeGreaterThanOrEqual(freezeUntil);
  });

  it("does not shorten expiresAt when TTL-based expiry is beyond freeze", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    // stable TTL = 90 days; freeze = 10 days ahead
    const freezeUntil = nowSec + 10 * 86400;
    const entry = db.store({
      text: "Review in 10 days",
      category: "other",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "stable", // TTL = 90 days (> 10 days)
      decayFreezeUntil: freezeUntil,
    });
    // expiresAt should stay at the 90-day TTL, not be shortened to freeze
    expect(entry.expiresAt).not.toBeNull();
    expect(entry.expiresAt!).toBeGreaterThanOrEqual(nowSec + 89 * 86400);
  });
});

describe("FactsDB — decayConfidence skips frozen facts", () => {
  it("does NOT decay a fact that is frozen (decay_freeze_until > now)", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    // Set freeze 10 days ahead
    const freezeUntil = nowSec + 10 * 86400;

    // Create a fact that is close to expiry (will decay in normal operation)
    const entry = db.store({
      text: "Meeting reminder 2026-03-15",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active", // short-lived; expires in 14 days
      decayFreezeUntil: freezeUntil,
    });

    // Artificially push last_confirmed_at far back so decay would normally fire
    const rawDb = db.getRawDb();
    const expiresAt = nowSec + 2 * 86400; // expires in 2 days
    rawDb.prepare(`UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.9 WHERE id = ?`)
      .run(nowSec - 20 * 86400, expiresAt, entry.id);

    db.decayConfidence();

    const retrieved = db.getById(entry.id);
    // confidence should NOT have been halved (fact is frozen)
    expect(retrieved?.confidence).toBeCloseTo(0.9, 1);
  });

  it("DOES decay a fact that has no freeze", () => {
    const nowSec = Math.floor(NOW_MS / 1000);

    const entry = db.store({
      text: "Old task from last month",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
    });

    // Push last_confirmed_at far back and expires_at close
    const rawDb = db.getRawDb();
    const expiresAt = nowSec + 2 * 86400;
    rawDb.prepare(`UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.9 WHERE id = ?`)
      .run(nowSec - 20 * 86400, expiresAt, entry.id);

    db.decayConfidence();

    const retrieved = db.getById(entry.id);
    // confidence should be halved
    expect(retrieved?.confidence).toBeCloseTo(0.45, 1);
  });

  it("resumes decay after freeze_until passes", () => {
    const nowSec = Math.floor(NOW_MS / 1000);

    // Set freeze to 5 days AGO (expired)
    const pastFreeze = nowSec - 5 * 86400;
    const entry = db.store({
      text: "Reminder for past event",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
      decayFreezeUntil: pastFreeze,
    });

    const rawDb = db.getRawDb();
    const expiresAt = nowSec + 2 * 86400;
    rawDb.prepare(`UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.9 WHERE id = ?`)
      .run(nowSec - 20 * 86400, expiresAt, entry.id);

    db.decayConfidence();

    const retrieved = db.getById(entry.id);
    // Freeze expired, so decay should have run
    expect(retrieved?.confidence).toBeCloseTo(0.45, 1);
  });
});

describe("FactsDB — decayConfidence deletes low-confidence frozen facts that expired", () => {
  it("does not delete a frozen fact even if confidence would drop below 0.1", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const freezeUntil = nowSec + 30 * 86400;

    const entry = db.store({
      text: "Future event: April conference",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
      decayFreezeUntil: freezeUntil,
    });

    const rawDb = db.getRawDb();
    const expiresAt = nowSec + 1 * 86400;
    // Set confidence very low and last_confirmed far back
    rawDb.prepare(`UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.15 WHERE id = ?`)
      .run(nowSec - 20 * 86400, expiresAt, entry.id);

    db.decayConfidence();

    // The fact should still exist because the freeze prevented decay
    const retrieved = db.getById(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.confidence).toBeCloseTo(0.15, 2);
  });
});

describe("FactsDB — pruneExpired respects decay_freeze_until", () => {
  it("does NOT delete a frozen fact even if expires_at has passed", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const freezeUntil = nowSec + 30 * 86400;

    const entry = db.store({
      text: "Meeting reminder for next Thursday",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
      decayFreezeUntil: freezeUntil,
    });

    const rawDb = db.getRawDb();
    const expiresAt = nowSec - 1 * 86400;
    rawDb.prepare(`UPDATE facts SET expires_at = ? WHERE id = ?`)
      .run(expiresAt, entry.id);

    db.pruneExpired();

    const retrieved = db.getById(entry.id);
    expect(retrieved).not.toBeNull();
  });

  it("DOES delete a fact with expired expires_at and no freeze", () => {
    const nowSec = Math.floor(NOW_MS / 1000);

    const entry = db.store({
      text: "Old expired fact",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
    });

    const rawDb = db.getRawDb();
    const expiresAt = nowSec - 1 * 86400;
    rawDb.prepare(`UPDATE facts SET expires_at = ? WHERE id = ?`)
      .run(expiresAt, entry.id);

    db.pruneExpired();

    const retrieved = db.getById(entry.id);
    expect(retrieved).toBeNull();
  });

  it("DOES delete a fact with expired expires_at and expired freeze", () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const pastFreeze = nowSec - 5 * 86400;

    const entry = db.store({
      text: "Old fact with expired freeze",
      category: "other",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      decayClass: "active",
      decayFreezeUntil: pastFreeze,
    });

    const rawDb = db.getRawDb();
    const expiresAt = nowSec - 1 * 86400;
    rawDb.prepare(`UPDATE facts SET expires_at = ? WHERE id = ?`)
      .run(expiresAt, entry.id);

    db.pruneExpired();

    const retrieved = db.getById(entry.id);
    expect(retrieved).toBeNull();
  });
});
