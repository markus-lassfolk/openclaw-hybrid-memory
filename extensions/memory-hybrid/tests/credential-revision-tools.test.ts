/**
 * Regression tests for issue #2104 — credential_revision_* agent tools.
 *
 * Acceptance criteria covered here:
 * - Overwriting a credential creates a revision automatically.
 * - credential_revision_list never exposes values.
 * - credential_revision_get retrieves a specific revision's value intentionally.
 * - credential_revision_restore promotes a revision back to current.
 * - credential_revision_purge hard-deletes (single or all).
 * - credential_revision_pin/unpin controls expiry exemption.
 * - Normal credential_get is unaffected by revision history.
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

type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{
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

let tmpDir: string;
let db: CredentialsDB;
let api: MockApi;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cred-revision-tools-"));
  db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_KEY);
  api = makeMockApi();
  const cfg = makeMinimalCfg();
  // credential_store requires factsDb to write a vault pointer fact; stub it so store() succeeds
  // without pulling in the real FactsDB (irrelevant to what these revision-tool tests exercise).
  const factsDb = {
    storeWithResult: vi.fn().mockReturnValue({
      skipped: false,
      newlyStored: true,
      embeddingStale: false,
      evictedFactId: null,
      entry: { id: "pointer-1", text: "pointer", category: "technical" },
    }),
  } as unknown as PluginContext["factsDb"];
  const ctx: PluginContext = {
    credentialsDb: db,
    factsDb,
    cfg,
    api: api as unknown as PluginContext["api"],
    currentAgentIdRef: { value: "agent-42" },
  };
  registerCredentialTools(ctx, api as unknown as PluginContext["api"]);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function getTool(name: string): { execute: ToolExecuteFn } {
  const tool = api.getTool(name);
  if (!tool) throw new Error(`${name} tool was not registered`);
  return tool;
}

describe("credential_store — retention note (#2104)", () => {
  it("mentions revision retention when overwriting an existing credential", async () => {
    await getTool("credential_store").execute("c1", {
      service: "doris-gateway",
      type: "other",
      value: "192.168.1.195",
    });
    const result = await getTool("credential_store").execute("c2", {
      service: "doris-gateway",
      type: "other",
      value: "192.168.1.70",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/retained as revision/i);
  });

  it("says nothing about retention for a brand-new credential", async () => {
    const result = await getTool("credential_store").execute("c1", {
      service: "brand-new",
      type: "other",
      value: "v1",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).not.toMatch(/retained as revision/i);
  });
});

describe("credential_revision_list (#2104)", () => {
  it("lists revisions without exposing values", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "secret-2" });

    const result = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    expect(result.details.count).toBe(1);
    expect(JSON.stringify(result.details)).not.toContain("secret-1");
  });

  it("reports zero revisions for a service with only one stored value", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    const result = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    expect(result.details.count).toBe(0);
  });
});

describe("credential_revision_get (#2104)", () => {
  it("retrieves the prior value intentionally", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "secret-2" });
    const list = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    const revisionId = (list.details.revisions as Array<{ id: string }>)[0].id;

    const result = await getTool("credential_revision_get").execute("g1", {
      service: "svc",
      type: "token",
      revision: revisionId,
    });
    expect(result.details.value).toBe("secret-1");
    expect(JSON.stringify(result.content)).not.toContain("secret-1");
  });

  it("returns found:false for an unknown revision id", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    const result = await getTool("credential_revision_get").execute("g1", {
      service: "svc",
      type: "token",
      revision: "does-not-exist",
    });
    expect(result.details.found).toBe(false);
  });
});

describe("credential_revision_restore (#2104)", () => {
  it("promotes a revision back to current", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "secret-2" });
    const list = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    const revisionId = (list.details.revisions as Array<{ id: string }>)[0].id;

    const result = await getTool("credential_revision_restore").execute("r1", {
      service: "svc",
      type: "token",
      revision: revisionId,
    });
    expect(result.details.restored).toBe(true);

    const current = await getTool("credential_get").execute("g1", { service: "svc", type: "token" });
    expect(current.details.value).toBe("secret-1");
  });
});

describe("credential_revision_purge (#2104)", () => {
  it("purges a single revision", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "secret-1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "secret-2" });
    const list = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    const revisionId = (list.details.revisions as Array<{ id: string }>)[0].id;

    const result = await getTool("credential_revision_purge").execute("p1", {
      service: "svc",
      type: "token",
      revision: revisionId,
    });
    expect(result.details.purged).toBe(1);

    const listAfter = await getTool("credential_revision_list").execute("l2", { service: "svc", type: "token" });
    expect(listAfter.details.count).toBe(0);
  });

  it("purges every revision with all:true", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "v1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "v2" });
    await getTool("credential_store").execute("c3", { service: "svc", type: "token", value: "v3" });

    const result = await getTool("credential_revision_purge").execute("p1", {
      service: "svc",
      type: "token",
      all: true,
    });
    expect(result.details.purged).toBeGreaterThanOrEqual(2);

    const listAfter = await getTool("credential_revision_list").execute("l2", { service: "svc", type: "token" });
    expect(listAfter.details.count).toBe(0);
  });

  it("throws when neither revision nor all is specified", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "v1" });
    await expect(
      getTool("credential_revision_purge").execute("p1", { service: "svc", type: "token" }),
    ).rejects.toThrow();
  });
});

describe("credential_revision_pin (#2104)", () => {
  it("pins and unpins a revision", async () => {
    await getTool("credential_store").execute("c1", { service: "svc", type: "token", value: "v1" });
    await getTool("credential_store").execute("c2", { service: "svc", type: "token", value: "v2" });
    const list = await getTool("credential_revision_list").execute("l1", { service: "svc", type: "token" });
    const revisionId = (list.details.revisions as Array<{ id: string }>)[0].id;

    const pinResult = await getTool("credential_revision_pin").execute("pin1", {
      service: "svc",
      type: "token",
      revision: revisionId,
      pinned: true,
    });
    expect(pinResult.details.changed).toBe(true);

    const unpinResult = await getTool("credential_revision_pin").execute("pin2", {
      service: "svc",
      type: "token",
      revision: revisionId,
      pinned: false,
    });
    expect(unpinResult.details.changed).toBe(true);
  });

  it("reports changed:false for an unknown revision id", async () => {
    const result = await getTool("credential_revision_pin").execute("pin1", {
      service: "svc",
      type: "token",
      revision: "does-not-exist",
      pinned: true,
    });
    expect(result.details.changed).toBe(false);
  });
});
