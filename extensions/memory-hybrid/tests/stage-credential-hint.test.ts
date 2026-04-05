import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerCredentialHint } from "../lifecycle/stage-credential-hint.js";

function createApi() {
  let beforeStartHandler: (() => Promise<unknown> | unknown) | undefined;
  return {
    api: {
      on: vi.fn((event: string, handler: () => Promise<unknown> | unknown) => {
        if (event === "before_agent_start") beforeStartHandler = handler;
      }),
      logger: {
        warn: vi.fn(),
      },
    },
    runBeforeAgentStart: async () => {
      if (!beforeStartHandler) throw new Error("before_agent_start not registered");
      return await beforeStartHandler();
    },
  };
}

describe("stage-credential-hint", () => {
  let root: string;
  let sqlitePath: string;
  let pendingPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stage-credential-hint-"));
    const dbDir = join(root, "db");
    mkdirSync(dbDir, { recursive: true });
    sqlitePath = join(dbDir, "memory.sqlite");
    pendingPath = join(dbDir, "credentials-pending.json");
  });

  it("drops invalid/truncated JSON without throwing or reporting", async () => {
    writeFileSync(pendingPath, '{"hints": ["api_key"]', "utf8");

    const { api, runBeforeAgentStart } = createApi();
    const ctx = {
      cfg: {
        credentials: { enabled: true, autoDetect: true },
        verbosity: "normal",
      },
      resolvedSqlitePath: sqlitePath,
    } as const;

    registerCredentialHint(api as never, ctx as never);

    const result = await runBeforeAgentStart();
    expect(result).toBeUndefined();

    await expect(stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(api.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns prependContext for valid hints and clears file", async () => {
    writeFileSync(
      pendingPath,
      JSON.stringify({ hints: ["token", "password"], at: Date.now() }),
      "utf8",
    );

    const { api, runBeforeAgentStart } = createApi();
    const ctx = {
      cfg: {
        credentials: { enabled: true, autoDetect: true },
        verbosity: "normal",
      },
      resolvedSqlitePath: sqlitePath,
    } as const;

    registerCredentialHint(api as never, ctx as never);
    const result = (await runBeforeAgentStart()) as { prependContext: string };

    expect(result.prependContext).toContain("credential-hint");
    expect(result.prependContext).toContain("token, password");
    await expect(stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
