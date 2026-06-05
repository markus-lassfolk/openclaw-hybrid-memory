import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { ChangeFeed } from "../services/change-feed.js";
import {
  BROADCAST_CHANGE_SESSION_KEY,
  emitDreamCycleComplete,
  emitFrustrationDetected,
  emitPersonaApplied,
  shouldNotifyChangeInChat,
  supersedeActiveDreamCycleEvents,
  supersedeActiveFrustrationEvents,
  supersedeActiveProposedEvent,
  syncProposalWithdrawnInChangeFeed,
} from "../services/change-feed-emit.js";
import { createFrustrationResetCallback, resolveChangeEventForRevert } from "../services/change-feed-revert.js";
import {
  buildChangeNoticeBlock,
  collectPendingChangeEvents,
  trimEventsToBudget,
} from "../lifecycle/stage-change-notify.js";
import { createSessionState } from "../lifecycle/session-state.js";
import type { HybridMemoryConfig } from "../config.js";

function makeCfg(overrides?: Partial<HybridMemoryConfig["liveChangeFeed"]>): HybridMemoryConfig {
  return {
    liveChangeFeed: {
      enabled: true,
      retentionDays: 90,
      notifyInChat: true,
      notifyOn: {
        sessionAdaptation: true,
        proposalCreated: true,
        proposalApplied: true,
        proposalReverted: true,
        dreamCycleComplete: false,
      },
      maxInChatEventsPerTurn: 5,
      inChatBudgetTokens: 150,
      ...overrides,
    },
  } as HybridMemoryConfig;
}

describe("ChangeFeed", () => {
  it("appends events with per-session ordinals", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);

    const e1 = feed.append({
      sessionKey: "sess-a",
      timestamp: Date.now(),
      tier: "session",
      category: "frustration",
      action: "detected",
      title: "Frustration detected",
      detail: "test",
      proposalKey: null,
      rollbackAvailable: true,
      activation: "immediate",
    });
    const e2 = feed.append({
      sessionKey: "sess-a",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Proposal",
      detail: "test",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });

    expect(e1.ordinal).toBe(1);
    expect(e2.ordinal).toBe(2);
    expect(feed.getByOrdinal("sess-a", 2)?.title).toBe("Proposal");
  });

  it("lists events after ordinal without skipping same-timestamp rows", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const ts = Date.now();
    feed.append({
      sessionKey: "s1",
      timestamp: ts,
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "First",
      detail: "",
      proposalKey: "persona:a",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    feed.append({
      sessionKey: "s1",
      timestamp: ts,
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Second",
      detail: "",
      proposalKey: "persona:b",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    const afterFirst = feed.listRecent({ sessionKey: "s1", sinceOrdinal: 1, limit: 10 });
    expect(afterFirst.map((e) => e.title)).toEqual(["Second"]);
  });

  it("finds active applied events by proposal key across sessions", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    feed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Applied",
      detail: "",
      proposalKey: "persona:cross",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    expect(feed.findActiveByProposalKey("persona:cross", "applied")?.sessionKey).toBe(BROADCAST_CHANGE_SESSION_KEY);
  });

  it("marks events reverted and lists since timestamp", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const t0 = Date.now() - 1000;
    const event = feed.append({
      sessionKey: "s1",
      timestamp: t0,
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Applied",
      detail: "",
      proposalKey: "persona:x",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    feed.markReverted(event.id);
    const listed = feed.listRecent({ sessionKey: "s1", since: t0 - 1 });
    expect(listed[0]?.status).toBe("reverted");
  });
});

describe("shouldNotifyChangeInChat", () => {
  it("respects notifyOn flags", () => {
    const cfg = makeCfg({ notifyOn: { ...makeCfg().liveChangeFeed.notifyOn, proposalCreated: false } });
    expect(shouldNotifyChangeInChat(cfg, { tier: "persistent", action: "proposed", category: "persona" })).toBe(false);
    expect(shouldNotifyChangeInChat(cfg, { tier: "persistent", action: "applied", category: "persona" })).toBe(true);
  });

  it("does not notify unknown action types by default", () => {
    const cfg = makeCfg();
    expect(shouldNotifyChangeInChat(cfg, { tier: "persistent", action: "rejected", category: "persona" })).toBe(false);
  });
});

describe("buildChangeNoticeBlock", () => {
  it("includes display ordinals and system/session scope labels", () => {
    const block = buildChangeNoticeBlock([
      {
        id: "1",
        ordinal: 3,
        sessionKey: "s",
        timestamp: Date.now(),
        tier: "session",
        category: "frustration",
        action: "detected",
        title: "Frustration detected (0.62/rising)",
        detail: "",
        proposalKey: null,
        rollbackAvailable: true,
        status: "active",
        activation: "immediate",
      },
      {
        id: "2",
        ordinal: 1,
        sessionKey: BROADCAST_CHANGE_SESSION_KEY,
        timestamp: Date.now(),
        tier: "persistent",
        category: "persona",
        action: "proposed",
        title: "Dream-cycle proposal",
        detail: "",
        proposalKey: "persona:x",
        rollbackAvailable: true,
        status: "active",
        activation: "next-reload",
      },
    ]);
    expect(block).toContain("<memory-change-notice>");
    expect(block).toContain("#1 [session/session]");
    expect(block).toContain("#2 [system/persistent]");
    expect(block).toContain("revert change 1");
    expect(block).toContain("revert change 2");
  });
});

describe("createFrustrationResetCallback", () => {
  it("clears frustration state for a session", () => {
    const sessionState = createSessionState();
    sessionState.frustrationStateMap.set("chat-1", { level: 0.8, turns: [{ role: "user", content: "ugh" }] });
    sessionState.frustrationThresholdBandMap.set("chat-1", "high");
    const reset = createFrustrationResetCallback(sessionState, "chat-1");
    reset?.();
    expect(sessionState.frustrationStateMap.get("chat-1")).toEqual({ level: 0, turns: [] });
    expect(sessionState.frustrationThresholdBandMap.get("chat-1")).toBe("none");
  });
});

describe("BROADCAST_CHANGE_SESSION_KEY", () => {
  it("is stable for cross-session notifications", () => {
    expect(BROADCAST_CHANGE_SESSION_KEY).toBe("__broadcast__");
  });
});

describe("resolveChangeEventForRevert", () => {
  it("resolves broadcast events via display map when session ordinals collide", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    feed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "session",
      category: "frustration",
      action: "detected",
      title: "Session change",
      detail: "",
      proposalKey: null,
      rollbackAvailable: true,
      activation: "immediate",
    });
    const broadcast = feed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Broadcast proposal",
      detail: "",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    const displayMap = new Map<number, string>([[2, broadcast.id]]);
    const resolved = resolveChangeEventForRevert(feed, 2, "chat-1", displayMap);
    expect(resolved?.id).toBe(broadcast.id);
    expect(resolveChangeEventForRevert(feed, 1, "chat-1", displayMap)?.title).toBe("Session change");
  });

  it("does not fall back to storage ordinal when display slot is consumed", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const sessionEvent = feed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "session",
      category: "frustration",
      action: "detected",
      title: "Session change",
      detail: "",
      proposalKey: null,
      rollbackAvailable: true,
      activation: "immediate",
    });
    feed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Different event",
      detail: "",
      proposalKey: "persona:other",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    feed.markReverted(sessionEvent.id);
    const displayMap = new Map<number, string>([[1, sessionEvent.id]]);
    expect(resolveChangeEventForRevert(feed, 1, "chat-1", displayMap)).toBeNull();
    expect(resolveChangeEventForRevert(feed, 1, "chat-1", null)).toBeNull();
    expect(resolveChangeEventForRevert(feed, 2, "chat-1", null)?.title).toBe("Different event");
  });
});

describe("proposal lifecycle sync", () => {
  it("supersedes active proposed events after apply", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    const proposed = feed.append({
      sessionKey: "s1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Proposed persona",
      detail: "",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    feed.append({
      sessionKey: "s1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "applied",
      title: "Applied persona",
      detail: "",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    supersedeActiveProposedEvent(feed, "persona:abc");
    expect(feed.getById(proposed.id)?.status).toBe("superseded");
  });

  it("syncs workshop reject into change feed", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    const proposed = feed.append({
      sessionKey: "s1",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Pending",
      detail: "",
      proposalKey: "persona:xyz",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    syncProposalWithdrawnInChangeFeed(feed, cfg, "persona:xyz", "Rejected via workshop");
    expect(feed.getById(proposed.id)?.status).toBe("reverted");
    const recent = feed.listRecent({ sessionKey: "s1" });
    expect(recent.some((e) => e.action === "reverted")).toBe(true);
  });
});

describe("emitDreamCycleComplete", () => {
  it("emits broadcast dream-cycle event", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg({ notifyOn: { ...makeCfg().liveChangeFeed.notifyOn, dreamCycleComplete: true } });
    const event = emitDreamCycleComplete(feed, cfg, {
      success: true,
      digestSummary: "Pruned 3 facts",
      personaProposalsCreated: 2,
    });
    expect(event?.sessionKey).toBe(BROADCAST_CHANGE_SESSION_KEY);
    expect(event?.category).toBe("dream-cycle");
    expect(shouldNotifyChangeInChat(cfg, event!)).toBe(true);
  });
});

describe("frustration change events", () => {
  it("supersedes prior active frustration detections on escalation", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    const first = emitFrustrationDetected(feed, cfg, {
      sessionKey: "chat-1",
      level: 0.4,
      trend: "rising",
      adaptationAction: "slow_down",
      adaptationReasoning: "User seems rushed",
    });
    const second = emitFrustrationDetected(feed, cfg, {
      sessionKey: "chat-1",
      level: 0.7,
      trend: "rising",
      adaptationAction: "simplify",
      adaptationReasoning: "High frustration",
    });
    expect(feed.getById(first!.id)?.status).toBe("superseded");
    expect(second?.status).toBe("active");
    expect(
      feed.listRecent({ sessionKey: "chat-1", status: "active" }).filter((e) => e.category === "frustration"),
    ).toHaveLength(1);
  });

  it("supersedeActiveFrustrationEvents can keep one event active", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    const keep = emitFrustrationDetected(feed, cfg, {
      sessionKey: "chat-1",
      level: 0.5,
      trend: "flat",
      adaptationAction: "none",
      adaptationReasoning: "Monitor",
    });
    feed.append({
      sessionKey: "chat-1",
      timestamp: Date.now(),
      tier: "session",
      category: "frustration",
      action: "detected",
      title: "Legacy duplicate",
      detail: "",
      proposalKey: null,
      rollbackAvailable: true,
      activation: "immediate",
    });
    supersedeActiveFrustrationEvents(feed, "chat-1", keep!.id);
    expect(feed.getById(keep!.id)?.status).toBe("active");
    expect(feed.listRecent({ sessionKey: "chat-1", status: "active", limit: 10 })).toHaveLength(1);
  });
});

describe("collectPendingChangeEvents", () => {
  it("advances past muted events without blocking notifiable ones", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg({ notifyOn: { ...makeCfg().liveChangeFeed.notifyOn, dreamCycleComplete: false } });
    feed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "dream-cycle",
      action: "detected",
      title: "Muted dream cycle",
      detail: "",
      proposalKey: null,
      rollbackAvailable: false,
      activation: "next-turn",
    });
    feed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now() + 1,
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Visible proposal",
      detail: "",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    const batch = collectPendingChangeEvents(feed, cfg, BROADCAST_CHANGE_SESSION_KEY, 0);
    expect(batch.notifiable).toHaveLength(1);
    expect(batch.notifiable[0]?.title).toBe("Visible proposal");
    expect(batch.maxSeenOrdinal).toBe(2);
  });

  it("lets each chat session track broadcast ordinals independently", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    feed.append({
      sessionKey: BROADCAST_CHANGE_SESSION_KEY,
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: "Broadcast proposal",
      detail: "",
      proposalKey: "persona:abc",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    const sessionAState = { lastNotifiedOrdinal: 0, lastNotifiedBroadcastOrdinal: 0 };
    const sessionBState = { lastNotifiedOrdinal: 0, lastNotifiedBroadcastOrdinal: 0 };
    const firstForA = collectPendingChangeEvents(
      feed,
      cfg,
      BROADCAST_CHANGE_SESSION_KEY,
      sessionAState.lastNotifiedBroadcastOrdinal,
    );
    expect(firstForA.notifiable).toHaveLength(1);
    sessionAState.lastNotifiedBroadcastOrdinal = firstForA.maxSeenOrdinal;
    const firstForB = collectPendingChangeEvents(
      feed,
      cfg,
      BROADCAST_CHANGE_SESSION_KEY,
      sessionBState.lastNotifiedBroadcastOrdinal,
    );
    expect(firstForB.notifiable).toHaveLength(1);
    expect(firstForB.notifiable[0]?.title).toBe("Broadcast proposal");
  });

  it("truncates a single oversized event to fit the token budget", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const longTitle = "Very long system change title ".repeat(20);
    const ev = feed.append({
      sessionKey: "sess-a",
      timestamp: Date.now(),
      tier: "persistent",
      category: "persona",
      action: "proposed",
      title: longTitle,
      detail: "",
      proposalKey: "persona:long",
      rollbackAvailable: true,
      activation: "next-reload",
    });
    const trimmed = trimEventsToBudget([ev], 5, 40);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]!.title.length).toBeLessThan(longTitle.length);
    const block = buildChangeNoticeBlock(trimmed);
    expect(block).not.toContain(longTitle);
  });
});

describe("ChangeFeed concurrent append", () => {
  it("assigns unique ordinals under parallel worker appends", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "change-feed-race-"));
    const dbPath = join(tmpDir, "facts.db");
    const db = new DatabaseSync(dbPath);
    const feed = ChangeFeed.fromDb(db);
    feed.migrate();
    db.close();

    const sessionKey = "race-session";
    const workerCount = 12;
    const ordinals = await Promise.all(
      Array.from(
        { length: workerCount },
        () =>
          new Promise<number>((resolve, reject) => {
            const worker = new Worker(
              `
              const { parentPort, workerData } = require('node:worker_threads');
              const { DatabaseSync } = require('node:sqlite');
              const { randomUUID } = require('node:crypto');
              const db = new DatabaseSync(workerData.dbPath);
              db.exec('PRAGMA busy_timeout = 5000');
              const sessionKey = workerData.sessionKey;
              db.exec('BEGIN IMMEDIATE');
              try {
                const maxRow = db
                  .prepare('SELECT MAX(ordinal) AS maxOrd FROM change_events WHERE session_key = ?')
                  .get(sessionKey);
                const ordinal = (maxRow?.maxOrd ?? 0) + 1;
                db.prepare(
                  \`INSERT INTO change_events (
                    id, session_key, ordinal, timestamp_ms, tier, category, action,
                    title, detail, proposal_key, rollback_available, activation, status
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
                ).run(
                  randomUUID(),
                  sessionKey,
                  ordinal,
                  Date.now(),
                  'session',
                  'persona',
                  'detected',
                  'race',
                  '',
                  null,
                  0,
                  'immediate',
                  'active',
                );
                db.exec('COMMIT');
                db.close();
                parentPort.postMessage({ ordinal });
              } catch (err) {
                try { db.exec('ROLLBACK'); } catch {}
                try { db.close(); } catch {}
                parentPort.postMessage({ error: String(err) });
              }
            `,
              { eval: true, workerData: { dbPath, sessionKey } },
            );
            worker.on("message", (msg: { ordinal?: number; error?: string }) => {
              worker.terminate().catch(() => {});
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.ordinal!);
            });
            worker.on("error", reject);
          }),
      ),
    );

    expect(new Set(ordinals).size).toBe(workerCount);
    expect(ordinals.sort((a, b) => a - b)).toEqual(Array.from({ length: workerCount }, (_, i) => i + 1));

    const verifyDb = new DatabaseSync(dbPath);
    const rows = verifyDb
      .prepare("SELECT ordinal FROM change_events WHERE session_key = ? ORDER BY ordinal")
      .all(sessionKey) as Array<{ ordinal: number }>;
    verifyDb.close();
    expect(rows).toHaveLength(workerCount);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("assigns unique ordinals for rapid sequential appends", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const sessionKey = "rapid-session";
    const count = 50;
    const ordinals: number[] = [];

    for (let i = 0; i < count; i++) {
      ordinals.push(
        feed.append({
          sessionKey,
          timestamp: Date.now(),
          tier: "session",
          category: "frustration",
          action: "detected",
          title: `Event ${i}`,
          detail: "",
          proposalKey: null,
          rollbackAvailable: false,
          activation: "immediate",
        }).ordinal,
      );
    }

    expect(new Set(ordinals).size).toBe(count);
    expect(Math.max(...ordinals)).toBe(count);
  });
});

describe("applied and dream-cycle dedupe", () => {
  it("supersedes prior applied events for the same proposal key", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg();
    const first = emitPersonaApplied(feed, cfg, {
      sessionKey: "s1",
      proposalId: "abc",
      targetFile: "SOUL.md",
      rollbackAvailable: true,
    });
    const second = emitPersonaApplied(feed, cfg, {
      sessionKey: "s1",
      proposalId: "abc",
      targetFile: "SOUL.md",
      rollbackAvailable: true,
    });
    expect(feed.getById(first!.id)?.status).toBe("superseded");
    expect(feed.getById(second!.id)?.status).toBe("active");
  });

  it("supersedes prior dream-cycle completion notices", () => {
    const db = new DatabaseSync(":memory:");
    const feed = ChangeFeed.fromDb(db);
    const cfg = makeCfg({ notifyOn: { ...makeCfg().liveChangeFeed.notifyOn, dreamCycleComplete: true } });
    const first = emitDreamCycleComplete(feed, cfg, { success: true, digestSummary: "Night 1" });
    const second = emitDreamCycleComplete(feed, cfg, { success: true, digestSummary: "Night 2" });
    expect(feed.getById(first!.id)?.status).toBe("superseded");
    expect(feed.getById(second!.id)?.status).toBe("active");
  });
});
