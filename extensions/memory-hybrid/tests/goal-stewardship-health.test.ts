import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { getBlockedVerificationHostReason, parseGithubPrTarget, runGoalHealthCheck } from "../services/goal-health.js";
import { createGoal, readGoal, updateGoal } from "../services/goal-registry.js";

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

function baseCfg(over: Partial<GoalStewardshipConfig> = {}): GoalStewardshipConfig {
  return {
    enabled: true,
    autoEnableWhenGoalsPresent: true,
    goalsDir: "state/goals",
    model: null,
    heartbeatStewardship: true,
    watchdogHealthCheck: true,
    defaults: {
      maxDispatches: 20,
      maxAssessments: 50,
      cooldownMinutes: 10,
      escalateAfterFailures: 3,
      priority: "normal",
    },
    globalLimits: { maxDispatchesPerHour: 6, maxActiveGoals: 5 },
    heartbeatPatterns: [],
    attentionWeights: { critical: 4, high: 2, normal: 1, low: 0.5 },
    multiGoalMaxChars: 12_000,
    multiGoalMaxGoals: 8,
    heartbeatRefreshActiveTask: true,
    injectActiveGoalsEveryTurn: true,
    everyTurnGoalMaxChars: 2500,
    everyTurnGoalMaxGoals: 5,
    confirmationPolicy: { requireRegisterAckForPriorities: ["critical", "high"] },
    llmTriageOnHeartbeat: false,
    triageSuggestHeavyDirective: true,
    circuitBreaker: {
      enabled: false,
      sameBlockerRepeatLimit: 0,
      maxAssessmentsWithoutProgress: 0,
      composeHumanSummary: true,
      appendMemoryEscalation: true,
    },
    escalationPolicy: { taskHygieneOnBlockedGoals: true },
    allowCommandVerification: false,
    allowPrVerification: false,
    ...over,
  };
}

describe("runGoalHealthCheck", () => {
  let goalsDir: string | undefined;
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (goalsDir) await rm(goalsDir, { recursive: true, force: true });
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    goalsDir = undefined;
    workspaceRoot = undefined;
  });

  it("returns no updates when stewardship is disabled", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(goalsDir, { label: "x", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ enabled: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBe(0);
    expect(r.goalsUpdated).toBe(0);
  });

  it("returns no updates when watchdogHealthCheck is false", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(goalsDir, { label: "x", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ watchdogHealthCheck: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBe(0);
  });

  it("blocks goal when dispatch budget is exhausted", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "budget_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        maxDispatches: 1,
      },
      { ...defaults, maxDispatches: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { dispatchCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBeGreaterThanOrEqual(1);
    expect(r.actions.some((a) => a.action === "blocked")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
  });

  it("marks goal stalled when idle past stale threshold", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "stale_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        cooldownMinutes: 5,
      },
      { ...defaults, cooldownMinutes: 5 },
    );
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await updateGoal(
      goalsDir,
      g.id,
      { lastAssessedAt: old },
      { timestamp: new Date().toISOString(), action: "test", detail: "old activity", actor: "user" },
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a) => a.action === "stalled")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("stalled");
  });

  it("parseGithubPrTarget accepts owner/repo#N and github.com pull URLs", () => {
    expect(parseGithubPrTarget("foo/bar#42")).toEqual({ owner: "foo", repo: "bar", number: 42 });
    expect(parseGithubPrTarget("https://github.com/a/b/pull/7")).toEqual({ owner: "a", repo: "b", number: 7 });
    expect(parseGithubPrTarget("not-a-pr")).toBeNull();
  });

  it("pr_merged: records lastMechanicalCheck and does not verify when allowPrVerification is false", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const created = await createGoal(
      goalsDir,
      {
        label: "pr_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "pr_merged", target: "x/y#1" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ allowPrVerification: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(false);
    const after = await readGoal(goalsDir, created.id);
    expect(after?.lastMechanicalCheck?.ok).toBe(false);
    expect(after?.lastMechanicalCheck?.detail).toContain("allowPrVerification");
  });

  it("pr_merged: transitions to verifying when GitHub API reports merged", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ merged: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
      const created = await createGoal(
        goalsDir,
        {
          label: "pr_merged_ok",
          description: "d",
          acceptanceCriteria: ["a"],
          verification: { type: "pr_merged", target: "o/r#99" },
        },
        defaults,
      );
      const r = await runGoalHealthCheck({
        goalsDir,
        cfg: baseCfg({ allowPrVerification: true }),
        workspaceRoot,
        logger: {},
      });
      expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(true);
      expect(fetchMock).toHaveBeenCalled();
      const after = await readGoal(goalsDir, created.id);
      expect(after?.lastMechanicalCheck?.ok).toBe(true);
      expect(after?.status).toBe("verifying");
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) {
        Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
      } else {
        process.env.GITHUB_TOKEN = prev;
      }
    }
  });

  it("sets verifying when file_exists verification passes", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const marker = join(workspaceRoot, "proof.txt");
    await writeFile(marker, "ok", "utf-8");
    await createGoal(
      goalsDir,
      {
        label: "verify_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "file_exists", target: "proof.txt" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(true);
  });

  it("blocks file_exists verification targets that escape the workspace via '..' (#40)", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    // A file that genuinely exists just outside workspaceRoot — proves the guard is a real
    // containment check, not merely relying on the file being absent.
    const outsideMarker = join(workspaceRoot, "..", `escape-marker-${Date.now()}.txt`);
    await writeFile(outsideMarker, "secret", "utf-8");
    try {
      const g = await createGoal(
        goalsDir,
        {
          label: "verify_escape",
          description: "d",
          acceptanceCriteria: ["a"],
          verification: { type: "file_exists", target: `../${outsideMarker.split("/").pop()}` },
        },
        defaults,
      );
      const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
      expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(false);
      const after = await readGoal(goalsDir, g.id);
      expect(after?.lastMechanicalCheck?.detail).toContain("escapes workspace");
    } finally {
      await rm(outsideMarker, { force: true });
    }
  });

  it("blocks file_exists verification targets that are absolute paths outside the workspace (#40)", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "verify_absolute_escape",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "file_exists", target: "/etc/hostname" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(false);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.lastMechanicalCheck?.detail).toContain("escapes workspace");
  });

  it("allows file_exists verification targets that are absolute paths inside the workspace (#40)", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const marker = join(workspaceRoot, "nested", "proof.txt");
    await mkdir(join(workspaceRoot, "nested"), { recursive: true });
    await writeFile(marker, "ok", "utf-8");
    await createGoal(
      goalsDir,
      {
        label: "verify_absolute_inside",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "file_exists", target: marker },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(true);
  });

  it("escalates after consecutive failures", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "fail_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        escalateAfterFailures: 2,
      },
      { ...defaults, escalateAfterFailures: 2 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { consecutiveFailures: 2 },
      { timestamp: new Date().toISOString(), action: "test", detail: "force", actor: "user" },
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a) => a.action === "escalated")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
  });

  it("unstalls goal when activity resumes", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "unstall",
        description: "d",
        acceptanceCriteria: ["a"],
        cooldownMinutes: 5,
      },
      { ...defaults, cooldownMinutes: 5 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { status: "stalled", lastAssessedAt: new Date().toISOString() },
      { timestamp: new Date().toISOString(), action: "test", detail: "stall", actor: "user" },
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a) => a.action === "unstalled")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("active");
  });

  it("blocks goal when assessment budget is exhausted", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "assess_budget",
        description: "d",
        acceptanceCriteria: ["a"],
        maxAssessments: 1,
      },
      { ...defaults, maxAssessments: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { assessmentCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a) => a.action === "blocked")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
  });

  it("skips command_exit_zero when allowCommandVerification is false", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(
      goalsDir,
      {
        label: "cmd_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "command_exit_zero", target: "true" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ allowCommandVerification: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.every((a) => a.action !== "verifying")).toBe(true);
  });

  it("runs command_exit_zero when allowCommandVerification is true", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(
      goalsDir,
      {
        label: "cmd_ok",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "command_exit_zero", target: "true" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ allowCommandVerification: true }),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(true);
  });

  it("blocks http_ok verification against local/private hosts", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const g = await createGoal(
        goalsDir,
        {
          label: "http_blocked",
          description: "d",
          acceptanceCriteria: ["a"],
          verification: { type: "http_ok", target: "http://127.0.0.1:8080/health" },
        },
        defaults,
      );
      const r = await runGoalHealthCheck({
        goalsDir,
        cfg: baseCfg(),
        workspaceRoot,
        logger: {},
      });
      expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      const after = await readGoal(goalsDir, g.id);
      expect(after?.lastMechanicalCheck?.detail).toContain("blocked host");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks http_ok verification for IPv4-mapped IPv6 loopback hosts", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createGoal(
        goalsDir,
        {
          label: "http_mapped_ipv6_blocked",
          description: "d",
          acceptanceCriteria: ["a"],
          verification: { type: "http_ok", target: "http://[::ffff:127.0.0.1]/health" },
        },
        defaults,
      );
      const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
      expect(r.actions.some((a: { action: string }) => a.action === "verifying")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports literal private IP targets as blocked verification hosts", async () => {
    await expect(getBlockedVerificationHostReason("192.168.1.20")).resolves.toBe("local/private IP");
  });

  it("escalates goal after consecutive failures", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "escalate_label",
        description: "d",
        acceptanceCriteria: ["a"],
        escalateAfterFailures: 2,
      },
      { ...defaults, escalateAfterFailures: 2 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { consecutiveFailures: 2 },
      { timestamp: new Date().toISOString(), action: "test", detail: "force", actor: "user" },
    );
    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a) => a.action === "escalated" && a.reason === "failures")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
    expect(after?.currentBlockers.some((b) => b.includes("Escalated after"))).toBe(true);
  });

  it("transitions to verifying on command_exit_zero success", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(
      goalsDir,
      {
        label: "cmd_echo",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "command_exit_zero", target: "echo hello" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ allowCommandVerification: true }),
      workspaceRoot,
      logger: {},
    });
    const verifying = r.actions.find((a) => a.action === "verifying");
    expect(verifying).toBeDefined();
    expect(verifying?.reason).toContain("command ok");
  });

  it("goalsChecked and goalsUpdated counts are correct", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(goalsDir, { label: "count_a", description: "d", acceptanceCriteria: ["a"] }, defaults);
    await createGoal(goalsDir, { label: "count_b", description: "d", acceptanceCriteria: ["b"] }, defaults);
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBe(2);
    expect(r.goalsUpdated).toBe(0);
  });

  it("continues processing other goals when one goal throws inside loop", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const broken = await createGoal(
      goalsDir,
      { label: "broken_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    const brokenPath = join(goalsDir, `${broken.id}.json`);
    const raw = await readFile(brokenPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.linkedTasks = null;
    await writeFile(brokenPath, JSON.stringify(parsed, null, 2), "utf-8");
    const healthy = await createGoal(
      goalsDir,
      { label: "healthy_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.goalsChecked).toBe(2);
    expect(r.outcomes.some((o) => o.goalId === broken.id && o.outcome === "blocked")).toBe(true);
    expect(r.outcomes.some((o) => o.goalId === healthy.id)).toBe(true);
  });

  it("persists noop pulse outcome in goal history when no action is eligible", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(goalsDir, { label: "noop_goal", description: "d", acceptanceCriteria: ["a"] }, defaults);

    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    const outcome = r.outcomes.find((o) => o.goalId === g.id);
    expect(outcome?.outcome).toBe("noop");
    const after = await readGoal(goalsDir, g.id);
    const pulse = [...(after?.history ?? [])].reverse().find((h) => h.action === "pulse-outcome");
    expect(pulse?.detail).toContain("outcome=noop");
    expect(pulse?.detail).toContain("No eligible deterministic action");
  });

  it("does not rewrite goal history when the pulse outcome is unchanged", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      { label: "stable_noop_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    const afterFirst = await readGoal(goalsDir, g.id);
    const pulseCountAfterFirst = (afterFirst?.history ?? []).filter((h) => h.action === "pulse-outcome").length;

    await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    const afterSecond = await readGoal(goalsDir, g.id);
    const pulseCountAfterSecond = (afterSecond?.history ?? []).filter((h) => h.action === "pulse-outcome").length;

    expect(pulseCountAfterFirst).toBe(1);
    expect(pulseCountAfterSecond).toBe(1);
  });

  it("records waiting outcome when actionable next exists but no dispatch/execution occurs", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      { label: "actionable_wait", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    await updateGoal(
      goalsDir,
      g.id,
      {
        lastAssessedAt: new Date().toISOString(),
        lastOutcome: "Reviewed state | next: dispatch worker to apply fix",
      },
      { timestamp: new Date().toISOString(), action: "test", detail: "assessment-only", actor: "user" },
    );

    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    const outcome = r.outcomes.find((o) => o.goalId === g.id);
    expect(outcome).toBeDefined();
    expect(outcome?.outcome).toBe("waiting");
    expect(outcome?.reason).toContain("Actionable next step pending");
    const after = await readGoal(goalsDir, g.id);
    const pulse = [...(after?.history ?? [])].reverse().find((h) => h.action === "pulse-outcome");
    expect(pulse?.detail).toContain("outcome=waiting");
    expect(pulse?.detail).toContain("Actionable next step pending");
  });

  it("marks goal blocked when in-progress dispatch has no sessionKey/runId metadata", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      { label: "missing_dispatch_meta", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    const now = new Date().toISOString();
    await updateGoal(
      goalsDir,
      g.id,
      {
        linkedTasks: [
          {
            label: "dispatch-attempt-1",
            sessionKey: null,
            runId: null,
            status: "in_progress",
            linkedAt: now,
            updatedAt: now,
          },
        ],
      },
      { timestamp: now, action: "test", detail: "simulate dispatch attempt", actor: "user" },
    );

    const r = await runGoalHealthCheck({ goalsDir, cfg: baseCfg(), workspaceRoot, logger: {} });
    expect(r.actions.some((a) => a.action === "dispatch-metadata-missing")).toBe(true);
    const outcome = r.outcomes.find((o) => o.goalId === g.id);
    expect(outcome?.outcome).toBe("blocked");
    expect(outcome?.reason).toContain("missing dispatch metadata");
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
    expect(after?.linkedTasks.find((t) => t.label === "dispatch-attempt-1")?.status).toBe("failed");
    const pulse = [...(after?.history ?? [])].reverse().find((h) => h.action === "pulse-outcome");
    expect(pulse?.detail).toContain("outcome=blocked");
    expect(pulse?.detail).toContain("dispatch-attempt-1");
  });

  it("does not lose a concurrent currentBlockers update racing the dispatch-metadata-missing patch", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-race-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-race-"));
    const g = await createGoal(
      goalsDir,
      { label: "race_dispatch_meta", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    const now = new Date().toISOString();
    await updateGoal(
      goalsDir,
      g.id,
      {
        linkedTasks: [
          {
            label: "dispatch-attempt-1",
            sessionKey: null,
            runId: null,
            status: "in_progress",
            linkedAt: now,
            updatedAt: now,
          },
        ],
      },
      { timestamp: now, action: "test", detail: "simulate dispatch attempt", actor: "user" },
    );

    // Race the watchdog's dispatch-metadata-missing patch (which appends to currentBlockers and
    // increments consecutiveFailures, derived from `fresh` after this fix) against a concurrent
    // updateGoal call doing the same kind of derived update — both must land regardless of which
    // commits first, because each is computed from the state the lock actually protects.
    const goalsDirLocal = goalsDir;
    const [r] = await Promise.all([
      runGoalHealthCheck({ goalsDir: goalsDirLocal, cfg: baseCfg(), workspaceRoot, logger: {} }),
      updateGoal(
        goalsDirLocal,
        g.id,
        (fresh) => ({
          consecutiveFailures: fresh.consecutiveFailures + 10,
          currentBlockers: fresh.currentBlockers.includes("concurrent-blocker")
            ? fresh.currentBlockers
            : [...fresh.currentBlockers, "concurrent-blocker"],
        }),
        { timestamp: new Date().toISOString(), action: "assessed", detail: "concurrent update", actor: "steward" },
      ),
    ]);
    expect(r.actions.some((a) => a.action === "dispatch-metadata-missing")).toBe(true);

    const after = await readGoal(goalsDirLocal, g.id);
    // The watchdog's own +1 plus the concurrent +10 must both land: total 11, not 1 or 10.
    expect(after?.consecutiveFailures).toBe(11);
    expect(after?.currentBlockers).toContain("concurrent-blocker");
    expect(after?.currentBlockers.some((b) => b.includes("missing dispatch metadata"))).toBe(true);
  });

  it("does not lose a concurrent currentBlockers update racing the budget-exhausted patch (#36)", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-race-budget-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-race-budget-"));
    const g = await createGoal(
      goalsDir,
      { label: "race_budget", description: "d", acceptanceCriteria: ["a"], maxDispatches: 1 },
      { ...defaults, maxDispatches: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { dispatchCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );

    const goalsDirLocal = goalsDir;
    const [r] = await Promise.all([
      runGoalHealthCheck({ goalsDir: goalsDirLocal, cfg: baseCfg(), workspaceRoot, logger: {} }),
      updateGoal(
        goalsDirLocal,
        g.id,
        (fresh) => ({
          currentBlockers: fresh.currentBlockers.includes("concurrent-blocker")
            ? fresh.currentBlockers
            : [...fresh.currentBlockers, "concurrent-blocker"],
        }),
        { timestamp: new Date().toISOString(), action: "assessed", detail: "concurrent update", actor: "steward" },
      ),
    ]);
    expect(r.actions.some((a) => a.action === "blocked")).toBe(true);

    const after = await readGoal(goalsDirLocal, g.id);
    expect(after?.currentBlockers).toContain("concurrent-blocker");
    expect(after?.currentBlockers.some((b) => b.includes("Budget exhausted"))).toBe(true);
  });

  it("does not lose a concurrent currentBlockers update racing the escalation patch (#36)", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-race-escalate-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-race-escalate-"));
    const g = await createGoal(
      goalsDir,
      { label: "race_escalate", description: "d", acceptanceCriteria: ["a"], escalateAfterFailures: 1 },
      { ...defaults, escalateAfterFailures: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { consecutiveFailures: 1, status: "active" },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );

    const goalsDirLocal = goalsDir;
    const [r] = await Promise.all([
      runGoalHealthCheck({ goalsDir: goalsDirLocal, cfg: baseCfg(), workspaceRoot, logger: {} }),
      updateGoal(
        goalsDirLocal,
        g.id,
        (fresh) => ({
          currentBlockers: fresh.currentBlockers.includes("concurrent-blocker")
            ? fresh.currentBlockers
            : [...fresh.currentBlockers, "concurrent-blocker"],
        }),
        { timestamp: new Date().toISOString(), action: "assessed", detail: "concurrent update", actor: "steward" },
      ),
    ]);
    expect(r.actions.some((a) => a.action === "escalated")).toBe(true);

    const after = await readGoal(goalsDirLocal, g.id);
    expect(after?.currentBlockers).toContain("concurrent-blocker");
    expect(after?.currentBlockers.some((b) => b.includes("Escalated after"))).toBe(true);
  });
});
