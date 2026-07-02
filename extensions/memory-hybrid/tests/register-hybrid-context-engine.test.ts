import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHybridContextEngine } from "../services/context-engine.js";

describe("registerHybridContextEngine", () => {
  const baseOpts = {
    factsDb: {} as never,
    vectorDb: {} as never,
    wal: null,
    embeddings: {} as never,
    cfg: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("registers via api.registerContextEngine when provided", async () => {
    const registerContextEngine = vi.fn();
    const ok = await registerHybridContextEngine({
      ...baseOpts,
      registerContextEngine,
    });

    expect(ok).toBe(true);
    expect(registerContextEngine).toHaveBeenCalledWith("hybrid-memory", expect.any(Function));
    expect(baseOpts.logger.info).toHaveBeenCalledWith("memory-hybrid: ContextEngine registered (id=hybrid-memory)");
  });

  it("returns false when no registrar is available", async () => {
    vi.doMock("openclaw/plugin-sdk", () => ({}));

    const ok = await registerHybridContextEngine({ ...baseOpts });

    expect(ok).toBe(false);
    expect(baseOpts.logger.debug).toHaveBeenCalledWith(
      "memory-hybrid: registerContextEngine not found in SDK; skipping ContextEngine registration",
    );
  });

  it("falls back to openclaw/plugin-sdk when api hook is absent", async () => {
    const registerContextEngine = vi.fn();
    vi.doMock("openclaw/plugin-sdk", () => ({ registerContextEngine }));

    const { registerHybridContextEngine: registerFresh } = await import("../services/context-engine.js");
    const ok = await registerFresh({ ...baseOpts });

    expect(ok).toBe(true);
    expect(registerContextEngine).toHaveBeenCalledWith("hybrid-memory", expect.any(Function));
  });
});
