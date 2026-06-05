/**
 * Degraded recall path — narrative block wiring (sessionKey vs sanitized sessionId).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { buildDegradedFtsHotRecallStage } from "../lifecycle/stage-recall/degraded-recall.js";
import {
  buildRecallLifecycleContext,
  DEFAULT_TEST_SESSION_KEY,
  makeMockStageApi,
  makeRecallSessionState,
  seedSessionRecallQueueDepth,
} from "./helpers/lifecycle-recall-harness.js";

describe("buildDegradedFtsHotRecallStage narrative block", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let narrativesDb: NarrativesDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "degraded-recall-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    narrativesDb = new NarrativesDB(join(tmpDir, "narratives.db"));
  });

  afterEach(() => {
    narrativesDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes narrative summaries when sessionKey is passed to recallNarrativeSummaries", async () => {
    narrativesDb.store({
      sessionId: DEFAULT_TEST_SESSION_KEY,
      periodStart: 1_774_224_000,
      periodEnd: 1_774_224_600,
      tag: "session",
      narrativeText: "Earlier we debugged the deploy pipeline and fixed CI retries.",
    });

    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      autoRecall: { narrativeMaxTokens: 500, degradationQueueDepth: 1 },
    });
    ctx.narrativesDb = narrativesDb;

    vi.spyOn(factsDb, "search").mockReturnValue([]);
    const sessionState = makeRecallSessionState();
    seedSessionRecallQueueDepth(sessionState, 1);
    const api = makeMockStageApi();

    const result = await buildDegradedFtsHotRecallStage(
      { prompt: "what happened with the deploy pipeline?" },
      api as never,
      ctx,
      sessionState,
      "queue",
    );

    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.prependContext).toContain("<recent-history-narratives>");
      expect(result.prependContext).toContain("deploy pipeline");
      expect(result.prependContext).toContain(`sessionKey: ${DEFAULT_TEST_SESSION_KEY}`);
    }
  });
});
