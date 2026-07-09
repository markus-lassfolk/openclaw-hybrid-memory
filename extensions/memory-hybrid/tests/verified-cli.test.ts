/**
 * Regression test (loop iteration 122) for cli/verified.ts:
 *
 * `verified triage` printed `failed <n>` in its own summary line whenever any item landed in
 * the "failed-review" bucket, but never converted that into a nonzero process.exitCode --
 * cron/CI automation checking the exit code would treat a partial failure as success.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { Chainable } from "../cli/shared.js";
import { registerVerifiedCommands } from "../cli/verified.js";
import { VerificationStore } from "../services/verification-store.js";

type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

function captureActions(): { actions: Map<string, ActionFn>; mem: Chainable } {
  const actions = new Map<string, ActionFn>();
  let currentCommand = "";
  const chainable: Chainable = {
    command(name: string) {
      currentCommand = name;
      return chainable;
    },
    description() {
      return chainable;
    },
    option() {
      return chainable;
    },
    requiredOption() {
      return chainable;
    },
    action(fn: ActionFn) {
      actions.set(currentCommand, fn);
      return chainable;
    },
  };
  return { actions, mem: chainable };
}

let tmpDir: string;
let factsDb: FactsDB;
let verificationStore: VerificationStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verified-cli-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  verificationStore = new VerificationStore(factsDb.getRawDb(), {
    backupPath: join(tmpDir, "verified.json"),
    reverificationDays: 30,
  });
  process.exitCode = undefined;
});

afterEach(() => {
  verificationStore.close();
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** Adds a verified, due-for-reverification fact whose underlying `facts` row is then deleted --
 * the fixture verified-fact-triage.test.ts uses to force a triage item into "failed-review". */
function addOrphanedVerifiedFact(id: string): void {
  factsDb
    .getRawDb()
    .prepare(
      "INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, last_confirmed_at, confidence, scope, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      "Orphaned fact",
      "fact",
      0.8,
      "test",
      Math.floor(Date.now() / 1000),
      "durable",
      Math.floor(Date.now() / 1000),
      0.95,
      "global",
      "{}",
    );
  verificationStore.verify(id, "Orphaned fact", "user");
  factsDb
    .getRawDb()
    .prepare("UPDATE verified_facts SET next_verification = ? WHERE fact_id = ?")
    .run("2000-01-01T00:00:00.000Z", id);
  factsDb.getRawDb().exec("PRAGMA foreign_keys = OFF");
  factsDb.getRawDb().prepare("DELETE FROM facts WHERE id = ?").run(id);
  factsDb.getRawDb().exec("PRAGMA foreign_keys = ON");
}

describe("verified triage exit code (loop iteration 122 regression)", () => {
  it("sets process.exitCode when the triage run reports failed items", async () => {
    addOrphanedVerifiedFact("missing-1");
    const { actions, mem } = captureActions();
    registerVerifiedCommands(mem, { factsDb, reverificationDays: 30 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await actions.get("triage")!({});

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("failed 1"));
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
  });

  it("does not set process.exitCode when no items fail", async () => {
    const { actions, mem } = captureActions();
    registerVerifiedCommands(mem, { factsDb, reverificationDays: 30 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await actions.get("triage")!({});

    expect(process.exitCode).toBeUndefined();
    logSpy.mockRestore();
  });
});
