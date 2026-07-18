/** Tests for the shared Loom nightly maintenance service (#2150): stale-claim sweep + drift scan. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { runLoomMaintenance } from "../services/loom-maintenance.js";
import { MAINTENANCE_STEPS } from "../services/maintenance-orchestrator.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

function storeFact(text: string): { id: string } {
  return factsDb.store({
    text,
    category: "project",
    importance: 0.5,
    source: "conversation",
    entity: null,
    key: null,
    value: null,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loom-maintenance-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runLoomMaintenance (#2150)", () => {
  it("returns ran:false and does nothing when the Loom store is absent", () => {
    const result = runLoomMaintenance({ factsDb, loomStore: null }, { staleAfterDays: 30 });
    expect(result).toEqual({ ran: false, staleDegraded: 0, driftNew: 0, driftExisting: 0, driftApplied: 0 });
  });

  it("degrades stale claims and records drift findings in a single pass", () => {
    const claim = loomStore.assertClaim({ entity: "Z", predicate: "endpoint", value: "old.example.com" });
    // Verified long ago → older than the 30-day window relative to now.
    loomStore.verifyClaim(claim.id, { at: "2020-01-01T00:00:00.000Z" });
    storeFact("Run `hybrid-mem old-cmd` for the weekly report.");

    const result = runLoomMaintenance(
      { factsDb, loomStore },
      { staleAfterDays: 30, deprecatedCommands: { "old-cmd": "new-cmd" } },
    );

    expect(result.ran).toBe(true);
    expect(result.staleDegraded).toBe(1);
    expect(loomStore.getClaim(claim.id)?.status).toBe("stale");
    expect(result.driftNew).toBeGreaterThanOrEqual(1);
    expect(result.driftApplied).toBe(0); // report-only by default
  });

  it("does not rewrite fact text unless applySafeDrift is set", () => {
    const fact = storeFact("Run `hybrid-mem old-cmd` for the weekly report.");

    const reportOnly = runLoomMaintenance(
      { factsDb, loomStore },
      { staleAfterDays: 30, deprecatedCommands: { "old-cmd": "new-cmd" } },
    );
    expect(reportOnly.driftApplied).toBe(0);
    expect(factsDb.getAll({ includeSuperseded: true }).find((f) => f.id === fact.id)?.text).toContain("old-cmd");

    const applied = runLoomMaintenance(
      { factsDb, loomStore },
      { staleAfterDays: 30, deprecatedCommands: { "old-cmd": "new-cmd" }, applySafeDrift: true },
    );
    expect(applied.driftApplied).toBeGreaterThanOrEqual(1);
    const updated = factsDb.getAll({ includeSuperseded: true }).find((f) => f.id === fact.id);
    expect(updated?.text).toContain("new-cmd");
    expect(updated?.text).not.toContain("old-cmd");
  });

  it("is a no-op sweep when nothing is stale and no drift configured", () => {
    loomStore.assertClaim({ entity: "A", predicate: "k", value: "v" });
    const result = runLoomMaintenance({ factsDb, loomStore }, { staleAfterDays: 30 });
    expect(result.ran).toBe(true);
    expect(result.staleDegraded).toBe(0);
    expect(result.driftNew).toBe(0);
  });
});

describe("loom-maintenance orchestrator step (#2150)", () => {
  const step = MAINTENANCE_STEPS.find((s) => s.name === "loom-maintenance");

  it("is registered as a nightly step", () => {
    expect(step).toBeDefined();
    expect(step?.tier).toBe("nightly");
  });

  it("runs by default (Loom enabled by default) and is gated off when loom.enabled is false", () => {
    const onByDefault = parseConfig({ embedding: { provider: "ollama", model: "nomic-embed-text" } });
    const disabled = parseConfig({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      loom: { enabled: false },
    });
    expect(step?.featureGate?.(onByDefault as never)).toBe(true);
    expect(step?.featureGate?.(disabled as never)).toBe(false);
  });
});
