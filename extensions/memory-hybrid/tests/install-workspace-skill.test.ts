import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import {
	applyHybridMemoryToolsMd,
	ensureHybridMemoryWorkspaceSkillIfMissing,
	installHybridMemoryWorkspaceSkill,
	resolveAgentWorkspaceRoot,
	resolveOpenclawJsonPathForWorkspace,
} from "../cli/cmd-install.js";

describe("workspace skill install", () => {
	const originalEnv = process.env.OPENCLAW_WORKSPACE;
	let tmp: string;

	beforeEach(() => {
		tmp = join(tmpdir(), `mh-skill-${Date.now()}`);
		mkdirSync(tmp, { recursive: true });
		Reflect.deleteProperty(process.env, "OPENCLAW_WORKSPACE");
	});

	afterEach(() => {
		if (originalEnv !== undefined) process.env.OPENCLAW_WORKSPACE = originalEnv;
		else Reflect.deleteProperty(process.env, "OPENCLAW_WORKSPACE");
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("resolveAgentWorkspaceRoot prefers OPENCLAW_WORKSPACE", () => {
		process.env.OPENCLAW_WORKSPACE = tmp;
		expect(resolveAgentWorkspaceRoot({})).toBe(tmp);
	});

	it("resolveAgentWorkspaceRoot reads agents.defaults.workspace", () => {
		expect(
			resolveAgentWorkspaceRoot({
				agents: { defaults: { workspace: tmp } },
			}),
		).toBe(tmp);
	});

	it("resolveAgentWorkspaceRoot reads agent.workspace (OpenClaw doc shape)", () => {
		expect(resolveAgentWorkspaceRoot({ agent: { workspace: tmp } })).toBe(tmp);
	});

	it("resolveAgentWorkspaceRoot ignores invalid OPENCLAW_WORKSPACE and uses agents.defaults", () => {
		process.env.OPENCLAW_WORKSPACE = "undefined";
		expect(
			resolveAgentWorkspaceRoot({
				agents: { defaults: { workspace: tmp } },
			}),
		).toBe(tmp);
	});

	it("resolveAgentWorkspaceRoot falls back to ~/.openclaw/workspace when path invalid and no config", () => {
		process.env.OPENCLAW_WORKSPACE = "null";
		expect(resolveAgentWorkspaceRoot({})).toBe(
			join(homedir(), ".openclaw", "workspace"),
		);
	});

	it("resolveOpenclawJsonPathForWorkspace honors OPENCLAW_CONFIG_PATH when OPENCLAW_CONFIG is unset", () => {
		const p = "/tmp/openclaw-test-config-1085.json";
		const savedPath = process.env.OPENCLAW_CONFIG_PATH;
		const savedConfig = process.env.OPENCLAW_CONFIG;
		try {
			Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG");
			process.env.OPENCLAW_CONFIG_PATH = p;
			expect(resolveOpenclawJsonPathForWorkspace()).toBe(p);
		} finally {
			if (savedConfig !== undefined) process.env.OPENCLAW_CONFIG = savedConfig;
			else Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG");
			if (savedPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = savedPath;
			else Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
		}
	});

	it("installHybridMemoryWorkspaceSkill copies bundled SKILL.md", () => {
		const pluginRoot = PLUGIN_ROOT;
		const destRoot = join(tmp, "ws");
		const r = installHybridMemoryWorkspaceSkill({
			mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
			pluginRootDir: pluginRoot,
			dryRun: false,
		});
		expect(r.error).toBeUndefined();
		const body = readFileSync(r.path, "utf-8");
		expect(body).toContain("name: openclaw_hybrid_memory");
		expect(body).toContain("memory_store");
		const refPath = join(
			destRoot,
			"skills",
			"hybrid-memory",
			"references",
			"memory-optimization.md",
		);
		expect(readFileSync(refPath, "utf-8")).toContain("run-all");
	});

	it("ensureHybridMemoryWorkspaceSkillIfMissing copies when SKILL.md is absent", () => {
		const pluginRoot = PLUGIN_ROOT;
		const destRoot = join(tmp, "ws-ensure");
		const dest = join(destRoot, "skills", "hybrid-memory", "SKILL.md");
		const r = ensureHybridMemoryWorkspaceSkillIfMissing({
			mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
			pluginRootDir: pluginRoot,
		});
		expect(r.deployed).toBe(true);
		expect(r.skippedReason).toBeUndefined();
		expect(readFileSync(dest, "utf-8")).toContain("memory_store");
	});

	it("ensureHybridMemoryWorkspaceSkillIfMissing skips when destination dir exists without SKILL.md", () => {
		const pluginRoot = PLUGIN_ROOT;
		const destRoot = join(tmp, "ws-ensure-partial");
		const destDir = join(destRoot, "skills", "hybrid-memory");
		mkdirSync(destDir, { recursive: true });
		writeFileSync(join(destDir, "notes.txt"), "keep\n", "utf-8");
		const r = ensureHybridMemoryWorkspaceSkillIfMissing({
			mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
			pluginRootDir: pluginRoot,
		});
		expect(r.deployed).toBe(false);
		expect(r.skippedReason).toBe("destination_dir_exists");
		expect(readFileSync(join(destDir, "notes.txt"), "utf-8")).toBe("keep\n");
	});

	it("ensureHybridMemoryWorkspaceSkillIfMissing skips when SKILL.md already exists", () => {
		const pluginRoot = PLUGIN_ROOT;
		const destRoot = join(tmp, "ws-ensure2");
		mkdirSync(join(destRoot, "skills", "hybrid-memory"), { recursive: true });
		writeFileSync(
			join(destRoot, "skills", "hybrid-memory", "SKILL.md"),
			"# custom\n",
			"utf-8",
		);
		const r = ensureHybridMemoryWorkspaceSkillIfMissing({
			mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
			pluginRootDir: pluginRoot,
		});
		expect(r.deployed).toBe(false);
		expect(r.skippedReason).toBe("already_exists");
		expect(
			readFileSync(
				join(destRoot, "skills", "hybrid-memory", "SKILL.md"),
				"utf-8",
			),
		).toBe("# custom\n");
	});

	it("installHybridMemoryWorkspaceSkill dry-run does not write", () => {
		const pluginRoot = PLUGIN_ROOT;
		const destRoot = join(tmp, "ws2");
		const dest = join(destRoot, "skills", "hybrid-memory", "SKILL.md");
		installHybridMemoryWorkspaceSkill({
			mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
			pluginRootDir: pluginRoot,
			dryRun: true,
		});
		try {
			readFileSync(dest, "utf-8");
			expect.fail("file should not exist");
		} catch {
			expect(true).toBe(true);
		}
	});
});

describe("applyHybridMemoryToolsMd", () => {
	let tmp: string;
	const pluginRoot = PLUGIN_ROOT;

	beforeEach(() => {
		tmp = join(tmpdir(), `mh-tools-${Date.now()}`);
		mkdirSync(tmp, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("creates TOOLS.md with managed block when missing", () => {
		const r = applyHybridMemoryToolsMd({
			mergedOpenclawConfig: { agents: { defaults: { workspace: tmp } } },
			pluginRootDir: pluginRoot,
			dryRun: false,
		});
		expect(r.error).toBeUndefined();
		expect(r.updated).toBe(true);
		const body = readFileSync(join(tmp, "TOOLS.md"), "utf-8");
		expect(body).toContain("# TOOLS");
		expect(body).toContain("<!-- openclaw-hybrid-memory:managed-begin -->");
		expect(body).toContain("memory_store");
	});

	it("replaces managed block on second run", () => {
		const path = join(tmp, "TOOLS.md");
		writeFileSync(
			path,
			"# TOOLS\n\n<!-- openclaw-hybrid-memory:managed-begin -->\n\nold\n\n<!-- openclaw-hybrid-memory:managed-end -->\n",
			"utf-8",
		);
		const r = applyHybridMemoryToolsMd({
			mergedOpenclawConfig: { agents: { defaults: { workspace: tmp } } },
			pluginRootDir: pluginRoot,
			dryRun: false,
		});
		expect(r.error).toBeUndefined();
		expect(r.updated).toBe(true);
		const body = readFileSync(path, "utf-8");
		expect(body).not.toContain("\nold\n");
		expect(body).toContain("memory_store");
	});

	it("appends managed block when file exists without markers", () => {
		writeFileSync(
			join(tmp, "TOOLS.md"),
			"# TOOLS\n\n## My notes\n\n- custom\n",
			"utf-8",
		);
		const r = applyHybridMemoryToolsMd({
			mergedOpenclawConfig: { agents: { defaults: { workspace: tmp } } },
			pluginRootDir: pluginRoot,
			dryRun: false,
		});
		expect(r.updated).toBe(true);
		const body = readFileSync(join(tmp, "TOOLS.md"), "utf-8");
		expect(body).toContain("## My notes");
		expect(body).toContain("openclaw-hybrid-memory:managed-begin");
	});
});
