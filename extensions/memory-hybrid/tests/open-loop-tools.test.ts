/**
 * Tests for the open-loop obligations ledger tools (Issue #2152).
 *
 * Covers registration, the create/list/update/close lifecycle, and a regression
 * for issue #2185 (GlitchTip issue 20): memory_loop_list crashed with
 * `TypeError: filter.status.map is not a function` when an LLM caller passed a
 * bare string (e.g. status: "open") for a filter field the tool schema declares
 * as an array. The fix coerces scalar-or-array filter fields (status, loop_type)
 * via `toArrayFilter` before they reach the store's query builder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoomStore } from "../backends/loom-store.js";
import { parseConfig } from "../config/parsers/index.js";
import { registerOpenLoopTools } from "../tools/open-loop-tools.js";

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...a: unknown[]) => Promise<any> });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    call(name: string, params: Record<string, unknown>) {
      const t = tools.get(name);
      if (!t) throw new Error(`Tool not registered: ${name}`);
      return t.execute("test-call-id", params);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const EMBEDDING = { provider: "ollama", model: "nomic-embed-text" };
const enabledCfg = parseConfig({ embedding: EMBEDDING, loom: { enabled: true } }) as any;
const disabledCfg = parseConfig({ embedding: EMBEDDING, loom: { enabled: false } }) as any;

let tmpDir: string;
let loomStore: LoomStore;
let api: ReturnType<typeof makeMockApi>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "open-loop-tools-test-"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
  api = makeMockApi();
  registerOpenLoopTools({ loomStore, cfg: enabledCfg }, api as any);
});

afterEach(() => {
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerOpenLoopTools — registration", () => {
  it("registers every open-loop tool", () => {
    for (const name of ["memory_loop_create", "memory_loop_list", "memory_loop_update", "memory_loop_close"]) {
      expect(api.getTool(name)).toBeDefined();
    }
  });

  it("returns loom_disabled when loom.enabled is false", async () => {
    const disabledApi = makeMockApi();
    registerOpenLoopTools({ loomStore, cfg: disabledCfg }, disabledApi as any);
    const result = await disabledApi.call("memory_loop_list", {});
    expect(result.details.error).toBe("loom_disabled");
  });
});

describe("memory_loop_create / memory_loop_list / memory_loop_update / memory_loop_close", () => {
  it("creates, lists, updates, and closes an open loop end-to-end", async () => {
    const created = await api.call("memory_loop_create", {
      title: "Verify Doris M365 auth",
      loop_type: "needs_verification",
      closure_criteria: "whoami succeeds",
    });
    const loopId: string = created.details.id;
    expect(loopId).toBeTruthy();

    const listed = await api.call("memory_loop_list", { status: ["open"] });
    expect(listed.details.count).toBe(1);

    const updated = await api.call("memory_loop_update", { loop_id: loopId, next_action: "run whoami" });
    expect(updated.details.loop.nextAction).toBe("run whoami");

    const closed = await api.call("memory_loop_close", { loop_id: loopId, reason: "verified" });
    expect(closed.details.loop.status).toBe("closed");

    const stillOpen = await api.call("memory_loop_list", { status: ["open"] });
    expect(stillOpen.details.count).toBe(0);
  });
});

describe("memory_loop_list — status/loop_type scalar coercion (regression, issue #2185)", () => {
  it("does not throw when status is passed as a bare string instead of an array", async () => {
    await api.call("memory_loop_create", { title: "loop A", loop_type: "needs_verification" });
    await api.call("memory_loop_create", { title: "loop B", loop_type: "watch_condition" });

    const arrayResult = await api.call("memory_loop_list", { status: ["open"] });
    expect(arrayResult.details.error).toBeUndefined();

    // An LLM caller frequently passes a bare scalar despite the array-typed schema declared above.
    const scalarResult = await api.call("memory_loop_list", { status: "open" });
    expect(scalarResult.details.error).toBeUndefined();
    expect(scalarResult.details.count).toBe(arrayResult.details.count);
    expect(scalarResult.details.loops.map((l: any) => l.id).sort()).toEqual(
      arrayResult.details.loops.map((l: any) => l.id).sort(),
    );
  });

  it("does not throw when loop_type is passed as a bare string instead of an array, and filters correctly", async () => {
    await api.call("memory_loop_create", { title: "loop A", loop_type: "needs_verification" });
    await api.call("memory_loop_create", { title: "loop B", loop_type: "watch_condition" });

    const arrayResult = await api.call("memory_loop_list", { loop_type: ["needs_verification"] });
    const scalarResult = await api.call("memory_loop_list", { loop_type: "needs_verification" });

    expect(scalarResult.details.error).toBeUndefined();
    expect(scalarResult.details.count).toBe(arrayResult.details.count);
    expect(scalarResult.details.count).toBe(1);
    expect(scalarResult.details.loops[0].title).toBe("loop A");
  });

  it("does not throw when both status and loop_type are bare strings together", async () => {
    await api.call("memory_loop_create", { title: "loop A", loop_type: "needs_verification" });
    const result = await api.call("memory_loop_list", { status: "open", loop_type: "needs_verification" });
    expect(result.details.error).toBeUndefined();
    expect(result.details.count).toBe(1);
  });
});
