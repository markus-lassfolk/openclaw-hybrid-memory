/**
 * Azure API Management (e.g. Azure AI Gateway) in front of Azure OpenAI / Foundry.
 * The OpenAI SDK sends `Authorization: Bearer <key>`; many gateways expect `api-key` (and reject duplicate auth).
 */

export function isAzureApiManagementGatewayUrl(url: string): boolean {
  return /\.azure-api\.net/i.test(url);
}

/** Fetch wrapper: remove Bearer from SDK and send `api-key` for the backend gateway. */
export function createApimGatewayFetch(apiKey: string): typeof fetch {
  return async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.delete("Authorization");
    headers.set("api-key", apiKey);
    return fetch(input, { ...init, headers });
  };
}
