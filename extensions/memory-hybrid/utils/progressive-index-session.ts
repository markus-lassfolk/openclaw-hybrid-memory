/** Resolve the session key used for progressive index and auto-recall prompt maps. */
export function resolveProgressiveIndexSessionKey(api: {
  context?: { sessionKey?: string; sessionId?: string };
}): string {
  const key = api.context?.sessionKey ?? api.context?.sessionId;
  return key && key.trim().length > 0 ? key.trim() : "default";
}

export function getProgressiveIndexIds(
  map: Map<string, string[]> | undefined,
  sessionKey: string,
): string[] {
  return map?.get(sessionKey) ?? [];
}

export function setProgressiveIndexIds(
  map: Map<string, string[]> | undefined,
  sessionKey: string,
  ids: string[],
): void {
  if (!map) return;
  if (ids.length === 0) {
    map.delete(sessionKey);
    return;
  }
  map.set(sessionKey, [...ids]);
}
