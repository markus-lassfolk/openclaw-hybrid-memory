import { describe, expect, it } from "vitest";
import { redactMaintenancePrivateText } from "../utils/maintenance-privacy.js";
import { repairLooseJsonObject } from "../utils/llm-json-array.js";

describe("maintenance-privacy", () => {
  it("redacts home paths and emails", () => {
    const raw = "Check /home/markus/.openclaw/workspace/tmp/guards/foo and email m@test.com";
    const out = redactMaintenancePrivateText(raw);
    expect(out).not.toContain("/home/markus");
    expect(out).toContain("[private-path]");
    expect(out).toContain("[redacted-email]");
  });
});

describe("repairLooseJsonObject", () => {
  it("repairs trailing commas and extracts rules array", () => {
    const raw = '{"rules": ["Always verify repo ownership", "Use guard files first",], "noAction": false}';
    const obj = repairLooseJsonObject(raw);
    expect(obj?.rules).toEqual(["Always verify repo ownership", "Use guard files first"]);
  });
});
