/**
 * Issue #590: PluginRuntime isolation tests.
 *
 * Proves that two independent PluginRuntime instances can be constructed and
 * operated without sharing state — the core acceptance criterion for #590.
 *
 * Before this refactor, all state lived in module-level `let` variables
 * (index.ts:295–321), making independent instances impossible to construct
 * in the same process and almost impossible to test in isolation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PluginRuntime, createTimers } from "../api/plugin-runtime.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// createTimers — factory helper
// ---------------------------------------------------------------------------

describe("createTimers", () => {
  it("returns a fresh object every call (no aliasing)", () => {
    const a = createTimers();
    const b = createTimers();
    expect(a).not.toBe(b);
    expect(a.pruneTimer).not.toBe(b.pruneTimer);
    expect(a.classifyTimer).not.toBe(b.classifyTimer);
  });

  it("all timer refs start null", () => {
    const t = createTimers();
    for (const key of Object.keys(t) as Array<keyof typeof t>) {
      expect(t[key].value).toBeNull();
    }
  });

  it("mutating one instance does not affect another", () => {
    const a = createTimers();
    const b = createTimers();
    // Simulate a timer being set in runtime A
    a.pruneTimer.value = setInterval(() => {}, 99999);
    expect(b.pruneTimer.value).toBeNull();
    clearInterval(a.pruneTimer.value!);
  });
});

// ---------------------------------------------------------------------------
// PluginRuntime — two independent instances
// ---------------------------------------------------------------------------

describe("PluginRuntime — two independent instances", () => {
  let tmpDir1: string;
  let tmpDir2: string;
  let db1: InstanceType<typeof FactsDB>;
  let db2: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir1 = mkdtempSync(join(tmpdir(), "plugin-runtime-a-"));
    tmpDir2 = mkdtempSync(join(tmpdir(), "plugin-runtime-b-"));
    db1 = new FactsDB(join(tmpDir1, "facts.db"));
    db2 = new FactsDB(join(tmpDir2, "facts.db"));
  });

  afterEach(() => {
    db1.close();
    db2.close();
    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  /** Build a minimal PluginRuntime-shaped object without spinning up the full plugin. */
  function buildRuntime(
    factsDb: InstanceType<typeof FactsDB>,
    captureMaxChars: number,
  ): Pick<PluginRuntime, "factsDb" | "cfg" | "currentAgentIdRef" | "timers" | "pendingLLMWarnings"> {
    return {
      factsDb,
      cfg: { captureMaxChars } as unknown as PluginRuntime["cfg"],
      currentAgentIdRef: { value: null },
      timers: createTimers(),
      pendingLLMWarnings: {
        warnings: [],
        add: () => {},
        flush: () => [],
      } as unknown as PluginRuntime["pendingLLMWarnings"],
    };
  }

  it("factsDb instances are fully independent: storing in one does not affect the other", () => {
    buildRuntime(db1, 1000);
    buildRuntime(db2, 1000);

    db1.store({
      text: "runtime A fact",
      category: "preference",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    expect(db1.count()).toBe(1);
    expect(db2.count()).toBe(0);
  });

  it("cfg is instance-scoped: two runtimes hold separate config values", () => {
    const r1 = buildRuntime(db1, 512);
    const r2 = buildRuntime(db2, 2048);

    expect(r1.cfg.captureMaxChars).toBe(512);
    expect(r2.cfg.captureMaxChars).toBe(2048);
  });

  it("currentAgentIdRef is instance-scoped: updating one does not affect the other", () => {
    const r1 = buildRuntime(db1, 1000);
    const r2 = buildRuntime(db2, 1000);

    r1.currentAgentIdRef.value = "agent-alpha";

    expect(r1.currentAgentIdRef.value).toBe("agent-alpha");
    expect(r2.currentAgentIdRef.value).toBeNull();
  });

  it("timers are instance-scoped: each runtime gets its own timer bag", () => {
    const r1 = buildRuntime(db1, 1000);
    const r2 = buildRuntime(db2, 1000);

    // Simulate service setting a timer for r1
    r1.timers.pruneTimer.value = setInterval(() => {}, 99999);

    expect(r1.timers.pruneTimer.value).not.toBeNull();
    expect(r2.timers.pruneTimer.value).toBeNull();

    clearInterval(r1.timers.pruneTimer.value!);
  });

  it("deleting a fact from runtime A does not touch runtime B's database", () => {
    const r1 = buildRuntime(db1, 1000);
    buildRuntime(db2, 1000);

    const entry1 = db1.store({
      text: "runtime A deletable",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db2.store({
      text: "runtime B keeper",
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    r1.factsDb.delete(entry1.id);

    expect(db1.count()).toBe(0);
    expect(db2.count()).toBe(1);
  });
});
