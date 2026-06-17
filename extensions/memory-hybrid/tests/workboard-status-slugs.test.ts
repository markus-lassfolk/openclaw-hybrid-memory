import { describe, expect, it } from "vitest";
import { isValidWorkboardStatusSlug, toWorkboardStatusSlug } from "../services/workboard-status-slugs.js";

describe("workboard-status-slugs", () => {
  it("passes through valid slugs", () => {
    expect(toWorkboardStatusSlug("running")).toBe("running");
    expect(toWorkboardStatusSlug("DONE")).toBe("done");
    expect(isValidWorkboardStatusSlug("backlog")).toBe(true);
  });

  it("maps legacy display labels to slugs", () => {
    expect(toWorkboardStatusSlug("In Progress")).toBe("running");
    expect(toWorkboardStatusSlug("Waiting")).toBe("scheduled");
    expect(toWorkboardStatusSlug("Backlog")).toBe("backlog");
    expect(toWorkboardStatusSlug("Failed")).toBe("blocked");
    expect(toWorkboardStatusSlug("Blocked")).toBe("blocked");
  });
});
