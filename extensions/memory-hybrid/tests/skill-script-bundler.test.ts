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

  it("escapes double quotes in echo step labels", () => {
    const script = maybeBundleReplayScript([{ tool: "exec", args: { command: 'echo "ok"' } }]);
    expect(script).toContain('echo "Step 1: echo \\"ok\\""');
  });

  it("single-quotes every replay command for bash -lc", () => {
    const script = maybeBundleReplayScript([
      { tool: "exec", args: { command: "echo 'safe'; echo next && printf done" } },
    ]);
    expect(script).not.toBeNull();
    expect(script).toContain("bash -lc 'echo '\\''safe'\\''; echo next && printf done'");
    expect(script).not.toMatch(/^echo 'safe'; echo next && printf done$/m);
  });
});
