import { describe, expect, it } from "vitest";
import { findActiveTaskForSubagentEnd, subagentEndedIsSuccess } from "../utils/subagent-ended-utils.js";

describe("subagentEndedIsSuccess", () => {
  it("uses boolean success when present", () => {
    expect(subagentEndedIsSuccess({ success: true })).toBe(true);
    expect(subagentEndedIsSuccess({ success: false })).toBe(false);
  });

  it("maps outcome strings from core", () => {
    expect(subagentEndedIsSuccess({ outcome: "error" })).toBe(false);
    expect(subagentEndedIsSuccess({ outcome: "timeout" })).toBe(false);
    expect(subagentEndedIsSuccess({ outcome: "killed" })).toBe(false);
    expect(subagentEndedIsSuccess({ outcome: "success" })).toBe(true);
    expect(subagentEndedIsSuccess({ outcome: "completed" })).toBe(true);
  });

  it("defaults to failure when outcome is empty or unknown", () => {
    expect(subagentEndedIsSuccess({})).toBe(false);
    expect(subagentEndedIsSuccess({ outcome: "weird-state" })).toBe(false);
  });

  it("matches labels case-insensitively", () => {
    expect(
      findActiveTaskForSubagentEnd([{ label: "Deploy-API", subagent: "sess:1" }], { label: "deploy-api" }),
    ).toEqual({ label: "Deploy-API", subagent: "sess:1" });
  });
});

describe("findActiveTaskForSubagentEnd", () => {
  const active = [
    { label: "task-a", subagent: "sess:child:1" },
    { label: "sess:child:2", description: "fallback label = session" },
  ];

  it("matches by label first", () => {
    expect(findActiveTaskForSubagentEnd(active, { label: "task-a" })).toEqual(active[0]);
  });

  it("matches by label using targetSessionKey when label omitted", () => {
    expect(findActiveTaskForSubagentEnd(active, { targetSessionKey: "sess:child:2" })).toEqual(active[1]);
  });

  it("falls back to subagent field when label differs but targetSessionKey matches", () => {
    expect(
      findActiveTaskForSubagentEnd([{ label: "my-task", subagent: "agent:sub:xyz" }], {
        label: "wrong",
        targetSessionKey: "agent:sub:xyz",
      }),
    ).toEqual({ label: "my-task", subagent: "agent:sub:xyz" });
  });

  it("returns undefined when nothing matches", () => {
    expect(findActiveTaskForSubagentEnd(active, { targetSessionKey: "nope" })).toBeUndefined();
  });
});
