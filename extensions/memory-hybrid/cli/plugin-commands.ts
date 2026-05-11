/**
 * Plugin CLI Commands
 * Manage third-party plugins (list, install, remove)
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pluginLogger } from "../utils/logger.js";

export interface PluginInfo {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	enabled: boolean;
	path: string;
}

/**
 * List all installed plugins
 */
export async function listPlugins(pluginsDir: string): Promise<PluginInfo[]> {
	if (!existsSync(pluginsDir)) {
		return [];
	}

	const plugins: PluginInfo[] = [];
	const entries = await readdir(pluginsDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const pluginPath = join(pluginsDir, entry.name);
		const manifestPath = join(pluginPath, "package.json");

		if (!existsSync(manifestPath)) continue;

		try {
			const manifest = await import(manifestPath, { assert: { type: "json" } });
			plugins.push({
				id: entry.name,
				name: manifest.default?.name || entry.name,
				version: manifest.default?.version || "unknown",
				description: manifest.default?.description || "",
				author: manifest.default?.author || "",
				enabled: existsSync(join(pluginPath, "index.js")),
				path: pluginPath,
			});
		} catch (error) {
			pluginLogger.warn(`[Plugin CLI] Failed to read plugin manifest: ${manifestPath}`);
		}
	}

	return plugins;
}

/**
 * Install a plugin from npm or local path
 */
export async function installPlugin(
	pluginsDir: string,
	source: string,
	options: { npm?: boolean; local?: boolean } = {},
): Promise<void> {
	// Ensure plugins directory exists
	if (!existsSync(pluginsDir)) {
		await mkdir(pluginsDir, { recursive: true });
	}

	if (options.npm) {
		// Install from npm
		const { execa } = await import("execa");
		pluginLogger.info(`[Plugin CLI] Installing plugin from npm: ${source}`);

		await execa("npm", ["install", source, "--prefix", pluginsDir], {
			stdio: "inherit",
		});

		pluginLogger.info(`[Plugin CLI] Plugin installed successfully`);
	} else if (options.local) {
		// Copy from local path
		const { cp } = await import("node:fs/promises");
		const targetPath = join(pluginsDir, source.split("/").pop() || "plugin");

		pluginLogger.info(`[Plugin CLI] Installing plugin from local path: ${source}`);

		await cp(source, targetPath, { recursive: true });

		pluginLogger.info(`[Plugin CLI] Plugin installed successfully to ${targetPath}`);
	} else {
		throw new Error("Must specify either --npm or --local");
	}
}

/**
 * Remove an installed plugin
 */
export async function removePlugin(pluginsDir: string, pluginId: string): Promise<void> {
	const pluginPath = join(pluginsDir, pluginId);

	if (!existsSync(pluginPath)) {
		throw new Error(`Plugin not found: ${pluginId}`);
	}

	pluginLogger.info(`[Plugin CLI] Removing plugin: ${pluginId}`);

	await rm(pluginPath, { recursive: true, force: true });

	pluginLogger.info(`[Plugin CLI] Plugin removed successfully`);
}

/**
 * Get plugin info
 */
export async function getPluginInfo(pluginsDir: string, pluginId: string): Promise<PluginInfo | null> {
	const plugins = await listPlugins(pluginsDir);
	return plugins.find(p => p.id === pluginId) || null;
}

/**
 * Enable a plugin
 */
export async function enablePlugin(pluginsDir: string, pluginId: string): Promise<void> {
	const pluginPath = join(pluginsDir, pluginId);

	if (!existsSync(pluginPath)) {
		throw new Error(`Plugin not found: ${pluginId}`);
	}

	// Plugin is enabled by default if index.js exists
	const indexPath = join(pluginPath, "index.js");

	if (!existsSync(indexPath)) {
		throw new Error(`Plugin ${pluginId} is missing index.js`);
	}

	pluginLogger.info(`[Plugin CLI] Plugin ${pluginId} is already enabled`);
}

/**
 * Disable a plugin
 */
export async function disablePlugin(pluginsDir: string, pluginId: string): Promise<void> {
	const pluginPath = join(pluginsDir, pluginId);

	if (!existsSync(pluginPath)) {
		throw new Error(`Plugin not found: ${pluginId}`);
	}

	const indexPath = join(pluginPath, "index.js");
	const disabledPath = join(pluginPath, "index.js.disabled");

	if (!existsSync(indexPath)) {
		throw new Error(`Plugin ${pluginId} is already disabled`);
	}

	const { rename } = await import("node:fs/promises");
	await rename(indexPath, disabledPath);

	pluginLogger.info(`[Plugin CLI] Plugin ${pluginId} disabled`);
}
