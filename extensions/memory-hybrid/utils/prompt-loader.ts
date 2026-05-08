/**
 * Load prompt templates from prompts/ directory.
 * Resolves prompts/ relative to the plugin root (the directory containing
 * `openclaw.plugin.json`), so paths are correct whether the runtime entry is
 * the TS source or the compiled `dist/index.js` (issue #1174).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPluginRoot } from "./plugin-root.js";

const PROMPTS_DIR = join(findPluginRoot(import.meta.url), "prompts");

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  let template = cache.get(name);
  if (template !== undefined) return template;
  const path = join(PROMPTS_DIR, `${name}.txt`);
  template = readFileSync(path, "utf-8");
  cache.set(name, template);
  return template;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fillPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, "g");
    out = out.replace(pattern, () => value);
  }
  return out;
}
