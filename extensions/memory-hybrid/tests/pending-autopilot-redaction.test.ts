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

/**
 * Regression test (loop iteration 102): SECRET_PATTERNS' `\b(?:...|token|...)\b` word-boundary
 * match requires the keyword to be preceded by a non-word character, but a lowercase-to-uppercase
 * transition (camelCase) and `_` (a word character) are both NOT `\b` transitions -- so a
 * credential keyword glued onto a compound identifier (`sessionToken:`, `auth_token:`) passed
 * through unredacted, even though the structured object-key redaction a few lines below already
 * treats these exact compound forms as sensitive via CREDENTIAL_KEY_NORMALIZED.
 */
describe("redactAutopilotText compound credential-key identifiers (loop iteration 102 regression)", () => {
  it("redacts camelCase-compound keyword forms", () => {
    for (const raw of [
      'sessionToken: "sekrit-value-1"',
      'authToken: "sekrit-value-2"',
      'clientSecret: "sekrit-value-3"',
      'refreshToken: "sekrit-value-4"',
    ]) {
      const { redacted, redactionCount } = redactAutopilotText(raw);
      expect(redactionCount).toBeGreaterThan(0);
      expect(redacted).not.toContain("sekrit-value");
    }
  });

  it("redacts underscore-joined compound keyword forms", () => {
    const raw = 'auth_token: "sekrit-value-5"';
    const { redacted, redactionCount } = redactAutopilotText(raw);
    expect(redactionCount).toBeGreaterThan(0);
    expect(redacted).not.toContain("sekrit-value-5");
  });

  it("still redacts the plain standalone form (no regression on the original case)", () => {
    const { redacted } = redactAutopilotText('token: "sekrit-value-6"');
    expect(redacted).not.toContain("sekrit-value-6");
  });
});
