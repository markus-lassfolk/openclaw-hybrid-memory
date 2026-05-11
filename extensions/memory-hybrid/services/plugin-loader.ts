/**
 * Plugin Integration
 * Integrates the Plugin Manager into the main hybrid memory plugin lifecycle
 */

type MemoryPluginContext = Record<string, unknown>;

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { PluginManager, type MemoryPlugin } from "../api/plugin-system.js";
import { pluginLogger } from "../utils/logger.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

/**
 * Plugin Loader
 * Discovers and loads plugins from the plugins directory
 */
export class PluginLoader {
  private pluginManager: PluginManager;
  private pluginsDir: string;

  constructor(
    factsDb: FactsDB,
    vectorDb: VectorDB | undefined,
    pluginContext: MemoryPluginContext,
    pluginsDir: string,
  ) {
    this.pluginManager = new PluginManager(factsDb, vectorDb, pluginContext);
    this.pluginsDir = pluginsDir;
  }

  /**
   * Discover and load all plugins from the plugins directory
   */
  async discoverAndLoadPlugins(): Promise<void> {
    if (!existsSync(this.pluginsDir)) {
      pluginLogger.debug(`[PluginLoader] Plugins directory not found: ${this.pluginsDir}`);
      return;
    }

    try {
      for (const pluginFile of await this.discoverPluginFiles()) {
        try {
          await this.loadPlugin(pluginFile);
        } catch (error) {
          pluginLogger.error(`[PluginLoader] Failed to load plugin from ${pluginFile}: ${String(error)}`);
        }
      }
    } catch (error) {
      pluginLogger.error(`[PluginLoader] Failed to scan plugins directory: ${String(error)}`);
    }
  }

  private async discoverPluginFiles(): Promise<string[]> {
    const files: string[] = [];
    const addPluginFile = (pluginPath: string) => {
      const pluginFile = join(pluginPath, "index.js");
      if (existsSync(pluginFile)) files.push(pluginFile);
    };

    const entries = await readdir(this.pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      addPluginFile(join(this.pluginsDir, entry.name));
    }

    const nodeModulesDir = join(this.pluginsDir, "node_modules");
    if (existsSync(nodeModulesDir)) {
      const modules = await readdir(nodeModulesDir, { withFileTypes: true });
      for (const entry of modules) {
        if (!entry.isDirectory()) continue;
        const modulePath = join(nodeModulesDir, entry.name);
        if (entry.name.startsWith("@")) {
          const scoped = await readdir(modulePath, { withFileTypes: true });
          for (const scopedEntry of scoped) {
            if (scopedEntry.isDirectory()) addPluginFile(join(modulePath, scopedEntry.name));
          }
        } else {
          addPluginFile(modulePath);
        }
      }
    }

    return files;
  }

  /**
   * Load a single plugin from a file path
   */
  async loadPlugin(pluginPath: string): Promise<void> {
    try {
      const module = await import(pathToFileURL(pluginPath).href);
      const plugin: MemoryPlugin = module.default || module;

      if (!plugin.metadata || !plugin.init) {
        throw new Error("Invalid plugin: must have metadata and init function");
      }

      await this.pluginManager.loadPlugin(plugin);
      pluginLogger.info(`[PluginLoader] Loaded plugin: ${plugin.metadata.name} v${plugin.metadata.version}`);
    } catch (error) {
      throw new Error(`Failed to load plugin from ${pluginPath}: ${error}`);
    }
  }

  /**
   * Get the plugin manager instance
   */
  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /**
   * Shutdown all plugins
   */
  async shutdown(): Promise<void> {
    await this.pluginManager.shutdownAll();
  }
}

/**
 * Integration hooks for the main plugin
 * These connect the plugin system to the memory operations
 */
export class PluginIntegration {
  constructor(private pluginManager: PluginManager) {}

  /**
   * Hook: Before storing a fact
   */
  async beforeFactStore(fact: unknown): Promise<unknown> {
    return await this.pluginManager.beforeFactStore(fact);
  }

  /**
   * Hook: After storing a fact
   */
  async afterFactStore(fact: unknown): Promise<void> {
    await this.pluginManager.afterFactStore(fact);
  }

  /**
   * Hook: Before deleting a fact
   */
  async beforeFactDelete(factId: string): Promise<boolean> {
    return await this.pluginManager.beforeFactDelete(factId);
  }

  /**
   * Hook: After deleting a fact
   */
  async afterFactDelete(factId: string): Promise<void> {
    await this.pluginManager.afterFactDelete(factId);
  }

  /**
   * Hook: Before performing a search
   */
  async beforeSearch(query: string): Promise<string> {
    return await this.pluginManager.beforeSearch(query);
  }

  /**
   * Hook: After performing a search
   */
  async afterSearch(results: unknown[]): Promise<unknown[]> {
    return await this.pluginManager.afterSearch(results);
  }
}
