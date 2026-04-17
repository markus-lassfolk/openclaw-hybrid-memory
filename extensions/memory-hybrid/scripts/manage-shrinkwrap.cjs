#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageLockPath = path.join(root, "package-lock.json");
const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
const mode = process.argv[2];

function createShrinkwrap() {
	if (!fs.existsSync(packageLockPath)) {
		throw new Error(`package-lock.json not found at ${packageLockPath}`);
	}

	fs.copyFileSync(packageLockPath, shrinkwrapPath);
	console.log("Created npm-shrinkwrap.json from package-lock.json");
}

function cleanShrinkwrap() {
	fs.rmSync(shrinkwrapPath, { force: true });
	console.log("Removed generated npm-shrinkwrap.json");
}

if (mode === "create") {
	createShrinkwrap();
} else if (mode === "clean") {
	cleanShrinkwrap();
} else {
	console.error("Usage: node scripts/manage-shrinkwrap.cjs <create|clean>");
	process.exit(1);
}
