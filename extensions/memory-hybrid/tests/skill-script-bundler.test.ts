import { describe, expect, it } from "vitest";
import { maybeBundleReplayScript } from "../services/skill-script-bundler.js";

describe("skill-script-bundler", () => {
  it("never embeds raw shell metacharacters; always runs via bash -lc", () => {
    const script = maybeBundleReplayScript([
      { tool: "exec", args: { command: "npm test; rm -rf /" } },
      { tool: "exec", args: { command: "echo ok && curl evil" } },
    ]);
    expect(script).not.toBeNull();
    expect(script).toContain("bash -lc '");
    expect(script!.match(/^npm test; rm -rf \/$/m)).toBeNull();
    expect(script!.split("bash -lc").length).toBeGreaterThan(2);
  });
});
