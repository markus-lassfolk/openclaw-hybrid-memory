import { describe, expect, it } from "vitest";
import {
  getProgressiveIndexIds,
  resolveProgressiveIndexSessionKey,
  setProgressiveIndexIds,
} from "../utils/progressive-index-session.js";

describe("progressive index session helpers", () => {
  it("resolves session key from api context with sessionKey preferred", () => {
    expect(
      resolveProgressiveIndexSessionKey({
        context: { sessionKey: "agent:main:telegram:a", sessionId: "other" },
      }),
    ).toBe("agent:main:telegram:a");
  });

  it("stores and retrieves progressive index ids per session", () => {
    const map = new Map<string, string[]>();
    setProgressiveIndexIds(map, "session-a", ["fact-1", "fact-2"]);
    setProgressiveIndexIds(map, "session-b", ["fact-9"]);
    expect(getProgressiveIndexIds(map, "session-a")).toEqual(["fact-1", "fact-2"]);
    expect(getProgressiveIndexIds(map, "session-b")).toEqual(["fact-9"]);
    expect(getProgressiveIndexIds(map, "missing")).toEqual([]);
    setProgressiveIndexIds(map, "session-a", []);
    expect(map.has("session-a")).toBe(false);
  });
});
