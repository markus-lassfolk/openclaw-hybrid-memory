/**
 * Regression tests for issue #1577:
 * credential_get must NOT include raw secret values in tool content.
 *
 * Acceptance criteria:
 * - result.content text does not contain the raw secret.
 * - Raw secret is only present in result.details.value (marked sensitiveFields: ["value"]).
 * - When credentials.revealInContent is true, the value IS present in content (opt-in path).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsDB } from "../backends/credentials-db.js";
import type { CredentialsConfig, HybridMemoryConfig } from "../config/types/index.js";
import type { PluginContext } from "../tools/credential-tools.js";
import { registerCredentialTools } from "../tools/credential-tools.js";

const TEST_KEY = "test-encryption-key-for-unit-tests-32chars";
const FAKE_SECRET = "ghp_FAKE_DO_NOT_LEAK_1234567890abcdef";

type ToolExecuteFn = (toolCallId: string, params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}>;

type MockApi = {
  registerTool(opts: { name: string; execute: ToolExecuteFn }, _options: unknown): void;
  getTool(name: string): { execute: ToolExecuteFn } | undefined;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  context: { sessionId: string };
};

function makeMockApi(): MockApi {
  const tools = new Map<string, { execute: ToolExecuteFn }>();
  return {
    registerTool(opts: { name: string; execute: ToolExecuteFn }, _options: unknown) {
      tools.set(opts.name, { execute: opts.execute });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

function makeMinimalCfg(overrides: Partial<CredentialsConfig> = {}): HybridMemoryConfig {
  const credentials: CredentialsConfig = {
    enabled: true,
    store: "sqlite",
    encryptionKey: "",
    expiryWarningDays: 7,
    revealInContent: false,
    ...overrides,
  };
  return { credentials } as HybridMemoryConfig;
}

function makeCtx(db: CredentialsDB, cfg: HybridMemoryConfig, api: MockApi): PluginContext {
  return { credentialsDb: db, cfg, api: api as unknown as PluginContext["api"] };
}

let tmpDir: string;
let db: CredentialsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cred-tools-no-leak-"));
  db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_KEY);
  db.store({ service: "github", type: "api_key", value: FAKE_SECRET });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("credential_get — no secret in content (issue #1577)", () => {
  it("content does not contain the raw secret value by default", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg();
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "github", type: "api_key" });

    // Serialize entire content array to verify no leakage even through nested structures
    const serializedContent = JSON.stringify(result.content);
    expect(serializedContent).not.toContain(FAKE_SECRET);
  });

  it("details.value contains the raw secret and is marked sensitive", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg();
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "github", type: "api_key" });

    expect(result.details.value).toBe(FAKE_SECRET);
    expect(Array.isArray(result.details.sensitiveFields)).toBe(true);
    expect((result.details.sensitiveFields as string[]).includes("value")).toBe(true);
  });

  it("content confirms retrieval without exposing the value", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg();
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "github", type: "api_key" });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("github");
    expect(text).toContain("api_key");
    expect(text).not.toContain(FAKE_SECRET);
  });

  it("not-found path does not include any secret in content", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg();
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "nonexistent" });

    expect(result.details.found).toBe(false);
    expect(JSON.stringify(result.content)).not.toContain(FAKE_SECRET);
  });
});

describe("credential_get — revealInContent opt-in path", () => {
  it("when revealInContent is true, the value appears in content", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg({ revealInContent: true });
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "github", type: "api_key" });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(FAKE_SECRET);
    // details.value and sensitiveFields must still be present even in reveal mode
    expect(result.details.value).toBe(FAKE_SECRET);
    expect((result.details.sensitiveFields as string[]).includes("value")).toBe(true);
  });

  it("revealInContent text includes a production warning", async () => {
    const api = makeMockApi();
    const cfg = makeMinimalCfg({ revealInContent: true });
    registerCredentialTools(makeCtx(db, cfg, api), api as unknown as PluginContext["api"]);

    const tool = api.getTool("credential_get");
    if (!tool) throw new Error("credential_get tool was not registered");

    const result = await tool.execute("call-1", { service: "github", type: "api_key" });

    const text = result.content[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("production");
  });
});
