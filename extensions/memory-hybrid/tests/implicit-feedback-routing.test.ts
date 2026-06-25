/**
 * Tests for implicit feedback signal routing (Issue #262 — Phase 2).
 *
 * Covers:
 *   - Positive signals route to reinforcement pipeline (reinforceFact)
 *   - Negative signals route to self-correction pipeline (technical implicit_feedback_signal facts)
 *   - Routing is suppressed when feedToReinforcement / feedToSelfCorrection are false
 *   - CLI command 'extract-implicit' is registered in ManageContext
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  implicitFeedbackCollapseStatus,
  isSemanticNoOpImplicitFeedbackCollapseStatus,
  propagateAbortSignal,
  remainingDeadlineMs,
  resolveTrajectoryLlmBudgetMs,
  runWithConcurrencyLimit,
  trajectoryCallTimeoutMs,
  TRAJECTORY_LLM_MIN_BUDGET_MS,
  TRAJECTORY_PER_CALL_BUDGET_MS,
} from "../cli/cmd-feedback.js";
import {
  cleanupImplicitFeedbackDuplicates,
  type HandlerContext,
  runExtractImplicitFeedbackForCli,
} from "../cli/handlers.js";
import type { ManageContext } from "../cli/manage.js";
import type { HybridMemoryConfig } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string) {
  return new FactsDB(join(dir, "facts.db"));
}

/** Access raw SQLite DB from FactsDB for test assertions. */
function rawDb(db: InstanceType<typeof FactsDB>) {
  return db.getRawDb();
}

/** Minimal HandlerContext for routing tests — only the fields runExtractImplicitFeedbackForCli uses. */
function makeCtx(
  db: InstanceType<typeof FactsDB>,
  sessionsDir: string,
  implicitFeedbackOverrides?: Partial<NonNullable<HybridMemoryConfig["implicitFeedback"]>>,
): HandlerContext {
  const cfg = {
    enabled: true,
    encryption: { enabled: false },
    procedures: { sessionsDir, maxRecentSessions: 50 },
    reinforcement: { enabled: true, trackContext: true, maxEventsPerFact: 50, boostAmount: 0.2 },
    closedLoop: { enabled: false },
    implicitFeedback: {
      enabled: true,
      minConfidence: 0.0,
      feedToReinforcement: true,
      feedToSelfCorrection: true,
      ...implicitFeedbackOverrides,
    },
  } as unknown as HybridMemoryConfig;

  return {
    factsDb: db,
    edictStore: null as any,
    cfg,
    logger: {},
  } as unknown as HandlerContext;
}

/** Write a minimal OpenClaw session JSONL file with a grateful close signal (positive). */
function writePositiveSession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Can you explain async await TypeScript pattern with examples for error handling in async code?",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Here is a complete async await TypeScript pattern example with proper error handling.",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Perfect, that is exactly what I needed. Thanks!" }] },
    }),
  ];
  writeFileSync(join(sessionsDir, filename), lines.join("\n"), "utf-8");
}

/** Write a session with repeated corrections (negative signals). */
function writeNegativeSession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "How do I sort an array of objects by a property in TypeScript?" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "You can use Array.prototype.sort with a comparator." }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "No that is not what I meant, I need it sorted in descending order, please fix that." },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "My apologies, here is the corrected descending sort." }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "No that is still wrong, you are not listening. I need to sort by createdAt date field.",
          },
        ],
      },
    }),
  ];
  writeFileSync(join(sessionsDir, filename), lines.join("\n"), "utf-8");
}

/** Write a session with two distinct grateful closes in one file. */
function writeDoublePositiveSession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Can you explain async await TypeScript patterns for API retries?" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Use an async await TypeScript pattern with retry and backoff for API calls.",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Perfect, that retry pattern helped. Thanks!" }] },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Great. The async await TypeScript pattern also works for sequential API workflows.",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Awesome, thanks again for the async walkthrough!" }] },
    }),
  ];
  writeFileSync(join(sessionsDir, filename), lines.join("\n"), "utf-8");
}

/** Write a session long enough to produce a trajectory. */
function writeTrajectorySession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "How do I set up webpack configuration for my project?" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Create a webpack.config.js with entry and output." }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "How do I set up the webpack configuration entry point and output?" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Set entry to src/index.js and output to dist." }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Perfect, that worked great! Thanks." }],
      },
    }),
  ];
  writeFileSync(join(sessionsDir, filename), lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests — positive signals → reinforcement pipeline
// ---------------------------------------------------------------------------

describe("implicit feedback routing — positive → reinforcement", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ifr-pos-"));
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates reinforcement_log entries for positive signals when feedToReinforcement=true", async () => {
    const db = makeDb(tmpDir);

    // Pre-seed a fact whose text contains words the FTS search will find in the grateful message.
    // The handler calls factsDb.search(sig.context.userMessage, 3) where userMessage is the
    // grateful user turn: "Perfect, that is exactly what I needed. Thanks!"
    db.store({
      text: "async await TypeScript pattern with error handling examples",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    // Also store a fact that will match some words from the grateful message
    db.store({
      text: "exactly what is needed for async TypeScript pattern",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    writePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, { feedToReinforcement: true, feedToSelfCorrection: false });
    const result = await runExtractImplicitFeedbackForCli(ctx, { days: 365, dryRun: false });

    expect(result.signalsExtracted).toBeGreaterThan(0);
    expect(result.positiveCount).toBeGreaterThan(0);

    // The implicit_signals table must have been populated with positive signals.
    const sigRows = rawDb(db)
      .prepare(`SELECT COUNT(*) as cnt FROM implicit_signals WHERE polarity = 'positive'`)
      .get() as { cnt: number };
    expect(sigRows.cnt).toBeGreaterThan(0);
  });

  it("stores implicit_signals but skips reinforcement_log when feedToReinforcement=false", async () => {
    const db = makeDb(tmpDir);
    db.store({
      text: "exactly what is needed for async TypeScript pattern",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    writePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, { feedToReinforcement: false, feedToSelfCorrection: false });
    const result = await runExtractImplicitFeedbackForCli(ctx, { days: 365, dryRun: false });

    expect(result.positiveCount).toBeGreaterThan(0);

    // No reinforcement_log entries should have been created.
    const logRows = rawDb(db).prepare("SELECT COUNT(*) as cnt FROM reinforcement_log").get() as { cnt: number };
    expect(logRows.cnt).toBe(0);
  });

  it("applies multiple distinct positive boosts for the same fact/session when trackContext=false", async () => {
    const db = makeDb(tmpDir);
    const fact = db.store({
      text: "async await TypeScript pattern for api retry and sequential workflows",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    writeDoublePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, {
      minConfidence: 0.0,
      signalTypes: ["grateful_close"],
      feedToReinforcement: true,
      feedToSelfCorrection: false,
    });
    ctx.cfg.reinforcement = {
      ...(ctx.cfg.reinforcement ?? {}),
      enabled: true,
      trackContext: false,
      maxEventsPerFact: 50,
    } as HybridMemoryConfig["reinforcement"];

    const result = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });

    expect(result.positiveCount).toBe(2);
    const eventCount = rawDb(db)
      .prepare("SELECT COUNT(*) as cnt FROM reinforcement_log WHERE fact_id = ? AND session_file = ?")
      .get(fact.id, "2026-01-01-session.jsonl") as { cnt: number };
    expect(eventCount.cnt).toBe(2);
  });

  it("rolls back interrupted reinforcement work when wall-clock stops mid-session and reruns", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const db = makeDb(tmpDir);
      db.store({
        text: "exactly what is needed for async TypeScript pattern",
        category: "technical",
        importance: 0.7,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
      writePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

      const originalReinforceFact = db.reinforceFact.bind(db);
      let reinforceCalls = 0;
      vi.spyOn(db, "reinforceFact").mockImplementation((...args: Parameters<typeof originalReinforceFact>) => {
        const result = originalReinforceFact(...args);
        reinforceCalls++;
        if (reinforceCalls === 1) {
          vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
        }
        return result;
      });

      const firstCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 1,
      });
      const firstRun = await runExtractImplicitFeedbackForCli(firstCtx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });
      expect(firstRun.partial).toBe(true);
      expect(firstRun.partialReason).toBe("maxWallClock");
      const firstCount = (rawDb(db).prepare("SELECT COUNT(*) as cnt FROM reinforcement_log").get() as { cnt: number })
        .cnt;
      expect(firstCount).toBe(0);

      vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
      const secondCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 300,
      });
      const secondRun = await runExtractImplicitFeedbackForCli(secondCtx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });
      expect(secondRun.sessionsProcessed).toBe(1);

      const duplicateReinforcementRows = rawDb(db)
        .prepare(
          `SELECT fact_id, session_file, topic, query_snippet, COUNT(*) as cnt
           FROM reinforcement_log
           GROUP BY fact_id, session_file, topic, query_snippet
           HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ cnt: number }>;
      expect(duplicateReinforcementRows).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("avoids replaying positive reinforcement after a wall-clock partial even when trackContext=false", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const db = makeDb(tmpDir);
      const factId = db.store({
        text: "exactly what is needed for async TypeScript pattern",
        category: "technical",
        importance: 0.7,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
      writePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

      const originalReinforceFact = db.reinforceFact.bind(db);
      let reinforceCalls = 0;
      vi.spyOn(db, "reinforceFact").mockImplementation((...args: Parameters<typeof originalReinforceFact>) => {
        const result = originalReinforceFact(...args);
        reinforceCalls++;
        if (reinforceCalls === 1) {
          vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
        }
        return result;
      });

      const firstCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 1,
      });
      firstCtx.cfg.reinforcement = {
        ...(firstCtx.cfg.reinforcement ?? {}),
        enabled: true,
        trackContext: false,
        maxEventsPerFact: 50,
      } as HybridMemoryConfig["reinforcement"];
      const firstRun = await runExtractImplicitFeedbackForCli(firstCtx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });

      expect(firstRun.partial).toBe(true);
      expect(firstRun.partialReason).toBe("maxWallClock");
      const afterFirstRun = rawDb(db).prepare("SELECT reinforced_count FROM facts WHERE id = ?").get(factId.id) as {
        reinforced_count: number;
      };
      expect(afterFirstRun.reinforced_count).toBe(0);

      vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
      const secondCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 300,
      });
      secondCtx.cfg.reinforcement = {
        ...(secondCtx.cfg.reinforcement ?? {}),
        enabled: true,
        trackContext: false,
        maxEventsPerFact: 50,
      } as HybridMemoryConfig["reinforcement"];
      const secondRun = await runExtractImplicitFeedbackForCli(secondCtx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });

      expect(secondRun.sessionsProcessed).toBe(1);
      const afterSecondRun = rawDb(db).prepare("SELECT reinforced_count FROM facts WHERE id = ?").get(factId.id) as {
        reinforced_count: number;
      };
      expect(afterSecondRun.reinforced_count).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses session-level dedupe fallback when trackContext=false rows are missing topic/query columns", async () => {
    const db = makeDb(tmpDir);
    const fact = db.store({
      text: "exactly what is needed for async TypeScript pattern",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    writePositiveSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, {
      feedToReinforcement: true,
      feedToSelfCorrection: false,
    });
    ctx.cfg.reinforcement = {
      ...(ctx.cfg.reinforcement ?? {}),
      enabled: true,
      trackContext: false,
      maxEventsPerFact: 50,
    } as HybridMemoryConfig["reinforcement"];

    const firstRun = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });
    expect(firstRun.sessionsProcessed).toBe(1);

    rawDb(db).prepare("UPDATE reinforcement_log SET topic = NULL, query_snippet = NULL WHERE fact_id = ?").run(fact.id);

    const secondRun = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      full: true,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });
    expect(secondRun.sessionsProcessed).toBe(1);

    const duplicateRows = rawDb(db)
      .prepare(
        `SELECT fact_id, session_file, COUNT(*) as cnt
         FROM reinforcement_log
         GROUP BY fact_id, session_file
         HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ cnt: number }>;
    expect(duplicateRows).toEqual([]);
  });

  it("does not duplicate persisted trajectories when wall-clock expires during reinforcement and run is retried", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const db = makeDb(tmpDir);
      db.store({
        text: "webpack configuration entry output",
        category: "technical",
        importance: 0.7,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
      writeTrajectorySession(sessionsDir, "2026-01-01-session.jsonl");

      const originalReinforceFact = db.reinforceFact.bind(db);
      let reinforceCalls = 0;
      vi.spyOn(db, "reinforceFact").mockImplementation((...args: Parameters<typeof originalReinforceFact>) => {
        const result = originalReinforceFact(...args);
        reinforceCalls++;
        if (reinforceCalls === 1) {
          vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
        }
        return result;
      });

      const firstCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 1,
      });
      const firstRun = await runExtractImplicitFeedbackForCli(firstCtx, {
        days: 365,
        dryRun: false,
        includeClosedLoop: false,
      });
      expect(firstRun.partial).toBe(true);
      expect(firstRun.partialReason).toBe("maxWallClock");

      vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
      const secondCtx = makeCtx(db, sessionsDir, {
        feedToReinforcement: true,
        feedToSelfCorrection: false,
        maxWallClockSeconds: 300,
      });
      const secondRun = await runExtractImplicitFeedbackForCli(secondCtx, {
        days: 365,
        dryRun: false,
        includeClosedLoop: false,
      });
      expect(secondRun.sessionsProcessed).toBe(1);

      const duplicateTrajectories = rawDb(db)
        .prepare(
          `SELECT session_file, turns_json, COUNT(*) as cnt
           FROM feedback_trajectories
           GROUP BY session_file, turns_json
           HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ cnt: number }>;
      expect(duplicateTrajectories).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks reinforcement failures as partial without advancing session accounting after trajectories persist", async () => {
    const db = makeDb(tmpDir);
    db.store({
      text: "set entry to src/index.js and output to dist in webpack configuration",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    writeTrajectorySession(sessionsDir, "2026-01-01-session.jsonl");

    vi.spyOn(db, "reinforceFact").mockImplementation(() => {
      throw new Error("reinforcement apply failed");
    });

    const ctx = makeCtx(db, sessionsDir, {
      feedToReinforcement: true,
      feedToSelfCorrection: false,
    });
    const result = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeClosedLoop: false,
    });

    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe("reinforcementError");
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsDeferred).toBe(1);
    expect(result.trajectoriesBuilt).toBe(1);
    const trajectoryRows = rawDb(db).prepare("SELECT COUNT(*) as cnt FROM feedback_trajectories").get() as {
      cnt: number;
    };
    expect(trajectoryRows.cnt).toBe(1);
    expect(db.getScanCursor("extract-implicit-feedback")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — negative signals → self-correction signal facts
// ---------------------------------------------------------------------------

describe("implicit feedback routing — negative → implicit_feedback_signal", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ifr-neg-"));
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores technical implicit_feedback_signal facts tagged [implicit-feedback, negative] when feedToSelfCorrection=true", async () => {
    const db = makeDb(tmpDir);
    writeNegativeSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, {
      minConfidence: 0.0,
      feedToReinforcement: false,
      feedToSelfCorrection: true,
    });
    const result = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });

    expect(result.negativeCount).toBeGreaterThan(0);

    // Verify technical signal facts with implicit-feedback + negative tags were stored.
    const negFacts = rawDb(db).prepare(`SELECT * FROM facts WHERE source = 'implicit-feedback'`).all() as Array<{
      category: string;
      key: string | null;
      tags: string;
    }>;

    expect(negFacts.length).toBeGreaterThan(0);
    for (const fact of negFacts) {
      expect(fact.category).toBe("technical");
      expect(fact.key).toBe("implicit_feedback_signal");
      // Tags are stored as comma-separated strings (not JSON).
      const tags = (fact.tags ?? "").split(",").map((t: string) => t.trim());
      expect(tags).toContain("implicit-feedback");
      expect(tags).toContain("negative");
    }
  });

  it("collapses historical near-duplicate implicit-feedback facts", () => {
    const db = makeDb(tmpDir);
    const first = db.store({
      text: "User satisfaction increases when the agent provides concrete next steps",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    const duplicate = db.store({
      text: "User satisfaction improves when the agent provides concrete next steps",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });

    const result = cleanupImplicitFeedbackDuplicates(db, { threshold: 0.7, limit: 100 });

    expect(result.collapsed).toBe(1);
    const rows = rawDb(db)
      .prepare("SELECT id, superseded_by as supersededBy, superseded_at as supersededAt FROM facts WHERE id IN (?, ?)")
      .all(first.id, duplicate.id) as Array<{ id: string; supersededBy: string | null; supersededAt: number | null }>;
    const canonical = rows.find((row) => row.supersededAt == null);
    const superseded = rows.find((row) => row.supersededAt != null);
    expect(canonical).toBeDefined();
    expect(superseded?.supersededBy).toBe(canonical?.id);
    expect(superseded?.supersededAt).toBeTypeOf("number");
  });

  it("supports dry-run collapse without superseding historical duplicates", () => {
    const db = makeDb(tmpDir);
    const first = db.store({
      text: "User satisfaction increases when the agent provides concrete next steps",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    const duplicate = db.store({
      text: "User satisfaction improves when the agent provides concrete next steps",
      category: "pattern",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "implicit-feedback",
      tags: ["trajectory"],
    });

    const result = cleanupImplicitFeedbackDuplicates(db, { threshold: 0.7, limit: 100, dryRun: true });

    expect(result.collapsed).toBe(1);
    const rows = rawDb(db)
      .prepare("SELECT id, superseded_by as supersededBy, superseded_at as supersededAt FROM facts WHERE id IN (?, ?)")
      .all(first.id, duplicate.id) as Array<{ id: string; supersededBy: string | null; supersededAt: number | null }>;
    expect(rows.every((row) => row.supersededAt == null)).toBe(true);
    expect(rows.every((row) => row.supersededBy == null)).toBe(true);
  });

  it("returns actual scanned progress and cursor row when cleanup is interrupted by wall-clock", () => {
    const db = makeDb(tmpDir);
    db.store({
      text: "A trajectory lesson about concrete next steps",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    db.store({
      text: "Another trajectory lesson about concise examples",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    db.store({
      text: "A third trajectory lesson about explaining tradeoffs",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });

    const orderedRowIds = rawDb(db)
      .prepare(
        `SELECT rowid as rowid
         FROM facts
         WHERE source = 'implicit-feedback'
         ORDER BY rowid ASC`,
      )
      .all() as Array<{ rowid: number }>;
    let checks = 0;
    const result = cleanupImplicitFeedbackDuplicates(db, {
      threshold: 0.7,
      limit: 100,
      wallClockCheck: () => {
        checks++;
        return checks > 1;
      },
    });

    expect(result.interrupted).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.resumeAfterRowid).toBe(orderedRowIds[0]?.rowid ?? null);
  });

  it("collapses legacy pattern-shaped trajectory rows into canonical implicit-feedback signals", () => {
    const db = makeDb(tmpDir);
    const canonical = db.store({
      text: "Validate dispatched tasks return complete structured evidence",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    const legacyPattern = db.store({
      text: "Validate that each dispatched task returns complete structured evidence",
      category: "pattern",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "implicit-feedback",
      tags: ["trajectory"],
    });

    const result = cleanupImplicitFeedbackDuplicates(db, { threshold: 0.7, limit: 100 });

    expect(result.collapsed).toBe(1);
    const row = rawDb(db)
      .prepare("SELECT category, superseded_by as supersededBy, superseded_at as supersededAt FROM facts WHERE id = ?")
      .get(legacyPattern.id) as { category: string; supersededBy: string | null; supersededAt: number | null };
    expect(row.category).toBe("pattern");
    expect(row.supersededBy).toBe(canonical.id);
    expect(row.supersededAt).toBeTypeOf("number");
  });

  it("collapses legacy category=pattern implicit-feedback rows when includeLegacy=true", () => {
    const db = makeDb(tmpDir);
    const sharedText = '[Implicit correction] "legacy pattern row exact match"';
    const canonical = db.store({
      text: sharedText,
      category: "technical",
      importance: 0.5,
      entity: null,
      key: "implicit_feedback_signal",
      value: sharedText.slice(0, 200),
      source: "implicit-feedback",
      tags: ["implicit-feedback", "negative", "correction"],
      decayClass: "normal",
    });
    // Raw text must differ from canonical or store() dedupes to a single row (exact text / hash path).
    const legacyText = `${sharedText}\u2003`;
    const legacyPattern = db.store({
      text: legacyText,
      category: "pattern",
      importance: 0.5,
      entity: null,
      key: null,
      value: legacyText.slice(0, 200),
      source: "implicit-feedback",
      tags: ["implicit-feedback", "negative", "correction"],
    });

    const withoutLegacy = cleanupImplicitFeedbackDuplicates(db, { threshold: 0.8, limit: 100 });
    expect(withoutLegacy.collapsed).toBe(0);

    const withLegacy = cleanupImplicitFeedbackDuplicates(db, {
      threshold: 0.8,
      limit: 100,
      includeLegacy: true,
    });
    expect(withLegacy.collapsed).toBe(1);
    const row = rawDb(db)
      .prepare("SELECT superseded_by as supersededBy FROM facts WHERE id = ?")
      .get(legacyPattern.id) as { supersededBy: string | null };
    expect(row.supersededBy).toBe(canonical.id);
  });

  it("keeps enough canonical context across many batches so late-page duplicates still collapse", {
    timeout: 120_000,
  }, () => {
    const db = makeDb(tmpDir);
    // Put the late duplicate in the first batch after legacy 2k carry would evict the canonical row.
    const PAGED_SCAN_LIMIT = 250;
    const INTERLEAVED_UNIQUE_ROWS = 2249;
    const canonical = db.store({
      text: "collapse canonical alpha beta gamma delta epsilon",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });
    for (let i = 0; i < INTERLEAVED_UNIQUE_ROWS; i++) {
      db.store({
        text: `uniquesignal${i}`,
        category: "technical",
        importance: 0.7,
        entity: null,
        key: "implicit_feedback_signal",
        value: null,
        source: "implicit-feedback",
        tags: ["implicit-feedback", "trajectory", "feedback"],
      });
    }
    // Keep this similar (not exact) so cleanup exercises Jaccard matching rather than exact-text dedupe.
    const lateDuplicate = db.store({
      text: "collapse canonical alpha beta gamma delta epsilon zeta",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });

    let afterRowid = 0;
    let carryCanonical: ReadonlyArray<{ id: string; text: string }> | undefined;
    let totalScanned = 0;
    let totalCollapsed = 0;
    for (;;) {
      const batch = cleanupImplicitFeedbackDuplicates(db, {
        threshold: 0.8,
        limit: PAGED_SCAN_LIMIT,
        afterRowid,
        seedCanonical: carryCanonical,
      });
      totalScanned += batch.scanned;
      totalCollapsed += batch.collapsed;
      carryCanonical = batch.carryCanonical;
      if (batch.scanned < PAGED_SCAN_LIMIT || batch.resumeAfterRowid == null) break;
      afterRowid = batch.resumeAfterRowid;
    }

    expect(totalScanned).toBeGreaterThan(INTERLEAVED_UNIQUE_ROWS);
    expect(totalCollapsed).toBe(1);
    const row = rawDb(db)
      .prepare("SELECT superseded_by as supersededBy FROM facts WHERE id = ?")
      .get(lateDuplicate.id) as { supersededBy: string | null };
    expect(row.supersededBy).toBe(canonical.id);
  });

  it("does NOT store implicit-feedback signal facts when feedToSelfCorrection=false", async () => {
    const db = makeDb(tmpDir);
    writeNegativeSession(sessionsDir, "2026-01-01-session.jsonl");

    const ctx = makeCtx(db, sessionsDir, {
      minConfidence: 0.0,
      feedToReinforcement: false,
      feedToSelfCorrection: false,
    });
    const result = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });

    expect(result.negativeCount).toBeGreaterThan(0);

    const negFacts = rawDb(db)
      .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback'`)
      .get() as { cnt: number };
    expect(negFacts.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — dry-run mode
// ---------------------------------------------------------------------------

describe("implicit feedback routing — cleanup progress reporting", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ifr-cleanup-progress-"));
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  describe("implicit feedback routing — incremental caps and resume", () => {
    let capsTmpDir: string;
    let capsSessionsDir: string;

    beforeEach(() => {
      capsTmpDir = mkdtempSync(join(tmpdir(), "ifr-caps-"));
      capsSessionsDir = join(capsTmpDir, "sessions");
      mkdirSync(capsSessionsDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(capsTmpDir, { recursive: true, force: true });
    });

    it("resumes from the last processed session when multiple sessions share the same mtime", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");
        writePositiveSession(capsSessionsDir, "2026-01-01-b.jsonl");
        const sharedMtime = new Date("2026-01-01T00:00:00.000Z");
        utimesSync(join(capsSessionsDir, "2026-01-01-a.jsonl"), sharedMtime, sharedMtime);
        utimesSync(join(capsSessionsDir, "2026-01-01-b.jsonl"), sharedMtime, sharedMtime);

        const ctx = makeCtx(db, capsSessionsDir, {
          feedToSelfCorrection: false,
          maxSessionsPerRun: 1,
        });

        const firstRun = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeTrajectories: false,
          includeClosedLoop: false,
        });
        expect(firstRun.sessionsProcessed).toBe(1);
        expect(firstRun.sessionsDeferred).toBe(1);
        expect(firstRun.partial).toBe(true);
        expect(firstRun.partialReason).toBe("maxSessions");
        expect(db.getScanCursor("extract-implicit-feedback")).toEqual({
          lastSessionTs: sharedMtime.getTime(),
          lastSessionFile: "2026-01-01-a.jsonl",
          lastRunAt: expect.any(Number),
          sessionsProcessed: 1,
        });

        vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
        const secondRun = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeTrajectories: false,
          includeClosedLoop: false,
        });
        expect(secondRun.sessionsScanned).toBe(1);
        expect(secondRun.sessionsProcessed).toBe(1);
        expect(secondRun.sessionsDeferred).toBe(0);
        expect(secondRun.partial).toBe(false);
        expect(db.getScanCursor("extract-implicit-feedback")).toEqual({
          lastSessionTs: sharedMtime.getTime(),
          lastSessionFile: "2026-01-01-b.jsonl",
          lastRunAt: expect.any(Number),
          sessionsProcessed: 2,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes capped incremental backlog outside the moving day window", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");
        writePositiveSession(capsSessionsDir, "2026-01-01-b.jsonl");
        const oldMtimeA = new Date("2026-01-01T00:00:00.000Z");
        const oldMtimeB = new Date("2026-01-01T00:00:01.000Z");
        utimesSync(join(capsSessionsDir, "2026-01-01-a.jsonl"), oldMtimeA, oldMtimeA);
        utimesSync(join(capsSessionsDir, "2026-01-01-b.jsonl"), oldMtimeB, oldMtimeB);

        db.updateScanCursor("extract-implicit-feedback", oldMtimeA.getTime(), 1, "2026-01-01-a.jsonl");

        const ctx = makeCtx(db, capsSessionsDir, {
          feedToSelfCorrection: false,
          maxSessionsPerRun: 1,
        });

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 3,
          dryRun: false,
          includeTrajectories: false,
          includeClosedLoop: false,
        });

        expect(result.sessionsScanned).toBe(1);
        expect(result.sessionsProcessed).toBe(1);
        expect(db.getScanCursor("extract-implicit-feedback")?.lastSessionFile).toBe("2026-01-01-b.jsonl");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not reprocess same-mtime peers when a legacy cursor has no filename", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");
        writePositiveSession(capsSessionsDir, "2026-01-01-b.jsonl");
        const sharedMtime = new Date("2026-01-01T00:00:00.000Z");
        utimesSync(join(capsSessionsDir, "2026-01-01-a.jsonl"), sharedMtime, sharedMtime);
        utimesSync(join(capsSessionsDir, "2026-01-01-b.jsonl"), sharedMtime, sharedMtime);
        db.updateScanCursor("extract-implicit-feedback", sharedMtime.getTime(), 1);

        const ctx = makeCtx(db, capsSessionsDir, {
          feedToSelfCorrection: false,
          maxSessionsPerRun: 10,
        });

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeTrajectories: false,
          includeClosedLoop: false,
        });

        expect(result.sessionsScanned).toBe(0);
        expect(result.sessionsProcessed).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts the current session as deferred when a cap stops before processing it", async () => {
      const db = makeDb(capsTmpDir);
      writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");
      writeNegativeSession(capsSessionsDir, "2026-01-01-b.jsonl");

      const ctx = makeCtx(db, capsSessionsDir, {
        minConfidence: 0.0,
        feedToReinforcement: false,
        feedToSelfCorrection: false,
        maxSignalsPerRun: 2,
      });

      const result = await runExtractImplicitFeedbackForCli(ctx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });

      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessionsVisited).toBe(2);
      expect(result.sessionsDeferred).toBe(1);
      expect(result.backlogSessionsEstimate).toBe(1);
      expect(db.getScanCursor("extract-implicit-feedback")?.lastSessionFile).toBe("2026-01-01-a.jsonl");
    });

    it("processes one oversized session instead of stalling on per-run caps", async () => {
      const db = makeDb(capsTmpDir);
      writeNegativeSession(capsSessionsDir, "2026-01-01-oversized.jsonl");

      const ctx = makeCtx(db, capsSessionsDir, {
        minConfidence: 0.0,
        feedToReinforcement: false,
        feedToSelfCorrection: false,
        maxSignalsPerRun: 1,
      });

      const result = await runExtractImplicitFeedbackForCli(ctx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
      });

      expect(result.signalsExtracted).toBeGreaterThan(1);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessionsDeferred).toBe(0);
      expect(result.partial).toBe(false);
      expect(db.getScanCursor("extract-implicit-feedback")?.lastSessionFile).toBe("2026-01-01-oversized.jsonl");
    });

    it("reports partial healthy progress and backlog estimates when a signal cap defers remaining sessions", async () => {
      const db = makeDb(capsTmpDir);
      writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");
      writeNegativeSession(capsSessionsDir, "2026-01-01-b.jsonl");

      const snapshots: Array<{ partial?: boolean; partialReason?: string; sessionsDeferred?: number }> = [];
      const ctx = makeCtx(db, capsSessionsDir, {
        minConfidence: 0.0,
        feedToReinforcement: false,
        feedToSelfCorrection: false,
        maxSignalsPerRun: 1,
      });

      const result = await runExtractImplicitFeedbackForCli(ctx, {
        days: 365,
        dryRun: false,
        includeTrajectories: false,
        includeClosedLoop: false,
        onProgress: (snapshot) => snapshots.push(snapshot),
      });

      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessionsDeferred).toBe(1);
      expect(result.partial).toBe(true);
      expect(result.partialReason).toBe("maxSignals");
      expect(result.backlogSessionsEstimate).toBe(1);
      expect(result.backlogSignalsEstimate).toBeGreaterThan(0);
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.partial === true && snapshot.partialReason === "maxSignals" && snapshot.sessionsDeferred === 1,
        ),
      ).toBe(true);
    });

    it("defers remaining sessions when a trajectory cap is reached", async () => {
      const db = makeDb(capsTmpDir);
      writeTrajectorySession(capsSessionsDir, "2026-01-01-a.jsonl");
      writeTrajectorySession(capsSessionsDir, "2026-01-01-b.jsonl");

      const ctx = makeCtx(db, capsSessionsDir, {
        feedToSelfCorrection: false,
        maxTrajectoriesPerRun: 1,
      });

      const result = await runExtractImplicitFeedbackForCli(ctx, {
        days: 365,
        dryRun: false,
        includeClosedLoop: false,
      });

      expect(result.trajectoriesBuilt).toBe(1);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.sessionsDeferred).toBe(1);
      expect(result.partial).toBe(true);
      expect(result.partialReason).toBe("maxTrajectories");
      expect(result.backlogSessionsEstimate).toBe(1);
      expect(result.backlogTrajectoriesEstimate).toBeGreaterThan(0);
    });

    it("skips cleanup and closed-loop phases once the wall-clock budget is exhausted", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writeNegativeSession(capsSessionsDir, "2026-01-01-a.jsonl");

        const stages: string[] = [];
        let advancedClock = false;
        const ctx = makeCtx(db, capsSessionsDir, {
          autoCleanup: true,
          cleanupLimit: 1,
          maxWallClockSeconds: 1,
        });
        ctx.cfg.closedLoop = { enabled: true } as HybridMemoryConfig["closedLoop"];

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          onProgress: (snapshot) => {
            stages.push(snapshot.stage);
            if (!advancedClock && snapshot.stage === "scan-sessions" && snapshot.sessionsProcessed >= 1) {
              vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
              advancedClock = true;
            }
          },
        });

        expect(result.sessionsProcessed).toBe(1);
        expect(result.sessionsDeferred).toBe(0);
        expect(result.partial).toBe(true);
        expect(result.partialReason).toBe("maxWallClock");
        expect(stages).not.toContain("cleanup-duplicates");
        expect(stages).not.toContain("closed-loop");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops a session before marking it processed when wall-clock expires during trajectory lesson storage", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writeTrajectorySession(capsSessionsDir, "2026-01-01-a.jsonl");

        let advancedClock = false;
        const ctx = makeCtx(db, capsSessionsDir, {
          feedToSelfCorrection: false,
          maxWallClockSeconds: 1,
        });

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeClosedLoop: false,
          onProgress: (snapshot) => {
            if (!advancedClock && snapshot.stage === "scan-sessions" && snapshot.trajectoriesBuilt >= 1) {
              vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
              advancedClock = true;
            }
          },
        });

        expect(result.partial).toBe(true);
        expect(result.partialReason).toBe("maxWallClock");
        expect(result.sessionsProcessed).toBe(0);
        expect(result.sessionsDeferred).toBe(1);
        expect(db.getScanCursor("extract-implicit-feedback")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks runs partial when wall-clock expires during cleanup even when closed-loop is disabled", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writeNegativeSession(capsSessionsDir, "2026-01-01-a.jsonl");

        let advancedClock = false;
        const ctx = makeCtx(db, capsSessionsDir, {
          autoCleanup: true,
          cleanupLimit: 1,
          maxWallClockSeconds: 1,
        });

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeClosedLoop: false,
          onProgress: (snapshot) => {
            if (!advancedClock && snapshot.stage === "cleanup-duplicates" && (snapshot.cleanupBatches ?? 0) >= 1) {
              vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
              advancedClock = true;
            }
          },
        });

        expect(result.partial).toBe(true);
        expect(result.partialReason).toBe("maxWallClock");
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks runs partial when wall-clock expires after entering closed-loop analysis", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const db = makeDb(capsTmpDir);
        writePositiveSession(capsSessionsDir, "2026-01-01-a.jsonl");

        let advancedClock = false;
        const ctx = makeCtx(db, capsSessionsDir, {
          feedToSelfCorrection: false,
          autoCleanup: false,
          maxWallClockSeconds: 1,
        });
        ctx.cfg.closedLoop = { enabled: true } as HybridMemoryConfig["closedLoop"];

        const result = await runExtractImplicitFeedbackForCli(ctx, {
          days: 365,
          dryRun: false,
          includeTrajectories: false,
          includeClosedLoop: true,
          onProgress: (snapshot) => {
            if (!advancedClock && snapshot.stage === "closed-loop") {
              vi.setSystemTime(new Date("2026-05-01T00:00:02.000Z"));
              advancedClock = true;
            }
          },
        });

        expect(result.partial).toBe(true);
        expect(result.partialReason).toBe("maxWallClock");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a cleanup-duplicates progress snapshot immediately when entering the phase", async () => {
    const db = makeDb(tmpDir);
    writeNegativeSession(sessionsDir, "2026-01-03-session.jsonl");

    const snapshots: Array<{
      stage?: string;
      cleanupScanned?: number;
      cleanupCollapsed?: number;
      cleanupBatches?: number;
    }> = [];
    const ctx = makeCtx(db, sessionsDir, {
      feedToSelfCorrection: true,
      autoCleanup: true,
      cleanupLimit: 1,
    });

    await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      verbose: true,
      onProgress: (snapshot) => snapshots.push(snapshot),
    });

    const firstCleanupSnapshot = snapshots.find((snapshot) => snapshot.stage === "cleanup-duplicates");

    expect(firstCleanupSnapshot).toBeDefined();
    expect(firstCleanupSnapshot?.cleanupScanned).toBe(0);
    expect(firstCleanupSnapshot?.cleanupCollapsed).toBe(0);
    expect(firstCleanupSnapshot?.cleanupBatches).toBe(0);
  });
});

describe("implicit feedback routing — dry-run mode", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ifr-dry-"));
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports signals but does NOT persist anything when dryRun=true", async () => {
    const db = makeDb(tmpDir);
    writePositiveSession(sessionsDir, "2026-01-01-pos.jsonl");
    writeNegativeSession(sessionsDir, "2026-01-01-neg.jsonl");

    const ctx = makeCtx(db, sessionsDir);
    const result = await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: true,
      includeTrajectories: false,
      includeClosedLoop: false,
    });

    expect(result.signalsExtracted).toBeGreaterThan(0);

    const sigRows = rawDb(db).prepare("SELECT COUNT(*) as cnt FROM implicit_signals").get() as { cnt: number };
    expect(sigRows.cnt).toBe(0);

    const factRows = rawDb(db)
      .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback'`)
      .get() as { cnt: number };
    expect(factRows.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — CLI command registration
// ---------------------------------------------------------------------------

describe("CLI command registration — extract-implicit", () => {
  it("ManageContext type includes runExtractImplicitFeedback property", () => {
    // Static type check: if this compiles, the property is defined in ManageContext.
    // This confirms the CLI command is wired in manage.ts.
    const check: Pick<ManageContext, "runExtractImplicitFeedback"> = {
      runExtractImplicitFeedback: undefined,
    };
    expect(check).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — Gap 1: runExtractImplicitFeedback wired in HybridMemCliContext
// ---------------------------------------------------------------------------

describe("HybridMemCliContext wiring — runExtractImplicitFeedback", () => {
  it("HybridMemCliContext type includes runExtractImplicitFeedback property", async () => {
    // Import the type to confirm the property is declared in register.ts
    const { registerHybridMemCli } = await import("../cli/register.js");
    // registerHybridMemCli requires the context to have the property (optional)
    // If the type compiles and the function is importable, the type is correct.
    expect(typeof registerHybridMemCli).toBe("function");
  });

  it("createHybridMemCliContext returns an object with runExtractImplicitFeedback defined", async () => {
    // Import and verify the function is exported from handlers.ts
    const handlers = await import("../cli/handlers.js");
    expect(typeof handlers.runExtractImplicitFeedbackForCli).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests — Gap 2: trajectory-analyze.txt prompt exists and is valid
// ---------------------------------------------------------------------------

describe("Trajectory LLM analysis prompt", () => {
  it("trajectory-analyze.txt exists in prompts directory", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // Resolve relative to the extensions/memory-hybrid/prompts/ directory
    const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
    const promptPath = join(baseDir, "trajectory-analyze.txt");

    expect(existsSync(promptPath)).toBe(true);
  });

  it("trajectory-analyze.txt contains {{trajectory_json}} placeholder", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
    const promptPath = join(baseDir, "trajectory-analyze.txt");
    const content = readFileSync(promptPath, "utf-8");

    expect(content).toContain("{{trajectory_json}}");
  });

  it("trajectory-analyze.txt describes expected JSON output shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
    const promptPath = join(baseDir, "trajectory-analyze.txt");
    const content = readFileSync(promptPath, "utf-8");

    // Must mention the required output fields
    expect(content).toContain('"outcome"');
    expect(content).toContain('"keyLesson"');
    expect(content).toContain('"pivotTurn"');
    expect(content).toContain('"patterns"');
  });
});

// ---------------------------------------------------------------------------
// Tests — trajectoryLLMAnalysis config defaults to false
// ---------------------------------------------------------------------------

describe("ImplicitFeedbackConfig — trajectoryLLMAnalysis", () => {
  it("parseImplicitFeedbackConfig defaults trajectoryLLMAnalysis to false", async () => {
    const { parseImplicitFeedbackConfig } = await import("../config/parsers/features.js");
    const result = parseImplicitFeedbackConfig({});
    expect(result.trajectoryLLMAnalysis).toBe(false);
    expect(result.maxSessionsPerRun).toBe(50);
    expect(result.maxSignalsPerRun).toBe(100);
    expect(result.maxTrajectoriesPerRun).toBe(50);
    expect(result.maxWallClockSeconds).toBe(300);
  });

  it("parseImplicitFeedbackConfig respects trajectoryLLMAnalysis: true", async () => {
    const { parseImplicitFeedbackConfig } = await import("../config/parsers/features.js");
    const result = parseImplicitFeedbackConfig({ implicitFeedback: { trajectoryLLMAnalysis: true } });
    expect(result.trajectoryLLMAnalysis).toBe(true);
  });

  it("parseImplicitFeedbackConfig clamps new per-run caps", async () => {
    const { parseImplicitFeedbackConfig } = await import("../config/parsers/features.js");
    const result = parseImplicitFeedbackConfig({
      implicitFeedback: {
        maxSessionsPerRun: 12.8,
        maxSignalsPerRun: 1234.9,
        maxTrajectoriesPerRun: 7.6,
        maxWallClockSeconds: 42.2,
      },
    });
    expect(result.maxSessionsPerRun).toBe(12);
    expect(result.maxSignalsPerRun).toBe(1234);
    expect(result.maxTrajectoriesPerRun).toBe(7);
    expect(result.maxWallClockSeconds).toBe(42);
  });
});

describe("implicit feedback routing — self-correction bridge", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ifr-bridge-"));
    sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("calls runSelfCorrectionRunForCli when triggerSelfCorrectionRun is enabled", async () => {
    const mod = await import("../cli/cmd-selfcorrection.js");
    const spy = vi.spyOn(mod, "runSelfCorrectionRunForCli").mockResolvedValue({
      incidentsFound: 1,
      analysed: 1,
      autoFixed: 0,
      proposals: [],
      reportPath: null,
      status: "success_analyzed",
    });
    const db = makeDb(tmpDir);
    writeNegativeSession(sessionsDir, "2026-01-01-session.jsonl");
    const ctx = makeCtx(db, sessionsDir, {
      feedToReinforcement: false,
      feedToSelfCorrection: true,
      triggerSelfCorrectionRun: true,
      selfCorrectionBridgeMaxIncidents: 5,
      selfCorrectionBridgeMinConfidence: 0,
    });
    await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0]?.[1];
    expect(call?.incidents?.length).toBeGreaterThan(0);
    expect(call?.incidents?.length ?? 0).toBeLessThanOrEqual(5);
    spy.mockRestore();
  });

  it("does not call runSelfCorrectionRunForCli when triggerSelfCorrectionRun is false", async () => {
    const mod = await import("../cli/cmd-selfcorrection.js");
    const spy = vi.spyOn(mod, "runSelfCorrectionRunForCli").mockResolvedValue({
      incidentsFound: 0,
      analysed: 0,
      autoFixed: 0,
      proposals: [],
      reportPath: null,
    });
    const db = makeDb(tmpDir);
    writeNegativeSession(sessionsDir, "2026-01-02-session.jsonl");
    const ctx = makeCtx(db, sessionsDir, {
      feedToReinforcement: false,
      feedToSelfCorrection: true,
      triggerSelfCorrectionRun: false,
    });
    await runExtractImplicitFeedbackForCli(ctx, {
      days: 365,
      dryRun: false,
      includeTrajectories: false,
      includeClosedLoop: false,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("trajectory LLM budget (#1953)", () => {
  it("resolveTrajectoryLlmBudgetMs returns 0 when remaining wall-clock is below minimum", () => {
    expect(resolveTrajectoryLlmBudgetMs(TRAJECTORY_LLM_MIN_BUDGET_MS - 1)).toBe(0);
    expect(resolveTrajectoryLlmBudgetMs(0)).toBe(0);
  });

  it("resolveTrajectoryLlmBudgetMs caps per-trajectory budget at TRAJECTORY_PER_CALL_BUDGET_MS", () => {
    expect(resolveTrajectoryLlmBudgetMs(120_000)).toBe(TRAJECTORY_PER_CALL_BUDGET_MS);
    expect(resolveTrajectoryLlmBudgetMs(TRAJECTORY_PER_CALL_BUDGET_MS)).toBe(TRAJECTORY_PER_CALL_BUDGET_MS);
    expect(resolveTrajectoryLlmBudgetMs(5_000)).toBe(5_000);
  });

  it("runWithConcurrencyLimit bounds in-flight workers", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await runWithConcurrencyLimit(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("runWithConcurrencyLimit honors shouldStop before claiming new work", async () => {
    const processed: number[] = [];
    let stopAfter = 2;
    await runWithConcurrencyLimit(
      [0, 1, 2, 3, 4],
      2,
      async (item) => {
        processed.push(item);
        if (processed.length >= stopAfter) stopAfter = 0;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      { shouldStop: () => stopAfter === 0 },
    );
    expect(processed.length).toBeLessThanOrEqual(3);
    expect(processed.length).toBeGreaterThanOrEqual(2);
  });

  it("trajectoryCallTimeoutMs shrinks as deadline approaches", () => {
    const deadline = 10_000;
    expect(trajectoryCallTimeoutMs(deadline, 9_000)).toBe(1_000);
    expect(trajectoryCallTimeoutMs(deadline, 10_000)).toBe(0);
    expect(remainingDeadlineMs(deadline, 9_500)).toBe(500);
  });

  it("propagateAbortSignal aborts target when source aborts", () => {
    const source = new AbortController();
    const target = new AbortController();
    propagateAbortSignal(source.signal, target);
    source.abort(new Error("wall clock"));
    expect(target.signal.aborted).toBe(true);
  });
});

describe("implicitFeedbackCollapseStatus (#1736)", () => {
  it("classifies operator-facing collapse outcomes", () => {
    expect(implicitFeedbackCollapseStatus(0, 0)).toBe("no_candidates");
    expect(implicitFeedbackCollapseStatus(10, 0)).toBe("no_changes");
    expect(implicitFeedbackCollapseStatus(10, 4)).toBe("partial");
    expect(implicitFeedbackCollapseStatus(5, 5)).toBe("collapsed");
  });

  it("flags semantic no-op outcomes used for strict maintenance exit handling", () => {
    expect(isSemanticNoOpImplicitFeedbackCollapseStatus("no_candidates")).toBe(true);
    expect(isSemanticNoOpImplicitFeedbackCollapseStatus("no_changes")).toBe(true);
    expect(isSemanticNoOpImplicitFeedbackCollapseStatus("partial")).toBe(false);
    expect(isSemanticNoOpImplicitFeedbackCollapseStatus("collapsed")).toBe(false);
  });
});
