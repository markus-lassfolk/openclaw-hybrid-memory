import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preserveGoalsMirrorSection, refreshActiveTaskMirrorWithGoals } from "../services/goal-active-task-mirror.js";

describe("refreshActiveTaskMirrorWithGoals", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("preserves unknown sections and content when refreshing goals mirror", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-mirror-"));
    const activeTaskPath = join(dir, "ACTIVE-TASKS.md");
    await writeFile(
      activeTaskPath,
      `# ACTIVE-TASKS.md — Working Memory

## Active Tasks

### [task-1]: Do thing
- **Status:** In progress
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T11:00:00.000Z
- **Custom Field:** keep me

## Notes

Do not remove this custom section.
`,
      "utf-8",
    );

    const result = await refreshActiveTaskMirrorWithGoals({
      activeTaskPath,
      goals: [
        {
          id: "goal-1",
          label: "g1",
          description: "Goal one",
          acceptanceCriteria: ["a"],
          verification: undefined,
          status: "active",
          priority: "normal",
          createdAt: "2026-02-24T10:00:00.000Z",
          lastAssessedAt: null,
          lastDispatchedAt: null,
          assessmentCount: 0,
          dispatchCount: 0,
          currentBlockers: [],
          lastOutcome: null,
          maxDispatches: 10,
          maxAssessments: 10,
          cooldownMinutes: 5,
          escalateAfterFailures: 3,
          consecutiveFailures: 0,
          lastBlockerFingerprint: null,
          sameBlockerStreak: 0,
          circuitBreakerLastProgressAssessmentCount: 0,
          humanEscalationSummary: null,
          escalationKind: null,
          linkedTasks: [],
          history: [],
          lastMechanicalCheck: null,
        },
      ],
      staleMinutes: 1440,
    });
    expect(result.ok).toBe(true);
    const content = await readFile(activeTaskPath, "utf-8");
    expect(content).toContain("## Notes");
    expect(content).toContain("Do not remove this custom section.");
    expect(content).toContain("**Custom Field:** keep me");
    expect(content).toContain("## Active Goals");
    expect(content).toContain("### [g1]: Goal one");
  });

  it("preserves permissions and leaves no temp files", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-mirror-"));
    const activeTaskPath = join(dir, "ACTIVE-TASKS.md");
    await writeFile(activeTaskPath, "# ACTIVE-TASKS.md\n", "utf-8");
    await chmod(activeTaskPath, 0o600);
    const result = await refreshActiveTaskMirrorWithGoals({ activeTaskPath, goals: [], staleMinutes: 1440 });
    expect(result.ok).toBe(true);
    expect((await stat(activeTaskPath)).mode & 0o777).toBe(0o600);
    const files = await readdir(dir);
    expect(files.some((f) => f.includes("ACTIVE-TASKS.md.tmp-"))).toBe(false);
  });

  it("replaces only the existing goals mirror section", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-mirror-"));
    const activeTaskPath = join(dir, "ACTIVE-TASKS.md");
    await writeFile(
      activeTaskPath,
      `# ACTIVE-TASKS.md — Working Memory

## Active Tasks

_No active tasks._

## Active Goals
_Mirror from goal registry — do not edit by hand; refreshed on heartbeat._

### [old-goal]: old

## Completed

_none_
`,
      "utf-8",
    );

    await refreshActiveTaskMirrorWithGoals({
      activeTaskPath,
      goals: [],
      staleMinutes: 1440,
    });
    const content = await readFile(activeTaskPath, "utf-8");
    expect(content).toContain("## Completed");
    expect(content).toContain("_none_");
    expect(content).toContain("## Active Goals");
    expect(content).toContain("_No active goals._");
    expect(content).not.toContain("[old-goal]");
  });
});

describe("preserveGoalsMirrorSection", () => {
  it("keeps goals block when projection is regenerated", () => {
    const previous = `# ACTIVE-TASKS.md

## Active

### [task-a]: Work
- **Status:** In progress

## Active Goals
_Mirror from goal registry — do not edit by hand; refreshed on heartbeat._

### [g1]: Goal one

`;
    const projection = `# ACTIVE-TASKS.md

> **Projection** of hybrid-memory facts

## Active

### [task-b]: New work
- **Status:** In progress
`;
    const merged = preserveGoalsMirrorSection(previous, projection);
    expect(merged).toContain("### [task-b]: New work");
    expect(merged).toContain("## Active Goals");
    expect(merged).toContain("### [g1]: Goal one");
    expect(merged).not.toContain("### [task-a]: Work");
  });
});
