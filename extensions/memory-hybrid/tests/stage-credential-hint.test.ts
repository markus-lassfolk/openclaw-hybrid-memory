/**
 * registerCredentialHint before_agent_start JSON/file boundaries.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCredentialHint } from "../lifecycle/stage-credential-hint.js";
import { capturePluginError } from "../services/error-reporter.js";
import { FactsDB } from "../backends/facts-db.js";
import { buildRecallLifecycleContext } from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

describe("registerCredentialHint", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let pendingPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stage-credential-hint-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    pendingPath = join(tmpDir, "credentials-pending.json");
    vi.mocked(capturePluginError).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureHandler(ctx: ReturnType<typeof buildRecallLifecycleContext>) {
    const api = { on: vi.fn(), logger: { warn: vi.fn() } };
    registerCredentialHint(api as never, ctx);
    const reg = (api.on as ReturnType<typeof vi.fn>).mock.calls[0];
    return reg[1] as () => Promise<{ prependContext?: string } | undefined>;
  }

  it("removes invalid JSON without throwing and returns no prependContext", async () => {
    writeFileSync(pendingPath, "{not-json", "utf-8");
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    ctx.cfg.credentials = {
      enabled: true,
      autoDetect: true,
      store: "sqlite",
      encryptionKey: "test-key-32-chars-minimum!!!!",
    };

    const handler = captureHandler(ctx);
    const out = await handler();

    expect(out).toBeUndefined();
    expect(ctx.resolvedSqlitePath).toBeTruthy();
  });

  it("returns credential-hint prependContext for fresh valid pending file", async () => {
    writeFileSync(pendingPath, JSON.stringify({ hints: ["github token"], at: Date.now() }), "utf-8");
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    ctx.cfg.credentials = {
      enabled: true,
      autoDetect: true,
      store: "sqlite",
      encryptionKey: "test-key-32-chars-minimum!!!!",
    };
    ctx.cfg.verbosity = "normal";

    const handler = captureHandler(ctx);
    const out = await handler();

    expect(out?.prependContext).toContain("<credential-hint>");
    expect(out?.prependContext).toContain("github token");
  });
});
