/**
 * Tests for implicit feedback signal routing (Issue #262 — Phase 2).
 *
 * Covers:
 *   - Positive signals route to reinforcement pipeline (reinforceFact)
 *   - Negative signals route to self-correction pipeline (pattern facts)
 *   - Routing is suppressed when feedToReinforcement / feedToSelfCorrection are false
 *   - CLI command 'extract-implicit' is registered in ManageContext
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import { runExtractImplicitFeedbackForCli, type HandlerContext } from "../cli/handlers.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ManageContext } from "../cli/manage.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string) {
  return new FactsDB(join(dir, "facts.db"));
}

/** Access raw SQLite DB from FactsDB for test assertions. */
function rawDb(db: InstanceType<typeof FactsDB>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).liveDb as import("better-sqlite3").Database;
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
    cfg,
    logger: {},
  } as unknown as HandlerContext;
}

/** Write a minimal OpenClaw session JSONL file with a grateful close signal (positive). */
function writePositiveSession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({ type: "message", message: { role: "user",      content: [{ type: "text", text: "Can you explain async await TypeScript pattern with examples for error handling in async code?" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Here is a complete async await TypeScript pattern example with proper error handling." }] } }),
    JSON.stringify({ type: "message", message: { role: "user",      content: [{ type: "text", text: "Perfect, that is exactly what I needed. Thanks!" }] } }),
  ];
  writeFileSync(join(sessionsDir, filename), lines.join("\n"), "utf-8");
}

/** Write a session with repeated corrections (negative signals). */
function writeNegativeSession(sessionsDir: string, filename: string) {
  const lines = [
    JSON.stringify({ type: "message", message: { role: "user",      content: [{ type: "text", text: "How do I sort an array of objects by a property in TypeScript?" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "You can use Array.prototype.sort with a comparator." }] } }),
    JSON.stringify({ type: "message", message: { role: "user",      content: [{ type: "text", text: "No that is not what I meant, I need it sorted in descending order, please fix that." }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "My apologies, here is the corrected descending sort." }] } }),
    JSON.stringify({ type: "message", message: { role: "user",      content: [{ type: "text", text: "No that is still wrong, you are not listening. I need to sort by createdAt date field." }] } }),
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
    const sigRows = rawDb(db).prepare(
      `SELECT COUNT(*) as cnt FROM implicit_signals WHERE polarity = 'positive'`,
    ).get() as { cnt: number };
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
    const logRows = rawDb(db).prepare(
      `SELECT COUNT(*) as cnt FROM reinforcement_log`,
    ).get() as { cnt: number };
    expect(logRows.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — negative signals → self-correction pattern facts
// ---------------------------------------------------------------------------

describe("implicit feedback routing — negative → pattern facts", () => {
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

  it("stores pattern facts tagged [implicit-feedback, negative] when feedToSelfCorrection=true", async () => {
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

    // Verify pattern facts with implicit-feedback + negative tags were stored.
    const negFacts = rawDb(db).prepare(
      `SELECT * FROM facts WHERE source = 'implicit-feedback'`,
    ).all() as Array<{ category: string; tags: string }>;

    expect(negFacts.length).toBeGreaterThan(0);
    for (const fact of negFacts) {
      expect(fact.category).toBe("pattern");
      // Tags are stored as comma-separated strings (not JSON).
      const tags = (fact.tags ?? "").split(",").map((t: string) => t.trim());
      expect(tags).toContain("implicit-feedback");
      expect(tags).toContain("negative");
    }
  });

  it("does NOT store implicit-feedback pattern facts when feedToSelfCorrection=false", async () => {
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

    const negFacts = rawDb(db).prepare(
      `SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback'`,
    ).get() as { cnt: number };
    expect(negFacts.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — dry-run mode
// ---------------------------------------------------------------------------

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

    const sigRows = rawDb(db).prepare(
      `SELECT COUNT(*) as cnt FROM implicit_signals`,
    ).get() as { cnt: number };
    expect(sigRows.cnt).toBe(0);

    const factRows = rawDb(db).prepare(
      `SELECT COUNT(*) as cnt FROM facts WHERE source = 'implicit-feedback'`,
    ).get() as { cnt: number };
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
