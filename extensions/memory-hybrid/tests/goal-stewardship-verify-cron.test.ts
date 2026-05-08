import { describe, expect, it } from "vitest";

import { compileHeartbeatMatchers } from "../services/goal-stewardship-heartbeat.js";
import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  textMatchesAnyHeartbeatPattern,
} from "../services/goal-stewardship-verify-cron.js";

describe("goal-stewardship-verify-cron", () => {
  it("extractCronJobMessageEntries reads payload.message and top-level message", () => {
    const store = {
      jobs: [
        { pluginJobId: "a", payload: { message: "cron heartbeat" } },
        { id: "b", message: "scheduled ping" },
        { name: "c" },
      ],
    };
    const e = extractCronJobMessageEntries(store);
    expect(e).toEqual([
      { id: "a", text: "cron heartbeat", enabled: true },
      { id: "b", text: "scheduled ping", enabled: true },
      { id: "c", text: "", enabled: true },
    ]);
  });

  it("analyzeCronJobsAgainstHeartbeatPatterns classifies matching vs non-matching", () => {
    const matchers = compileHeartbeatMatchers([]);
    const h = analyzeCronJobsAgainstHeartbeatPatterns(matchers, [
      { id: "j1", text: "heartbeat", enabled: true },
      { id: "j2", text: "unrelated work item", enabled: true },
      { id: "j3", text: "", enabled: true },
    ]);
    expect(h.matchingJobIds).toEqual(["j1"]);
    expect(h.nonMatchingMessageCount).toBe(1);
    expect(h.emptyMessageCount).toBe(1);
    expect(h.patternCount).toBe(matchers.length);
    expect(h.disabledMatchingJobIds).toEqual([]);
  });

  it("textMatchesAnyHeartbeatPattern matches default sources", () => {
    const matchers = compileHeartbeatMatchers([]);
    expect(textMatchesAnyHeartbeatPattern(matchers, "scheduled ping")).toBe(true);
    expect(textMatchesAnyHeartbeatPattern(matchers, "hello")).toBe(false);
  });

  it("analyzeCronJobsAgainstHeartbeatPatterns excludes disabled jobs from delivery but reports them separately", () => {
    const matchers = compileHeartbeatMatchers([]);
    const h = analyzeCronJobsAgainstHeartbeatPatterns(matchers, [
      { id: "active-match", text: "heartbeat", enabled: true },
      { id: "disabled-match", text: "heartbeat", enabled: false },
      { id: "disabled-no-match", text: "other", enabled: false },
    ]);
    // Only enabled jobs contribute to delivery results
    expect(h.matchingJobIds).toEqual(["active-match"]);
    expect(h.nonMatchingMessageCount).toBe(0);
    // Disabled jobs are tracked separately
    expect(h.disabledMatchingJobIds).toEqual(["disabled-match"]);
  });

  it("extractCronJobMessageEntries reads enabled flag", () => {
    const store = {
      jobs: [
        { id: "enabled-job", enabled: true, message: "always on" },
        { id: "disabled-job", enabled: false, message: "paused" },
        { id: "no-flag", message: "default on" },
      ],
    };
    const e = extractCronJobMessageEntries(store);
    expect(e).toEqual([
      { id: "enabled-job", text: "always on", enabled: true },
      { id: "disabled-job", text: "paused", enabled: false },
      { id: "no-flag", text: "default on", enabled: true },
    ]);
  });
});
