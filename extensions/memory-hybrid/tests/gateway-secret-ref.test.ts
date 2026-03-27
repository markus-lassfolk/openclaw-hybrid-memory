import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGatewayConfig, resolveSecretRef } from "../config/parsers/core.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gateway-secret-ref-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ── resolveSecretRef ──────────────────────────────────────────────────────────

describe("resolveSecretRef", () => {
  it("returns undefined for empty string", () => {
    expect(resolveSecretRef("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(resolveSecretRef("   ")).toBeUndefined();
  });

  it("resolves env: prefix from environment variable", () => {
    vi.stubEnv("TEST_GW_TOKEN_278", "my-secret-token");
    expect(resolveSecretRef("env:TEST_GW_TOKEN_278")).toBe("my-secret-token");
  });

  it("trims resolved env var value", () => {
    vi.stubEnv("TEST_GW_TOKEN_278", "  trimmed-token  ");
    expect(resolveSecretRef("env:TEST_GW_TOKEN_278")).toBe("trimmed-token");
  });

  it("returns undefined when env var is not set", () => {
    delete process.env.TEST_GW_TOKEN_UNSET_278;
    expect(resolveSecretRef("env:TEST_GW_TOKEN_UNSET_278")).toBeUndefined();
  });

  it("returns undefined when env var is empty string", () => {
    vi.stubEnv("TEST_GW_TOKEN_EMPTY_278", "");
    expect(resolveSecretRef("env:TEST_GW_TOKEN_EMPTY_278")).toBeUndefined();
  });

  it("returns undefined for env: with no var name", () => {
    expect(resolveSecretRef("env:")).toBeUndefined();
    expect(resolveSecretRef("env:   ")).toBeUndefined();
  });

  it("resolves file: prefix by reading the file", () => {
    const tokenFile = join(tmpDir, "token.txt");
    writeFileSync(tokenFile, "file-backed-token\n");
    expect(resolveSecretRef(`file:${tokenFile}`)).toBe("file-backed-token");
  });

  it("trims file contents on resolution", () => {
    const tokenFile = join(tmpDir, "token.txt");
    writeFileSync(tokenFile, "  spaces-token  \n");
    expect(resolveSecretRef(`file:${tokenFile}`)).toBe("spaces-token");
  });

  it("returns undefined when file does not exist", () => {
    expect(resolveSecretRef(`file:${tmpDir}/nonexistent.txt`)).toBeUndefined();
  });

  it("returns undefined for file: with empty path", () => {
    expect(resolveSecretRef("file:")).toBeUndefined();
    expect(resolveSecretRef("file:  ")).toBeUndefined();
  });

  it("returns plain string as-is", () => {
    expect(resolveSecretRef("plain-token-value")).toBe("plain-token-value");
  });

  it("trims plain string before returning", () => {
    expect(resolveSecretRef("  plain  ")).toBe("plain");
  });

  it("resolves ${VAR} template syntax", () => {
    vi.stubEnv("TEST_VAR_TMPL", "template-value");
    expect(resolveSecretRef("${TEST_VAR_TMPL}")).toBe("template-value");
  });

  it("resolves ${VAR} template with surrounding text", () => {
    vi.stubEnv("TEST_VAR_TMPL", "value");
    expect(resolveSecretRef("prefix-${TEST_VAR_TMPL}-suffix")).toBe("prefix-value-suffix");
  });

  it("returns undefined when ${VAR} template references unset env var", () => {
    delete process.env.TEST_VAR_UNSET;
    expect(resolveSecretRef("${TEST_VAR_UNSET}")).toBeUndefined();
  });

  it("accepts resolved value containing literal ${ without closing brace", () => {
    vi.stubEnv("TEST_VAR_WITH_DOLLAR", "val${ue");
    expect(resolveSecretRef("${TEST_VAR_WITH_DOLLAR}")).toBe("val${ue");
  });

  it("accepts plain string containing ${ without closing brace", () => {
    expect(resolveSecretRef("plain${ token")).toBe("plain${ token");
  });

  it("returns undefined for malformed template with unresolved ${VAR} pattern", () => {
    vi.stubEnv("TEST_VAR_A", "value-a");
    expect(resolveSecretRef("${TEST_VAR_A}-${TEST_VAR_B}")).toBeUndefined();
  });
});

// ── parseGatewayConfig ────────────────────────────────────────────────────────

describe("parseGatewayConfig", () => {
  it("returns undefined when no gateway key", () => {
    expect(parseGatewayConfig({})).toBeUndefined();
  });

  it("returns undefined when gateway is not an object", () => {
    expect(parseGatewayConfig({ gateway: "string" })).toBeUndefined();
    expect(parseGatewayConfig({ gateway: 42 })).toBeUndefined();
  });

  it("returns undefined when gateway has no auth", () => {
    expect(parseGatewayConfig({ gateway: {} })).toBeUndefined();
  });

  it("returns undefined when auth has no token", () => {
    expect(parseGatewayConfig({ gateway: { auth: {} } })).toBeUndefined();
    expect(parseGatewayConfig({ gateway: { auth: { token: "" } } })).toBeUndefined();
  });

  it("stores the SecretRef string as enumerable token (safe for config display)", () => {
    vi.stubEnv("MY_GATEWAY_TOKEN_278", "secret");
    const result = parseGatewayConfig({ gateway: { auth: { token: "env:MY_GATEWAY_TOKEN_278" } } });
    expect(result?.auth?.token).toBe("env:MY_GATEWAY_TOKEN_278");
  });

  it("stores resolved value as non-enumerable _resolvedToken", () => {
    vi.stubEnv("MY_GATEWAY_TOKEN_278", "actual-secret");
    const result = parseGatewayConfig({ gateway: { auth: { token: "env:MY_GATEWAY_TOKEN_278" } } });
    expect(result?.auth?._resolvedToken).toBe("actual-secret");
  });

  it("_resolvedToken is not visible in JSON.stringify output", () => {
    vi.stubEnv("MY_GATEWAY_TOKEN_278", "actual-secret");
    const result = parseGatewayConfig({ gateway: { auth: { token: "env:MY_GATEWAY_TOKEN_278" } } });
    const json = JSON.stringify(result);
    expect(json).not.toContain("actual-secret");
    expect(json).toContain("env:MY_GATEWAY_TOKEN_278");
  });

  it("resolves file-backed token", () => {
    const tokenFile = join(tmpDir, "gw-token.txt");
    writeFileSync(tokenFile, "file-token-value");
    const result = parseGatewayConfig({ gateway: { auth: { token: `file:${tokenFile}` } } });
    expect(result?.auth?._resolvedToken).toBe("file-token-value");
    // The SecretRef string is preserved in the enumerable field
    expect(result?.auth?.token).toBe(`file:${tokenFile}`);
  });

  it("sets _resolvedToken to undefined when SecretRef cannot be resolved", () => {
    delete process.env.UNSET_GW_TOKEN_278;
    const result = parseGatewayConfig({ gateway: { auth: { token: "env:UNSET_GW_TOKEN_278" } } });
    // The config is still returned (SecretRef string is valid), but resolved value is undefined
    expect(result?.auth?.token).toBe("env:UNSET_GW_TOKEN_278");
    expect(result?.auth?._resolvedToken).toBeUndefined();
  });

  it("accepts plain string token (not a SecretRef)", () => {
    const result = parseGatewayConfig({ gateway: { auth: { token: "plain-token-value" } } });
    expect(result?.auth?.token).toBe("plain-token-value");
    expect(result?.auth?._resolvedToken).toBe("plain-token-value");
  });
});
