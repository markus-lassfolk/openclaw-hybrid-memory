import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventLog } from "../backends/event-log.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { buildDailyNarrative } from "../src/worker/narratives.js";
import * as chatModule from "../services/chat.js";

describe("buildDailyNarrative", () => {
  let dir: string;
  let eventLog: EventLog;
  let workflowStore: WorkflowStore;
  let narrativesDb: NarrativesDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "narratives-worker-"));
    eventLog = new EventLog(join(dir, "event-log.db"));
    workflowStore = new WorkflowStore(join(dir, "workflow.db"));
    narrativesDb = new NarrativesDB(join(dir, "narratives.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventLog.close();
    workflowStore.close();
    narrativesDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for trivial sessions", async () => {
    eventLog.append({
      sessionId: "s1",
      timestamp: "2026-03-22T10:00:00.000Z",
      eventType: "action_taken",
      content: { action: "session_start" },
    });
    const chatSpy = vi.spyOn(chatModule, "chatCompleteWithRetry").mockResolvedValue("should not be used");

    const stored = await buildDailyNarrative({
      sessionId: "s1",
      eventLog,
      workflowStore,
      narrativesDb,
      openai: {} as never,
      model: "test-model",
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(stored).toBe(false);
    expect(chatSpy).not.toHaveBeenCalled();
    expect(narrativesDb.listRecent(5, "session").length).toBe(0);
  });

  it("stores a synthesized narrative for a non-trivial session", async () => {
    eventLog.append({
      sessionId: "s2",
      timestamp: "2026-03-22T10:00:00.000Z",
      eventType: "action_taken",
      content: { action: "session_start" },
    });
    eventLog.append({
      sessionId: "s2",
      timestamp: "2026-03-22T10:05:00.000Z",
      eventType: "decision_made",
      content: { decision: "switch strategy" },
    });
    workflowStore.record({
      goal: "Investigate failure",
      toolSequence: ["rg", "npm test"],
      outcome: "failure",
      sessionId: "s2",
    });

    vi.spyOn(chatModule, "chatCompleteWithRetry").mockResolvedValue(
      "**Context** Goal.\n**Chronicle** Step-by-step.\n**Decisions** Next action.",
    );

    const stored = await buildDailyNarrative({
      sessionId: "s2",
      eventLog,
      workflowStore,
      narrativesDb,
      openai: {} as never,
      model: "test-model",
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(stored).toBe(true);
    const rows = narrativesDb.listRecent(5, "session");
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe("s2");
    expect(rows[0].narrativeText).toContain("**Context**");
  });

  it("skips storage when model says NO_NARRATIVE", async () => {
    eventLog.append({
      sessionId: "s3",
      timestamp: "2026-03-22T10:00:00.000Z",
      eventType: "action_taken",
      content: { action: "session_start" },
    });
    eventLog.append({
      sessionId: "s3",
      timestamp: "2026-03-22T10:05:00.000Z",
      eventType: "action_taken",
      content: { action: "heartbeat" },
    });

    vi.spyOn(chatModule, "chatCompleteWithRetry").mockResolvedValue("NO_NARRATIVE");

    const stored = await buildDailyNarrative({
      sessionId: "s3",
      eventLog,
      workflowStore,
      narrativesDb,
      openai: {} as never,
      model: "test-model",
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(stored).toBe(false);
    expect(narrativesDb.listRecent(5, "session").length).toBe(0);
  });
});

