/**
 * Regression tests for #2138: `memory_store` diverted ordinary infrastructure facts into bogus
 * credential vault entries. Root cause — the bare SSH connection-string pattern
 * (`ssh <host> <user>`) matched ordinary prose, and because extractCredentialMatch returned the
 * connection string as a "secret" with hasPatternMatch=true, validateCredentialValue skipped its
 * natural-language guard and accepted it. A bare SSH connection string carries no secret, so it is
 * now `detectionOnly`: it may still prompt the user, but it never routes into the vault.
 */
import { describe, expect, it } from "vitest";
import {
  detectCredentialPatterns,
  extractCredentialMatch,
  isStructuredCredentialCandidate,
  tryParseCredentialForVault,
} from "../services/auto-capture.js";

describe("SSH connection strings are not vault-routable credentials (#2138)", () => {
  // The concrete shape from the issue: infrastructure fact for DorisVM referencing stored service
  // names (doris-windows-host, doris-vm-ssh) and an ssh access method — but no secret payload.
  const infraText =
    "DorisVM runtime: Hyper-V host maevevm, VM IP 192.168.1.42, gateway port 8443, static MAC " +
    "00:15:5d:01:02:03. Connect via ssh doris-vm-ssh service; stored service doris-windows-host.";

  it("extractCredentialMatch no longer treats a bare SSH connection string as a secret", () => {
    expect(extractCredentialMatch("ssh root@192.168.1.1 deploy-server")).toBeNull();
    expect(extractCredentialMatch(infraText)).toBeNull();
  });

  it("isStructuredCredentialCandidate returns false for a bare SSH connection string / infra note", () => {
    expect(isStructuredCredentialCandidate("ssh root@192.168.1.1 deploy-server")).toBe(false);
    expect(isStructuredCredentialCandidate(infraText, "DorisVM", "runtime_host_and_network", null)).toBe(false);
  });

  it("tryParseCredentialForVault returns null for infra text mentioning ssh + service names", () => {
    expect(tryParseCredentialForVault(infraText, "DorisVM", "runtime_host_and_network", null)).toBeNull();
    // Even with requirePatternMatch off, a value that is just narrative infra text is not a secret.
    expect(
      tryParseCredentialForVault(infraText, "DorisVM", "runtime_host_and_network", infraText),
    ).toBeNull();
  });

  it("still routes a REAL secret to the vault (JWT / sk- / connection-string password)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const parsedJwt = tryParseCredentialForVault(`Authorization: Bearer ${jwt}`, null, null, null);
    expect(parsedJwt?.type).toBe("bearer");

    const parsedConn = tryParseCredentialForVault(
      "mongodb://svc-user:s3cr3t-pw-example@db.internal:27017/app",
      null,
      null,
      null,
    );
    expect(parsedConn?.type).toBe("password");
    expect(parsedConn?.secretValue).toBe("s3cr3t-pw-example");
  });

  it("still surfaces a bare SSH connection string as a detection-only prompt hint", () => {
    // detectCredentialPatterns is the user-facing nudge (never a vault write); it may still flag ssh.
    const detected = detectCredentialPatterns("ssh root@192.168.1.1 deploy-server");
    expect(detected.some((d) => d.type === "ssh")).toBe(true);
  });
});
