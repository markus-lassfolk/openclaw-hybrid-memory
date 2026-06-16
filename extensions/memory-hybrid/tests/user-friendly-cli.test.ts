import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerUserFriendlyCommands } from "../cli/cmd-user-friendly.js";
import { registerSetupCommand } from "../cli/cmd-setup.js";
import { registerHealthCommand } from "../cli/cmd-health.js";
import { getWalDisabledSentinelPath } from "../services/wal-helpers.js";
import { registerExamplesCommand } from "../cli/cmd-examples.js";
import { wrapCommonError, UserFriendlyError } from "../utils/error-codes.js";
import { ProgressBar } from "../utils/progress-indicators.js";
import { detectAvailableProviders, formatProviderStatus } from "../utils/provider-detection.js";

class FakeCommand {
  children: FakeCommand[] = [];
  commands: FakeCommand[] = this.children;
  name: string;
  handler: ((...args: unknown[]) => unknown) | null = null;
  options: Array<{ flags: string; defaultValue?: unknown }> = [];

  constructor(name = "root") {
    this.name = name;
  }

  command(name: string): FakeCommand {
    const child = new FakeCommand(name.split(/\s+/)[0]);
    this.children.push(child);
    return child;
  }

  description(): FakeCommand {
    return this;
  }

  option(flags: string, _desc?: string, defaultValue?: unknown): FakeCommand {
    this.options.push({ flags, defaultValue });
    return this;
  }

  requiredOption(flags: string, _desc?: string, defaultValue?: unknown): FakeCommand {
    this.options.push({ flags, defaultValue });
    return this;
  }

  action(fn: (...args: unknown[]) => unknown): FakeCommand {
    this.handler = fn;
    return this;
  }
}

const cfg = {
  embedding: {
    provider: "ollama" as const,
    model: "nomic-embed-text",
    dimensions: 768,
    batchSize: 32,
  },
};

const factsDb = { getCount: vi.fn(() => 3) };
const vectorDb = { getAllIds: vi.fn(async () => ["a", "b", "c"]) };
const embeddings = {
  embed: vi.fn(),
  embedBatch: vi.fn(),
  dimensions: 768,
  modelName: "nomic-embed-text",
  activeProvider: "ollama",
};

describe("user-friendly CLI registration", () => {
  it("registers setup/demo/providers/health/doctor/examples on the command tree", () => {
    const root = new FakeCommand();
    registerUserFriendlyCommands(root as never, {
      cfg: cfg as never,
      factsDb: factsDb as never,
      vectorDb: vectorDb as never,
      embeddings,
    });
    expect(root.children.map((child) => child.name).sort()).toEqual([
      "bootstrap",
      "demo",
      "doctor",
      "examples",
      "focus",
      "health",
      "mine",
      "providers",
      "setup",
    ]);
  });

  it("setup is non-interactive by default and persists recommended config through runConfigSet", async () => {
    const root = new FakeCommand();
    const writes: Array<[string, string]> = [];
    registerSetupCommand(root as never, cfg as never, async (key, value) => {
      writes.push([key, value]);
      return { ok: true };
    });
    const setup = root.children.find((child) => child.name === "setup");
    expect(setup?.options.find((opt) => opt.flags === "--interactive")?.defaultValue).toBeUndefined();
    expect(setup?.handler).toBeTypeOf("function");
    await setup?.handler?.({ interactive: false });
    expect(writes.some(([key]) => key === "embedding.provider")).toBe(true);
    expect(writes.some(([key]) => key === "embedding.model")).toBe(true);
  });

  it("health reuses expensive vector id count for size and sync checks", async () => {
    const root = new FakeCommand();
    const localVectorDb = { getAllIds: vi.fn(async () => ["a", "b", "c"]) };
    registerHealthCommand(root as never, cfg as never, factsDb as never, localVectorDb as never);
    const health = root.children.find((child) => child.name === "health");
    await health?.handler?.({ json: true });
    expect(localVectorDb.getAllIds).toHaveBeenCalledTimes(1);
  });

  it("health reports persistent WAL circuit-breaker state", async () => {
    const root = new FakeCommand();
    const walRoot = mkdtempSync(join(tmpdir(), "hm-health-wal-"));
    try {
      const walPath = join(walRoot, "memory.wal");
      writeFileSync(getWalDisabledSentinelPath(walPath), '{"reason":"test"}\n', "utf-8");
      const wal = {
        getPath: () => walPath,
        readAll: vi.fn().mockResolvedValue([]),
        getValidEntries: vi.fn().mockResolvedValue([]),
      };
      registerHealthCommand(
        root as never,
        { ...cfg, wal: { enabled: true, walPath } } as never,
        factsDb as never,
        vectorDb as never,
        wal as never,
      );
      const health = root.children.find((child) => child.name === "health");
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await health?.handler?.({ json: true });
      const output = log.mock.calls.at(-1)?.[0];
      const parsed = JSON.parse(String(output)) as { indicators: Array<{ name: string; status: string }> };
      const walIndicator = parsed.indicators.find((indicator) => indicator.name === "WAL");
      expect(walIndicator?.status).toBe("error");
    } finally {
      rmSync(walRoot, { recursive: true, force: true });
    }
  });

  it("health JSON surfaces decay guidance and vector bounds", async () => {
    const root = new FakeCommand();
    const localFactsDb = {
      getCount: vi.fn(() => 10),
      statsBreakdownByDecayClass: vi.fn(() => ({ stable: 9, permanent: 0, short: 1 })),
    };
    const localVectorDb = {
      getAllIds: vi.fn(async () => Array.from({ length: 10 }, (_, i) => `id-${i}`)),
      getRuntimeBounds: vi.fn(() => ({
        vectorSearchMaxResults: 200,
        semanticCacheMaxRowsPerFilterKey: 100,
        semanticCacheCandidateLimitMax: 200,
      })),
    };
    registerHealthCommand(root as never, cfg as never, localFactsDb as never, localVectorDb as never);
    const health = root.children.find((child) => child.name === "health");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await health?.handler?.({ json: true });
    const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? "{}")) as {
      indicators: Array<{ name: string; status: string; detail: string }>;
    };
    const decay = payload.indicators.find((indicator) => indicator.name === "Decay Profile");
    const bounds = payload.indicators.find((indicator) => indicator.name === "Vector Bounds");
    expect(decay?.status).toBe("warn");
    expect(decay?.detail).toContain("decay reclassify --dry-run --stable-only");
    expect(bounds?.status).toBe("good");
    expect(bounds?.detail).toContain("search<=200");
    log.mockRestore();
  });

  it("examples uses own-property category checks", () => {
    const root = new FakeCommand();
    registerExamplesCommand(root as never);
    const examples = root.children.find((child) => child.name === "examples");
    expect(() => examples?.handler?.("toString")).not.toThrow();
  });
});

describe("provider detection helpers", () => {
  it("includes google as configured when a google key is present", async () => {
    const providers = await detectAvailableProviders(undefined, "google-key");
    const google = providers.find((provider) => provider.provider === "google");
    expect(google).toBeDefined();
    if (!google) throw new Error("google provider missing");
    expect(google.available).toBe(true);
    expect(formatProviderStatus(google)).toContain("GOOGLE");
  });
});

describe("progress and error helpers", () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("non-TTY progress logs each 10% milestone once", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const bar = new ProgressBar("work", 100);
    bar.update(10);
    bar.update(10);
    bar.update(15);
    bar.update(20);
    expect(write.mock.calls.map((call) => String(call[0]))).toEqual(["work: 10% (10/100)\n", "work: 20% (20/100)\n"]);
  });

  it("maps timeout errors to HM_E008", () => {
    const wrapped = wrapCommonError(new Error("operation timeout while embedding"));
    expect(wrapped).toBeInstanceOf(UserFriendlyError);
    expect((wrapped as UserFriendlyError).code).toBe("HM_E008");
  });
});
