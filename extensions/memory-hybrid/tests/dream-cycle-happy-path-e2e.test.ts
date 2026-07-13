/**
 * End-to-end happy-path test for runDreamCycle: every other dream-cycle test gives it a rejecting
 * LLM/embeddings stub and a `{}`-stubbed vectorDb, so reflection/reflect-rules/vector-reconcile are
 * only ever exercised in their "gracefully degraded" branch, never a genuine success path with real
 * counts. This file uses a real FactsDB + EventLog + VectorDB and working (non-rejecting) LLM/
 * embedding stubs to exercise the actual multi-stage sequence — prune, orphan-vector reconcile,
 * reflection, MEMORY_INDEX.md refresh — end to end with real, assertable side effects.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { type DreamCycleConfig, runDreamCycle } from "../services/dream-cycle.js";
import { getEnv, setEnv } from "../utils/env-manager.js";

const { FactsDB, EventLog, VectorDB } = _testing;

const DIM = 3;
const silentLogger = { info: () => undefined, warn: () => undefined };

function makeWorkingOpenAI() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content:
                  "PATTERN: User consistently reviews deploy logs after each release to catch regressions early\n" +
                  "PATTERN: A failed deployment is always followed by an automatic rollback within the hour",
              },
            },
          ],
        }),
      },
    },
  } as never;
}

function makeWorkingEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    modelName: "test-embedding-model",
  } as never;
}

describe("runDreamCycle happy path e2e (real FactsDB + VectorDB + working LLM/embeddings)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let eventLog: InstanceType<typeof EventLog>;

  const baseConfig: DreamCycleConfig = {
    enabled: true,
    schedule: "45 2 * * *",
    reflectWindowDays: 7,
    pruneMode: "both",
    model: "gpt-4o-mini",
    consolidateAfterDays: 7,
    eventLogArchivalDays: 90,
    eventLogArchivePath: join(tmpdir(), "dream-cycle-happy-path-archive"),
    maxUnconsolidatedAgeDays: 90,
    maxEventsPerConsolidation: 200,
    logRetentionDays: 30,
    vacuumOnCycle: false,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-cycle-happy-path-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
    eventLog = new EventLog(join(tmpDir, "event-log.db"));
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    eventLog.close();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs the full stage sequence successfully with real counts: prune, orphan-vector reconcile, reflection, MEMORY_INDEX", async () => {
    // Stage 1 material: an expired fact (prune) and a genuine Lance orphan vector (no matching
    // active fact) for the vector-reconcile substep to actually find and remove.
    const nowSec = Math.floor(Date.now() / 1000);
    factsDb.store({
      text: "Expired scratch note",
      category: "fact",
      importance: 0.3,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: nowSec - 100,
    });
    const orphanVectorId = "11111111-1111-4111-8111-111111111111";
    await vectorDb.store({
      id: orphanVectorId,
      text: "orphaned vector with no matching fact",
      vector: [0.4, 0.5, 0.6],
      importance: 0.5,
      category: "fact",
    });

    // Stage 3 material: >= minObservations (2, hardcoded in dream-cycle's own reflection call) recent
    // facts so reflection actually calls the LLM instead of self-skipping.
    factsDb.store({
      text: "User always reviews deploy logs after each release to catch regressions early",
      category: "decision",
      importance: 0.8,
      entity: "Release",
      key: null,
      value: null,
      source: "test",
    });
    factsDb.store({
      text: "A failed deployment is always followed by an automatic rollback within the hour",
      category: "decision",
      importance: 0.8,
      entity: "Release",
      key: null,
      value: null,
      source: "test",
    });

    // MEMORY_INDEX.md would otherwise resolve against the real OpenClaw workspace root — redirect
    // it into the temp dir for the duration of this run (matches tests/dream-cycle.test.ts's own
    // pattern for the same stage).
    const originalWorkspace = getEnv("OPENCLAW_WORKSPACE");
    setEnv("OPENCLAW_WORKSPACE", tmpDir);

    const openaiStub = makeWorkingOpenAI();
    let result: Awaited<ReturnType<typeof runDreamCycle>>;
    try {
      result = await runDreamCycle(
        factsDb,
        vectorDb as never,
        makeWorkingEmbeddings(),
        openaiStub,
        eventLog,
        baseConfig,
        silentLogger,
      );
    } finally {
      if (originalWorkspace !== undefined) setEnv("OPENCLAW_WORKSPACE", originalWorkspace);
      else setEnv("OPENCLAW_WORKSPACE", undefined);
    }

    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);
    expect(result.failedStages).toEqual([]);

    // Stage 1: prune + orphan-vector reconcile actually ran against the real stores.
    expect(result.factsPruned).toBe(1);
    expect(result.orphanVectorsRemoved).toBe(1);
    const remainingVectorIds = await vectorDb.getAllIds();
    expect(remainingVectorIds).not.toContain(orphanVectorId);

    // Stage 3: reflection genuinely called the working LLM stub and stored real patterns — not
    // just "didn't throw", the degraded/rejecting-stub branch every other test exercises instead.
    expect(result.patternsFound).toBeGreaterThan(0);
    const patternFacts = factsDb.getByCategory("pattern");
    expect(patternFacts.length).toBe(result.patternsFound);

    // Stage 5: MEMORY_INDEX.md was actually written to disk with real content.
    const indexPath = join(tmpDir, "MEMORY_INDEX.md");
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf-8").length).toBeGreaterThan(0);
  });
});
