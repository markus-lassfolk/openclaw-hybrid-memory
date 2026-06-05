/**
 * Per-session fact ID tracking to avoid duplicate injection between lifecycle hooks
 * and ContextEngine assemble / prepareSubagentSpawn paths.
 */

export type InjectedFactIdsBySession = Map<string, Set<string>>;

export function clearSessionInjectionDedup(map: InjectedFactIdsBySession | undefined, sessionKey: string): void {
  map?.delete(sessionKey);
}

export function markFactsInjectedForSession(
  map: InjectedFactIdsBySession | undefined,
  sessionKey: string,
  factIds: Iterable<string>,
): void {
  if (!map || !sessionKey) return;
  let set = map.get(sessionKey);
  if (!set) {
    set = new Set();
    map.set(sessionKey, set);
  }
  for (const id of factIds) {
    if (id) set.add(id);
  }
}

export function filterFactsNotYetInjected<T extends { id: string }>(
  map: InjectedFactIdsBySession | undefined,
  sessionKey: string,
  facts: T[],
): T[] {
  if (!map || !sessionKey) return facts;
  const injected = map.get(sessionKey);
  if (!injected || injected.size === 0) return facts;
  return facts.filter((f) => !injected.has(f.id));
}
