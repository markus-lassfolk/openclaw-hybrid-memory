/**
 * The `scope-promote` maintenance step queried findSessionFactsForPromotion with no LIMIT and
 * looped over every candidate with no orchestrator-wide wall-clock deadline check -- the same
 * class of bug already fixed for repair-vectors (#2041 review finding) and
 * implicit-feedback-collapse. A large session-scope promotion backlog could otherwise run past
 * `--max-runtime-min`, blocking every step queued behind it with no graceful stop (#2067-followup).
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

describe("maintenance-step-runners scope-promote wall-clock wiring (#2067-followup)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-scope-promote-deadline-"));
  });

  afterEach(() => {
    clearMaintenanceRunDeadline();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops and reports deadlineHit=true once the orchestrator run deadline has passed", async () => {
    const db = new FactsDB(join(tmpDir, "facts.db"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (db as any).db;
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 10 * 86400;

    const eligible = db.store({
      text: "Important session fact eligible for promotion",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "session",
      scopeTarget: "sess-deadline-fixture",
    });
    rawDb.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(oldSec, eligible.id);

    setMaintenanceRunDeadlineMs(Date.now() - 1000);

    const runner = buildCliMaintenanceRunners({ factsDb: db, cfg: {} } as unknown as ManageBindings).get(
      "scope-promote",
    );
    expect(runner).toBeDefined();

    await expect(runner?.()).rejects.toThrow(/scope-promote partial failure.*deadlineHit=true/);

    db.close();
  });
});
