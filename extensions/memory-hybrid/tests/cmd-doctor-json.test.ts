/**
 * `doctor --json`: stdout carries the full check list + summary as JSON, with no human-readable
 * banner/icons/summary text mixed in, matching the JSON output contract cmd-health.ts already
 * implements (docs/CLI-REFERENCE.md, "JSON output contract").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";

describe("doctor --json", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupDoctorHarness() {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-json-"));
    tmpRoots.push(root);

    const sqlitePath = join(root, "facts.db");
    const factsDb = new FactsDB(sqlitePath);
    const mem = new Command("hybrid-mem");
    mem.exitOverride();

    registerDoctorCommand(
      mem as never,
      { sqlitePath, embedding: { provider: "openai", apiKey: "sk-test-doctor-json" } } as never,
      factsDb,
      { getAllIds: async () => [] } as never,
    );

    return { root, sqlitePath, factsDb, mem };
  }

  it("prints only a JSON blob to stdout (no banner/icon lines) and sets exitCode 0 when healthy", async () => {
    const { factsDb, mem } = setupDoctorHarness();

    let stdout = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") stdout += msg;
    });

    await mem.parseAsync(["doctor", "--json"], { from: "user" });

    expect(() => JSON.parse(stdout)).not.toThrow();
    const report = JSON.parse(stdout) as {
      overall: string;
      checks: Array<{ name: string; status: string; message: string }>;
      summary: { passed: number; warnings: number; failed: number };
      durationMs: number;
      timestamp: string;
    };
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.some((c) => c.name === "SQLite Database")).toBe(true);
    expect(report.summary.failed).toBe(0);
    expect(report.overall).not.toBe("unhealthy");
    expect(typeof report.durationMs).toBe("number");
    expect(typeof report.timestamp).toBe("string");
    expect(process.exitCode).toBeUndefined();

    // None of the human-readable banner/icon/summary text should leak into --json stdout.
    expect(stdout).not.toContain("🏥");
    expect(stdout).not.toContain("Summary:");

    factsDb.close();
  });

  it("sets exitCode 1 for `doctor --json` when a check fails, and overall is unhealthy", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const brokenFactsDb = {
      getCount: () => {
        throw new Error("db down");
      },
    };
    registerDoctorCommand(
      mem as never,
      { sqlitePath: "unused", embedding: { provider: "openai", apiKey: "sk-test-doctor-json" } } as never,
      brokenFactsDb as never,
      { getAllIds: async () => [] } as never,
    );

    let stdout = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") stdout += msg;
    });

    await mem.parseAsync(["doctor", "--json"], { from: "user" });

    const report = JSON.parse(stdout) as { overall: string; summary: { failed: number } };
    expect(report.overall).toBe("unhealthy");
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });
});
