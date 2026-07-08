/**
 * validateUrl() (apitap_capture / apitap_peek's capture-time gate) only checked
 * blockedPatterns/allowedPatterns -- glob-style matches against the URL's path and literal host
 * text. It never resolved the hostname, so an agent tool call could point the apitap CLI's
 * headless browser at loopback/private/link-local targets (including cloud metadata endpoints
 * like 169.254.169.254) as long as the URL text itself didn't contain a blocked keyword. This
 * test proves the fix: validateUrl() now also rejects hosts that resolve (or are given as an IP
 * literal) to a private/loopback/link-local address, via the same SSRF guard goal-health's
 * http_ok verification already uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiTapConfig } from "../config/types/features.js";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: lookupMock };
});

const { validateUrl } = await import("../services/apitap-service.js");

function makeCfg(overrides: Partial<ApiTapConfig> = {}): ApiTapConfig {
  return {
    enabled: true,
    captureTimeoutSeconds: 60,
    endpointTtlDays: 30,
    maxEndpointsPerSession: 50,
    allowedPatterns: [],
    blockedPatterns: ["**/*oauth*/**", "**/*auth*/**"],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("validateUrl SSRF host guard", () => {
  it("blocks a literal loopback IP without needing a DNS lookup", async () => {
    const result = await validateUrl("http://127.0.0.1:8080/admin", makeCfg());
    expect(result).toMatch(/not allowed/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks a literal cloud metadata link-local IP", async () => {
    const result = await validateUrl("http://169.254.169.254/latest/meta-data/", makeCfg());
    expect(result).toMatch(/not allowed/i);
  });

  it("blocks a hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const result = await validateUrl("http://internal-service.invalid/api", makeCfg());
    expect(result).toMatch(/not allowed/i);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("allows a hostname that resolves to a public address and passes pattern checks", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const result = await validateUrl("https://api.example.com/v1/widgets", makeCfg());
    expect(result).toBeNull();
  });

  it("still rejects a public host whose path matches a blocked pattern", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const result = await validateUrl("https://api.example.com/oauth/token", makeCfg());
    expect(result).toMatch(/blocked pattern/i);
  });
});
