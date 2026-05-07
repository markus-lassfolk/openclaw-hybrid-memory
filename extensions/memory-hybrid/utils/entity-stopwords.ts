/**
 * Entity stop words (#1190): common nouns and role labels that should not become
 * graph entities. Keep this list intentionally conservative: project names,
 * filenames, hostnames, people, and org names must still pass through.
 */

export const DEFAULT_ENTITY_STOP_WORDS = [
  "agent",
  "api",
  "assistant",
  "credential",
  "credentials",
  "convention",
  "fact",
  "facts",
  "memory",
  "owner",
  "preference",
  "system",
  "the",
  "user",
  "users",
] as const;

export function normalizeEntityStopWord(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildEntityStopWordSet(extra: readonly string[] = []): Set<string> {
  const stopWords = new Set<string>();
  for (const word of DEFAULT_ENTITY_STOP_WORDS) {
    const normalized = normalizeEntityStopWord(word);
    if (normalized) stopWords.add(normalized);
  }
  for (const word of extra) {
    if (typeof word !== "string") continue;
    const normalized = normalizeEntityStopWord(word);
    if (normalized) stopWords.add(normalized);
  }
  return stopWords;
}

export function isEntityStopWord(value: string | null | undefined, extra: readonly string[] = []): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeEntityStopWord(value);
  if (!normalized) return false;
  return buildEntityStopWordSet(extra).has(normalized);
}

export function filterEntityStopWords<T extends string | null | undefined>(
  entities: readonly T[],
  extra: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entity of entities) {
    if (typeof entity !== "string") continue;
    const trimmed = entity.trim();
    if (!trimmed || isEntityStopWord(trimmed, extra)) continue;
    const key = normalizeEntityStopWord(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
