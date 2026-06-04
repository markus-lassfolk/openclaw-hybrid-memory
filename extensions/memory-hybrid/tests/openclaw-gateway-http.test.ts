import { describe, expect, it } from "vitest";
import {
  OPENCLAW_GATEWAY_AGENT_MODEL,
  applyOpenClawGatewayModelRequest,
  isOpenClawGatewayBaseUrl,
  isOpenClawGatewayClient,
} from "../utils/openclaw-gateway-http.js";

describe("openclaw-gateway-http", () => {
  const gatewayBaseUrl = "http://127.0.0.1:18789/v1";

  it("detects gateway base URL with or without trailing slash", () => {
    expect(isOpenClawGatewayBaseUrl("http://127.0.0.1:18789/v1", gatewayBaseUrl)).toBe(true);
    expect(isOpenClawGatewayBaseUrl("http://127.0.0.1:18789/v1/", gatewayBaseUrl)).toBe(true);
    expect(isOpenClawGatewayBaseUrl("https://api.openai.com/v1", gatewayBaseUrl)).toBe(false);
  });

  it("detects gateway OpenAI clients by baseURL", () => {
    expect(isOpenClawGatewayClient({ baseURL: gatewayBaseUrl }, gatewayBaseUrl)).toBe(true);
    expect(isOpenClawGatewayClient({ baseURL: "https://api.openai.com/v1" }, gatewayBaseUrl)).toBe(false);
  });

  it("rewrites model to openclaw and sets x-openclaw-model", () => {
    const { body, opts } = applyOpenClawGatewayModelRequest(
      { model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] },
      "openai/gpt-4.1-nano",
      { signal: new AbortController().signal },
    );
    expect(body.model).toBe(OPENCLAW_GATEWAY_AGENT_MODEL);
    expect(opts.headers).toEqual({ "x-openclaw-model": "openai/gpt-4.1-nano" });
  });
});
