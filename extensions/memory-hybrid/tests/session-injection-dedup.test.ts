import { describe, expect, it } from "vitest";
import {
  clearSessionInjectionDedup,
  filterFactsNotYetInjected,
  markFactsInjectedForSession,
} from "../services/session-injection-dedup.js";

describe("session-injection-dedup", () => {
  it("marks and filters injected fact ids per session", () => {
    const map = new Map<string, Set<string>>();
    markFactsInjectedForSession(map, "sess-a", ["f1", "f2"]);
    markFactsInjectedForSession(map, "sess-b", ["f3"]);

    const facts = [
      { id: "f1", text: "one" },
      { id: "f2", text: "two" },
      { id: "f4", text: "four" },
    ];
    expect(filterFactsNotYetInjected(map, "sess-a", facts).map((f) => f.id)).toEqual(["f4"]);
    expect(filterFactsNotYetInjected(map, "sess-b", facts).map((f) => f.id)).toEqual(["f1", "f2", "f4"]);
  });

  it("clears dedup state for a session", () => {
    const map = new Map<string, Set<string>>([["sess", new Set(["f1"])]]);
    clearSessionInjectionDedup(map, "sess");
    expect(map.has("sess")).toBe(false);
  });
});
