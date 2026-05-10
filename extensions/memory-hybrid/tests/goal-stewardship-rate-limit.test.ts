import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGlobalRateLimited, recordGoalDispatch } from "../services/goal-stewardship.js";

describe("goal-stewardship global dispatch rate limit persistence", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("tracks dispatches in goalsDir independently from process-memory fallback", async () => {
    const goalsDir = await mkdtemp(join(tmpdir(), "gs-rate-limit-"));
    dirs.push(goalsDir);

    recordGoalDispatch();
    expect(isGlobalRateLimited(1, goalsDir)).toBe(false);

    recordGoalDispatch(goalsDir);
    expect(isGlobalRateLimited(1, goalsDir)).toBe(true);

    const raw = await readFile(join(goalsDir, "_global_dispatch_rate_limit.json"), "utf-8");
    const parsed = JSON.parse(raw) as { timestamps?: unknown[] };
    expect(Array.isArray(parsed.timestamps)).toBe(true);
    expect((parsed.timestamps ?? []).length).toBe(1);
  });

  it("prunes stale persisted timestamps older than one hour", async () => {
    const goalsDir = await mkdtemp(join(tmpdir(), "gs-rate-limit-prune-"));
    dirs.push(goalsDir);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(
      join(goalsDir, "_global_dispatch_rate_limit.json"),
      JSON.stringify({ timestamps: [old], updatedAt: new Date(old).toISOString() }),
      "utf-8",
    );

    expect(isGlobalRateLimited(1, goalsDir)).toBe(false);
  });
});
