/**
 * Regression test (#2067-followup) for services/goal-registry.ts's readGoal():
 *
 * readGoal() built its canonical file path via `join(goalsDir, `${id}.json`)` with no validation
 * of `id` at all. A caller-supplied id containing `../` segments escaped goalsDir entirely,
 * giving an arbitrary-file-read primitive reachable from an ordinary goal_get/goal_update/
 * goal_complete MCP tool call: if the resolved path happened to parse as JSON and satisfy the
 * minimal Goal shape check, its contents were returned to the caller; if not, the differing
 * not_found vs corrupt error responses still acted as a file-existence oracle for arbitrary
 * paths reachable via relative traversal.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGoal } from "../services/goal-registry.js";
import { cleanDir, makeTempDir } from "./helpers/goal-helpers.js";

describe("goal-registry readGoal path traversal (#2067-followup)", () => {
  let dir: string;
  afterEach(async () => {
    await cleanDir(dir);
  });

  it("does not escape goalsDir via a relative-traversal id", async () => {
    dir = await makeTempDir();
    // A file that would be readable if `id` escaped goalsDir into its parent.
    const secretPath = join(dir, "..", "secret-outside-goals-dir.json");
    await writeFile(
      secretPath,
      JSON.stringify({ id: "secret", label: "leaked", description: "should never be read", acceptanceCriteria: [] }),
      "utf-8",
    );
    try {
      const result = await readGoal(dir, "../secret-outside-goals-dir");
      expect(result).toBeNull();
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(secretPath, { force: true }));
    }
  });

  it("does not escape goalsDir via a deeply nested relative-traversal id", async () => {
    dir = await makeTempDir();
    const result = await readGoal(dir, "../../../../../../../../etc/passwd");
    expect(result).toBeNull();
  });

  it("rejects an id containing a path separator even without traversal", async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "subdir"), { recursive: true });
    await writeFile(
      join(dir, "subdir", "nested.json"),
      JSON.stringify({ id: "nested", label: "nested", description: "d", acceptanceCriteria: [] }),
      "utf-8",
    );
    const result = await readGoal(dir, "subdir/nested");
    expect(result).toBeNull();
  });

  it("still resolves a legitimate legacy non-UUID id (#1999) that contains no path separators", async () => {
    dir = await makeTempDir();
    await writeFile(
      join(dir, "legacy-label-0001.json"),
      JSON.stringify({
        id: "legacy-label-0001",
        label: "legacy-label",
        description: "legitimate legacy goal",
        acceptanceCriteria: ["a"],
        status: "active",
        priority: "normal",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAssessedAt: null,
        lastDispatchedAt: null,
        assessmentCount: 0,
        dispatchCount: 0,
        currentBlockers: [],
        lastOutcome: null,
        maxDispatches: 5,
        maxAssessments: 10,
        cooldownMinutes: 5,
        escalateAfterFailures: 3,
        consecutiveFailures: 0,
        linkedTasks: [],
        history: [],
      }),
      "utf-8",
    );
    const result = await readGoal(dir, "legacy-label-0001");
    expect(result?.description).toBe("legitimate legacy goal");
  });
});
