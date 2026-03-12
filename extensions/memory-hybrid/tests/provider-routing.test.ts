/**
 * Tests for MiniMax provider routing in the multi-provider OpenAI proxy.
 * Verifies that minimax/* models are routed to the correct base URL (issue #312).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock OpenAI BEFORE any module imports (vi.mock is hoisted automatically).
// Must use a regular named function (not arrow) so `new OpenAI(...)` works as a constructor.
vi.mock("openai", () => {
  // eslint-disable-next-line prefer-arrow-callback
  const MockOpenAI = vi.fn(function MockOpenAI(this: Record<string, unknown>, args: Record<string, unknown>) {
    this._constructArgs = args;
    this.chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    };
    this.embeddings = {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    };
  });
  return { default: MockOpenAI };
});

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

import OpenAI from "openai";
import { initializeDatabases, closeOldDatabases, MINIMAX_BASE_URL, OPENROUTER_BASE_URL } from "../setup/init-databases.js";
import { hybridConfigSchema } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi(overrides: Record<string, unknown> = {}) {
  return {
    registerTool: vi.fn(),
    registerService: vi.fn(),
    registerCli: vi.fn(),
    registerLifecycleHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session", agentId: "test-agent" },
    config: {},
    ...overrides,
  };
}

function getTestConfig(tmpDir: string, overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-embed-key-that-is-long-enough",
      model: "text-embedding-3-small",
    },
    sqlitePath: join(tmpDir, "facts.db"),
    lanceDbPath: join(tmpDir, "lancedb"),
    credentials: { enabled: false },
    wal: { enabled: false },
    personaProposals: { enabled: false },
    verification: { enabled: false },
    provenance: { enabled: false },
    nightlyCycle: { enabled: false },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// MINIMAX_BASE_URL constant
// ---------------------------------------------------------------------------

describe("MINIMAX_BASE_URL", () => {
  it("exports the correct MiniMax global API endpoint", () => {
    expect(MINIMAX_BASE_URL).toBe("https://api.minimax.io/v1");
  });
});

// ---------------------------------------------------------------------------
// MiniMax provider routing — direct API key
// ---------------------------------------------------------------------------

describe("MiniMax provider routing — direct API key", () => {
  let tmpDir: string;
  let MockOpenAI: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof initializeDatabases> | undefined;
  // Capture original env vars so we can restore them after each test
  let origGatewayPort: string | undefined;
  let origGatewayToken: string | undefined;
  let origMinimaxApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-routing-"));
    MockOpenAI = vi.mocked(OpenAI);
    MockOpenAI.mockClear();
    ctx = undefined;
    // Capture originals before mutating
    origGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    origGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    origMinimaxApiKey = process.env.MINIMAX_API_KEY;
    // Unset gateway env vars to ensure direct routing
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    // Always close db handles before removing the temp dir
    if (ctx) { try { closeOldDatabases(ctx); } catch { /* best effort */ } }
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore original env vars
    if (origGatewayPort !== undefined) process.env.OPENCLAW_GATEWAY_PORT = origGatewayPort; else delete process.env.OPENCLAW_GATEWAY_PORT;
    if (origGatewayToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = origGatewayToken; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
    if (origMinimaxApiKey !== undefined) process.env.MINIMAX_API_KEY = origMinimaxApiKey; else delete process.env.MINIMAX_API_KEY;
  });

  it("routes minimax/MiniMax-M2.5 to MINIMAX_BASE_URL when apiKey is configured but no explicit baseURL", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["minimax/MiniMax-M2.5"],
        heavy: ["minimax/MiniMax-M2.5"],
        providers: {
          minimax: { apiKey: "sk-cp-minimax-test-key-1234" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    // Trigger routing — this lazily creates the minimax OpenAI client
    await ctx.openai.chat.completions.create({
      model: "minimax/MiniMax-M2.5",
      messages: [{ role: "user", content: "hello" }],
    });

    // Find the OpenAI constructor call that used MINIMAX_BASE_URL
    const minimaxCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === MINIMAX_BASE_URL,
    );
    expect(minimaxCall).toBeDefined();
    expect((minimaxCall![0] as Record<string, unknown>).apiKey).toBe("sk-cp-minimax-test-key-1234");
    expect((minimaxCall![0] as Record<string, unknown>).baseURL).toBe("https://api.minimax.io/v1");

  });

  it("routes to custom baseURL when explicitly overridden in llm.providers.minimax", async () => {
    const customURL = "https://custom.minimax.example.com/v1";
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["minimax/MiniMax-M2.5"],
        heavy: ["minimax/MiniMax-M2.5"],
        providers: {
          minimax: { apiKey: "sk-cp-minimax-custom", baseURL: customURL },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "minimax/MiniMax-M2.5",
      messages: [{ role: "user", content: "hello" }],
    });

    const minimaxCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === customURL,
    );
    expect(minimaxCall).toBeDefined();
    expect((minimaxCall![0] as Record<string, unknown>).baseURL).toBe(customURL);

  });

  it("uses MINIMAX_API_KEY env var as fallback when no apiKey in config", async () => {
    process.env.MINIMAX_API_KEY = "sk-cp-from-env-123456";
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["minimax/MiniMax-M2.5"],
        heavy: ["minimax/MiniMax-M2.5"],
        // No minimax provider config — should fall back to MINIMAX_API_KEY env var
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "minimax/MiniMax-M2.5",
      messages: [{ role: "user", content: "hello" }],
    });

    const minimaxCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === MINIMAX_BASE_URL,
    );
    expect(minimaxCall).toBeDefined();
    expect((minimaxCall![0] as Record<string, unknown>).apiKey).toBe("sk-cp-from-env-123456");
  });

  it("throws UnconfiguredProviderError when no apiKey is available for minimax", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["minimax/MiniMax-M2.5"],
        heavy: ["minimax/MiniMax-M2.5"],
        // No minimax provider config and no MINIMAX_API_KEY env var
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    // resolveClient throws synchronously for unconfigured providers,
    // so we test with a sync toThrow matcher (not rejects)
    expect(() =>
      ctx!.openai.chat.completions.create({
        model: "minimax/MiniMax-M2.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow("Provider 'minimax' is not configured");

  });

  it("sends bare model name MiniMax-M2.5 (not full provider/model) to the MiniMax API", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["minimax/MiniMax-M2.5"],
        heavy: ["minimax/MiniMax-M2.5"],
        providers: {
          minimax: { apiKey: "sk-cp-bare-model-test" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "minimax/MiniMax-M2.5",
      messages: [{ role: "user", content: "test" }],
    });

    // Find the minimax client instance (constructed with MINIMAX_BASE_URL)
    const minimaxClientIdx = MockOpenAI.mock.calls.findIndex(
      ([args]) => (args as Record<string, unknown>)?.baseURL === MINIMAX_BASE_URL,
    );
    expect(minimaxClientIdx).toBeGreaterThanOrEqual(0);

    // Get the mock instance that was constructed at that index
    const minimaxInstance = MockOpenAI.mock.results[minimaxClientIdx];
    expect(minimaxInstance?.type).toBe("return");

    const instance = minimaxInstance?.value as { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
    const createCalls = instance?.chat?.completions?.create?.mock?.calls ?? [];

    // The proxy strips the "minimax/" prefix and sends bare "MiniMax-M2.5" to the API
    const callWithBareModel = createCalls.find(
      ([body]) => (body as { model?: string })?.model === "MiniMax-M2.5",
    );
    expect(callWithBareModel).toBeDefined();

  });

  it("auto-prefixes bare MiniMax-M2.5 (no provider/ prefix) to minimax/MiniMax-M2.5 and routes correctly", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["MiniMax-M2.5"],  // bare — no minimax/ prefix
        heavy: ["MiniMax-M2.5"],
        providers: {
          minimax: { apiKey: "sk-cp-bare-prefix-test" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    // Use the bare model name — normalizeModelId should auto-prefix it to minimax/MiniMax-M2.5
    await ctx.openai.chat.completions.create({
      model: "MiniMax-M2.5",
      messages: [{ role: "user", content: "bare prefix test" }],
    });

    // Verify it routed to MINIMAX_BASE_URL (not default OpenAI)
    const minimaxCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === MINIMAX_BASE_URL,
    );
    expect(minimaxCall).toBeDefined();
    expect((minimaxCall![0] as Record<string, unknown>).apiKey).toBe("sk-cp-bare-prefix-test");
  });
});

// ---------------------------------------------------------------------------
// MiniMax provider routing — gateway key auto-merge
// ---------------------------------------------------------------------------

describe("MiniMax provider routing — gateway key auto-merge", () => {
  let tmpDir: string;
  let MockOpenAI: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof initializeDatabases> | undefined;
  let origGatewayPort: string | undefined;
  let origGatewayToken: string | undefined;
  let origMinimaxApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-routing-gw-"));
    MockOpenAI = vi.mocked(OpenAI);
    MockOpenAI.mockClear();
    ctx = undefined;
    origGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    origGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    origMinimaxApiKey = process.env.MINIMAX_API_KEY;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    if (ctx) { try { closeOldDatabases(ctx); } catch { /* best effort */ } }
    rmSync(tmpDir, { recursive: true, force: true });
    if (origGatewayPort !== undefined) process.env.OPENCLAW_GATEWAY_PORT = origGatewayPort; else delete process.env.OPENCLAW_GATEWAY_PORT;
    if (origGatewayToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = origGatewayToken; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
    if (origMinimaxApiKey !== undefined) process.env.MINIMAX_API_KEY = origMinimaxApiKey; else delete process.env.MINIMAX_API_KEY;
  });

  it("uses MINIMAX_BASE_URL (not OpenAI default) when gateway provides apiKey but no baseURL", async () => {
    // Simulate gateway config merge: apiKey present from gateway, no explicit baseURL.
    // Before fix: this would create an OpenAI client without baseURL → calls api.openai.com → 404.
    // After fix: this uses MINIMAX_BASE_URL as default.
    const cfg = getTestConfig(tmpDir);
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: { apiKey: "sk-cp-from-gateway-no-baseurl" },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "minimax/MiniMax-M2.5",
      messages: [{ role: "user", content: "hello" }],
    });

    // Must route to MINIMAX_BASE_URL — NOT the default OpenAI URL
    const minimaxCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === MINIMAX_BASE_URL,
    );
    expect(minimaxCall).toBeDefined();
    expect((minimaxCall![0] as Record<string, unknown>).baseURL).toBe(MINIMAX_BASE_URL);

    // Should NOT have created a client without baseURL for the gateway's minimax key
    const wrongCall = MockOpenAI.mock.calls.find(
      ([args]) =>
        (args as Record<string, unknown>)?.baseURL === undefined &&
        (args as Record<string, unknown>)?.apiKey === "sk-cp-from-gateway-no-baseurl",
    );
    expect(wrongCall).toBeUndefined();

  });

  it("appends minimax/MiniMax-Text-01 to tier lists when gateway provides minimax key but no minimax model is configured", () => {
    // When gateway has a minimax key but the user's llm.default/heavy lists have no minimax model,
    // the knownDefault fallback should auto-append minimax/MiniMax-Text-01 (same as anthropic/google/openai).
    const cfg = getTestConfig(tmpDir);
    // Start with no llm config so auto-derive runs from gateway models (empty → no gatewayModels).
    // We simulate the post-merge state by setting llm with non-minimax tiers.
    cfg.llm = {
      default: ["openai/gpt-4.1-mini"],
      heavy: ["openai/gpt-4o"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: { apiKey: "sk-cp-gw-knowndefault-test" },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    const heavyList = Array.isArray(cfg.llm?.heavy) ? cfg.llm.heavy : [];
    expect(defaultList).toContain("minimax/MiniMax-Text-01");
    expect(heavyList).toContain("minimax/MiniMax-Text-01");
  });

  it("appends minimax/MiniMax-M2.5 when gateway models array specifies MiniMax-M2.5 (issue #375)", () => {
    // When the gateway provider config has minimax.models: ["MiniMax-M2.5"], the plugin must
    // read that model ID from the config instead of falling back to the hardcoded MiniMax-Text-01.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["openai/gpt-4.1-mini"],
      heavy: ["openai/gpt-4o"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: { apiKey: "sk-cp-gw-m2-5-test", models: ["MiniMax-M2.5"] },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    const heavyList = Array.isArray(cfg.llm?.heavy) ? cfg.llm.heavy : [];
    expect(defaultList).toContain("minimax/MiniMax-M2.5");
    expect(heavyList).toContain("minimax/MiniMax-M2.5");
    expect(defaultList).not.toContain("minimax/MiniMax-Text-01");
    expect(heavyList).not.toContain("minimax/MiniMax-Text-01");
  });

  it("skips non-chat models at the start of gateway models[] and uses the first chat-compatible entry", () => {
    // When a gateway provider's models[] starts with an embedding model, the plugin must NOT
    // route chatCompleteWithRetry through it. It should find the first chat-compatible entry instead.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["openai/gpt-4.1-mini"],
      heavy: ["openai/gpt-4o"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: {
              apiKey: "sk-cp-non-chat-skip-test",
              // First entry is an embedding model — must be skipped; MiniMax-M2.5 is the chat model.
              models: [
                { id: "MiniMax-Embed-01", type: "embedding" },
                { id: "MiniMax-M2.5", type: "chat" },
              ],
            },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    const heavyList = Array.isArray(cfg.llm?.heavy) ? cfg.llm.heavy : [];
    // Must use the chat model, not the embedding model
    expect(defaultList).toContain("minimax/MiniMax-M2.5");
    expect(heavyList).toContain("minimax/MiniMax-M2.5");
    expect(defaultList).not.toContain("minimax/MiniMax-Embed-01");
    expect(heavyList).not.toContain("minimax/MiniMax-Embed-01");
  });

  it("falls back to knownDefault when all gateway models[] entries are non-chat", () => {
    // If every entry in models[] is an embedding/transcription model, defaultModel stays null
    // and the hardcoded knownDefault (e.g. minimax/MiniMax-Text-01) is used instead.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["openai/gpt-4.1-mini"],
      heavy: ["openai/gpt-4o"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: {
              apiKey: "sk-cp-all-non-chat-test",
              models: [
                { id: "MiniMax-Embed-01", type: "embedding" },
                { id: "MiniMax-Embed-02", type: "embeddings" },
              ],
            },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    // Falls back to hardcoded knownDefault since no chat model was found in models[]
    expect(defaultList).toContain("minimax/MiniMax-Text-01");
    expect(defaultList).not.toContain("minimax/MiniMax-Embed-01");
    expect(defaultList).not.toContain("minimax/MiniMax-Embed-02");
  });

  it("filters non-chat defaultModel and falls back to knownDefault", () => {
    // Regression test: if models[] contains only non-chat entries AND defaultModel is also
    // a non-chat model, the fallback should skip the non-chat defaultModel and use knownDefault.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["openai/gpt-4.1-mini"],
      heavy: ["openai/gpt-4o"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: {
              apiKey: "sk-cp-non-chat-defaultmodel-test",
              models: [
                { id: "MiniMax-Embed-01", type: "embedding" },
              ],
              defaultModel: "MiniMax-Embed-01",
            },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    // Should fall back to the safe knownDefault (MiniMax-Text-01), not the embedding model
    expect(defaultList).toContain("minimax/MiniMax-Text-01");
    expect(defaultList).not.toContain("minimax/MiniMax-Embed-01");
  });

  it("skips image-generation string IDs (e.g. gpt-image-1) when inferring chat model from models[]", () => {
    // Regression: NON_CHAT_ID_RE must match image-gen model IDs like "gpt-image-1" so that
    // chatCompleteWithRetry is never routed through an image generation endpoint.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["anthropic/claude-3.5-sonnet"],
      heavy: ["anthropic/claude-opus-4-6"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            openai: {
              apiKey: "sk-cp-image-skip-test",
              // First entry is an image generation model — must be skipped.
              models: ["gpt-image-1", "gpt-4o"],
            },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    const heavyList = Array.isArray(cfg.llm?.heavy) ? cfg.llm.heavy : [];
    // Must use the chat model gpt-4o, not the image model
    expect(defaultList).toContain("openai/gpt-4o");
    expect(heavyList).toContain("openai/gpt-4o");
    expect(defaultList).not.toContain("openai/gpt-image-1");
    expect(heavyList).not.toContain("openai/gpt-image-1");
  });


  it("hasModelFrom recognises bare MiniMax-* names (case-insensitive) so minimax is not double-appended", () => {
    // If the user already has a bare MiniMax-M2.5 in their tier list (which normalizeModelId
    // converts to minimax/MiniMax-M2.5 when routing), hasModelFrom should detect the minimax
    // prefix so the knownDefault fallback is skipped.
    const cfg = getTestConfig(tmpDir);
    cfg.llm = {
      default: ["minimax/MiniMax-M2.5"],
      heavy: ["minimax/MiniMax-M2.5"],
    } as typeof cfg.llm;
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            minimax: { apiKey: "sk-cp-hasmodelfrom-test" },
          },
        },
      },
    });

    ctx = initializeDatabases(cfg, api as never);

    // The tier lists should NOT have MiniMax-Text-01 appended since minimax is already present.
    const defaultList = Array.isArray(cfg.llm?.default) ? cfg.llm.default : [];
    expect(defaultList.filter((m) => m.startsWith("minimax/")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter provider routing (issue #380)
// ---------------------------------------------------------------------------

describe("OpenRouter provider routing (issue #380)", () => {
  let tmpDir: string;
  let MockOpenAI: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof initializeDatabases> | undefined;
  let origOpenrouterApiKey: string | undefined;
  let origGatewayPort: string | undefined;
  let origGatewayToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-routing-openrouter-"));
    MockOpenAI = vi.mocked(OpenAI);
    MockOpenAI.mockClear();
    ctx = undefined;
    origOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    origGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    origGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (ctx) { try { closeOldDatabases(ctx); } catch { /* best effort */ } }
    rmSync(tmpDir, { recursive: true, force: true });
    if (origOpenrouterApiKey !== undefined) process.env.OPENROUTER_API_KEY = origOpenrouterApiKey; else delete process.env.OPENROUTER_API_KEY;
    if (origGatewayPort !== undefined) process.env.OPENCLAW_GATEWAY_PORT = origGatewayPort; else delete process.env.OPENCLAW_GATEWAY_PORT;
    if (origGatewayToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = origGatewayToken; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("exports OPENROUTER_BASE_URL as the canonical OpenRouter endpoint", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("routes openrouter/* models to OPENROUTER_BASE_URL when apiKey is configured", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/anthropic/claude-3.5-sonnet"],
        heavy: ["openrouter/anthropic/claude-3.5-sonnet"],
        providers: {
          openrouter: { apiKey: "sk-or-test-key-1234" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterCall).toBeDefined();
    expect((openrouterCall![0] as Record<string, unknown>).apiKey).toBe("sk-or-test-key-1234");
  });

  it("strips the openrouter/ prefix and sends bare model name to the API", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/anthropic/claude-3.5-sonnet"],
        heavy: ["openrouter/anthropic/claude-3.5-sonnet"],
        providers: {
          openrouter: { apiKey: "sk-or-bare-model-test" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "test" }],
    });

    // Find the openrouter client instance
    const openrouterClientIdx = MockOpenAI.mock.calls.findIndex(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterClientIdx).toBeGreaterThanOrEqual(0);

    const openrouterInstance = MockOpenAI.mock.results[openrouterClientIdx];
    expect(openrouterInstance?.type).toBe("return");

    const instance = openrouterInstance?.value as { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
    const createCalls = instance?.chat?.completions?.create?.mock?.calls ?? [];

    // The proxy strips "openrouter/" prefix; the bare model is "anthropic/claude-3.5-sonnet"
    const callWithBareModel = createCalls.find(
      ([body]) => (body as { model?: string })?.model === "anthropic/claude-3.5-sonnet",
    );
    expect(callWithBareModel).toBeDefined();
  });

  it("uses OPENROUTER_API_KEY env var as fallback when no apiKey in config", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-from-env-key";
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/openai/gpt-4o"],
        heavy: ["openrouter/openai/gpt-4o"],
        // No openrouter provider config — should fall back to OPENROUTER_API_KEY env var
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/openai/gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterCall).toBeDefined();
    expect((openrouterCall![0] as Record<string, unknown>).apiKey).toBe("sk-or-from-env-key");
  });

  it("throws UnconfiguredProviderError when no apiKey is available for openrouter", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/anthropic/claude-3.5-sonnet"],
        heavy: ["openrouter/anthropic/claude-3.5-sonnet"],
        // No openrouter config and no OPENROUTER_API_KEY env var
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    expect(() =>
      ctx!.openai.chat.completions.create({
        model: "openrouter/anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow("Provider 'openrouter' is not configured");
  });

  it("uses a custom baseURL when explicitly overridden in llm.providers.openrouter", async () => {
    const customURL = "https://custom.openrouter.example.com/v1";
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/meta-llama/llama-3.1-8b-instruct"],
        heavy: ["openrouter/meta-llama/llama-3.1-8b-instruct"],
        providers: {
          openrouter: { apiKey: "sk-or-custom-url", baseURL: customURL },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });

    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/meta-llama/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "hello" }],
    });

    const customCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === customURL,
    );
    expect(customCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic provider routing — issue #386
// ---------------------------------------------------------------------------

describe("Anthropic provider routing — issue #386", () => {
  const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
  let tmpDir: string;
  let MockOpenAI: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof initializeDatabases> | undefined;
  let origAnthropicApiKey: string | undefined;
  let origGatewayPort: string | undefined;
  let origGatewayToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-routing-anthropic-"));
    MockOpenAI = vi.mocked(OpenAI);
    MockOpenAI.mockClear();
    ctx = undefined;
    origAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    origGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    origGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (ctx) { try { closeOldDatabases(ctx); } catch { /* best effort */ } }
    rmSync(tmpDir, { recursive: true, force: true });
    if (origAnthropicApiKey !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropicApiKey; else delete process.env.ANTHROPIC_API_KEY;
    if (origGatewayPort !== undefined) process.env.OPENCLAW_GATEWAY_PORT = origGatewayPort; else delete process.env.OPENCLAW_GATEWAY_PORT;
    if (origGatewayToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = origGatewayToken; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("routes anthropic/* to ANTHROPIC_BASE_URL when llm.providers.anthropic.apiKey is set", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["anthropic/claude-sonnet-4-6"],
        heavy: ["anthropic/claude-sonnet-4-6"],
        providers: { anthropic: { apiKey: "sk-ant-direct-key-1234567890" } },
      },
    });
    const api = makeMockApi({ resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)) });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    });

    const anthropicCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === ANTHROPIC_BASE_URL,
    );
    expect(anthropicCall).toBeDefined();
    expect((anthropicCall![0] as Record<string, unknown>).apiKey).toBe("sk-ant-direct-key-1234567890");
  });

  it("picks up Anthropic key from api.config.models.providers (standard gateway path)", async () => {
    // When the gateway has anthropic configured at models.providers, the plugin must merge
    // it into llm.providers so resolveClient() can use it — even if the user only set llm.heavy.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["anthropic/claude-sonnet-4-6"],
        heavy: ["anthropic/claude-sonnet-4-6"],
        // No providers.anthropic in plugin config — key must come from gateway
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            anthropic: { apiKey: "sk-ant-from-gateway-models-providers" },
          },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    });

    const anthropicCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === ANTHROPIC_BASE_URL,
    );
    expect(anthropicCall).toBeDefined();
    expect((anthropicCall![0] as Record<string, unknown>).apiKey).toBe("sk-ant-from-gateway-models-providers");
  });

  it("picks up Anthropic key from api.config.providers (top-level gateway path, issue #386)", async () => {
    // The gateway may store provider keys at the top-level providers object rather than
    // under models.providers or llm.providers. This was a missing path in the merge logic.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["anthropic/claude-sonnet-4-6"],
        heavy: ["anthropic/claude-sonnet-4-6"],
        // No providers.anthropic in plugin config — key must come from gateway top-level
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        // Top-level providers (not nested under models.providers or llm.providers)
        providers: {
          anthropic: { apiKey: "sk-ant-from-gateway-top-level-providers" },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    });

    const anthropicCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === ANTHROPIC_BASE_URL,
    );
    expect(anthropicCall).toBeDefined();
    expect((anthropicCall![0] as Record<string, unknown>).apiKey).toBe("sk-ant-from-gateway-top-level-providers");
  });

  it("gateway key fills in when plugin provider entry has undefined apiKey (issue #386 stale placeholder)", async () => {
    // When the plugin config has providers.anthropic: {} (entry exists but no apiKey),
    // the gateway key must still be used — the old condition `if (!prov[name])` would skip the merge.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["anthropic/claude-sonnet-4-6"],
        heavy: ["anthropic/claude-sonnet-4-6"],
        providers: {
          // Entry exists but apiKey is empty — must be filled from gateway
          anthropic: { apiKey: undefined },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            anthropic: { apiKey: "sk-ant-gateway-fills-empty-plugin-entry" },
          },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    });

    const anthropicCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === ANTHROPIC_BASE_URL,
    );
    expect(anthropicCall).toBeDefined();
    expect((anthropicCall![0] as Record<string, unknown>).apiKey).toBe("sk-ant-gateway-fills-empty-plugin-entry");
  });

  it("throws UnconfiguredProviderError when no Anthropic key is found anywhere", async () => {
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["anthropic/claude-sonnet-4-6"],
        heavy: ["anthropic/claude-sonnet-4-6"],
        // No providers.anthropic, no claude.apiKey, no env var, no gateway key
      },
    });
    const api = makeMockApi({ resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)) });
    ctx = initializeDatabases(cfg, api as never);

    expect(() =>
      ctx!.openai.chat.completions.create({
        model: "anthropic/claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow("Provider 'anthropic' is not configured");
  });
});

// ---------------------------------------------------------------------------
// OpenRouter gateway merge — issue #392
// ---------------------------------------------------------------------------

describe("OpenRouter gateway merge — issue #392", () => {
  let tmpDir: string;
  let MockOpenAI: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof initializeDatabases> | undefined;
  let origOpenrouterApiKey: string | undefined;
  let origGatewayPort: string | undefined;
  let origGatewayToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provider-routing-openrouter-merge-"));
    MockOpenAI = vi.mocked(OpenAI);
    MockOpenAI.mockClear();
    ctx = undefined;
    origOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    origGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    origGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (ctx) { try { closeOldDatabases(ctx); } catch { /* best effort */ } }
    rmSync(tmpDir, { recursive: true, force: true });
    if (origOpenrouterApiKey !== undefined) process.env.OPENROUTER_API_KEY = origOpenrouterApiKey; else delete process.env.OPENROUTER_API_KEY;
    if (origGatewayPort !== undefined) process.env.OPENCLAW_GATEWAY_PORT = origGatewayPort; else delete process.env.OPENCLAW_GATEWAY_PORT;
    if (origGatewayToken !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = origGatewayToken; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("picks up OpenRouter key from api.config.models.providers (standard gateway path)", async () => {
    // When the gateway has openrouter configured at models.providers, the plugin must merge
    // it into llm.providers so resolveClient() can use it — even if the user only set llm.default.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/qwen/qwen3-14b"],
        heavy: ["openrouter/qwen/qwen3-14b"],
        // No providers.openrouter in plugin config — key must come from gateway
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            openrouter: { apiKey: "sk-or-from-gateway-models-providers" },
          },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/qwen/qwen3-14b",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterCall).toBeDefined();
    expect((openrouterCall![0] as Record<string, unknown>).apiKey).toBe("sk-or-from-gateway-models-providers");
  });

  it("picks up OpenRouter key from api.config.providers (top-level gateway path)", async () => {
    // The gateway may store provider keys at the top-level providers object rather than
    // under models.providers or llm.providers. Same pattern as the Anthropic fix in #386.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/qwen/qwen3-14b"],
        heavy: ["openrouter/qwen/qwen3-14b"],
        // No providers.openrouter in plugin config — key must come from gateway top-level
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        // Top-level providers (not nested under models.providers or llm.providers)
        providers: {
          openrouter: { apiKey: "sk-or-from-gateway-top-level-providers" },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/qwen/qwen3-14b",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterCall).toBeDefined();
    expect((openrouterCall![0] as Record<string, unknown>).apiKey).toBe("sk-or-from-gateway-top-level-providers");
  });

  it("gateway key fills in when plugin provider entry has undefined apiKey (stale placeholder)", async () => {
    // When the plugin config has providers.openrouter: {} (entry exists but no apiKey),
    // the gateway key must still be used — same fix as #386 for the merge condition.
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/qwen/qwen3-14b"],
        heavy: ["openrouter/qwen/qwen3-14b"],
        providers: {
          // Entry exists but apiKey is empty — must be filled from gateway
          openrouter: { apiKey: undefined },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
      config: {
        models: {
          providers: {
            openrouter: { apiKey: "sk-or-gateway-fills-empty-plugin-entry" },
          },
        },
      },
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/qwen/qwen3-14b",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterCall = MockOpenAI.mock.calls.find(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterCall).toBeDefined();
    expect((openrouterCall![0] as Record<string, unknown>).apiKey).toBe("sk-or-gateway-fills-empty-plugin-entry");
  });

  it("strips openrouter/ prefix correctly for multi-segment models like openrouter/qwen/qwen3-14b", async () => {
    // The GlitchTip error was for openrouter/qwen/qwen3... which has two slashes.
    // Verify that prefix extraction (first slash only) gives "openrouter" and bareModel "qwen/qwen3-14b".
    const cfg = getTestConfig(tmpDir, {
      llm: {
        default: ["openrouter/qwen/qwen3-14b"],
        heavy: ["openrouter/qwen/qwen3-14b"],
        providers: {
          openrouter: { apiKey: "sk-or-qwen-test-key" },
        },
      },
    });
    const api = makeMockApi({
      resolvePath: (p: string) => (p.startsWith("/") ? p : join(tmpDir, p)),
    });
    ctx = initializeDatabases(cfg, api as never);

    await ctx.openai.chat.completions.create({
      model: "openrouter/qwen/qwen3-14b",
      messages: [{ role: "user", content: "hello" }],
    });

    const openrouterClientIdx = MockOpenAI.mock.calls.findIndex(
      ([args]) => (args as Record<string, unknown>)?.baseURL === OPENROUTER_BASE_URL,
    );
    expect(openrouterClientIdx).toBeGreaterThanOrEqual(0);

    const openrouterInstance = MockOpenAI.mock.results[openrouterClientIdx];
    expect(openrouterInstance?.type).toBe("return");

    const instance = openrouterInstance?.value as { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
    const createCalls = instance?.chat?.completions?.create?.mock?.calls ?? [];

    // The proxy strips only "openrouter/" prefix; bareModel must be "qwen/qwen3-14b" (not "qwen3-14b")
    const callWithBareModel = createCalls.find(
      ([body]) => (body as { model?: string })?.model === "qwen/qwen3-14b",
    );
    expect(callWithBareModel).toBeDefined();
  });
});
