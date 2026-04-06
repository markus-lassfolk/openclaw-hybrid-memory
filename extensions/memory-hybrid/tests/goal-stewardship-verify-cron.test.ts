import { describe, expect, it } from "vitest";

import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  textMatchesAnyHeartbeatPattern,
} from "../services/goal-stewardship-verify-cron.js";
import { compileHeartbeatMatchers } from "../services/goal-stewardship-heartbeat.js";

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
      { id: "a", text: "cron heartbeat" },
      { id: "b", text: "scheduled ping" },
      { id: "c", text: "" },
    ]);
  });

  it("analyzeCronJobsAgainstHeartbeatPatterns classifies matching vs non-matching", () => {
    const matchers = compileHeartbeatMatchers([]);
    const h = analyzeCronJobsAgainstHeartbeatPatterns(matchers, [
      { id: "j1", text: "heartbeat" },
      { id: "j2", text: "unrelated work item" },
      { id: "j3", text: "" },
    ]);
    expect(h.matchingJobIds).toEqual(["j1"]);
    expect(h.nonMatchingMessageCount).toBe(1);
    expect(h.emptyMessageCount).toBe(1);
    expect(h.patternCount).toBe(matchers.length);
  });

  it("textMatchesAnyHeartbeatPattern matches default sources", () => {
    const matchers = compileHeartbeatMatchers([]);
    expect(textMatchesAnyHeartbeatPattern(matchers, "scheduled ping")).toBe(true);
    expect(textMatchesAnyHeartbeatPattern(matchers, "hello")).toBe(false);
  });
});
