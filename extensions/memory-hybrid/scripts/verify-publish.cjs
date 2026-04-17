#!/usr/bin/env node
/**
 * Verifies publish packaging invariants for openclaw-hybrid-memory.
 * Ensures: postinstall present, and all modules imported by index.ts are
 * included in package.json "files" and exist on disk.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const requiredRuntimeDeps = ["@lancedb/lancedb"];
let failed = false;

// 1. postinstall required for native deps
if (!pkg.scripts?.postinstall) {
	console.error(
		"FAIL: postinstall missing from package.json - published package will not rebuild native deps",
	);
	failed = true;
} else {
	console.log("OK: postinstall present");
}

// 1b. Native runtime dependencies must be explicit direct dependencies.
let depsCheckFailed = false;
for (const dep of requiredRuntimeDeps) {
	if (!pkg.dependencies?.[dep]) {
		console.error(
			`FAIL: missing required runtime dependency in package.json dependencies: ${dep}`,
		);
		failed = true;
		depsCheckFailed = true;
	}
	if (pkg.optionalDependencies?.[dep]) {
		console.error(`FAIL: ${dep} must not be declared in optionalDependencies`);
		failed = true;
		depsCheckFailed = true;
	}
	if (pkg.peerDependencies?.[dep]) {
		console.error(`FAIL: ${dep} must not be declared in peerDependencies`);
		failed = true;
		depsCheckFailed = true;
	}
}
if (!depsCheckFailed) {
	console.log(
		"OK: required native runtime dependencies are declared correctly",
	);
}

// 1c. npm-shrinkwrap.json should ship with the package, but it must be generated
// only for packing/publishing so local npm ci continues to honor package-lock.json.
const shrinkwrapFilesListed = pkg.files?.includes("npm-shrinkwrap.json");
const packageLockExists = fs.existsSync(path.join(root, "package-lock.json"));
const shrinkwrapScriptPath = path.join(
	root,
	"scripts",
	"manage-shrinkwrap.cjs",
);
const hasShrinkwrapCreate = pkg.scripts?.prepack?.includes(
	"manage-shrinkwrap.cjs create",
);
const hasShrinkwrapClean = pkg.scripts?.postpack?.includes(
	"manage-shrinkwrap.cjs clean",
);

// npm intentionally omits package-lock.json from published tarballs; we ship
// npm-shrinkwrap.json (generated in prepack from package-lock.json) for npm ci / install.
if (!shrinkwrapFilesListed) {
	console.error(
		'FAIL: npm-shrinkwrap.json missing from package.json "files" - published package will resolve deps loosely during upgrade',
	);
	failed = true;
} else if (!packageLockExists) {
	console.error(
		"FAIL: package-lock.json missing - cannot generate npm-shrinkwrap.json for publish",
	);
	failed = true;
} else if (!fs.existsSync(shrinkwrapScriptPath)) {
	console.error(
		"FAIL: scripts/manage-shrinkwrap.cjs missing - cannot generate npm-shrinkwrap.json for publish",
	);
	failed = true;
} else if (!hasShrinkwrapCreate || !hasShrinkwrapClean) {
	console.error(
		"FAIL: package.json must generate npm-shrinkwrap.json in prepack and remove it in postpack",
	);
	failed = true;
} else {
	console.log("OK: npm-shrinkwrap.json is generated only for pack/publish");
}

let packIncludesShrinkwrap = false;
let packCheckErrored = false;
/** Resolve npm without relying on shell: true (Windows: npm lives beside node.exe). */
function npmExecutable() {
	if (process.platform !== "win32") return "npm";
	const candidate = path.join(path.dirname(process.execPath), "npm.cmd");
	return fs.existsSync(candidate) ? candidate : "npm.cmd";
}
try {
	const stdout = execFileSync(
		npmExecutable(),
		["pack", "--dry-run", "--json", "--silent"],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const jsonStart = stdout.indexOf("[");
	const jsonEnd = stdout.lastIndexOf("]") + 1;
	if (jsonStart < 0 || jsonEnd <= jsonStart) {
		throw new Error("npm pack --dry-run --json did not return a JSON array");
	}
	const packRows = JSON.parse(stdout.slice(jsonStart, jsonEnd));
	const first = packRows[0];
	const files = Array.isArray(first?.files)
		? first.files
				.map((f) => (typeof f === "string" ? f : f.path))
				.filter(Boolean)
		: [];
	packIncludesShrinkwrap = files.includes("npm-shrinkwrap.json");
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	console.error(
		"FAIL: could not verify packed file list includes npm-shrinkwrap.json:",
		message,
	);
	failed = true;
	packCheckErrored = true;
}
if (!packIncludesShrinkwrap && !packCheckErrored) {
	console.error(
		"FAIL: published pack must list npm-shrinkwrap.json — without it, npm ci / npm install after extract cannot resolve deps (e.g. @lancedb/lancedb)",
	);
	failed = true;
} else if (packIncludesShrinkwrap) {
	console.log(
		"OK: npm pack --dry-run lists npm-shrinkwrap.json (npm omits package-lock.json from publishes by design)",
	);
}

// 2. Collect relative imports from index.ts (from "./foo.js" or './bar/baz.js')
const indexPath = path.join(root, "index.ts");
const indexContent = fs.readFileSync(indexPath, "utf8");
const importRegex = /from\s+["'](\.\/.+?\.js)["']/g;
const importedJs = new Set();
for (const match of indexContent.matchAll(importRegex)) {
	importedJs.add(match[1]);
}

const importedRoots = [...importedJs].map((p) =>
	p.replace(/^\.\//, "").replace(/\.js$/, ""),
);
const filesEntries = new Set(pkg.files || []);

// 3. Ensure every imported root is covered by a files entry prefix
const uncovered = importedRoots.filter((r) => {
	const isTopLevel = !r.includes("/");
	if (isTopLevel) {
		return !filesEntries.has(`${r}.ts`);
	}
	const firstSeg = r.split("/")[0];
	return (
		!filesEntries.has(`${r}.ts`) &&
		!filesEntries.has(r) &&
		!filesEntries.has(firstSeg)
	);
});

if (uncovered.length > 0) {
	console.error(
		'FAIL: package.json "files" does not cover imports from index.ts:',
		uncovered,
	);
	failed = true;
} else {
	console.log('OK: all index.ts imports are covered by package.json "files"');
}

// 4. Ensure files actually exist on disk as .ts or directories/files
const missingOnDisk = importedRoots.filter((r) => {
	const tsFile = path.join(root, `${r}.ts`);
	const dir = path.join(root, r);
	return !fs.existsSync(tsFile) && !fs.existsSync(dir);
});

if (missingOnDisk.length > 0) {
	console.error("FAIL: imported paths missing on disk:", missingOnDisk);
	failed = true;
} else {
	console.log("OK: all imported files exist on disk");
}

// 5. Any file under cli/ that imports from ../benchmark/ requires "benchmark" in files
// (npm pack only ships listed paths; missing benchmark/ breaks hybrid-mem benchmark at runtime.)
const cliDir = path.join(root, "cli");
function walkTsFiles(dir) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) out.push(...walkTsFiles(p));
		else if (ent.name.endsWith(".ts")) out.push(p);
	}
	return out;
}
const benchmarkImportRe = /from\s+["']\.\.\/benchmark\//;
let needsBenchmark = false;
for (const f of walkTsFiles(cliDir)) {
	const content = fs.readFileSync(f, "utf8");
	if (benchmarkImportRe.test(content)) {
		needsBenchmark = true;
		break;
	}
}
if (needsBenchmark && !filesEntries.has("benchmark")) {
	console.error(
		'FAIL: cli imports from ../benchmark/ but "benchmark" is not listed in package.json files — publish will omit shadow-eval and feature benchmarks',
	);
	failed = true;
} else if (needsBenchmark) {
	console.log(
		'OK: "benchmark" is listed in package.json files (required by cli)',
	);
}

if (failed) process.exit(1);
console.log("verify-publish: all checks passed");
