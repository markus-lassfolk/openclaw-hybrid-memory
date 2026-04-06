#!/usr/bin/env node
/**
 * Standalone installer for openclaw-hybrid-memory.
 * Use when OpenClaw config validation fails (e.g. "plugin not found").
 * Run: npx -y openclaw-hybrid-memory-install
 * Fix broken credentials config (without loading plugin): npx -y openclaw-hybrid-memory-install fix-config
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.argv[2] === "fix-config") {
	require(path.join(__dirname, "fix-config.js"));
	process.exit(0);
}

const os = require("os");
const version = process.argv[2] || "latest";
const extDir =
	process.env.OPENCLAW_EXTENSIONS_DIR ||
	path.join(os.homedir(), ".openclaw", "extensions");
const pluginDir = path.join(extDir, "openclaw-hybrid-memory");
const tmpDir = path.join(os.tmpdir(), `openclaw-plugin-install-${process.pid}`);
const requiredRuntimeDependencies = ["@lancedb/lancedb"];

function run(cmd, args = [], opts = {}) {
	const isWindows = process.platform === "win32";

	// On Windows, avoid running npm via a shell (cmd.exe) to prevent shell interpretation
	// of arguments that may contain user-controlled data (e.g., version from process.argv).
	if (isWindows && cmd === "npm") {
		let npmExecPath = process.env.npm_execpath;
		if (!npmExecPath) {
			throw new Error(
				"Unable to locate npm safely on Windows (npm_execpath is not set). " +
					"Please run this installer via npm or npx so npm_execpath is available.",
			);
		}
		// When invoked via npx, npm_execpath may point to npx-cli.js instead of npm-cli.js
		// (npm issue #6662). Derive the correct npm-cli.js path.
		if (npmExecPath.endsWith("npx-cli.js")) {
			npmExecPath = npmExecPath.replace("npx-cli.js", "npm-cli.js");
		}
		return execFileSync(process.execPath, [npmExecPath, ...args], {
			stdio: "inherit",
			...opts,
		});
	}

	return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function packageDependencyDir(rootDir, pkgName) {
	return path.join(rootDir, "node_modules", ...pkgName.split("/"));
}

function getMissingRuntimeDependencies(rootDir) {
	return requiredRuntimeDependencies.filter((pkgName) => {
		const pkgJsonPath = path.join(
			packageDependencyDir(rootDir, pkgName),
			"package.json",
		);
		return !fs.existsSync(pkgJsonPath);
	});
}

function ensureRuntimeDependenciesInstalled(rootDir) {
	const missing = getMissingRuntimeDependencies(rootDir);
	if (missing.length === 0) {
		return;
	}

	console.log(`Missing runtime deps detected: ${missing.join(", ")}`);
	console.log("Installing missing runtime deps explicitly...");
	run("npm", ["install", "--no-save", "--omit=dev", ...missing], {
		cwd: rootDir,
	});

	const stillMissing = getMissingRuntimeDependencies(rootDir);
	if (stillMissing.length > 0) {
		throw new Error(
			`Missing runtime deps after install: ${stillMissing.join(", ")}`,
		);
	}
}

/** Best-effort rm -rf; avoids failing the install if cleanup hits permissions/AV locks. */
function rmPathBestEffort(absPath, label) {
	if (!fs.existsSync(absPath)) return;
	try {
		fs.rmSync(absPath, { recursive: true, force: true });
	} catch (e) {
		const msg = e && typeof e.message === "string" ? e.message : String(e);
		console.warn(`Warning: could not remove ${label} (${absPath}): ${msg}`);
	}
}

const stagingDir = path.join(
	extDir,
	`.openclaw-hybrid-memory-staging-${process.pid}`,
);

try {
	console.log(`Installing openclaw-hybrid-memory@${version} to ${pluginDir}\n`);

	if (fs.existsSync(stagingDir)) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
	fs.mkdirSync(stagingDir, { recursive: true });

	console.log("Fetching via npm pack...");
	fs.mkdirSync(tmpDir, { recursive: true });
	run("npm", ["pack", `openclaw-hybrid-memory@${version}`], { cwd: tmpDir });

	const tgz = fs.readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
	if (!tgz) throw new Error("npm pack did not produce a .tgz file");

	console.log(
		"Extracting to staging directory (existing plugin left in place until install succeeds)...",
	);
	const tgzPath = path.join(tmpDir, tgz);
	run("tar", ["-xzf", tgzPath, "-C", stagingDir, "--strip-components=1"]);

	console.log("Installing deps and rebuilding native modules in staging...");
	run("npm", ["install", "--omit=dev"], { cwd: stagingDir });
	ensureRuntimeDependenciesInstalled(stagingDir);

	const backupDir = `${pluginDir}.bak.${Date.now()}`;
	if (fs.existsSync(pluginDir)) {
		console.log("Swapping staging into place (backing up previous plugin)...");
		fs.renameSync(pluginDir, backupDir);
	}
	try {
		fs.renameSync(stagingDir, pluginDir);
	} catch (e) {
		if (fs.existsSync(backupDir)) {
			fs.renameSync(backupDir, pluginDir);
		}
		throw e;
	}
	if (fs.existsSync(backupDir)) {
		try {
			fs.rmSync(backupDir, { recursive: true, force: true });
		} catch (e) {
			const msg = e && typeof e.message === "string" ? e.message : String(e);
			console.warn(
				`Warning: install succeeded, but failed to remove backup directory ${backupDir}: ${msg}`,
			);
		}
	}

	console.log("Cleaning up...");
	rmPathBestEffort(tmpDir, "npm pack temp directory (.tgz and folder)");

	console.log(
		"\nDone. Restart the gateway: openclaw gateway stop && openclaw gateway start",
	);
} catch (err) {
	rmPathBestEffort(stagingDir, "staging directory");
	rmPathBestEffort(tmpDir, "npm pack temp directory (.tgz and folder)");
	console.error("Install failed:", err.message);
	process.exit(1);
}
