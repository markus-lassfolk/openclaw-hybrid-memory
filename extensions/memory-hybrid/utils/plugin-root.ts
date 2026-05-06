/**
 * Plugin-root path resolution (issue #1174).
 *
 * Walks up from a given module URL until it finds the directory that contains
 * `openclaw.plugin.json` — the unambiguous marker for the plugin's package
 * root. This works regardless of whether the runtime entry is the TypeScript
 * source (`extensions/memory-hybrid/index.ts`), the compiled multi-file dist
 * (`extensions/memory-hybrid/dist/index.js`), or any nested submodule
 * (`dist/cli/cmd-install.js`).
 *
 * Replaces the brittle pattern of `join(dirname(fileURLToPath(import.meta.url)), "..")`,
 * which silently resolved to `dist/` instead of the plugin root once the
 * package was bundled.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Marker file that uniquely identifies the plugin's package root. */
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";

/** Cache: metaUrl -> plugin root absolute path. */
const rootCache = new Map<string, string>();

/**
 * Resolve the plugin's package root directory by walking up parents from the
 * given `import.meta.url` until a directory containing `openclaw.plugin.json`
 * is found.
 *
 * @throws Error if no manifest is found between the start directory and the filesystem root.
 */
export function findPluginRoot(metaUrl: string): string {
  const cached = rootCache.get(metaUrl);
  if (cached !== undefined) return cached;

  const startFile = fileURLToPath(metaUrl);
  let current = dirname(startFile);
  // Hard upper bound to avoid pathological loops on malformed URLs.
  for (let i = 0; i < 64; i++) {
    if (existsSync(`${current}/${PLUGIN_MANIFEST_FILENAME}`)) {
      rootCache.set(metaUrl, current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `findPluginRoot: could not locate ${PLUGIN_MANIFEST_FILENAME} above ${startFile}. ` +
      "The plugin must be installed with its manifest at the package root.",
  );
}

/** Shape of `package.json` fields we read at runtime. */
export interface PluginPackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

/**
 * Read and parse the plugin's `package.json` from the package root resolved
 * via {@link findPluginRoot}.
 *
 * @throws Error if the manifest cannot be located or `package.json` is malformed.
 */
export function readPluginPackageJson(metaUrl: string): PluginPackageJson {
  const root = findPluginRoot(metaUrl);
  const pkgPath = `${root}/package.json`;
  const raw = readFileSync(pkgPath, "utf-8");
  const parsed = JSON.parse(raw) as PluginPackageJson;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`readPluginPackageJson: missing version in ${pkgPath}`);
  }
  return parsed;
}

/** Test-only: clear the resolver cache (used by unit tests). */
export function _clearPluginRootCache(): void {
  rootCache.clear();
}
