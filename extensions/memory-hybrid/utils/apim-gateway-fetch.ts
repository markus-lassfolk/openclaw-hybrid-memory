/**
 * Azure API Management gateway utilities.
 *
 * Azure API Management (APIM) gateways reject standard Bearer-token auth.
 * Instead they require:
 *  - `api-key` header with the subscription key, AND
 *  - `Ocp-Apim-Subscription-Key` header (legacy alias)
 *
 * This module provides:
 *  - `isAzureApiManagementGatewayUrl()` — detect APIM gateway base URLs
 *  - `createApimGatewayFetch()` — wrap globalThis.fetch to inject APIM auth headers
 */

const APIM_GATEWAY_PATTERNS = [
	/\.management\.azure-api\.net$/i,
	/\.scm\.azure-api\.net$/i,
	/\.azure-api\.net$/i,
];

/**
 * Returns true when `baseURL` looks like an Azure API Management gateway endpoint.
 */
export function isAzureApiManagementGatewayUrl(baseURL: string): boolean {
	try {
		const url = new URL(baseURL);
		return APIM_GATEWAY_PATTERNS.some((p) => p.test(url.hostname));
	} catch {
		return APIM_GATEWAY_PATTERNS.some((p) => p.test(baseURL));
	}
}

/**
 * Creates a fetch function that injects Azure API Management authentication headers.
 *
 * Replaces Bearer auth with `api-key` + `Ocp-Apim-Subscription-Key` headers.
 */
export function createApimGatewayFetch(
	apiKey: string,
): typeof globalThis.fetch {
	return async (
		...[input, init]: Parameters<typeof globalThis.fetch>
	): Promise<Response> => {
		const headers = new Headers(init?.headers);
		// Strip the SDK's default Authorization: Bearer — APIM gateways reject duplicate auth.
		headers.delete("Authorization");
		// Inject APIM auth headers.
		headers.set("api-key", apiKey);
		if (!headers.has("Ocp-Apim-Subscription-Key")) {
			headers.set("Ocp-Apim-Subscription-Key", apiKey);
		}
		return globalThis.fetch(input, { ...init, headers });
	};
}
