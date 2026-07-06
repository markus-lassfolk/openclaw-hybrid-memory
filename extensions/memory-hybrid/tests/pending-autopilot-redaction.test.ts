/**
 * Regression test (loop iteration 37): the credential-keyword SECRET_PATTERNS regex in
 * redactAutopilotText required its `:`/`=` to follow the keyword with only whitespace in
 * between (`\s*[:=]`). A JSON-serialized credential — `{"password":"hunter2"}` — has a closing
 * quote between the keyword and the colon (`password":`), which `\s*` never matches, so the
 * whole match failed and the secret passed through unredacted into audit/summary output.
 */
import { describe, expect, it } from "vitest";
import { redactAutopilotText } from "../services/pending-autopilot/redaction.js";

describe("redactAutopilotText JSON-quoted credential keys (loop iteration 37 regression)", () => {
  it("redacts a password value in a JSON-serialized object", () => {
    const { redacted, redactionCount } = redactAutopilotText('{"password":"hunter2"}');
    expect(redacted).not.toContain("hunter2");
    expect(redactionCount).toBeGreaterThan(0);
  });

  it("redacts secret/token/api_key values in JSON-serialized text", () => {
    const raw = '{"secret":"topsecretvalue","token":"abc.def.ghi","api_key":"sk-live-abc123def456"}';
    const { redacted } = redactAutopilotText(raw);
    expect(redacted).not.toContain("topsecretvalue");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("sk-live-abc123def456");
  });

  it("still redacts the plain whitespace-separated form (no regression on the original case)", () => {
    const { redacted } = redactAutopilotText("password: hunter2");
    expect(redacted).not.toContain("hunter2");
  });

  it("redacts a JSON credential embedded inside free text (e.g. a captured curl command)", () => {
    const raw = `curl -d '{"password":"hunter2"}' https://example.com/login`;
    const { redacted } = redactAutopilotText(raw);
    expect(redacted).not.toContain("hunter2");
  });
});
