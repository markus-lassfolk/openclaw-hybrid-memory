/**
 * Dynamic Salience Scoring tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeDynamicSalience } from "../utils/salience.js";
import type { MemoryEntry } from "../types/memory.js";
import { SECONDS_PER_DAY } from "../utils/constants.js";

describe("computeDynamicSalience", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const baseEntry: MemoryEntry = {
    id: "test-id",
    text: "test",
    category: "other",
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: nowSec - 7 * SECONDS_PER_DAY,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: nowSec - 7 * SECONDS_PER_DAY,
    confidence: 1,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns base score when no access boost and no decay", () => {
    const entry = { ...baseEntry, recallCount: 0, lastAccessed: null };
    const s = computeDynamicSalience(0.8, entry, { accessBoost: false, timeDecay: false });
    expect(s).toBe(0.8);
  });

  it("boosts score for high recall count", () => {
    const low = computeDynamicSalience(0.5, { ...baseEntry, recallCount: 0 });
    const high = computeDynamicSalience(0.5, { ...baseEntry, recallCount: 100 });
    expect(high).toBeGreaterThan(low);
  });

  it("applies time decay for old last_accessed", () => {
    const recent = computeDynamicSalience(0.8, {
      ...baseEntry,
      recallCount: 0,
      lastAccessed: nowSec - 1 * SECONDS_PER_DAY,
    });
    const old = computeDynamicSalience(0.8, {
      ...baseEntry,
      recallCount: 0,
      lastAccessed: nowSec - 60 * SECONDS_PER_DAY,
    });
    expect(recent).toBeGreaterThan(old);
  });

  it("uses lastConfirmedAt when lastAccessed is null", () => {
    const entry = {
      ...baseEntry,
      recallCount: 0,
      lastAccessed: null,
      lastConfirmedAt: nowSec - 90 * SECONDS_PER_DAY,
    };
    const s = computeDynamicSalience(0.8, entry);
    expect(s).toBeLessThan(0.8);
  });

  it("clamps result to [0, 1]", () => {
    const high = computeDynamicSalience(1, {
      ...baseEntry,
      recallCount: 9999,
      lastAccessed: nowSec,
    });
    expect(high).toBeLessThanOrEqual(1);
  });
});
