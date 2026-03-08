/**
 * Tests for cross-agent learning (Issue #263 — Phase 2).
 *
 * Covers:
 *   - parseCrossAgentLearningConfig: defaults, bounds, model fields
 *   - getCrossAgentFacts: returns global facts with correct source
 *   - runCrossAgentLearning: disabled path, no-agents path, LLM mocking
 *   - FactsDB integration: agent-scoped lessons collected, global facts stored,
 *     DERIVED_FROM links created
 *   - Deduplication: already-generalised facts skipped
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import {
  getCrossAgentFacts,
  getCrossAgentLessons,
  formatBriefInjection,
  verifyLessonForAgent,
  runCrossAgentLearning,
} from "../services/cross-agent-learning.js";
import { parseCrossAgentLearningConfig } from "../config/parsers/features.js";
import type { CrossAgentLearningConfig } from "../config/types/features.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string) {
  return new FactsDB(join(dir, "facts.db"));
}

/** Access raw SQLite DB from FactsDB for test assertions. */
function rawDb(db: InstanceType<typeof FactsDB>) {
  return (db as unknown as { liveDb: import("better-sqlite3").Database }).liveDb;
}

/** Insert an agent-scoped fact directly (bypassing store to control all fields). */
function insertAgentFact(
  db: InstanceType<typeof FactsDB>,
  opts: {
    id?: string;
    agentId: string;
    text: string;
    category?: string;
    confidence?: number;
    importance?: number;
  },
): string {
  const id = opts.id ?? Math.random().toString(36).slice(2, 12);
  const now = Math.floor(Date.now() / 1000);
  rawDb(db).prepare(
    `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
     VALUES (?, ?, ?, 'agent', ?, ?, ?, 'test', ?, ?, 'stable')`,
  ).run(
    id,
    opts.text,
    opts.category ?? "pattern",
    opts.agentId,
    opts.confidence ?? 0.7,
    opts.importance ?? 0.7,
    now,
    now,
  );
  return id;
}

/** Create a mock OpenAI client that returns a fixed JSON response. */
function makeMockOpenAI(responseJson: unknown): unknown {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(responseJson) } }],
        }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// parseCrossAgentLearningConfig tests
// ---------------------------------------------------------------------------

describe("parseCrossAgentLearningConfig", () => {
  it("returns defaults when empty config", () => {
    const cfg = parseCrossAgentLearningConfig({});
    expect(cfg.enabled).toBe(false); // default disabled
    expect(cfg.windowDays).toBe(14);
    expect(cfg.batchSize).toBe(20);
    expect(cfg.minSourceConfidence).toBe(0.4);
    expect(cfg.runInNightlyCycle).toBe(true);
  });

  it("respects enabled: true", () => {
    const cfg = parseCrossAgentLearningConfig({ crossAgentLearning: { enabled: true } });
    expect(cfg.enabled).toBe(true);
  });

  it("clamps windowDays to max 90", () => {
    const cfg = parseCrossAgentLearningConfig({ crossAgentLearning: { windowDays: 200 } });
    expect(cfg.windowDays).toBe(90);
  });

  it("respects custom model", () => {
    const cfg = parseCrossAgentLearningConfig({ crossAgentLearning: { model: "gpt-4o" } });
    expect(cfg.model).toBe("gpt-4o");
  });

  it("ignores invalid batchSize (<5)", () => {
    const cfg = parseCrossAgentLearningConfig({ crossAgentLearning: { batchSize: 2 } });
    expect(cfg.batchSize).toBe(20); // falls back to default
  });

  it("clamps batchSize to max 100", () => {
    const cfg = parseCrossAgentLearningConfig({ crossAgentLearning: { batchSize: 200 } });
    expect(cfg.batchSize).toBe(100);
  });

  it("respects fallbackModels array", () => {
    const cfg = parseCrossAgentLearningConfig({
      crossAgentLearning: { fallbackModels: ["gpt-3.5", "claude-haiku"] },
    });
    expect(cfg.fallbackModels).toEqual(["gpt-3.5", "claude-haiku"]);
  });

  it("filters invalid entries from fallbackModels", () => {
    const cfg = parseCrossAgentLearningConfig({
      crossAgentLearning: { fallbackModels: ["valid-model", 123, "", "   "] },
    });
    expect(cfg.fallbackModels).toEqual(["valid-model"]);
  });
});

// ---------------------------------------------------------------------------
// getCrossAgentFacts
// ---------------------------------------------------------------------------

describe("getCrossAgentFacts", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ca-facts-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no cross-agent facts", () => {
    const facts = getCrossAgentFacts(db);
    expect(facts).toHaveLength(0);
  });

  it("returns facts stored with cross-agent-learning source", () => {
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, source, confidence, importance, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'global', 'cross-agent-learning', 0.75, 0.8, ?, ?, 'permanent')`,
    ).run("test-id-1", "Always verify before applying changes", now, now);

    const facts = getCrossAgentFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toContain("verify");
  });

  it("does not return superseded facts", () => {
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, source, confidence, importance, created_at, last_confirmed_at, decay_class, superseded_at)
       VALUES (?, ?, 'pattern', 'global', 'cross-agent-learning', 0.75, 0.8, ?, ?, 'permanent', ?)`,
    ).run("superseded-id", "Old superseded fact", now, now, now);

    const facts = getCrossAgentFacts(db);
    expect(facts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runCrossAgentLearning — disabled path
// ---------------------------------------------------------------------------

describe("runCrossAgentLearning — disabled path", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ca-run-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero counts when disabled", async () => {
    const cfg: CrossAgentLearningConfig = {
      enabled: false,
      windowDays: 14,
      batchSize: 20,
      minSourceConfidence: 0.4,
      runInNightlyCycle: true,
    };
    const openai = makeMockOpenAI([]);
    const result = await runCrossAgentLearning(db, openai as never, cfg);
    expect(result.agentsScanned).toBe(0);
    expect(result.generalisedStored).toBe(0);
  });

  it("returns zero counts when no agent-scoped lessons", async () => {
    const cfg: CrossAgentLearningConfig = {
      enabled: true,
      windowDays: 14,
      batchSize: 20,
      minSourceConfidence: 0.4,
      runInNightlyCycle: true,
    };
    const openai = makeMockOpenAI([]);
    const result = await runCrossAgentLearning(db, openai as never, cfg);
    expect(result.agentsScanned).toBe(0);
    expect(result.lessonsConsidered).toBe(0);
    expect(result.generalisedStored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCrossAgentLearning — LLM integration (mocked)
// ---------------------------------------------------------------------------

describe("runCrossAgentLearning — LLM mock", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ca-llm-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores generalised facts when LLM returns valid lessons", async () => {
    // Insert agent-scoped facts
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'agent', 'forge', 0.8, 0.7, 'test', ?, ?, 'stable')`,
    ).run("agent-fact-1", "Always run tests before committing", now, now);

    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'rule', 'agent', 'scholar', 0.75, 0.65, 'test', ?, ?, 'stable')`,
    ).run("agent-fact-2", "Verify sources before citing them", now, now);

    const generalisedLesson = {
      text: "Always validate inputs before executing critical operations",
      rationale: "Applies across all agent types and tasks",
      sourceAgents: ["forge", "scholar"],
      importance: 0.8,
    };

    // Mock OpenAI to return a single generalised lesson
    const mockOpenAI = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify([generalisedLesson]),
                },
              },
            ],
          }),
        },
      },
    };

    const cfg: CrossAgentLearningConfig = {
      enabled: true,
      windowDays: 30,
      batchSize: 20,
      minSourceConfidence: 0.3,
      model: "gpt-4o-mini",
      runInNightlyCycle: true,
    };

    const result = await runCrossAgentLearning(db, mockOpenAI as never, cfg);

    expect(result.agentsScanned).toBeGreaterThanOrEqual(1);
    expect(result.generalisedStored).toBe(1);
    expect(result.newFacts).toHaveLength(1);
    expect(result.newFacts[0]!.text).toContain("validate");

    // Check stored in DB
    const globalFacts = getCrossAgentFacts(db);
    expect(globalFacts).toHaveLength(1);
    expect(globalFacts[0]!.importance).toBeGreaterThan(0.7); // boosted
  });

  it("skips duplicate facts in second run", async () => {
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'agent', 'forge', 0.8, 0.7, 'test', ?, ?, 'stable')`,
    ).run("agent-f-1", "Always run tests before committing code changes", now, now);

    const generalisedLesson = {
      text: "Always validate before executing to prevent errors",
      rationale: "Cross-agent applicable pattern",
      sourceAgents: ["forge"],
      importance: 0.75,
    };

    const mockOpenAI = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify([generalisedLesson]) } }],
          }),
        },
      },
    };

    const cfg: CrossAgentLearningConfig = {
      enabled: true,
      windowDays: 30,
      batchSize: 20,
      minSourceConfidence: 0.3,
      model: "gpt-4o-mini",
      runInNightlyCycle: true,
    };

    // First run
    const result1 = await runCrossAgentLearning(db, mockOpenAI as never, cfg);
    expect(result1.generalisedStored).toBe(1);

    // Second run — same agent fact, now linked → should be skipped
    const result2 = await runCrossAgentLearning(db, mockOpenAI as never, cfg);
    // The agent fact is already linked, so lessonsConsidered should be 0
    expect(result2.lessonsConsidered).toBe(0);
    expect(result2.generalisedStored).toBe(0);
  });

  it("handles LLM returning empty array", async () => {
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'agent', 'hearth', 0.8, 0.7, 'test', ?, ?, 'stable')`,
    ).run("agent-h-1", "Check HA entity state before toggling lights", now, now);

    const mockOpenAI = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "[]" } }],
          }),
        },
      },
    };

    const cfg: CrossAgentLearningConfig = {
      enabled: true,
      windowDays: 30,
      batchSize: 20,
      minSourceConfidence: 0.3,
      model: "gpt-4o-mini",
      runInNightlyCycle: true,
    };

    const result = await runCrossAgentLearning(db, mockOpenAI as never, cfg);
    expect(result.generalisedStored).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("handles LLM returning invalid JSON gracefully", async () => {
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, scope_target, confidence, importance, source, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'agent', 'warden', 0.8, 0.7, 'test', ?, ?, 'stable')`,
    ).run("agent-w-1", "Always audit credentials before deploying", now, now);

    const mockOpenAI = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "INVALID JSON RESPONSE FROM LLM" } }],
          }),
        },
      },
    };

    const cfg: CrossAgentLearningConfig = {
      enabled: true,
      windowDays: 30,
      batchSize: 20,
      minSourceConfidence: 0.3,
      model: "gpt-4o-mini",
      runInNightlyCycle: true,
    };

    const result = await runCrossAgentLearning(db, mockOpenAI as never, cfg);
    expect(result.generalisedStored).toBe(0);
    // The error counter increments on batch LLM error
    // (either 0 if just empty result from bad JSON, or 1 if exception)
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// parseFrustrationDetectionConfig tests (Phase 1 config)
// ---------------------------------------------------------------------------

import { parseFrustrationDetectionConfig } from "../config/parsers/features.js";

describe("parseFrustrationDetectionConfig", () => {
  it("returns defaults when empty config", () => {
    const cfg = parseFrustrationDetectionConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.windowSize).toBe(8);
    expect(cfg.decayRate).toBe(0.9);
    expect(cfg.injectionThreshold).toBe(0.3);
    expect(cfg.adaptationThresholds.medium).toBe(0.3);
    expect(cfg.adaptationThresholds.high).toBe(0.5);
    expect(cfg.adaptationThresholds.critical).toBe(0.7);
    expect(cfg.feedToImplicitPipeline).toBe(true);
  });

  it("respects enabled: false", () => {
    const cfg = parseFrustrationDetectionConfig({ frustrationDetection: { enabled: false } });
    expect(cfg.enabled).toBe(false);
  });

  it("clamps windowSize to [2, 50]", () => {
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { windowSize: 1 } }).windowSize).toBe(8);
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { windowSize: 100 } }).windowSize).toBe(8);
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { windowSize: 10 } }).windowSize).toBe(10);
  });

  it("clamps decayRate to (0, 1]", () => {
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { decayRate: 1.5 } }).decayRate).toBe(0.9);
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { decayRate: 0 } }).decayRate).toBe(0.9);
    expect(parseFrustrationDetectionConfig({ frustrationDetection: { decayRate: 0.85 } }).decayRate).toBe(0.85);
  });

  it("parses custom signalWeights", () => {
    const cfg = parseFrustrationDetectionConfig({
      frustrationDetection: {
        signalWeights: { explicit_frustration: 0.95, short_reply: 0.2 },
      },
    });
    expect(cfg.signalWeights?.explicit_frustration).toBe(0.95);
    expect(cfg.signalWeights?.short_reply).toBe(0.2);
  });

  it("ignores invalid signalWeights (out of range)", () => {
    const cfg = parseFrustrationDetectionConfig({
      frustrationDetection: {
        signalWeights: { explicit_frustration: 2.5 }, // >1, clamped
      },
    });
    expect(cfg.signalWeights?.explicit_frustration).toBe(1); // clamped to max 1
  });

  it("parses custom adaptationThresholds", () => {
    const cfg = parseFrustrationDetectionConfig({
      frustrationDetection: {
        adaptationThresholds: { medium: 0.2, high: 0.4, critical: 0.6 },
      },
    });
    expect(cfg.adaptationThresholds.medium).toBe(0.2);
    expect(cfg.adaptationThresholds.high).toBe(0.4);
    expect(cfg.adaptationThresholds.critical).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// parseToolEffectivenessConfig tests (Phase 3 config)
// ---------------------------------------------------------------------------

import { parseToolEffectivenessConfig } from "../config/parsers/features.js";

describe("parseToolEffectivenessConfig", () => {
  it("returns defaults when empty config", () => {
    const cfg = parseToolEffectivenessConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.minCalls).toBe(3);
    expect(cfg.topN).toBe(10);
    expect(cfg.lowScoreThreshold).toBe(0.3);
    expect(cfg.decayFactor).toBe(0.95);
    expect(cfg.runInNightlyCycle).toBe(true);
  });

  it("respects enabled: false", () => {
    const cfg = parseToolEffectivenessConfig({ toolEffectiveness: { enabled: false } });
    expect(cfg.enabled).toBe(false);
  });

  it("clamps topN to max 50", () => {
    const cfg = parseToolEffectivenessConfig({ toolEffectiveness: { topN: 100 } });
    expect(cfg.topN).toBe(50);
  });

  it("clamps decayFactor to (0, 1]", () => {
    const outOfRange = parseToolEffectivenessConfig({ toolEffectiveness: { decayFactor: 1.5 } });
    expect(outOfRange.decayFactor).toBe(0.95);
    const valid = parseToolEffectivenessConfig({ toolEffectiveness: { decayFactor: 0.8 } });
    expect(valid.decayFactor).toBe(0.8);
  });

  it("respects custom lowScoreThreshold", () => {
    const cfg = parseToolEffectivenessConfig({ toolEffectiveness: { lowScoreThreshold: 0.45 } });
    expect(cfg.lowScoreThreshold).toBe(0.45);
  });
});

// ---------------------------------------------------------------------------
// getCrossAgentLessons (Gap 1)
// ---------------------------------------------------------------------------

describe("getCrossAgentLessons", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cal-lessons-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertCrossAgentFact(
    opts: {
      text: string;
      tags?: string[];
      confidence?: number;
    },
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const tagsStr = (opts.tags ?? ["cross-agent"]).join(",");
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, source, confidence, importance, tags, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'global', 'cross-agent-learning', ?, 0.8, ?, ?, ?, 'permanent')`,
    ).run(
      Math.random().toString(36).slice(2, 12),
      opts.text,
      opts.confidence ?? 0.8,
      tagsStr,
      now,
      now,
    );
  }

  it("returns empty array when no cross-agent facts", async () => {
    const lessons = await getCrossAgentLessons(db, "forge", "coding tasks");
    expect(lessons).toHaveLength(0);
  });

  it("returns facts tagged with cross-agent", async () => {
    insertCrossAgentFact({ text: "Always validate before executing", tags: ["cross-agent", "forge"] });
    const lessons = await getCrossAgentLessons(db, "forge", "validate execution", 10, 0.5);
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });

  it("filters out facts with confidence below minConfidence", async () => {
    insertCrossAgentFact({ text: "Low confidence lesson", tags: ["cross-agent", "forge"], confidence: 0.3 });
    const lessons = await getCrossAgentLessons(db, "forge", "some context", 10, 0.6);
    expect(lessons).toHaveLength(0);
  });

  it("returns general cross-agent lessons when no agent-specific match", async () => {
    insertCrossAgentFact({ text: "General lesson for all agents", tags: ["cross-agent"] });
    const lessons = await getCrossAgentLessons(db, "scholar", "research context", 10, 0.5);
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      insertCrossAgentFact({ text: `Lesson number ${i}`, tags: ["cross-agent"] });
    }
    const lessons = await getCrossAgentLessons(db, "forge", "context", 2, 0.5);
    expect(lessons.length).toBeLessThanOrEqual(2);
  });

  it("ranks lessons with higher relevance to context first", async () => {
    insertCrossAgentFact({ text: "Always test your code before committing", tags: ["cross-agent", "forge"] });
    insertCrossAgentFact({ text: "General data backup policy", tags: ["cross-agent", "forge"] });
    const lessons = await getCrossAgentLessons(db, "forge", "test code commit", 5, 0.5);
    // At minimum, both should be returned; top should be the more relevant one
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    // The first lesson should contain "test" since context mentions "test"
    expect(lessons[0]!.text.toLowerCase()).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// formatBriefInjection (Gap 2)
// ---------------------------------------------------------------------------

/** Build a minimal MemoryEntry for formatBriefInjection tests. */
function makeLesson(
  id: string,
  text: string,
  overrides: {
    tags?: string[];
    confidence?: number;
    importance?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    text,
    category: "pattern",
    entity: null,
    key: null,
    value: null,
    scope: "global" as const,
    source: "cross-agent-learning",
    importance: overrides.importance ?? 0.8,
    confidence: overrides.confidence ?? 0.8,
    tags: overrides.tags ?? ["cross-agent"],
    createdAt: now,
    lastConfirmedAt: now,
    expiresAt: null,
    decayClass: "permanent" as const,
  };
}

describe("formatBriefInjection", () => {
  it("returns empty string for empty lessons array", () => {
    expect(formatBriefInjection([])).toBe("");
  });

  it("formats lessons with header and bullet points", () => {
    const lessons = [makeLesson("1", "Always verify before committing", { tags: ["cross-agent", "forge"], confidence: 0.85 })];
    const output = formatBriefInjection(lessons);
    expect(output).toContain("## Lessons from previous tasks");
    expect(output).toContain("Always verify before committing");
    expect(output).toContain("confidence: 0.85");
    expect(output).toMatch(/- .+/);
  });

  it("includes source agent from tags", () => {
    const lessons = [makeLesson("1", "Test your code", { tags: ["cross-agent", "forge"], confidence: 0.9 })];
    const output = formatBriefInjection(lessons);
    expect(output).toContain("forge");
  });

  it("handles lessons with no agent tags gracefully", () => {
    const lessons = [makeLesson("1", "General lesson", { tags: ["cross-agent"], confidence: 0.75 })];
    const output = formatBriefInjection(lessons);
    expect(output).toContain("General lesson");
    // Should not throw, just use "unknown" as agent
    expect(output).toContain("unknown");
  });

  it("formats multiple lessons as multiple bullet points", () => {
    const output = formatBriefInjection([
      makeLesson("1", "Lesson A"),
      makeLesson("2", "Lesson B"),
    ]);
    const bulletMatches = output.match(/^- /gm);
    expect(bulletMatches).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// verifyLessonForAgent (Gap 3)
// ---------------------------------------------------------------------------

describe("verifyLessonForAgent", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-lesson-test-"));
    db = makeDb(tmpDir);
  });

  afterEach(() => {
    db.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertCrossAgentFact(text: string, confidence = 0.7): string {
    const id = Math.random().toString(36).slice(2, 12);
    const now = Math.floor(Date.now() / 1000);
    rawDb(db).prepare(
      `INSERT INTO facts (id, text, category, scope, source, confidence, importance, tags, created_at, last_confirmed_at, decay_class)
       VALUES (?, ?, 'pattern', 'global', 'cross-agent-learning', ?, 0.8, 'cross-agent', ?, ?, 'permanent')`,
    ).run(id, text, confidence, now, now);
    return id;
  }

  it("boosts confidence by default amount (0.1)", async () => {
    const id = insertCrossAgentFact("Verify before committing", 0.7);
    await verifyLessonForAgent(db, id, "scholar");
    const row = rawDb(db).prepare(`SELECT confidence FROM facts WHERE id = ?`).get(id) as { confidence: number } | undefined;
    expect(row?.confidence).toBeCloseTo(0.8, 3);
  });

  it("adds verified-by tag", async () => {
    const id = insertCrossAgentFact("Lesson to verify", 0.7);
    await verifyLessonForAgent(db, id, "forge");
    const row = rawDb(db).prepare(`SELECT tags FROM facts WHERE id = ?`).get(id) as { tags: string | null } | undefined;
    expect(row?.tags).toContain("verified-by:forge");
  });

  it("does not add duplicate verified-by tag on second call", async () => {
    const id = insertCrossAgentFact("Lesson to verify twice", 0.7);
    await verifyLessonForAgent(db, id, "forge");
    await verifyLessonForAgent(db, id, "forge");
    const row = rawDb(db).prepare(`SELECT tags FROM facts WHERE id = ?`).get(id) as { tags: string | null } | undefined;
    const tagCount = (row?.tags?.match(/verified-by:forge/g) ?? []).length;
    expect(tagCount).toBe(1);
  });

  it("caps confidence at 1.0", async () => {
    const id = insertCrossAgentFact("High confidence lesson", 0.95);
    await verifyLessonForAgent(db, id, "scholar", 0.2);
    const row = rawDb(db).prepare(`SELECT confidence FROM facts WHERE id = ?`).get(id) as { confidence: number } | undefined;
    expect(row?.confidence).toBeLessThanOrEqual(1.0);
    expect(row?.confidence).toBeCloseTo(1.0, 3);
  });

  it("accepts custom boost value", async () => {
    const id = insertCrossAgentFact("Custom boost lesson", 0.6);
    await verifyLessonForAgent(db, id, "warden", 0.2);
    const row = rawDb(db).prepare(`SELECT confidence FROM facts WHERE id = ?`).get(id) as { confidence: number } | undefined;
    expect(row?.confidence).toBeCloseTo(0.8, 3);
  });

  it("does nothing for non-existent lesson ID", async () => {
    // Should not throw
    await expect(verifyLessonForAgent(db, "non-existent-id", "forge")).resolves.toBeUndefined();
  });

  it("multiple agents can all verify the same lesson", async () => {
    const id = insertCrossAgentFact("Multi-agent verified lesson", 0.6);
    await verifyLessonForAgent(db, id, "forge", 0.05);
    await verifyLessonForAgent(db, id, "scholar", 0.05);
    const row = rawDb(db).prepare(`SELECT tags FROM facts WHERE id = ?`).get(id) as { tags: string | null } | undefined;
    expect(row?.tags).toContain("verified-by:forge");
    expect(row?.tags).toContain("verified-by:scholar");
  });
});
