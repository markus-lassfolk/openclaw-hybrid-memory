import { describe, expect, it } from "vitest";
import {
	type VerifyDirectOpenAIOpts,
	applyAzureFoundryVerifyDirectClientAuth,
	isAzureFoundryFamilyProvider,
} from "../cli/verify-llm-azure-auth.js";
import { AZURE_OPENAI_API_VERSION } from "../services/embeddings.js";

describe("isAzureFoundryFamilyProvider", () => {
	it("recognizes azure-foundry, responses, and direct", () => {
		expect(isAzureFoundryFamilyProvider("azure-foundry")).toBe(true);
		expect(isAzureFoundryFamilyProvider("azure-foundry-responses")).toBe(true);
		expect(isAzureFoundryFamilyProvider("azure-foundry-direct")).toBe(true);
		expect(isAzureFoundryFamilyProvider("openai")).toBe(false);
	});
});

describe("applyAzureFoundryVerifyDirectClientAuth", () => {
	const key = "0".repeat(32);

	it("sets api-key and custom fetch for APIM gateway URLs", () => {
		const opts: VerifyDirectOpenAIOpts = {
			apiKey: key,
			baseURL: "https://svc.azure-api.net/openai/v1",
		};
		applyAzureFoundryVerifyDirectClientAuth(opts, "azure-foundry", key);
		expect(opts.defaultHeaders?.["api-key"]).toBe(key);
		expect(typeof opts.fetch).toBe("function");
	});

	it("sets api-key for direct Azure OpenAI resource (*.openai.azure.com) with /openai/v1 — no api-version query", () => {
		const opts: VerifyDirectOpenAIOpts = {
			apiKey: key,
			baseURL: "https://myres.openai.azure.com/openai/v1",
		};
		applyAzureFoundryVerifyDirectClientAuth(opts, "azure-foundry", key);
		expect(opts.defaultHeaders?.["api-key"]).toBe(key);
		expect(opts.fetch).toBeUndefined();
		expect(opts.defaultQuery).toBeUndefined();
	});

	it("sets api-key and api-version for direct resource base without /openai/v1 compat path", () => {
		const opts: VerifyDirectOpenAIOpts = {
			apiKey: key,
			baseURL: "https://myres.openai.azure.com/openai/deployments/mydep",
		};
		applyAzureFoundryVerifyDirectClientAuth(
			opts,
			"azure-foundry-responses",
			key,
		);
		expect(opts.defaultHeaders?.["api-key"]).toBe(key);
		expect(opts.defaultQuery?.["api-version"]).toBe(AZURE_OPENAI_API_VERSION);
		expect(opts.fetch).toBeUndefined();
	});

	it("does not mutate opts for non-Azure providers", () => {
		const opts: VerifyDirectOpenAIOpts = {
			apiKey: key,
			baseURL: "https://api.openai.com/v1",
		};
		applyAzureFoundryVerifyDirectClientAuth(opts, "openai", key);
		expect(opts.defaultHeaders).toBeUndefined();
	});

	it("merges with existing defaultHeaders", () => {
		const opts: VerifyDirectOpenAIOpts = {
			apiKey: key,
			baseURL: "https://x.openai.azure.com/openai/v1",
			defaultHeaders: { "x-prior": "1" },
		};
		applyAzureFoundryVerifyDirectClientAuth(opts, "azure-foundry", key);
		expect(opts.defaultHeaders?.["x-prior"]).toBe("1");
		expect(opts.defaultHeaders?.["api-key"]).toBe(key);
	});
});
