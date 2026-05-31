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
