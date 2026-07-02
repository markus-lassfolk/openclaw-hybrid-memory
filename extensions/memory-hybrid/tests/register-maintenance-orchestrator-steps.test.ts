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
