import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import {
  backfillRecallEventsFromSessionFile,
  extractRecallEventsFromAssistantContent,
  logRecallEvent,
  mergeRecallFactIdsForSession,
} from "../services/recall-events.js";
import { scoreIdentityGaps } from "../services/identity-gap-scorer.js";
import { appendDailySessionSummary } from "../services/daily-log-synthesizer.js";
import { scanSessionFileForMetadata } from "../services/session-metadata.js";
import { WorkflowStore } from "../backends/workflow-store.js";

function openTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "maint-gap-"));
  const dbPath = join(dir, "facts.db");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.5,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL
    )
  `);
  runFactsMigrations(db);
  return db;
}

describe("maintenance data gaps", { timeout: 60_000 }, () => {
  it("extracts recall events from assistant tool_use/tool_result blocks", () => {
    const memoryId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const events = extractRecallEventsFromAssistantContent([
      { type: "tool_use", name: "memory_recall", id: "t1", input: { query: "prefs" } },
      { type: "tool_result", tool_use_id: "t1", content: `Found memory: ${memoryId}` },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].factIds).toContain(memoryId);
    expect(events[0].hit).toBe(true);
    expect(events[0].query).toBe("prefs");
  });

  it("backfills recall_events and joins by session file", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const memoryId = "11111111-2222-3333-4444-555555555555";
    const sessionFile = join(dir, "2026-06-04-test.jsonl");
    writeFileSync(
      sessionFile,
      `{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"memory_recall","id":"t1","input":{"query":"x"}},{"type":"tool_result","tool_use_id":"t1","content":"Memory (id: ${memoryId})"}]}}\n`,
    );
    const inserted = backfillRecallEventsFromSessionFile(db, sessionFile);
    expect(inserted).toBe(1);
    const ids = mergeRecallFactIdsForSession(db, "2026-06-04-test.jsonl");
    expect(ids).toContain(memoryId);
    db.close();
  });

  it("logs runtime recall events", () => {
    const db = openTestDb();
    logRecallEvent(db, {
      hit: true,
      factIds: ["abc"],
      sessionKey: "sess-1",
      source: "tool",
      query: "hello",
    });
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM recall_events").get() as { cnt: number };
    expect(row.cnt).toBe(1);
    db.close();
  });

  it("scores identity gaps between insights and identity files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-"));
    writeFileSync(join(dir, "SOUL.md"), "# Soul\nBe helpful.\n");
    writeFileSync(join(dir, "IDENTITY.md"), "# Identity\nName: TestBot\n");
    writeFileSync(join(dir, "USER.md"), "# User\nName: Alice\n");
    const gaps = scoreIdentityGaps(
      [
        {
          id: "1",
          text: "Always validate kubernetes deployment manifests before applying cluster changes",
          category: "pattern",
          importance: 0.8,
          entity: null,
          key: null,
          value: null,
          source: "reflection",
          createdAt: 1,
          confidence: 0.9,
          decayClass: "normal",
          expiresAt: null,
          supersededAt: null,
          tags: [],
        },
      ],
      dir,
    );
    expect(gaps.score).toBeGreaterThan(0);
    expect(gaps.bullets.length).toBeGreaterThan(0);
  });

  it("appends idempotent daily session summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    process.env.OPENCLAW_WORKSPACE = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(process.env.OPENCLAW_WORKSPACE, "memory"), { recursive: true });
    const path1 = appendDailySessionSummary({
      sessionKey: "sess-daily-1",
      agentId: "main",
      turnCount: 5,
      toolsUsed: ["memory_recall"],
      outcome: "success",
      topicLine: "Discussed deployment",
      date: "2026-06-04",
    });
    const path2 = appendDailySessionSummary({
      sessionKey: "sess-daily-1",
      agentId: "main",
      turnCount: 5,
      toolsUsed: ["memory_recall"],
      outcome: "success",
      topicLine: "Discussed deployment",
      date: "2026-06-04",
    });
    expect(path1).toBe(path2);
    delete process.env.OPENCLAW_WORKSPACE;
  });

  it("detects session language metadata from JSONL", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "lang-"));
    const file = join(dir, "2026-06-04-sv.jsonl");
    writeFileSync(
      file,
      `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Jag behöver hjälp med att konfigurera min deployment och kubernetes kluster för produktion miljö"}]}}\n`,
    );
    const row = scanSessionFileForMetadata(db, file);
    expect(row).not.toBeNull();
    expect(row!.userCharCount).toBeGreaterThan(20);
    db.close();
  });

  it("backfills recall_events from v3 toolCall + toolResult session messages", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "sess-v3-"));
    const memoryId = "83ea74d1-736d-44bd-b4c1-82463f6e8e80";
    const sessionFile = join(dir, "a8419e96-827e-4ad2-b8ed-0e4839721239.jsonl");
    writeFileSync(
      sessionFile,
      [
        `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_v3_1","name":"memory_recall","arguments":{"query":"smart-home","limit":10}}]}}`,
        `{"type":"message","message":{"role":"toolResult","toolCallId":"call_v3_1","toolName":"memory_recall","content":[{"type":"text","text":"Found 1 memories"}],"details":{"memories":[{"id":"${memoryId}","text":"Task title","category":"project"}]}}}`,
      ].join("\n"),
    );
    const inserted = backfillRecallEventsFromSessionFile(db, sessionFile);
    expect(inserted).toBeGreaterThanOrEqual(1);
    const ids = mergeRecallFactIdsForSession(db, basename(sessionFile));
    expect(ids).toContain(memoryId);
    db.close();
  });

  it("backfill recall_events dedupes trajectory and session sources", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "sess-dedupe-"));
    const memoryId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const sessionFile = join(dir, "2026-06-04-dedupe.jsonl");
    writeFileSync(
      sessionFile,
      `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"memory_recall","arguments":{"query":"prefs"}},{"type":"tool_result","tool_use_id":"t1","content":"Memory (id: ${memoryId})"}]}}\n`,
    );
    writeFileSync(
      join(dir, "2026-06-04-dedupe.trajectory.jsonl"),
      [
        JSON.stringify({ type: "tool.call", data: { toolCallId: "t1", name: "memory_recall", arguments: { query: "prefs" } } }),
        JSON.stringify({
          type: "tool.result",
          data: { toolCallId: "t1", name: "memory_recall", content: `Memory (id: ${memoryId})` },
        }),
      ].join("\n"),
    );
    expect(backfillRecallEventsFromSessionFile(db, sessionFile)).toBe(1);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM recall_events").get() as { cnt: number };
    expect(row.cnt).toBe(1);
    db.close();
  });

  it("backfill recall_events preserves repeated recalls with different tool call ids", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "sess-repeat-"));
    const memoryId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const sessionFile = join(dir, "2026-06-04-repeat.jsonl");
    writeFileSync(
      sessionFile,
      [
        `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"memory_recall","arguments":{"query":"prefs"}}]}}`,
        `{"type":"message","message":{"role":"toolResult","toolCallId":"t1","toolName":"memory_recall","content":[{"type":"text","text":"Memory (id: ${memoryId})"}]}}`,
        `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t2","name":"memory_recall","arguments":{"query":"prefs"}}]}}`,
        `{"type":"message","message":{"role":"toolResult","toolCallId":"t2","toolName":"memory_recall","content":[{"type":"text","text":"Memory (id: ${memoryId})"}]}}`,
      ].join("\n"),
    );
    expect(backfillRecallEventsFromSessionFile(db, sessionFile)).toBe(2);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM recall_events").get() as { cnt: number };
    expect(row.cnt).toBe(2);
    db.close();
  });

  it("backfill recall_events is idempotent on rerun", () => {
    const db = openTestDb();
    const dir = mkdtempSync(join(tmpdir(), "sess-idem-"));
    const memoryId = "11111111-2222-3333-4444-555555555555";
    const sessionFile = join(dir, "2026-06-04-idem.jsonl");
    writeFileSync(
      sessionFile,
      `{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"memory_recall","id":"t1","input":{"query":"prefs"}},{"type":"tool_result","tool_use_id":"t1","content":"Memory (id: ${memoryId})"}]}}\n`,
    );
    expect(backfillRecallEventsFromSessionFile(db, sessionFile)).toBe(1);
    expect(backfillRecallEventsFromSessionFile(db, sessionFile)).toBe(0);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM recall_events").get() as { cnt: number };
    expect(row.cnt).toBe(1);
    db.close();
  });

  it("backfill workflow traces is idempotent on rerun", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-idem-"));
    const store = new WorkflowStore(join(dir, "workflow-traces.db"));
    const input = {
      goal: "Deploy service",
      toolSequence: ["read", "exec", "write"],
      outcome: "success" as const,
      sessionId: "2026-06-04-wf.jsonl",
    };
    expect(store.recordBackfillIfAbsent(input)).toBe(true);
    expect(store.recordBackfillIfAbsent(input)).toBe(false);
    expect(store.count()).toBe(1);
  });
});
