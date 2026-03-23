import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventLog } from "../backends/event-log.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../services/narrative-recall.js";

describe("recallNarrativeSummaries", () => {
  let dir: string;
  let narrativesDb: NarrativesDB;
  let eventLog: EventLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "narrative-recall-"));
    narrativesDb = new NarrativesDB(join(dir, "narratives.db"));
    eventLog = new EventLog(join(dir, "event-log.db"));
  });

  afterEach(() => {
    vi.useRealTimers();
    narrativesDb.close();
    eventLog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a query-matching narrative over a newer unrelated one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));

    narrativesDb.store({
      sessionId: "deploy-session",
      periodStart: 1_774_224_000,
      periodEnd: 1_774_224_600,
      tag: "session",
      narrativeText: "Yesterday you debugged the deploy pipeline, retried npm test, and decided to patch CI next.",
    });
    narrativesDb.store({
      sessionId: "gardening-session",
      periodStart: 1_774_310_400,
      periodEnd: 1_774_311_000,
      tag: "session",
      narrativeText: "You planned garden watering and discussed tomatoes.",
    });

    const rows = recallNarrativeSummaries({
      narrativesDb,
      query: "deploy pipeline ci",
      limit: 1,
      nowSec: Math.floor(Date.parse("2026-03-23T12:00:00.000Z") / 1000),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("deploy-session");
  });

  it("falls back to event-log timelines when no narratives exist", () => {
    eventLog.append({
      sessionId: "s-events",
      timestamp: "2026-03-22T10:00:00.000Z",
      eventType: "action_taken",
      content: { action: "run npm test" },
    });
    eventLog.append({
      sessionId: "s-events",
      timestamp: "2026-03-22T10:05:00.000Z",
      eventType: "decision_made",
      content: { decision: "fix the flaky queue worker" },
    });

    const rows = recallNarrativeSummaries({
      narrativesDb: null,
      eventLog,
      query: "queue worker",
      limit: 1,
      nowSec: Math.floor(Date.parse("2026-03-23T12:00:00.000Z") / 1000),
      sinceSec: Math.floor(Date.parse("2026-03-20T00:00:00.000Z") / 1000),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("event-log");
    expect(rows[0].text).toContain("fix the flaky queue worker");
  });

  it("formats stored second-based timestamps as real ISO ranges", () => {
    expect(formatNarrativeRange(1_774_224_000, 1_774_224_600)).toBe(
      "2026-03-23T00:00:00.000Z..2026-03-23T00:10:00.000Z",
    );
  });
});
