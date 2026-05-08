import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventLog } from "../backends/event-log.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import * as chatModule from "../services/chat.js";
import * as errorReporter from "../services/error-reporter.js";
import { buildDailyNarrative } from "../src/worker/narratives.js";

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

  it("treats gateway 502 as transient: no GlitchTip capture, info log only", async () => {
    eventLog.append({
      sessionId: "s502",
      timestamp: "2026-03-22T10:00:00.000Z",
      eventType: "action_taken",
      content: { action: "session_start" },
    });
    eventLog.append({
      sessionId: "s502",
      timestamp: "2026-03-22T10:05:00.000Z",
      eventType: "action_taken",
      content: { action: "heartbeat" },
    });

    const gateway502 = Object.assign(new Error("502 error code: 502"), { status: 502 });
    vi.spyOn(chatModule, "chatCompleteWithRetry").mockRejectedValue(gateway502);
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError");
    const info = vi.fn();
    const warn = vi.fn();

    const stored = await buildDailyNarrative({
      sessionId: "s502",
      eventLog,
      workflowStore,
      narrativesDb,
      openai: {} as never,
      model: "test-model",
      logger: { warn, info },
    });

    expect(stored).toBe(false);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    expect(String(info.mock.calls[0]?.[0])).toMatch(/narrative skipped/i);
    expect(narrativesDb.listRecent(5, "session").length).toBe(0);
  });
});
