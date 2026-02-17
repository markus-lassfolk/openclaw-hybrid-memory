/**
 * Load prompt templates from prompts/ directory.
 * Uses import.meta.url to resolve path relative to this package.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

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
