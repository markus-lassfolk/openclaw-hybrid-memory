/**
 * Issue #1002 — inherit embedding-related fields from OpenClaw gateway before config parse.
 */
import { describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import {
  applyGatewayEmbeddingInheritanceBeforeParse,
  shallowClonePluginConfigForGatewayMerge,
} from "../setup/provider-router.js";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

const FAKE_OPENAI_KEY = ["sk", "-proj-test", "1234567890abcdefghijklmnop"].join("");
const FAKE_GATEWAY_OTHER_KEY = ["sk", "-proj-other", "0987654321abcdefghijkl"].join("");
const FAKE_PLUGIN_KEY = ["sk", "-proj-plugin", "1234567890abcdefghijkl"].join("");

function parseWithGateway(
  raw: Record<string, unknown>,
  gateway: Record<string, unknown>,
): ReturnType<typeof hybridConfigSchema.parse> {
  const api = {
    config: gateway,
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as ClawdbotPluginApi;
  const clone = shallowClonePluginConfigForGatewayMerge(raw);
  applyGatewayEmbeddingInheritanceBeforeParse(clone, api);
  return hybridConfigSchema.parse(clone);
}

describe("embedding global inheritance (issue #1002)", () => {
  it("merges models.providers into raw llm before parse so azure-foundry backs openai embeddings", () => {
    const gateway = {
      models: {
        providers: {
          "azure-foundry": {
            apiKey: FAKE_OPENAI_KEY,
            baseURL: "https://example.openai.azure.com/openai",
          },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "azure-foundry",
            model: "text-embedding-3-small",
          },
        },
      },
    };
    const cfg = parseWithGateway({ mode: "minimal", embedding: {} }, gateway);
    expect(cfg.embedding.provider).toBe("openai");
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.apiKey).toBe(FAKE_OPENAI_KEY);
    expect(cfg.llm?.providers?.["azure-foundry"]?.apiKey).toBe(FAKE_OPENAI_KEY);
  });

  it("does not override plugin embedding fields when already set", () => {
    const gateway = {
      models: {
        providers: {
          openai: { apiKey: FAKE_GATEWAY_OTHER_KEY },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
            model: "text-embedding-3-large",
          },
        },
      },
    };
    const pluginKey = FAKE_PLUGIN_KEY;
    const cfg = parseWithGateway(
      {
        mode: "minimal",
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          apiKey: pluginKey,
        },
        llm: { providers: { openai: { apiKey: pluginKey } } },
      },
      gateway,
    );
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.apiKey).toBe(pluginKey);
  });

  it("merges gateway openai into mixed-case OpenAI llm.providers slot (no duplicate lowercase entry)", () => {
    const gateway = {
      models: {
        providers: {
          openai: { apiKey: FAKE_GATEWAY_OTHER_KEY },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    };
    const api = {
      config: gateway,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as ClawdbotPluginApi;
    const raw: Record<string, unknown> = {
      mode: "minimal",
      embedding: {
        apiKey: FAKE_PLUGIN_KEY,
        provider: "openai",
        model: "text-embedding-3-small",
      },
      llm: { providers: { OpenAI: { apiKey: FAKE_PLUGIN_KEY } } },
    };
    const clone = shallowClonePluginConfigForGatewayMerge(raw);
    applyGatewayEmbeddingInheritanceBeforeParse(clone, api);
    const prov = (clone.llm as Record<string, unknown>).providers as Record<string, unknown>;
    const openAiLikeKeys = Object.keys(prov).filter((k) => k.toLowerCase() === "openai");
    expect(openAiLikeKeys).toEqual(["OpenAI"]);
    expect((prov.OpenAI as Record<string, unknown>).apiKey).toBe(FAKE_PLUGIN_KEY);
  });

  it("skips memorySearch when enabled is false", () => {
    const gateway = {
      models: {
        providers: {
          openai: { apiKey: FAKE_OPENAI_KEY },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    };
    const cfg = parseWithGateway(
      {
        mode: "minimal",
        embedding: { provider: "openai", apiKey: FAKE_OPENAI_KEY, model: "text-embedding-3-small" },
      },
      gateway,
    );
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
  });
});
