/**
 * Shared OAuth-profile detection utility used by both the provider-routing logic in
 * init-databases.ts and the auth-order tests.  Keeping the implementation in a single
 * exported function ensures that tests exercise the real production code path.
 */

/**
 * Returns true when the auth order for a provider includes at least one OAuth/token profile
 * (i.e. not just the plain API-key profile). Used to decide whether to route through the gateway.
 * API-key-only profiles end with ':api' or ':default' (e.g. 'anthropic:api', 'google:default').
 */
export function hasOAuthProfiles(order: string[] | undefined, provider: string): boolean {
  if (!order || order.length === 0) return false;
  const apiOnlyPatterns = [`${provider}:api`, `${provider}:default`];
  return order.some((p) => !apiOnlyPatterns.includes(p));
}
