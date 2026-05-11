/**
 * Plugin Integration
 * Integrates the Plugin Manager into the main hybrid memory plugin lifecycle
 */

import type { FactsDB } from "../backends/facts-db/facts-db-layer1.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryPluginContext } from "../api/memory-plugin-api.js";
import { PluginManager, type MemoryPlugin } from "../api/plugin-system.js";
import { pluginLogger } from "../utils/logger.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
			const entries = await readdir(this.pluginsDir, { withFileTypes: true });

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				const pluginPath = join(this.pluginsDir, entry.name);
				const pluginFile = join(pluginPath, "index.js");

				if (!existsSync(pluginFile)) {
					pluginLogger.debug(`[PluginLoader] Skipping ${entry.name}: no index.js found`);
					continue;
				}

				try {
					await this.loadPlugin(pluginFile);
				} catch (error) {
					pluginLogger.error(`[PluginLoader] Failed to load plugin from ${pluginFile}:`, error);
				}
			}
		} catch (error) {
			pluginLogger.error(`[PluginLoader] Failed to scan plugins directory:`, error);
		}
	}

	/**
	 * Load a single plugin from a file path
	 */
	async loadPlugin(pluginPath: string): Promise<void> {
		try {
			const module = await import(pluginPath);
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
