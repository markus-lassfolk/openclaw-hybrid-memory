/**
 * CLI wiring test for `maintenance graph-link-enrichment` (#2127).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerGraphLinkEnrichmentCommand } from "../cli/commands/manage/register-graph-link-enrichment.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

function storeFactWithProvenance(sourceEventIds?: string[]): string {
  const raw = factsDb.getRawDb();
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const provenanceJson = sourceEventIds ? JSON.stringify({ sourceEventIds }) : null;
  raw
    .prepare(
      `INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, confidence, tier, valid_until, expires_at, superseded_at, provenance_json)
     VALUES (?, 'fact text', 'fact', 0.7, 'conversation', ?, 'stable', 1.0, 'warm', NULL, NULL, NULL, ?)`,
    )
    .run(id, nowSec, provenanceJson);
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-enrich-cli-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  process.exitCode = undefined;
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("maintenance graph-link-enrichment CLI (#2127)", () => {
  it("defaults to dry-run and reports the would-be link count as JSON", async () => {
    const a = storeFactWithProvenance(["evt-1"]);
    const b = storeFactWithProvenance(["evt-1"]);

    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGraphLinkEnrichmentCommand(program as never, { factsDb } as unknown as ManageBindings);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["graph-link-enrichment", "--json"], { from: "user" });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.dryRun).toBe(true);
    expect(payload.linksCreated).toBe(1);
    expect(factsDb.getEdgesForFactIds([a, b], 10)).toHaveLength(0);
  });

  it("--apply creates the link", async () => {
    const a = storeFactWithProvenance(["evt-1"]);
    const b = storeFactWithProvenance(["evt-1"]);

    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGraphLinkEnrichmentCommand(program as never, { factsDb } as unknown as ManageBindings);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["graph-link-enrichment", "--apply"], { from: "user" });

    expect(factsDb.getEdgesForFactIds([a, b], 10)).toHaveLength(1);
  });

  it("rejects a non-positive --limit", async () => {
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGraphLinkEnrichmentCommand(program as never, { factsDb } as unknown as ManageBindings);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["graph-link-enrichment", "--limit", "0"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });
});
