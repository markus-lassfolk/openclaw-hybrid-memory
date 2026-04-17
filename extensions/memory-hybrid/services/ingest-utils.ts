/**
 * Utilities for ingest-files CLI.
 * Exported for unit testing.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function resolvedWorkspaceRoot(workspaceRoot: string): string {
	try {
		return realpathSync(workspaceRoot);
	} catch {
		return resolve(workspaceRoot);
	}
}

/** Reject paths outside workspaceRoot (issue #858). Works with Windows backslashes and POSIX. */
function isPathInsideWorkspace(
	workspaceRootResolved: string,
	candidateAbs: string,
): boolean {
	let absResolved: string;
	try {
		absResolved = realpathSync(candidateAbs);
	} catch {
		absResolved = resolve(candidateAbs);
	}
	const rel = relative(workspaceRootResolved, absResolved);
	if (rel === "") return true;
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Expand glob patterns into absolute file paths under workspaceRoot.
 * Recursive patterns (e.g. skills/dir/*.md) walk subdirs; simple paths match single files.
 */
export function gatherIngestFiles(
	workspaceRoot: string,
	patterns: string[],
): string[] {
	const out: string[] = [];
	const ws = resolvedWorkspaceRoot(workspaceRoot);

	function walk(dir: string): void {
		if (!isPathInsideWorkspace(ws, dir)) return;
		if (!existsSync(dir)) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (!isPathInsideWorkspace(ws, full)) continue;
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".md")) out.push(full);
		}
	}

	for (const p of patterns) {
		if (p.includes("**")) {
			const base = p.split("**")[0].replace(/\/$/, "");
			const dir = join(workspaceRoot, base);
			if (isPathInsideWorkspace(ws, dir)) walk(dir);
		} else {
			const fp = join(workspaceRoot, p);
			if (isPathInsideWorkspace(ws, fp) && existsSync(fp)) {
				const st = statSync(fp);
				if (st.isFile()) out.push(fp);
			}
		}
	}

	return [...new Set(out)];
}
