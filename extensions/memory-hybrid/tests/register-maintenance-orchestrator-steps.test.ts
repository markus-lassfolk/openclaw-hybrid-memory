/**
 * `maintenance steps` must report the actual registered step count, not a stale hardcoded number
 * that silently drifts every time a step is added or removed from MAINTENANCE_STEPS.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceOrchestratorCommands } from "../cli/commands/manage/register-maintenance-orchestrator.js";
import { listMaintenanceSteps } from "../services/maintenance-orchestrator.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

describe("maintenance steps CLI step count", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the actual number of registered steps, not a hardcoded count", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "steps"], { from: "user" });

    const actualCount = listMaintenanceSteps().length;
    expect(lines[0]).toBe(`Maintenance steps (${actualCount} registered):`);
  });
});

describe("maintenance step <step> CLI (#2028)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("rejects an unknown step name with a non-zero exit and lists the valid step names", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);

    const errLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "step", "does-not-exist"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(errLines[0]).toContain("Unknown maintenance step: does-not-exist");
    // Lists valid step names so an operator can correct the invocation.
    const validNames = listMaintenanceSteps().map((s) => s.name);
    expect(errLines.some((l) => l.includes(`Valid steps (${validNames.length})`))).toBe(true);
    expect(errLines.some((l) => l.trim() === validNames[0])).toBe(true);
  });

  it("registers a `step <step>` command that takes a required step argument", () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);
    const stepCmd = maintenance.commands.find((c) => c.name() === "step");
    expect(stepCmd).toBeDefined();
    // The required positional makes `maintenance step` (no name) fail argument parsing.
    expect(stepCmd?.usage()).toContain("<step>");
  });
});
