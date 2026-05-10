import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureGoalStewardshipHeartbeatCronJob } from "../cli/cmd-install.js";
import { compileHeartbeatMatchers } from "../services/goal-stewardship-heartbeat.js";

function readCronStore(openclawDir: string): { jobs: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  return JSON.parse(raw) as { jobs: Array<Record<string, unknown>> };
}

describe("ensureGoalStewardshipHeartbeatCronJob", () => {
  it("adds a canonical heartbeat job when missing", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-install-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: [] });
      expect(result).toEqual({ added: true, normalized: false });

      const store = readCronStore(openclawDir);
      const job = store.jobs.find((j) => j.pluginJobId === "goal-stewardship-heartbeat");
      expect(job).toBeTruthy();
      expect(job?.id).toBe("goal-stewardship-heartbeat");
      expect(job?.name).toBe("goal-stewardship-heartbeat");
      expect(job?.enabled).toBe(true);
      expect(job?.sessionTarget).toBe("main");
      expect(job?.delivery).toEqual({ mode: "none" });
      expect(job?.schedule).toEqual({ kind: "cron", expr: "*/30 * * * *" });

      const payload = job?.payload as Record<string, unknown> | undefined;
      expect(payload?.kind).toBe("agentTurn");
      expect(payload?.sessionTarget).toBe("main");
      const message = String(payload?.message ?? "");
      expect(message.startsWith("cron heartbeat")).toBe(true);
      const matchers = compileHeartbeatMatchers([]);
      expect(matchers.some((re) => re.test(message))).toBe(true);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("normalizes an existing malformed heartbeat job", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-normalize-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(
        join(openclawDir, "cron", "jobs.json"),
        JSON.stringify(
          {
            jobs: [
              {
                pluginJobId: "goal-stewardship-heartbeat",
                id: "legacy-id",
                name: "legacy-name",
                enabled: false,
                isolated: true,
                sessionTarget: "isolated",
                delivery: { mode: "announce", channel: "system" },
                schedule: { kind: "cron", expr: "0 * * * *" },
                payload: {
                  kind: "system",
                  sessionTarget: "isolated",
                  message: "not a heartbeat",
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, {
        heartbeatPatterns: ["steward pulse"],
      });
      expect(result).toEqual({ added: false, normalized: true });

      const store = readCronStore(openclawDir);
      const job = store.jobs.find((j) => j.pluginJobId === "goal-stewardship-heartbeat");
      expect(job).toBeTruthy();
      expect(job?.id).toBe("goal-stewardship-heartbeat");
      expect(job?.name).toBe("goal-stewardship-heartbeat");
      expect(job?.enabled).toBe(true);
      expect(job?.sessionTarget).toBe("main");
      expect(job?.delivery).toEqual({ mode: "none" });
      expect(job?.schedule).toEqual({ kind: "cron", expr: "*/30 * * * *" });
      expect(job?.isolated).toBeUndefined();

      const payload = job?.payload as Record<string, unknown> | undefined;
      expect(payload?.kind).toBe("agentTurn");
      expect(payload?.sessionTarget).toBe("main");
      const message = String(payload?.message ?? "");
      expect(message.startsWith("cron heartbeat")).toBe(true);
      const matchers = compileHeartbeatMatchers(["steward pulse"]);
      expect(matchers.some((re) => re.test(message))).toBe(true);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
