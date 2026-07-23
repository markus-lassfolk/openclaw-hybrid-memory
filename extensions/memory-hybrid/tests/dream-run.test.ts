/**
 * Unified Dream facade (#2171).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { nightlyStepsOwnedByDream, runDream } from "../services/dream-run.js";

function dreamCfg(partial: Partial<DreamingConfig> = {}): DreamingConfig {
  return {
    ...structuredClone(DEFAULT_DREAMING_CONFIG),
    enabled: true,
    candidateStore: { enabled: true, shadow: true },
    autoPromote: {
      enabled: false,
      requireProvenance: true,
      blockOnContradictionWorsening: true,
    },
    ...partial,
  };
}

describe("runDream (#2171)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let store: DreamCandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dream-run-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    store = new DreamCandidateStore(factsDb.getRawDb());
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates dream_run + candidate even when promote disabled", async () => {
    const before = factsDb.count();
    const distill = vi.fn(async () => ({ detail: "distill-ok" }));
    const reflect = vi.fn(async () => ({ detail: "reflect-ok" }));

    const result = await runDream({
      factsDb,
      store,
      cfg: dreamCfg({ compose: ["distill", "reflect"], promoteAfterRun: false }),
      sessionIds: ["s1", "s2", "s3"],
      steps: { distill, reflect },
      promote: false,
    });

    expect(result.dreamRunId).toMatch(/^dream-/);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.promoteResult).toBeUndefined();
    expect(result.costFeature).toBe(CostFeature.dream);
    expect(distill).toHaveBeenCalledOnce();
    expect(reflect).toHaveBeenCalledOnce();

    const run = store.getDreamRun(result.dreamRunId);
    expect(run).toBeTruthy();
    expect(run!.sessionIds).toEqual(["s1", "s2", "s3"]);
    expect(store.listCandidateEntries(result.dreamRunId).length).toBeGreaterThanOrEqual(1);
    // Curriculum candidate is not applied when promote is off.
    expect(factsDb.count()).toBe(before);
  });

  it("drops reflect when dream-cycle-core is also composed", async () => {
    const reflect = vi.fn(async () => ({ detail: "reflect" }));
    const core = vi.fn(async () => ({ detail: "core" }));
    const result = await runDream({
      factsDb,
      store,
      cfg: dreamCfg({ compose: ["reflect", "dream-cycle-core"] }),
      steps: { reflect, "dream-cycle-core": core },
      promote: false,
    });
    expect(reflect).not.toHaveBeenCalled();
    expect(core).toHaveBeenCalledOnce();
    expect(result.stepSummaries.some((s) => s.step === "dream-cycle-core")).toBe(true);
  });

  it("nightlyStepsOwnedByDream respects skipNightlyOverlap", () => {
    const owned = nightlyStepsOwnedByDream(
      dreamCfg({
        enabled: true,
        skipNightlyOverlap: true,
        compose: ["distill", "contradictions", "reflect", "consolidate"],
      }),
    );
    expect(owned.has("distill")).toBe(true);
    expect(owned.has("resolve-contradictions")).toBe(true);
    expect(owned.has("reflect")).toBe(true);
    expect(owned.has("consolidate")).toBe(true);

    const none = nightlyStepsOwnedByDream(dreamCfg({ enabled: false }));
    expect(none.size).toBe(0);
  });
});
