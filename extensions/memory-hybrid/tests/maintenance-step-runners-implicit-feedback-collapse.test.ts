/**
 * The `implicit-feedback-collapse` maintenance step must honor the orchestrator-wide wall-clock
 * run deadline, the same safety valve every other long-running paged step respects. Without it,
 * a large implicit-feedback backlog can page through `cleanupImplicitFeedbackDuplicates` for as
 * long as it takes, ignoring `--max-runtime-min` and blocking every step queued behind it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCliMaintenanceRunners } from "../cli/commands/manage/maintenance-step-runners.js";
import { clearMaintenanceRunDeadline, setMaintenanceRunDeadlineMs } from "../utils/maintenance-run-deadline.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("maintenance-step-runners implicit-feedback-collapse wall-clock wiring", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-implicit-collapse-deadline-"));
  });

  afterEach(() => {
    clearMaintenanceRunDeadline();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops and reports interrupted=true once the orchestrator run deadline has passed", async () => {
    const db = new FactsDB(join(tmpDir, "facts.db"));
    db.store({
      text: "User satisfaction increases when the agent provides concrete next steps",
      category: "technical",
      importance: 0.7,
      entity: null,
      key: "implicit_feedback_signal",
      value: null,
      source: "implicit-feedback",
      tags: ["implicit-feedback", "trajectory", "feedback"],
    });

    setMaintenanceRunDeadlineMs(Date.now() - 1000);

    const runner = buildCliMaintenanceRunners({ factsDb: db, cfg: {} } as unknown as ManageBindings).get(
      "implicit-feedback-collapse",
    );
    expect(runner).toBeDefined();

    await expect(runner?.()).rejects.toThrow(/implicit-feedback-collapse interrupted.*interrupted=true/);

    db.close();
  });
});
