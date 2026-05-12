/**
 * Shared OAuth-profile detection utility used by both the provider-routing logic in
 * init-databases.ts and the auth-order tests.  Keeping the implementation in a single
 * exported function ensures that tests exercise the real production code path.
 */

/**
 * Returns true when the auth order for a provider includes at least one OAuth/token profile
 * (i.e. not just the plain API-key profile). Used to decide whether to route through the gateway.
 * API-key-only profiles end with ':api' or ':default' (e.g. 'anthropic:api', 'google:default').
 *
 * Comparison is case-insensitive to tolerate common capitalisation typos in operator config
 * (e.g. 'openai:Api' or 'openai:DEFAULT') without silently routing through the gateway.
 */
export function hasOAuthProfiles(
  order: string[] | undefined,
  provider: string,
  opts?: { onOAuthProfile?: (profile: string) => void },
): boolean {
  if (!order || order.length === 0) return false;
  const providerLower = provider.trim().toLowerCase();
  const apiOnlyPatternsLower = [`${providerLower}:api`, `${providerLower}:default`];
  return order.some((p) => {
    const pLower = p.toLowerCase();
    const isApiOnly = apiOnlyPatternsLower.includes(pLower);
    if (!isApiOnly && opts?.onOAuthProfile) {
      opts.onOAuthProfile(p);
    }
    return !isApiOnly;
  });
}
