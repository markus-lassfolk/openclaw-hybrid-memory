import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hybridConfigSchema } from "../config.js";
import { isHybridMemCredentialsOnlyInvocation } from "../index-credentials-cli.js";
import { resolveCredentialsDbPath } from "../services/credentials-path.js";

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

function makeMockApi() {
  return {
    registerCli: vi.fn(),
    registerTool: vi.fn(),
    registerService: vi.fn(),
    registerLifecycleHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session", agentId: "test-agent" },
    config: {},
  };
}

describe("isHybridMemCredentialsOnlyInvocation", () => {
  it("detects credentials get/list/vault-status fast-path commands", () => {
    expect(
      isHybridMemCredentialsOnlyInvocation([
        "node",
        "openclaw",
        "hybrid-mem",
        "credentials",
        "get",
        "--service",
        "github",
        "--value-only",
      ]),
    ).toBe(true);
    expect(isHybridMemCredentialsOnlyInvocation(["node", "openclaw", "hybrid-mem", "credentials", "list"])).toBe(true);
    expect(
      isHybridMemCredentialsOnlyInvocation(["node", "openclaw", "hybrid-mem", "credentials", "vault-status"]),
    ).toBe(true);
  });

  it("rejects migrate-to-vault and non-credentials commands", () => {
    expect(
      isHybridMemCredentialsOnlyInvocation(["node", "openclaw", "hybrid-mem", "credentials", "migrate-to-vault"]),
    ).toBe(false);
    expect(isHybridMemCredentialsOnlyInvocation(["node", "openclaw", "hybrid-mem", "verify"])).toBe(false);
  });

  it("stops at -- separator", () => {
    expect(
      isHybridMemCredentialsOnlyInvocation([
        "node",
        "openclaw",
        "hybrid-mem",
        "credentials",
        "get",
        "--",
        "--value-only",
      ]),
    ).toBe(true);
  });
});

describe("resolveCredentialsDbPath", () => {
  it("places credentials.db next to the memory sqlite file", () => {
    expect(resolveCredentialsDbPath("/data/memory/facts.db")).toBe("/data/memory/credentials.db");
  });
});

describe("hybrid-mem credentials-only invocations", () => {
  let tmpDir: string;
  let oldArgv: string[];
  let memoryHybridPlugin: typeof import("../index.js").default;

  beforeEach(async () => {
    if (!hasNodeSqlite) return;
    memoryHybridPlugin = (await import("../index.js")).default;
    tmpDir = mkdtempSync(join(tmpdir(), "hybrid-mem-cred-only-"));
    oldArgv = process.argv;
  });

  afterEach(async () => {
    if (!hasNodeSqlite) return;
    process.argv = oldArgv;
    rmSync(tmpDir, { recursive: true, force: true });
    const { resetPluginRegistrationStateForTests } = await import("../setup/register-plugin.js");
    resetPluginRegistrationStateForTests();
  });

  it.skipIf(!hasNodeSqlite)(
    "credentials get --value-only registers CLI only (no tools/services, no facts.db bootstrap)",
    () => {
      process.argv = ["node", "openclaw", "hybrid-mem", "credentials", "get", "--service", "github", "--value-only"];
      const api = makeMockApi();
      const sqlitePath = join(tmpDir, "facts.db");
      const lanceDbPath = join(tmpDir, "lancedb");
      const pluginConfig = hybridConfigSchema.parse({
        sqlitePath,
        lanceDbPath,
        embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
        credentials: { enabled: true, encryptionKey: "test-encryption-key-for-unit-tests-32chars" },
      });
      const mockApi = {
        ...api,
        pluginConfig,
        registrationMode: "full" as const,
        resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
      };

      expect(memoryHybridPlugin.register(mockApi as never)).toBeUndefined();
      expect(existsSync(sqlitePath)).toBe(false);
      expect(api.registerCli).toHaveBeenCalled();
      expect(api.registerTool).not.toHaveBeenCalled();
      expect(api.registerService).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!hasNodeSqlite)("credentials migrate-to-vault uses full registration", () => {
    process.argv = ["node", "openclaw", "hybrid-mem", "credentials", "migrate-to-vault"];
    const api = makeMockApi();
    const sqlitePath = join(tmpDir, "facts.db");
    const lanceDbPath = join(tmpDir, "lancedb");
    const pluginConfig = hybridConfigSchema.parse({
      sqlitePath,
      lanceDbPath,
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: "test-encryption-key-for-unit-tests-32chars" },
    });
    const mockApi = {
      ...api,
      pluginConfig,
      registrationMode: "full" as const,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };

    expect(memoryHybridPlugin.register(mockApi as never)).toBeUndefined();
    expect(api.registerTool).toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalled();
  });
});
