/**
 * GitHub lifecycle adapter — Phase 2 (Issue #1196).
 *
 * Drives `syncLifecycleFromGitHub` against a recorded `gh api` fixture so we can verify the
 * end-to-end behaviour (entity scan → REST lookup → action resolution → fact mutation) without
 * a real network round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseGitHubEntity,
  resolveActionForItem,
  syncLifecycleFromGitHub,
} from "../services/lifecycle/github-adapter.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

const FIXTURE: Record<string, unknown> = {
  "repos/openclaw/clawdbot/pulls/123": {
    number: 123,
    state: "closed",
    merged: true,
    merged_at: "2026-04-12T10:00:00Z",
    closed_at: "2026-04-12T10:00:00Z",
  },
  "repos/openclaw/clawdbot/issues/456": {
    number: 456,
    state: "closed",
    closed_at: "2026-04-13T09:00:00Z",
  },
  "repos/openclaw/clawdbot/issues/789": {
    number: 789,
    state: "open",
    closed_at: null,
  },
};

describe("parseGitHubEntity", () => {
  it("extracts PR references", () => {
    expect(parseGitHubEntity("PR #123")).toEqual({ kind: "pr", number: 123 });
    expect(parseGitHubEntity("Pull Request #99")).toEqual({ kind: "pr", number: 99 });
  });
  it("extracts Issue references", () => {
    expect(parseGitHubEntity("Issue #456")).toEqual({ kind: "issue", number: 456 });
  });
  it("returns null for non-matching strings", () => {
    expect(parseGitHubEntity("just a fact")).toBeNull();
    expect(parseGitHubEntity(null)).toBeNull();
    expect(parseGitHubEntity("")).toBeNull();
  });
});

describe("resolveActionForItem", () => {
  it("merged PR → onMerged (default expire-soon)", () => {
    expect(
      resolveActionForItem(
        { kind: "pr", number: 1, state: "closed", merged: true, mergedAt: "x", closedAt: "x" },
        { enabled: true },
      ),
    ).toBe("expire-soon");
  });
  it("closed (not merged) → onClosed (default expire-now)", () => {
    expect(
      resolveActionForItem(
        { kind: "issue", number: 2, state: "closed", merged: false, closedAt: "x" },
        { enabled: true },
      ),
    ).toBe("expire-now");
  });
  it("open → onOpen (default keep-stable)", () => {
    expect(resolveActionForItem({ kind: "issue", number: 3, state: "open" }, { enabled: true })).toBe("keep-stable");
  });
  it("respects config overrides", () => {
    expect(
      resolveActionForItem(
        { kind: "pr", number: 1, state: "closed", merged: true },
        { enabled: true, onMerged: "expire-now", onClosed: "keep-stable", onOpen: "expire-soon" },
      ),
    ).toBe("expire-now");
  });
});

describe("syncLifecycleFromGitHub", () => {
  let db: InstanceType<typeof FactsDB>;
  beforeEach(() => {
    db = new FactsDB(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("throws when adapter is disabled", async () => {
    await expect(
      syncLifecycleFromGitHub(db as never, { config: { enabled: false }, gh: async () => null }),
    ).rejects.toThrow(/disabled/);
  });

  it("expires merged PR to ~7 days, closed issue to now, keeps open issue stable", async () => {
    const merged = db.store({
      text: "PR fact about #123",
      category: "fact",
      importance: 0.5,
      entity: "PR #123",
      key: null,
      value: null,
      source: "test",
    });
    const closed = db.store({
      text: "Issue fact about #456",
      category: "fact",
      importance: 0.5,
      entity: "Issue #456",
      key: null,
      value: null,
      source: "test",
    });
    const open = db.store({
      text: "Issue fact about #789",
      category: "fact",
      importance: 0.5,
      entity: "Issue #789",
      key: null,
      value: null,
      source: "test",
    });

    const calls: string[] = [];
    const gh = async (path: string): Promise<unknown> => {
      calls.push(path);
      const data = FIXTURE[path];
      if (!data) throw new Error(`unexpected gh api ${path}`);
      return data;
    };

    const report = await syncLifecycleFromGitHub(db as never, {
      config: { enabled: true, repos: ["openclaw/clawdbot"] },
      gh,
    });

    expect(report.ok).toBe(true);
    expect(report.scanned).toBe(3);
    expect(report.matched).toBe(3);
    expect(report.expiredSoon).toBe(1);
    expect(report.expiredNow).toBe(1);
    expect(report.keptStable).toBe(1);
    expect(calls).toEqual([
      "repos/openclaw/clawdbot/pulls/123",
      "repos/openclaw/clawdbot/issues/456",
      "repos/openclaw/clawdbot/issues/789",
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const mergedRow = db.getById(merged.id)!;
    const closedRow = db.getById(closed.id)!;
    const openRow = db.getById(open.id)!;

    expect(mergedRow.expiresAt).toBeDefined();
    if (mergedRow.expiresAt != null) {
      expect(mergedRow.expiresAt).toBeGreaterThan(nowSec + 6 * 86400);
      expect(mergedRow.expiresAt).toBeLessThan(nowSec + 8 * 86400);
    }
    expect(mergedRow.decayClass).toBe("normal");
    expect(closedRow.expiresAt).toBeDefined();
    if (closedRow.expiresAt != null) {
      expect(Math.abs(closedRow.expiresAt - nowSec)).toBeLessThan(60);
    }
    expect(closedRow.decayClass).toBe("short");
    expect(openRow.decayClass).not.toBe("short");
  });

  it("dry-run leaves expires_at untouched", async () => {
    const fact = db.store({
      text: "PR dry-run fact",
      category: "fact",
      importance: 0.5,
      entity: "PR #123",
      key: null,
      value: null,
      source: "test",
    });
    const before = db.getById(fact.id)!;
    const beforeExpires = before.expiresAt ?? null;
    const beforeDecay = before.decayClass;

    const gh = async (path: string): Promise<unknown> => FIXTURE[path] ?? null;
    const report = await syncLifecycleFromGitHub(db as never, {
      config: { enabled: true, repos: ["openclaw/clawdbot"] },
      gh,
      apply: false,
    });
    expect(report.matched).toBe(1);
    expect(report.expiredSoon).toBe(1);

    const after = db.getById(fact.id)!;
    expect(after.expiresAt ?? null).toBe(beforeExpires);
    expect(after.decayClass).toBe(beforeDecay);
  });
});
