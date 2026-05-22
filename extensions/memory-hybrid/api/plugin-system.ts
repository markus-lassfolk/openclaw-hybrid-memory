/**
 * Plugin/Extension API for OpenClaw Hybrid Memory
 * Allows third-party extensions to integrate with the memory system
 */

interface MemoryPluginContext {
  config?: unknown;
  [key: string]: unknown;
}

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { pluginLogger } from "../utils/logger.js";

/**
 * Plugin lifecycle events
 */
export type PluginLifecycleEvent =
  | "init" // Plugin initialized
  | "shutdown" // Plugin shutting down
  | "fact_created" // New fact created
  | "fact_updated" // Fact updated
  | "fact_deleted" // Fact deleted
  | "search_performed" // Search query executed
  | "maintenance_start" // Maintenance job starting
  | "maintenance_end"; // Maintenance job completed

/**
 * Plugin hook callback types
 */
export interface PluginHooks {
  /** Called before a fact is stored */
  beforeFactStore?: (fact: unknown) => Promise<unknown>;
  /** Called after a fact is stored */
  afterFactStore?: (fact: unknown) => Promise<void>;
  /** Called before a fact is deleted */
  beforeFactDelete?: (factId: string) => Promise<boolean>; // Return false to prevent deletion
  /** Called after a fact is deleted */
  afterFactDelete?: (factId: string) => Promise<void>;
  /** Called before a search is performed */
  beforeSearch?: (query: string) => Promise<string>; // Can modify query
  /** Called after a search is performed */
  afterSearch?: (results: unknown[]) => Promise<unknown[]>; // Can modify results
  /** Called during maintenance cycles */
  onMaintenance?: () => Promise<void>;
  /** Called on plugin shutdown */
  onShutdown?: () => Promise<void>;
}

/**
 * Plugin capabilities
 */
export interface PluginCapabilities {
  /** Can modify facts before storage */
  canModifyFacts?: boolean;
  /** Can intercept searches */
  canInterceptSearch?: boolean;
  /** Provides custom storage backend */
  providesStorage?: boolean;
  /** Provides custom embedding provider */
  providesEmbedding?: boolean;
  /** Adds custom API endpoints */
  providesEndpoints?: boolean;
  /** Adds custom CLI commands */
  providesCommands?: boolean;
}

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
}

/**
 * Plugin context provided to extensions
 */
export interface PluginExtensionContext {
  /** Access to facts database */
  factsDb: FactsDB;
  /** Access to vector database (if enabled) */
  vectorDb?: VectorDB;
  /** Plugin configuration */
  config: MemoryPluginContext["config"];
  /** Logger instance */
  logger: {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    debug: (message: string, ...args: unknown[]) => void;
  };
  /** Emit events to other plugins */
  emit: (event: PluginLifecycleEvent, data?: unknown) => Promise<void>;
  /** Register API endpoint */
  registerEndpoint: (path: string, handler: (req: Request) => Promise<Response>) => void;
  /** Register CLI command */
  registerCommand: (name: string, handler: (args: string[]) => Promise<number>) => void;
}

/**
 * Plugin interface that all extensions must implement
 */
export interface MemoryPlugin {
  /** Plugin metadata */
  metadata: PluginMetadata;
  /** Plugin capabilities */
  capabilities: PluginCapabilities;
  /** Plugin hooks */
  hooks?: PluginHooks;

  /** Initialize the plugin */
  init(context: PluginExtensionContext): Promise<void>;
  /** Cleanup on shutdown */
  shutdown?(): Promise<void>;
}

/**
 * Plugin Manager
 * Manages plugin lifecycle, hooks, and events
 */
export class PluginManager {
  private plugins = new Map<string, MemoryPlugin>();
  private context: PluginExtensionContext;
  private eventListeners = new Map<PluginLifecycleEvent, Array<(data?: unknown) => Promise<void>>>();
  private pluginEventListeners = new Map<
    string,
    Array<{ event: PluginLifecycleEvent; listener: (data?: unknown) => Promise<void> }>
  >();

  constructor(factsDb: FactsDB, vectorDb: VectorDB | undefined, pluginContext: MemoryPluginContext) {
    this.context = {
      factsDb,
      vectorDb,
      config: pluginContext.config,
      logger: {
        info: (msg, ...args) =>
          pluginLogger.info(`[PluginManager] ${msg}${args.length ? ` ${args.map(String).join(" ")}` : ""}`),
        warn: (msg, ...args) =>
          pluginLogger.warn(`[PluginManager] ${msg}${args.length ? ` ${args.map(String).join(" ")}` : ""}`),
        error: (msg, ...args) =>
          pluginLogger.error(`[PluginManager] ${msg}${args.length ? ` ${args.map(String).join(" ")}` : ""}`),
        debug: (msg, ...args) =>
          pluginLogger.debug(`[PluginManager] ${msg}${args.length ? ` ${args.map(String).join(" ")}` : ""}`),
      },
      emit: async (event, data) => {
        await this.emit(event, data);
      },
      registerEndpoint: (path, _handler) => {
        // TODO: Implement endpoint registration
        this.context.logger.debug(`Registered endpoint: ${path}`);
      },
      registerCommand: (name, _handler) => {
        // TODO: Implement command registration
        this.context.logger.debug(`Registered command: ${name}`);
      },
    };
  }

  /**
   * Load and register a plugin
   */
  async loadPlugin(plugin: MemoryPlugin): Promise<void> {
    const { id, name, version } = plugin.metadata;

    if (this.plugins.has(id)) {
      throw new Error(`Plugin already loaded: ${id}`);
    }

    this.context.logger.info(`Loading plugin: ${name} v${version}`);

    // Validate plugin
    this.validatePlugin(plugin);

    // Initialize plugin
    await plugin.init(this.context);

    // Register event listeners
    if (plugin.hooks) {
      this.registerHooks(id, plugin.hooks);
    }

    this.plugins.set(id, plugin);
    this.context.logger.info(`Plugin loaded: ${name} v${version}`);
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    this.context.logger.info(`Unloading plugin: ${plugin.metadata.name}`);

    // Call shutdown hook
    if (plugin.shutdown) {
      await plugin.shutdown();
    }

    // Unregister event listeners
    this.unregisterHooks(pluginId);

    this.plugins.delete(pluginId);
    this.context.logger.info(`Plugin unloaded: ${plugin.metadata.name}`);
  }

  /**
   * Get loaded plugin by ID
   */
  getPlugin(pluginId: string): MemoryPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all loaded plugins
   */
  getAllPlugins(): MemoryPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Emit event to all plugins
   */
  async emit(event: PluginLifecycleEvent, data?: unknown): Promise<void> {
    const listeners = this.eventListeners.get(event) || [];
    await Promise.all(listeners.map((listener) => listener(data)));
  }

  /**
   * Execute beforeFactStore hooks
   */
  async beforeFactStore(fact: unknown): Promise<unknown> {
    let modifiedFact = fact;
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.beforeFactStore) {
        modifiedFact = await plugin.hooks.beforeFactStore(modifiedFact);
      }
    }
    return modifiedFact;
  }

  /**
   * Execute afterFactStore hooks
   */
  async afterFactStore(fact: unknown): Promise<void> {
    await Promise.all(
      Array.from(this.plugins.values())
        .filter((p) => p.hooks?.afterFactStore)
        .map((p) => p.hooks?.afterFactStore?.(fact)),
    );
  }

  /**
   * Execute beforeFactDelete hooks
   */
  async beforeFactDelete(factId: string): Promise<boolean> {
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.beforeFactDelete) {
        const shouldContinue = await plugin.hooks.beforeFactDelete(factId);
        if (!shouldContinue) {
          return false; // Plugin vetoed deletion
        }
      }
    }
    return true;
  }

  /**
   * Execute afterFactDelete hooks
   */
  async afterFactDelete(factId: string): Promise<void> {
    await Promise.all(
      Array.from(this.plugins.values())
        .filter((p) => p.hooks?.afterFactDelete)
        .map((p) => p.hooks?.afterFactDelete?.(factId)),
    );
  }

  /**
   * Execute beforeSearch hooks
   */
  async beforeSearch(query: string): Promise<string> {
    let modifiedQuery = query;
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.beforeSearch) {
        modifiedQuery = await plugin.hooks.beforeSearch(modifiedQuery);
      }
    }
    return modifiedQuery;
  }

  /**
   * Execute afterSearch hooks
   */
  async afterSearch(results: unknown[]): Promise<unknown[]> {
    let modifiedResults = results;
    for (const plugin of this.plugins.values()) {
      if (plugin.hooks?.afterSearch) {
        modifiedResults = await plugin.hooks.afterSearch(modifiedResults);
      }
    }
    return modifiedResults;
  }

  /**
   * Shutdown all plugins
   */
  async shutdownAll(): Promise<void> {
    this.context.logger.info("Shutting down all plugins...");

    const shutdownPromises = Array.from(this.plugins.keys()).map((id) =>
      this.unloadPlugin(id).catch((error) => {
        this.context.logger.error(`Failed to shutdown plugin ${id}:`, error);
      }),
    );

    await Promise.all(shutdownPromises);
    this.context.logger.info("All plugins shut down");
  }

  private validatePlugin(plugin: MemoryPlugin): void {
    if (!plugin.metadata?.id || !plugin.metadata?.name || !plugin.metadata?.version) {
      throw new Error("Plugin must have metadata with id, name, and version");
    }

    if (!plugin.capabilities) {
      throw new Error("Plugin must declare capabilities");
    }

    if (typeof plugin.init !== "function") {
      throw new Error("Plugin must implement init() method");
    }
  }

  private registerHooks(pluginId: string, hooks: PluginHooks): void {
    const ownedListeners: Array<{ event: PluginLifecycleEvent; listener: (data?: unknown) => Promise<void> }> = [];

    for (const [hookName, hookFn] of Object.entries(hooks)) {
      if (typeof hookFn !== "function") continue;
      const event = this.hookToEvent(hookName);
      if (!event) continue;
      const listener = hookFn as (data?: unknown) => Promise<void>;
      const listeners = this.eventListeners.get(event) || [];
      listeners.push(listener);
      this.eventListeners.set(event, listeners);
      ownedListeners.push({ event, listener });
    }

    this.pluginEventListeners.set(pluginId, ownedListeners);
  }

  private unregisterHooks(pluginId: string): void {
    const ownedListeners = this.pluginEventListeners.get(pluginId) ?? [];
    for (const { event, listener } of ownedListeners) {
      const listeners = this.eventListeners.get(event) ?? [];
      const remaining = listeners.filter((candidate) => candidate !== listener);
      if (remaining.length > 0) this.eventListeners.set(event, remaining);
      else this.eventListeners.delete(event);
    }
    this.pluginEventListeners.delete(pluginId);
  }

  private hookToEvent(hookName: string): PluginLifecycleEvent | null {
    const mapping: Record<string, PluginLifecycleEvent> = {
      afterFactStore: "fact_created",
      afterFactDelete: "fact_deleted",
      onMaintenance: "maintenance_start",
    };
    return mapping[hookName] || null;
  }
}

/**
 * Example plugin implementation
 */
export class SlackNotificationPlugin implements MemoryPlugin {
  metadata: PluginMetadata = {
    id: "slack-notifications",
    name: "Slack Notifications",
    version: "1.0.0",
    description: "Send Slack notifications when important facts are stored",
    author: "OpenClaw Team",
    license: "MIT",
  };

  capabilities: PluginCapabilities = {
    canModifyFacts: false,
    canInterceptSearch: false,
  };

  hooks: PluginHooks = {
    afterFactStore: async (fact: unknown) => {
      const candidate = fact && typeof fact === "object" ? (fact as { importance?: number; text?: string }) : {};
      if (candidate.importance && candidate.importance > 0.8) {
        // await this.sendSlackMessage(candidate);
      }
    },
  };

  async init(context: PluginExtensionContext): Promise<void> {
    context.logger.info("Slack notifications plugin initialized");
    // Slack webhook delivery is intentionally disabled in this example plugin.
  }

  async shutdown(): Promise<void> {}
}
