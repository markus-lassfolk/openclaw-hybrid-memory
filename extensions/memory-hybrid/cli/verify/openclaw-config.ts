import { existsSync, readFileSync } from "node:fs";

export type OpenclawConfigReadResult =
  | { path: string; exists: false; root: undefined; error: undefined }
  | { path: string; exists: true; root: Record<string, unknown>; error: undefined }
  | { path: string; exists: true; root: undefined; error: string };

export function readOpenclawConfigRoot(configPath: string): OpenclawConfigReadResult {
  if (!existsSync(configPath)) return { path: configPath, exists: false, root: undefined, error: undefined };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { path: configPath, exists: true, root: parsed, error: undefined };
  } catch (err) {
    return {
      path: configPath,
      exists: true,
      root: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
