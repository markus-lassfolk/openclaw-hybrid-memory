import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ensureMaintenanceCronJobs } from "../cli/cmd-install.js";

function readJobs(openclawDir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  const parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

describe("pending digest delivery via cron config (#1197)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function newOpenclawDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-pending-delivery-"));
    dirs.push(dir);
    return dir;
  }

  it("maps digest.weekly.delivery none → job delivery.mode none", () => {
    const openclawDir = newOpenclawDir();
    ensureMaintenanceCronJobs(openclawDir, undefined, {
      normalizeExisting: true,
      digestWeeklyDelivery: { mode: "none" },
    });
    const target = readJobs(openclawDir).find((j) => j.pluginJobId === "hybrid-mem:weekly-pending-digest");
    expect(target?.delivery).toMatchObject({ mode: "none" });
  });

  it("maps digest.weekly.delivery telegram + chatId → announce + telegram channel", () => {
    const openclawDir = newOpenclawDir();
    ensureMaintenanceCronJobs(openclawDir, undefined, {
      normalizeExisting: true,
      digestWeeklyDelivery: { mode: "telegram", chatId: "12345" },
    });
    const target = readJobs(openclawDir).find((j) => j.pluginJobId === "hybrid-mem:weekly-pending-digest");
    expect(target?.delivery).toMatchObject({ mode: "announce", channel: "telegram", chatId: "12345" });
  });
});
