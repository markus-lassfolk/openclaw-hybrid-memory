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
      expect(payload?.kind).toBe("systemEvent");
      expect(payload?.sessionTarget).toBeUndefined();
      const message = String(payload?.text ?? "");
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
      expect(payload?.kind).toBe("systemEvent");
      expect(payload?.sessionTarget).toBeUndefined();
      expect(payload?.message).toBeUndefined();
      const message = String(payload?.text ?? "");
      expect(message.startsWith("cron heartbeat")).toBe(true);
      const matchers = compileHeartbeatMatchers(["steward pulse"]);
      expect(matchers.some((re) => re.test(message))).toBe(true);
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("replaces non-plain payloads while normalizing existing jobs", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-array-payload-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(
        join(openclawDir, "cron", "jobs.json"),
        JSON.stringify(
          {
            jobs: [
              {
                pluginJobId: "goal-stewardship-heartbeat",
                payload: ["not", "a", "plain", "object"],
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: [] });
      expect(result).toEqual({ added: false, normalized: true });

      const store = readCronStore(openclawDir);
      const job = store.jobs.find((j) => j.pluginJobId === "goal-stewardship-heartbeat");
      expect(Array.isArray(job?.payload)).toBe(false);
      expect(job?.payload).toMatchObject({ kind: "systemEvent", text: "cron heartbeat" });
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("can synthesize strict non-prefixed heartbeat phrases from plain hints", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-hints-"));
    try {
      mkdirSync(join(openclawDir, "cron"), { recursive: true });
      writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: ["/^scheduled ping$/"] });
      expect(result).toEqual({ added: true, normalized: false });

      const store = readCronStore(openclawDir);
      const job = store.jobs.find((j) => j.pluginJobId === "goal-stewardship-heartbeat");
      expect(job?.payload).toMatchObject({ kind: "systemEvent", text: "scheduled ping" });
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("normalizes existing heartbeat jobs even when synthesis fallback uses existing message", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-existing-msg-"));
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
                sessionTarget: "isolated",
                schedule: { kind: "cron", expr: "0 * * * *" },
                payload: { kind: "agentTurn", message: "GOAL_PULSE_V1" },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: ["/^GOAL_PULSE_V1$/"] });
      expect(result).toEqual({ added: false, normalized: true });

      const store = readCronStore(openclawDir);
      const job = store.jobs.find((j) => j.pluginJobId === "goal-stewardship-heartbeat");
      expect(job?.id).toBe("goal-stewardship-heartbeat");
      expect(job?.name).toBe("goal-stewardship-heartbeat");
      expect(job?.enabled).toBe(true);
      expect(job?.sessionTarget).toBe("main");
      expect(job?.schedule).toEqual({ kind: "cron", expr: "*/30 * * * *" });
      expect(job?.delivery).toEqual({ mode: "none" });
      expect(job?.payload).toMatchObject({ kind: "systemEvent", text: "GOAL_PULSE_V1" });
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("skips installation when heartbeat patterns cannot match synthesized candidates", () => {
    const openclawDir = mkdtempSync(join(tmpdir(), "hm-heartbeat-skip-"));
    try {
      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, {
        heartbeatPatterns: ["^definitely-not-a-heartbeat$"],
      });
      expect(result).toEqual({
        added: false,
        normalized: false,
        skippedReason:
          "could not synthesize a 'cron heartbeat …' message that matches goalStewardship.heartbeatPatterns",
      });
    } finally {
      rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});
