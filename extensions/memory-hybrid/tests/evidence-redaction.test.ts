import { describe, expect, it } from "vitest";
import { EvidenceUnredactableError, redactEvidenceCapsuleInput } from "../services/evidence-redaction.js";
import type { CreateEvidenceCapsuleInput } from "../types/evidence-types.js";

const base: CreateEvidenceCapsuleInput = {
  title: "clean title",
  claim: "clean claim",
};

describe("redactEvidenceCapsuleInput", () => {
  it("passes clean content through unchanged", () => {
    const result = redactEvidenceCapsuleInput(base, { redactSecrets: true, rejectUnredactable: true });
    expect(result.redacted).toBe(false);
    expect(result.redactionCount).toBe(0);
    expect(result.title).toBe("clean title");
  });

  it("redacts a labeled secret in the claim", () => {
    const result = redactEvidenceCapsuleInput(
      { ...base, claim: "the API token: sk-ABCDEFGH12345678 still works" },
      { redactSecrets: true, rejectUnredactable: true },
    );
    expect(result.redacted).toBe(true);
    expect(result.claim).not.toContain("sk-ABCDEFGH12345678");
    expect(result.claim).toContain("[REDACTED]");
  });

  it("redacts secrets inside evidence items and commandsRun", () => {
    const result = redactEvidenceCapsuleInput(
      {
        ...base,
        evidence: [{ kind: "command", text: "curl -H 'Authorization: Bearer abc.def.ghi123456789'" }],
        commandsRun: ["export password=hunter2hunter2"],
      },
      { redactSecrets: true, rejectUnredactable: true },
    );
    expect(result.evidence[0]?.text).toContain("[REDACTED]");
    expect(result.commandsRun[0]).toContain("[REDACTED]");
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it("leaves content untouched when redactSecrets is false", () => {
    const result = redactEvidenceCapsuleInput(
      { ...base, claim: "token: sk-ABCDEFGH12345678" },
      { redactSecrets: false, rejectUnredactable: true },
    );
    expect(result.claim).toContain("sk-ABCDEFGH12345678");
    expect(result.redactionCount).toBe(0);
  });

  it("rejects an oversized/unstrippable PEM private-key block when rejectUnredactable is true", () => {
    const hugeKeyBody = "A".repeat(70_000);
    const claim = `here is a key:\n-----BEGIN RSA PRIVATE KEY-----\n${hugeKeyBody}\n-----END RSA PRIVATE KEY-----`;
    expect(() =>
      redactEvidenceCapsuleInput({ ...base, claim }, { redactSecrets: true, rejectUnredactable: true }),
    ).toThrow(EvidenceUnredactableError);
  });

  it("does not falsely flag ordinary evidence like commit SHAs or UUIDs", () => {
    const result = redactEvidenceCapsuleInput(
      {
        ...base,
        claim: "Fixed in commit a93fa8111234567890abcdef1234567890abcdef, entity 8b1c1f2e-6a3d-4e2f-9c1a-1234567890ab",
      },
      { redactSecrets: true, rejectUnredactable: true },
    );
    expect(result.redacted).toBe(false);
  });
});
