/**
 * In-memory cache for expensive FactsDB read paths (#870).
 */

/** TTL-backed set cache with explicit invalidation (superseded fact texts). */
export class SupersededTextsCache {
  private data: Set<string> | null = null;
  private loadedAt = 0;

  constructor(private readonly ttlMs: number) {}

  getSnapshot(now: number, loader: () => string[]): Set<string> {
    if (this.data !== null && now - this.loadedAt < this.ttlMs) {
      return this.data;
    }
    const next = new Set(loader());
    this.data = next;
    this.loadedAt = now;
    return next;
  }

  invalidate(): void {
    this.data = null;
  }
}
