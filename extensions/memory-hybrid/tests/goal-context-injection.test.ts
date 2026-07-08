import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import {
  buildCompactActiveGoalsPrepend,
  buildLightweightStewardshipDirective,
  buildSubagentLinkedGoalsPrepend,
  resolveGoalsForSubagentContext,
} from "../services/goal-context-injection.js";
import { createGoal } from "../services/goal-registry.js";
import type { Goal } from "../services/goal-stewardship-types.js";
import { goalDefaults, makeTempDir } from "./helpers/goal-helpers.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g-1",
    label: "deploy-api",
    description: "Deploy API to production",
    acceptanceCriteria: ["health check passes"],
    status: "active",
    priority: "high",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAssessedAt: null,
    lastDispatchedAt: null,
    assessmentCount: 0,
    dispatchCount: 0,
    currentBlockers: [],
    lastOutcome: null,
    maxDispatches: 5,
    maxAssessments: 10,
    cooldownMinutes: 10,
    escalateAfterFailures: 3,
    consecutiveFailures: 0,
    lastBlockerFingerprint: null,
    sameBlockerStreak: 0,
    circuitBreakerLastProgressAssessmentCount: 0,
    humanEscalationSummary: null,
    escalationKind: null,
    linkedTasks: [],
    history: [],
    ...overrides,
  };
}

describe("goal-context-injection", () => {
  it("builds compact prepend with goal_list hint", () => {
    const text = buildCompactActiveGoalsPrepend([makeGoal()], { maxChars: 2500, maxGoals: 5 });
    expect(text).toContain("<active-goals-summary>");
    expect(text).toContain("goal_list");
    expect(text).toContain("deploy-api");
  });

  it("prioritizes blocked goals in ordering", () => {
    const active = makeGoal({ id: "a", label: "zzzz-active-goal", status: "active", priority: "normal" });
    const blocked = makeGoal({
      id: "b",
      label: "aaaa-blocked-goal",
      status: "blocked",
      priority: "normal",
      currentBlockers: ["CI failing"],
    });
    const text = buildCompactActiveGoalsPrepend([active, blocked], { maxChars: 2500, maxGoals: 2 });
    expect(text?.indexOf("aaaa-blocked-goal")).toBeLessThan(text?.indexOf("zzzz-active-goal") ?? 999);
  });

  it("buildLightweightStewardshipDirective flags stale assessments", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const directive = buildLightweightStewardshipDirective(
      [makeGoal({ lastAssessedAt: old, label: "stale-goal" })],
      24,
    );
    expect(directive).toContain("goal-stewardship-hint");
    expect(directive).toContain("stale-goal");
  });

  it("buildSubagentLinkedGoalsPrepend adds checkpoint nudge", () => {
    const text = buildSubagentLinkedGoalsPrepend([makeGoal()], { maxChars: 2500 });
    expect(text).toContain("<subagent-goal-context>");
    expect(text).toContain("active_task_checkpoint");
    expect(text).toContain("deploy-api");
  });
});

describe("resolveGoalsForSubagentContext", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only resolves the caller's own tenant's linked goal, even when another tenant's task shares the same subagent session key (loop iteration 49 regression)", async () => {
    const root = mkdtempSync(join(tmpdir(), "goal-context-injection-scope-"));
    dirs.push(root);
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      sqlitePath: join(root, "facts.db"),
      lanceDbPath: join(root, "lancedb"),
      activeTask: { enabled: true, ledger: "facts", filePath: "ACTIVE-TASKS.md" },
    });
    const factsDb = new FactsDB(join(root, "facts.db"));

    const goalsDir = await makeTempDir("goal-context-injection-goals-");
    dirs.push(goalsDir);
    const defaults = goalDefaults();
    const goalA = await createGoal(
      goalsDir,
      { label: "tenant-a-goal", description: "Tenant A work", acceptanceCriteria: ["done"] },
      defaults,
    );
    const goalB = await createGoal(
      goalsDir,
      { label: "tenant-b-goal", description: "Tenant B work", acceptanceCriteria: ["done"] },
      defaults,
    );

    const sharedSessionKey = "agent:main:shared-subagent-label";
    const storeTask = (entity: string, scopeTarget: string, relatedGoal: string) => {
      const common = {
        category: "project" as const,
        importance: 0.5,
        entity,
        source: "active-task",
        decayClass: "permanent" as const,
        scope: "agent" as const,
        scopeTarget,
      };
      factsDb.store({ ...common, text: `[${entity}] status`, key: "status", value: "in_progress" });
      factsDb.store({ ...common, text: `[${entity}] session`, key: "related_session", value: sharedSessionKey });
      factsDb.store({ ...common, text: `[${entity}] goal`, key: "related_goal", value: relatedGoal });
    };
    storeTask("tenant-a-task", "tenantA", goalA.id);
    storeTask("tenant-b-task", "tenantB", goalB.id);

    const resolved = await resolveGoalsForSubagentContext(sharedSessionKey, goalsDir, factsDb, cfg, {
      agentId: "tenantA",
    });

    expect(resolved.map((g) => g.label)).toEqual(["tenant-a-goal"]);
  });
});
