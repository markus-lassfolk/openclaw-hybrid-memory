/**
 * Tests for apitap tool registrations (Issue #614).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerApitapTools } from "../tools/apitap-tools.js";
import { ApitapStore } from "../backends/apitap-store.js";
import { ApitapService } from "../services/apitap-service.js";
import type { HybridMemoryConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Minimal mock API
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools = new Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => Promise<unknown> }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, {
        opts,
        execute: opts.execute as (...args: unknown[]) => Promise<unknown>,
      });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    callTool(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// Minimal config factory
// ---------------------------------------------------------------------------

function makeDisabledConfig(): HybridMemoryConfig {
  return {
    apiTap: {
      enabled: false,
      captureTimeoutSeconds: 60,
      endpointTtlDays: 30,
      maxEndpointsPerSession: 50,
      allowedPatterns: [],
      blockedPatterns: ["**/*oauth*/**", "**/*auth*/**"],
    },
  } as unknown as HybridMemoryConfig;
}

function makeEnabledConfig(): HybridMemoryConfig {
  return {
    ...makeDisabledConfig(),
    apiTap: { ...makeDisabledConfig().apiTap, enabled: true },
  } as unknown as HybridMemoryConfig;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ApitapStore;
let api: ReturnType<typeof makeMockApi>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "apitap-tools-test-"));
  store = new ApitapStore(join(tmpDir, "apitap.db"));
  api = makeMockApi();
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("registerApitapTools — registration", () => {
  it("registers apitap_capture", () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    expect(api.getTool("apitap_capture")).toBeDefined();
  });

  it("registers apitap_peek", () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    expect(api.getTool("apitap_peek")).toBeDefined();
  });

  it("registers apitap_list", () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    expect(api.getTool("apitap_list")).toBeDefined();
  });

  it("registers apitap_to_skill", () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    expect(api.getTool("apitap_to_skill")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// apitap_capture — disabled path
// ---------------------------------------------------------------------------

describe("apitap_capture", () => {
  it("returns disabled message when apiTap.enabled = false", async () => {
    registerApitapTools({ apitapStore: store, cfg: makeDisabledConfig() }, api as any);
    const result = (await api.callTool("apitap_capture", { url: "https://example.com" })) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/disabled/i);
  });

  it("returns not-installed message when apitap CLI is absent (enabled = true)", async () => {
    // Deterministically force isAvailable() = false via prototype spy
    const spy = vi.spyOn(ApitapService.prototype, "isAvailable").mockReturnValue(false);
    try {
      registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
      const result = (await api.callTool("apitap_capture", { url: "https://example.com" })) as any;
      const text = result?.content?.[0]?.text ?? "";
      expect(text).toMatch(/not installed/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// apitap_peek — disabled path
// ---------------------------------------------------------------------------

describe("apitap_peek", () => {
  it("returns disabled message when apiTap.enabled = false", async () => {
    registerApitapTools({ apitapStore: store, cfg: makeDisabledConfig() }, api as any);
    const result = (await api.callTool("apitap_peek", { url: "https://example.com" })) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// apitap_list — empty store
// ---------------------------------------------------------------------------

describe("apitap_list", () => {
  it("returns empty list when store has no endpoints", async () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    const result = (await api.callTool("apitap_list", {})) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(typeof text).toBe("string");
  });

  it("still works when apiTap.enabled = false (read-only access to existing data)", async () => {
    // apitap_list is a read-only operation and must work even when new captures are disabled.
    store.create({ siteUrl: "https://example.com", endpoint: "/api/items", method: "GET", sessionId: "s1" });
    registerApitapTools({ apitapStore: store, cfg: makeDisabledConfig() }, api as any);
    const result = (await api.callTool("apitap_list", {})) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain("/api/items");
  });

  it("lists endpoints in the store", async () => {
    store.create({
      siteUrl: "https://example.com",
      endpoint: "/api/users",
      method: "GET",
      parameters: {},
      sessionId: "sess-1",
    });
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    const result = (await api.callTool("apitap_list", {})) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain("/api/users");
  });
});

// ---------------------------------------------------------------------------
// apitap_to_skill — unknown id
// ---------------------------------------------------------------------------

describe("apitap_to_skill", () => {
  it("returns error for unknown endpoint id", async () => {
    registerApitapTools({ apitapStore: store, cfg: makeEnabledConfig() }, api as any);
    const result = (await api.callTool("apitap_to_skill", { id: "nonexistent-id" })) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/not found|disabled/i);
  });

  it("still works when apiTap.enabled = false (read-only access to existing data)", async () => {
    // apitap_to_skill is a read-only operation; it must work for audit/recovery even when captures are disabled.
    const ep = store.create({ siteUrl: "https://example.com", endpoint: "/api/data", method: "GET", sessionId: "s1" });
    registerApitapTools({ apitapStore: store, cfg: makeDisabledConfig() }, api as any);
    const result = (await api.callTool("apitap_to_skill", { id: ep.id })) as any;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain("/api/data");
  });
});
