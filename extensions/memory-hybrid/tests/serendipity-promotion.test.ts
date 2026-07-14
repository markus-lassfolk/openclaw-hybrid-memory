/**
 * Tests for serendipity promotion (Issue #2119, phase 2): goal/task/skill
 * hand-off + the sweep's idle auto-promotion.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SerendipityStore } from "../backends/serendipity-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { listActiveGoals } from "../services/goal-stewardship.js";
import { promoteToGoal, promoteToSkillProposal, promoteToTask } from "../services/serendipity-promotion.js";
import { runSerendipitySweep } from "../services/serendipity-sweep-cron.js";
import type { HybridMemoryConfig } from "../config.js";

const EMB = { provider: "ollama", model: "nomic-embed-text" };
function cfgWith(extra: Record<string, unknown>): HybridMemoryConfig {
  return parseConfig({ embedding: EMB, serendipityProtocol: { enabled: true }, ...extra }) as HybridMemoryConfig;
}

let tmpDir: string;
let goalsDir: string;
let store: SerendipityStore;
let savedStateDir: string | undefined;

function newFinding(store: SerendipityStore, title = "packaging defect") {
  return store.create({
    title,
    description: "lancedb needs apache-arrow",
    findingType: "packaging_defect",
    riskLevel: "high",
    suggestedAction: "fix_now",
    adjacency: "direct",
    evidence: ["package.json diff"],
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "serendipity-promotion-test-"));
  goalsDir = join(tmpDir, "goals");
  store = new SerendipityStore(join(tmpDir, "serendipity.db"));
  savedStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir; // route Skill Workshop proposals into tmp
});

afterEach(() => {
  store.close();
  if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = savedStateDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("promoteToGoal", () => {
  it("creates a goal, links it, and marks the finding proposed", async () => {
    const cfg = cfgWith({ goalStewardship: { enabled: true } });
    const finding = newFinding(store);
    const res = await promoteToGoal(finding, { store, cfg, goalsDir, eventLog: null });
    expect(res.ok).toBe(true);
    expect(res.refId).toBeTruthy();
    expect(await listActiveGoals(goalsDir)).toHaveLength(1);
    const updated = store.get(finding.id);
    expect(updated?.status).toBe("proposed");
    expect(updated?.metadata.goalId).toBe(res.refId);
  });

  it("fails when goal stewardship is disabled", async () => {
    const cfg = cfgWith({}); // goalStewardship disabled by default
    const res = await promoteToGoal(newFinding(store), { store, cfg, goalsDir, eventLog: null });
    expect(res.ok).toBe(false);
  });
});

describe("promoteToTask", () => {
  it("fails gracefully when the active-task ledger deps are unavailable", async () => {
    const cfg = cfgWith({});
    const res = await promoteToTask(newFinding(store), { store, cfg });
    expect(res.ok).toBe(false);
  });
});

describe("promoteToSkillProposal", () => {
  it("writes a Skill Workshop proposal, links it, and marks the finding proposed", async () => {
    const cfg = cfgWith({});
    const finding = newFinding(store, "recurring friction");
    const res = await promoteToSkillProposal(finding, { store, cfg });
    expect(res.ok).toBe(true);
    expect(res.refId).toBeTruthy();
    expect(existsSync(join(tmpDir, "skill-workshop", "proposals", res.refId as string))).toBe(true);
    const updated = store.get(finding.id);
    expect(updated?.status).toBe("proposed");
    expect(updated?.relatedSkills).toContain(res.refId);
  });
});

describe("sweep idle auto-promotion", () => {
  it("promotes top backlog findings to goals when dispatch is enabled", async () => {
    const cfg = cfgWith({
      defaultLevel: 4,
      goalStewardship: { enabled: true },
      serendipityProtocol: {
        enabled: true,
        defaultLevel: 4,
        sweep: { enabled: true, minLevel: 4, dispatch: true, target: "goal", maxDispatch: 2 },
      },
    });
    newFinding(store, "finding one");
    newFinding(store, "finding two");
    const summary = await runSerendipitySweep({ cfg, store, promotion: { goalsDir, eventLog: null } });
    expect(summary.status).toBe("ok");
    expect(summary.dispatched.filter((d) => d.ok).length).toBe(2);
    expect(await listActiveGoals(goalsDir)).toHaveLength(2);
    // Promoted findings leave the actionable backlog.
    expect(store.listActionableDeferred({ level: 4 })).toHaveLength(0);
  });
});
