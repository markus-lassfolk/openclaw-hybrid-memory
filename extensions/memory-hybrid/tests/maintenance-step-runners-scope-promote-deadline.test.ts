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
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { buildCliMaintenanceRunners } from "../cli/commands/manage/maintenance-step-runners.js";
import { _testing } from "../index.js";
import { clearMaintenanceRunDeadline, setMaintenanceRunDeadlineMs } from "../utils/maintenance-run-deadline.js";

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

describe("repair-vectors / reembed-vectorless deadline-only truncation reports semantic=monitoring, not partial (QA follow-up)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-vectorless-deadline-"));
  });

  afterEach(() => {
    clearMaintenanceRunDeadline();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // With the orchestrator run deadline already past before the runner starts,
  // runUntilMaintenanceDeadline's first per-item check trips immediately and `fn` (the embed call)
  // never runs — so failures stays 0 and this exercises the exact "clean deadline-only
  // truncation" case the earlier fix targeted, without needing a real embeddings/vectorDb.
  const unusedEmbeddings = {
    embed: async () => {
      throw new Error("must not be called — deadline already passed before any candidate is processed");
    },
  };
  const unusedVectorDb = {
    store: async () => {
      throw new Error("must not be called — deadline already passed before any candidate is processed");
    },
  };

  it("reembed-vectorless: deadlineHit=true with zero failures resolves with semantic=monitoring", async () => {
    const db = new FactsDB(join(tmpDir, "facts.db"));
    db.store({
      text: "A fact with no vector yet",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    setMaintenanceRunDeadlineMs(Date.now() - 1000);

    const runner = buildCliMaintenanceRunners({
      factsDb: db,
      cfg: {},
      embeddings: unusedEmbeddings,
      vectorDb: unusedVectorDb,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ManageBindings stub for this runner
    } as any).get("reembed-vectorless");
    expect(runner).toBeDefined();

    const summary = await runner?.();
    expect(summary).toMatch(/failures=0/);
    expect(summary).toMatch(/deadlineHit=true/);
    // Before the fix, this was "semantic=partial" — semanticOutcomeBlocksOrchestratorGuard treats
    // "partial" as unconditionally blocking, so the orchestrator still marked the step "failed"
    // and withheld the guard timestamp even though the removed throw made it LOOK fixed.
    expect(summary).toMatch(/semantic=monitoring/);
    expect(summary).not.toMatch(/semantic=partial/);

    db.close();
  });

  it("repair-vectors: deadlineHit=true with zero failures resolves with semantic=monitoring", async () => {
    const db = new FactsDB(join(tmpDir, "facts.db"));
    db.store({
      text: "Another fact with no vector yet",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    setMaintenanceRunDeadlineMs(Date.now() - 1000);

    const runner = buildCliMaintenanceRunners({
      factsDb: db,
      cfg: {},
      embeddings: unusedEmbeddings,
      vectorDb: {
        ...unusedVectorDb,
        // reconcileOrphanVectors runs unconditionally after the (skipped) embed loop; give it an
        // empty, well-behaved surface so it completes with zero orphans/failures.
        getAllIds: async () => [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal ManageBindings stub for this runner
    } as any).get("repair-vectors");
    expect(runner).toBeDefined();

    const summary = await runner?.();
    expect(summary).toMatch(/failures=0/);
    expect(summary).toMatch(/deadlineHit=true/);
    expect(summary).toMatch(/semantic=monitoring/);
    expect(summary).not.toMatch(/semantic=partial/);

    db.close();
  });
});
