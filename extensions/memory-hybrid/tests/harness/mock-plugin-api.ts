/**
 * Minimal plugin API double for lifecycle tests without OpenClaw core.
 * Supports `on` / `emit` for hook names used by goal stewardship (and similar stages).
 */

export type PluginHookResult = { prependContext?: string } | undefined | null;

export type PluginHookHandler = (event: unknown, hookCtx?: unknown) => PluginHookResult | Promise<PluginHookResult>;

export function createMockPluginApi() {
  const handlers = new Map<string, PluginHookHandler[]>();

  return {
    on(name: string, fn: PluginHookHandler): void {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },

    /** First handler that returns a non-undefined value wins (typical prependContext). */
    async emitFirstResult(name: string, event: unknown, hookCtx?: unknown): Promise<PluginHookResult> {
      for (const fn of handlers.get(name) ?? []) {
        const r = await fn(event, hookCtx);
        if (r !== undefined) return r;
      }
      return undefined;
    },

    /** Await every handler (side-effect listeners). */
    async emitAll(name: string, event: unknown, hookCtx?: unknown): Promise<void> {
      for (const fn of handlers.get(name) ?? []) {
        await fn(event, hookCtx);
      }
    },

    handlerCount(name: string): number {
      return handlers.get(name)?.length ?? 0;
    },
  };
}

export type MockPluginApi = ReturnType<typeof createMockPluginApi>;
