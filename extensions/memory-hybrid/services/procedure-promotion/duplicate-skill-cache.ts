import { readFileSync, statSync } from "node:fs";

/** Minimal LRU cache with max-size cap for skill MD digest cache. */
class LRUCache<K, V> {
  private readonly cache: Map<K, V>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.cache = new Map();
    this.capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value as K;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const skillMdDuplicateDigestCache = new LRUCache<string, { mtimeMs: number; lower: string }>(500);

export function clearProcedurePromotionDuplicateSkillCache(): void {
  skillMdDuplicateDigestCache.clear();
}

export function readSkillMdLowerCached(skillPath: string, bypassCache: boolean): string | null {
  if (bypassCache) {
    try {
      const raw = readFileSync(skillPath, "utf8");
      return raw.toLowerCase();
    } catch {
      return null;
    }
  }
  try {
    const mtimeMs = Math.trunc(statSync(skillPath).mtimeMs);
    const hit = skillMdDuplicateDigestCache.get(skillPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.lower;
    const raw = readFileSync(skillPath, "utf8");
    const lower = raw.toLowerCase();
    skillMdDuplicateDigestCache.set(skillPath, { mtimeMs, lower });
    return lower;
  } catch {
    return null;
  }
}
