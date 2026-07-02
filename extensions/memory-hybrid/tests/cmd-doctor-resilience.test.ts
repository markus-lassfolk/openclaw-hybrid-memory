/**
 * doctor command resilience: individual check failures must not abort the whole command,
 * corrupt an unrelated check's status, or hide a later check's output.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/provider-detection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/provider-detection.js")>();
  return { ...actual, detectAvailableProviders: vi.fn() };
});
vi.mock("../services/maintenance-audit-journal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/maintenance-audit-journal.js")>();
  return { ...actual, getStaleMaintenanceJobs: vi.fn() };
});

class FakeCommand {
  children: FakeCommand[] = [];
  handler: ((...args: unknown[]) => unknown) | null = null;
  constructor(public name = "root") {}
  command(name: string): FakeCommand {
    const child = new FakeCommand(name.split(/\s+/)[0]);
    this.children.push(child);
    return child;
  }
  description(): FakeCommand {
    return this;
  }
  option(): FakeCommand {
    return this;
  }
  action(fn: (...args: unknown[]) => unknown): FakeCommand {
    this.handler = fn;
    return this;
  }
}

describe("doctor command resilience", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function setupDoctorHarness() {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-resilience-"));
    tmpRoots.push(root);
    const { registerDoctorCommand } = await import("../cli/cmd-doctor.js");
    const command = new FakeCommand();
    const rawDb = { prepare: () => ({ get: () => ({ cnt: 0 }) }) };
    registerDoctorCommand(
      command as never,
      { sqlitePath: join(root, "facts.db"), embedding: { provider: "openai", apiKey: "sk-test" } } as never,
      { getCount: () => 1, getRawDb: () => rawDb } as never,
      { getAllIds: async () => ["v1"] } as never,
    );
    const doctor = command.children.find((child) => child.name === "doctor");
    if (!doctor?.handler) throw new Error("doctor command handler missing");
    return doctor.handler;
  }

  it("doesn't abort the whole command when embedding-provider detection throws", async () => {
    const { detectAvailableProviders } = await import("../utils/provider-detection.js");
    vi.mocked(detectAvailableProviders).mockRejectedValue(new Error("network unreachable"));

    const runDoctor = await setupDoctorHarness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runDoctor()).resolves.toBeUndefined();

    const out = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("Embedding Provider");
    expect(out).toContain("network unreachable");
    // Later checks still ran instead of the whole command aborting.
    expect(out).toContain("Disk Space");
  });

  it("keeps Pin/snooze totals independent from a Maintenance health lookup failure", async () => {
    const { getStaleMaintenanceJobs } = await import("../services/maintenance-audit-journal.js");
    vi.mocked(getStaleMaintenanceJobs).mockImplementation(() => {
      throw new Error("audit journal corrupt");
    });

    const runDoctor = await setupDoctorHarness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDoctor();

    const out = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(out).toContain("Maintenance health: Audit journal unavailable: Error: audit journal corrupt");
    expect(out).toContain("Pin/snooze totals: 0 pinned facts");
  });
});
