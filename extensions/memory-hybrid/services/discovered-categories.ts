/**
 * Discoverable review workflow for auto-classifier category discovery (#2100).
 *
 * `.discovered-categories.json` (flat `string[]`, written by
 * `discoverCategoriesFromOther` in auto-classifier.ts) has always been advisory-only: labels
 * never become real categories until an operator promotes them into plugin config. Before this,
 * there was no CLI path to list, approve, or reject an entry — only a bootstrap log line pointing
 * at the raw file. This module owns approve/reject state as two sibling files next to the pending
 * one, keeping auto-classifier.ts's existing read/write of the pending file untouched.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { capturePluginError } from "./error-reporter.js";

/** Sibling path for labels an operator explicitly rejected — never re-proposed after that. */
export function getDiscoveredCategoriesRejectedPath(discoveredCategoriesPath: string): string {
  return discoveredCategoriesPath.replace(/\.json$/i, "-rejected.json");
}

async function readStringArrayFile(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function writeStringArrayFile(path: string, values: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(values, null, 2), "utf-8");
}

/** Labels currently pending operator review. */
export function readPendingDiscoveredCategories(discoveredCategoriesPath: string): Promise<string[]> {
  return readStringArrayFile(discoveredCategoriesPath);
}

/** Labels an operator has explicitly rejected — auto-classifier discovery must not re-propose these. */
export function readRejectedDiscoveredCategories(discoveredCategoriesPath: string): Promise<string[]> {
  return readStringArrayFile(getDiscoveredCategoriesRejectedPath(discoveredCategoriesPath));
}

export type DiscoveredCategoryDecision = "approved" | "rejected" | "not-pending";

/**
 * Remove `label` from the pending list. On reject, also record it in the rejected sidecar so
 * future discovery runs skip it. Returns "not-pending" (no-op) when the label wasn't pending —
 * callers should treat that as a usage error, not silently succeed.
 */
export async function decideDiscoveredCategory(
  discoveredCategoriesPath: string,
  label: string,
  decision: "approve" | "reject",
): Promise<DiscoveredCategoryDecision> {
  const pending = await readPendingDiscoveredCategories(discoveredCategoriesPath);
  if (!pending.includes(label)) return "not-pending";

  const remaining = pending.filter((l) => l !== label);
  try {
    await writeStringArrayFile(discoveredCategoriesPath, remaining);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "decide-discovered-category-write-pending",
      subsystem: "classifier",
    });
    throw err;
  }

  if (decision === "reject") {
    const rejectedPath = getDiscoveredCategoriesRejectedPath(discoveredCategoriesPath);
    const rejected = await readStringArrayFile(rejectedPath);
    if (!rejected.includes(label)) {
      try {
        await writeStringArrayFile(rejectedPath, [...rejected, label]);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "decide-discovered-category-write-rejected",
          subsystem: "classifier",
        });
        // Non-fatal: the label is already removed from pending; worst case it could be
        // re-proposed by a future discovery run.
      }
    }
    return "rejected";
  }
  return "approved";
}
