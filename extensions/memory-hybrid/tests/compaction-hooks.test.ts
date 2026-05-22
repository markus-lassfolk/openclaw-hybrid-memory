/**
 * before_compaction / after_compaction hook wiring in registerLifecycleHooks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerLifecycleHooks } from "../setup/register-hooks.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";
import * as postCompactionRecall from "../services/post-compaction-recall.js";
import { buildPluginApiForRegisterHooks, captureHookHandler, makeHooksApi } from "./helpers/register-hooks-harness.js";

vi.mock("../lifecycle/stage-capture.js", () => ({
  runCaptureStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worker/narratives.js", () => ({
  buildDailyNarrative: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/pre-consolidation-flush.js", () => ({
  runPreConsolidationFlush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/post-compaction-recall.js", () => ({
  buildPostCompactionRecallSnippet: vi.fn().mockResolvedValue(null),
}));

describe("compaction lifecycle hooks", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "compaction-hooks-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(runPreConsolidationFlush).mockClear();
    vi.mocked(postCompactionRecall.buildPostCompactionRecallSnippet).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers before_compaction and after_compaction on api.on", () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb);
    registerLifecycleHooks(pluginApi as never, api as never);

    const events = (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("before_compaction");
    expect(events).toContain("after_compaction");
  });

  it("before_compaction runs pre-consolidation flush", async () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb);
    registerLifecycleHooks(pluginApi as never, api as never);
    const handler = captureHookHandler(api, "before_compaction");

    await handler?.({ messageCount: 10, tokenCount: 5000 }, {});

    expect(runPreConsolidationFlush).toHaveBeenCalledWith(
      expect.objectContaining({ factsDb, wal: null }),
      api.logger,
      "before_compaction",
    );
  });

  it("before_compaction quality-gates recall-count pinned memories but preserves permanent pins", async () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, {
      autoRecall: { progressivePinnedRecallCount: 3 },
    });
    const lowQualityHot = factsDb.store({
      text: "low-quality recalled memory",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.2,
      confidence: 0.2,
    });
    const permanentHot = factsDb.store({
      text: "permanent memory",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.2,
      confidence: 0.2,
      decayClass: "permanent",
    });
    factsDb.setTier(lowQualityHot.id, "hot");
    factsDb.setTier(permanentHot.id, "hot");
    factsDb.refreshAccessedFacts([lowQualityHot.id]);
    factsDb.refreshAccessedFacts([lowQualityHot.id]);
    factsDb.refreshAccessedFacts([lowQualityHot.id]);
    factsDb.refreshAccessedFacts([permanentHot.id]);

    registerLifecycleHooks(pluginApi as never, api as never);
    const handler = captureHookHandler(api, "before_compaction");

    const out = (await handler?.({ messageCount: 10, tokenCount: 5000 }, {})) as
      | { prependContext?: string }
      | undefined;

    expect(out?.prependContext).toContain("permanent memory");
    expect(out?.prependContext).not.toContain("low-quality recalled memory");
  });

  it("after_compaction returns undefined in silent verbosity without injecting", async () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, { verbosity: "silent" });
    factsDb.store({
      text: "should not appear in silent mode",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    registerLifecycleHooks(pluginApi as never, api as never);
    const handler = captureHookHandler(api, "after_compaction");

    const out = await handler?.({ messageCount: 5, compactedCount: 2 }, {});

    expect(out).toBeUndefined();
    expect(postCompactionRecall.buildPostCompactionRecallSnippet).not.toHaveBeenCalled();
  });

  it("after_compaction injects post-compaction summary when facts exist", async () => {
    const api = makeHooksApi();
    const pluginApi = buildPluginApiForRegisterHooks(tmpDir, factsDb, {
      verbosity: "normal",
      autoRecall: { enabled: true },
    });
    (pluginApi.lastAutoRecallPromptRef as { value: string | null }).value = "long enough prompt for recall";
    factsDb.store({
      text: "retained fact across compaction",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    });
    vi.mocked(postCompactionRecall.buildPostCompactionRecallSnippet).mockResolvedValue(
      "<!-- memory-hybrid: post-compaction recall -->\n<recalled-context>hit</recalled-context>",
    );
    registerLifecycleHooks(pluginApi as never, api as never);
    const handler = captureHookHandler(api, "after_compaction");

    const out = (await handler?.({ messageCount: 8, compactedCount: 4 }, {})) as
      | { prependContext?: string }
      | undefined;

    expect(out?.prependContext).toContain("post-compaction memory summary");
    expect(out?.prependContext).toContain("retained fact across compaction");
    expect(postCompactionRecall.buildPostCompactionRecallSnippet).toHaveBeenCalled();
  });
});
