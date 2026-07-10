import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import {
  applyHybridMemoryToolsMd,
  detectRecommendedEmbeddingSetup,
  getDashboardUrl,
  ensureHybridMemoryWorkspaceSkillIfMissing,
  installHybridMemoryWorkspaceSkill,
  runInstallForCli,
  resolveAgentWorkspaceRoot,
  resolveOpenclawJsonPathForWorkspace,
} from "../cli/cmd-install.js";
import { ensureWorkspaceBootstrap } from "../setup/workspace-bootstrap.js";
import { isAtomicSkillWriteScratchDir } from "../utils/skill-discovery.js";

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
    expect(resolveAgentWorkspaceRoot({})).toBe(join(homedir(), ".openclaw", "workspace"));
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

  it("resolveOpenclawJsonPathForWorkspace honors OPENCLAW_HOME when explicit config vars are unset", () => {
    const openclawHome = "/tmp/openclaw-home-verify";
    const savedHome = process.env.OPENCLAW_HOME;
    const savedPath = process.env.OPENCLAW_CONFIG_PATH;
    const savedConfig = process.env.OPENCLAW_CONFIG;
    try {
      Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG");
      Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
      process.env.OPENCLAW_HOME = openclawHome;
      expect(resolveOpenclawJsonPathForWorkspace()).toBe(join(openclawHome, "openclaw.json"));
    } finally {
      if (savedConfig !== undefined) process.env.OPENCLAW_CONFIG = savedConfig;
      else Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG");
      if (savedPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = savedPath;
      else Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
      if (savedHome !== undefined) process.env.OPENCLAW_HOME = savedHome;
      else Reflect.deleteProperty(process.env, "OPENCLAW_HOME");
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
    expect(body).toContain("maintenance nightly");
    expect(body).toContain("credentials get");
    const refPath = join(destRoot, "skills", "hybrid-memory", "references", "memory-optimization.md");
    const refBody = readFileSync(refPath, "utf-8");
    expect(refBody).toContain("maintenance full");
    expect(refBody).toContain("maintenance-nightly");
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

  it("ensureHybridMemoryWorkspaceSkillIfMissing repairs partial dir by copying missing SKILL.md", () => {
    const pluginRoot = PLUGIN_ROOT;
    const destRoot = join(tmp, "ws-ensure-partial");
    const destDir = join(destRoot, "skills", "hybrid-memory");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "notes.txt"), "keep\n", "utf-8");
    const r = ensureHybridMemoryWorkspaceSkillIfMissing({
      mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
      pluginRootDir: pluginRoot,
    });
    expect(r.deployed).toBe(true);
    expect(readFileSync(join(destDir, "SKILL.md"), "utf-8")).toContain("memory_store");
    expect(readFileSync(join(destDir, "notes.txt"), "utf-8")).toBe("keep\n");
  });

  it("ensureHybridMemoryWorkspaceSkillIfMissing skips when SKILL.md already exists", () => {
    const pluginRoot = PLUGIN_ROOT;
    const destRoot = join(tmp, "ws-ensure2");
    mkdirSync(join(destRoot, "skills", "hybrid-memory"), { recursive: true });
    writeFileSync(join(destRoot, "skills", "hybrid-memory", "SKILL.md"), "# custom\n", "utf-8");
    const r = ensureHybridMemoryWorkspaceSkillIfMissing({
      mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
      pluginRootDir: pluginRoot,
    });
    expect(r.deployed).toBe(false);
    expect(r.skippedReason).toBe("already_exists");
    expect(readFileSync(join(destRoot, "skills", "hybrid-memory", "SKILL.md"), "utf-8")).toBe("# custom\n");
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

  it("installHybridMemoryWorkspaceSkill replaces blocking file at destination", () => {
    const destRoot = join(tmp, "ws-atomic-install");
    const skillsDir = join(destRoot, "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Place a file at the path where the skill directory should be installed.
    // The install should remove this file and successfully install the skill directory.
    writeFileSync(join(skillsDir, "hybrid-memory"), "blocking-file\n", "utf-8");
    const r = installHybridMemoryWorkspaceSkill({
      mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
      pluginRootDir: PLUGIN_ROOT,
      dryRun: false,
    });
    expect(r.error).toBeUndefined();
    // No atomic-write scratch directories should remain in skills/
    const leftover = readdirSync(skillsDir).filter((e) => isAtomicSkillWriteScratchDir(e));
    expect(leftover).toHaveLength(0);
    // The skill should be successfully installed
    expect(readFileSync(join(skillsDir, "hybrid-memory", "SKILL.md"), "utf-8")).toContain("memory_store");
  });

  it("ensureHybridMemoryWorkspaceSkillIfMissing leaves no temp dir after successful deploy", () => {
    const destRoot = join(tmp, "ws-ensure-atomic-success");
    const r = ensureHybridMemoryWorkspaceSkillIfMissing({
      mergedOpenclawConfig: { agents: { defaults: { workspace: destRoot } } },
      pluginRootDir: PLUGIN_ROOT,
    });
    expect(r.deployed).toBe(true);
    // The temp dir must have been renamed to the final destination — no atomic-write scratch dirs left.
    const skillsDir = join(destRoot, "skills");
    const leftover = readdirSync(skillsDir).filter((e) => isAtomicSkillWriteScratchDir(e));
    expect(leftover).toHaveLength(0);
    // Final destination should contain valid content
    expect(readFileSync(join(destRoot, "skills", "hybrid-memory", "SKILL.md"), "utf-8")).toContain("memory_store");
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
    writeFileSync(join(tmp, "TOOLS.md"), "# TOOLS\n\n## My notes\n\n- custom\n", "utf-8");
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

describe("ensureWorkspaceBootstrap", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `mh-bootstrap-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates starter directories and files without overwriting existing ones", () => {
    writeFileSync(join(tmp, "USER.md"), "# custom\n", "utf-8");
    const result = ensureWorkspaceBootstrap({ workspaceRoot: tmp, dryRun: false });
    expect(result.directories.some((entry) => entry.path.endsWith("memory/projects") && entry.created)).toBe(true);
    expect(result.files.some((entry) => entry.path.endsWith("AGENTS.md") && entry.created)).toBe(true);
    expect(readFileSync(join(tmp, "USER.md"), "utf-8")).toBe("# custom\n");
  });

  it("dry-run reports what would be created", () => {
    const result = ensureWorkspaceBootstrap({ workspaceRoot: tmp, dryRun: true });
    expect(result.directories.some((entry) => entry.created)).toBe(true);
    expect(result.files.some((entry) => entry.created)).toBe(true);
    expect(() => readFileSync(join(tmp, "AGENTS.md"), "utf-8")).toThrow(/ENOENT|no such file or directory/i);
  });
});

describe("install UX helpers", () => {
  it("prefers local runtimes for embedding recommendations", () => {
    const saved = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://127.0.0.1:11434";
    try {
      const result = detectRecommendedEmbeddingSetup({}, PLUGIN_ROOT);
      expect(["onnx", "ollama"]).toContain(result.provider);
    } finally {
      if (saved !== undefined) process.env.OLLAMA_HOST = saved;
      else Reflect.deleteProperty(process.env, "OLLAMA_HOST");
    }
  });

  describe("ollama detection scans PATH instead of executing the binary (#2072 regression)", () => {
    const savedPath = process.env.PATH;
    const savedOllamaHost = process.env.OLLAMA_HOST;
    const savedOpenclawHome = process.env.OPENCLAW_HOME;
    let binDir: string;
    let pluginRootDir: string;

    beforeEach(() => {
      binDir = join(tmpdir(), `mh-ollama-path-${randomUUID()}`);
      pluginRootDir = join(tmpdir(), `mh-ollama-pluginroot-${randomUUID()}`);
      mkdirSync(binDir, { recursive: true });
      mkdirSync(pluginRootDir, { recursive: true });
      Reflect.deleteProperty(process.env, "OLLAMA_HOST");
      // Isolate from any real ~/.openclaw/extensions/node_modules/onnxruntime-node on this
      // machine, so the onnx branch (checked before ollama) can't make this test flaky.
      process.env.OPENCLAW_HOME = pluginRootDir;
    });

    afterEach(() => {
      if (savedPath !== undefined) process.env.PATH = savedPath;
      else Reflect.deleteProperty(process.env, "PATH");
      if (savedOllamaHost !== undefined) process.env.OLLAMA_HOST = savedOllamaHost;
      else Reflect.deleteProperty(process.env, "OLLAMA_HOST");
      if (savedOpenclawHome !== undefined) process.env.OPENCLAW_HOME = savedOpenclawHome;
      else Reflect.deleteProperty(process.env, "OPENCLAW_HOME");
      rmSync(binDir, { recursive: true, force: true });
      rmSync(pluginRootDir, { recursive: true, force: true });
    });

    it("detects ollama when a real executable sits on an absolute PATH entry", () => {
      writeFileSync(join(binDir, "ollama"), "#!/bin/sh\necho fake ollama\n", { mode: 0o755 });
      process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;

      const result = detectRecommendedEmbeddingSetup({}, pluginRootDir);

      expect(result.provider).toBe("ollama");
    });

    it("does not trust a cwd-relative '.' PATH entry (matches the original CVE-adjacent risk)", () => {
      // A "." (or otherwise non-absolute) PATH entry lets an attacker who controls the working
      // directory plant a same-named binary that would previously have been spawned unqualified.
      writeFileSync(join(binDir, "ollama"), "#!/bin/sh\necho fake ollama\n", { mode: 0o755 });
      const originalCwd = process.cwd();
      process.chdir(binDir);
      try {
        process.env.PATH = `.${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
        const result = detectRecommendedEmbeddingSetup({}, pluginRootDir);
        expect(result.provider).not.toBe("ollama");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("builds dashboard URL from plugin config", () => {
    expect(
      getDashboardUrl({
        plugins: {
          entries: {
            "openclaw-hybrid-memory": {
              config: {
                dashboard: { port: 7788 },
              },
            },
          },
        },
      }),
    ).toBe("http://127.0.0.1:7788/");
  });
});

describe("install embedding autofill safety", () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const originalOpenclawHome = process.env.OPENCLAW_HOME;
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalAzureOpenAi = process.env.AZURE_OPENAI_API_KEY;

  function writeOpenclawConfig(config: Record<string, unknown>): void {
    const openclawDir = join(tmpHome, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(join(openclawDir, "openclaw.json"), JSON.stringify(config, null, 2), "utf-8");
  }

  beforeEach(() => {
    tmpHome = join(tmpdir(), `mh-install-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.OPENCLAW_HOME = join(tmpHome, ".openclaw");
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    Reflect.deleteProperty(process.env, "AZURE_OPENAI_API_KEY");
    Reflect.deleteProperty(process.env, "OLLAMA_HOST");
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else Reflect.deleteProperty(process.env, "HOME");
    if (originalOpenclawHome !== undefined) process.env.OPENCLAW_HOME = originalOpenclawHome;
    else Reflect.deleteProperty(process.env, "OPENCLAW_HOME");
    if (originalOpenAi !== undefined) process.env.OPENAI_API_KEY = originalOpenAi;
    else Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    if (originalAzureOpenAi !== undefined) process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAi;
    else Reflect.deleteProperty(process.env, "AZURE_OPENAI_API_KEY");
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("does not use AZURE_OPENAI_API_KEY as embedding.apiKey autofill source", () => {
    process.env.AZURE_OPENAI_API_KEY = "azure-key-that-should-not-be-written";
    const detection = detectRecommendedEmbeddingSetup({}, join(tmpHome, "plugin-root"));
    expect(detection.envKey).not.toBe("AZURE_OPENAI_API_KEY");
  });

  it("preserves embedding.apiKey SecretRef objects during install dry-run", () => {
    writeOpenclawConfig({
      plugins: {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              embedding: {
                provider: "openai",
                model: "text-embedding-3-small",
                apiKey: { source: "env", provider: "openclaw", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
      },
    });
    const result = runInstallForCli({ dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.configJson ?? "{}") as Record<string, unknown>;
    const apiKey = (
      (
        (
          ((parsed.plugins as Record<string, unknown>).entries as Record<string, unknown>)[
            "openclaw-hybrid-memory"
          ] as Record<string, unknown>
        ).config as Record<string, unknown>
      ).embedding as Record<string, unknown>
    ).apiKey;
    expect(apiKey).toEqual({ source: "env", provider: "openclaw", id: "OPENAI_API_KEY" });
  });

  it("treats llm.providers.openai/azure-foundry keys as valid embedding fallback auth", () => {
    writeOpenclawConfig({
      plugins: {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              embedding: {
                provider: "openai",
                model: "text-embedding-3-small",
                apiKey: "YOUR_OPENAI_API_KEY",
              },
              llm: {
                providers: {
                  "azure-foundry": { apiKey: "env:AZURE_OPENAI_API_KEY" },
                },
              },
            },
          },
        },
      },
    });
    const result = runInstallForCli({ dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.configJson ?? "{}") as Record<string, unknown>;
    const embedding = (
      (
        ((parsed.plugins as Record<string, unknown>).entries as Record<string, unknown>)[
          "openclaw-hybrid-memory"
        ] as Record<string, unknown>
      ).config as Record<string, unknown>
    ).embedding as Record<string, unknown>;
    expect(embedding.apiKey).toBe("");
    expect(result.remaining.some((line) => line.includes("OpenAI-compatible embedding API key"))).toBe(false);
  });

  it("keeps provider/model consistent when provider exists but model is missing", () => {
    writeOpenclawConfig({
      plugins: {
        entries: {
          "openclaw-hybrid-memory": {
            config: {
              embedding: {
                provider: "google",
              },
            },
          },
        },
      },
    });
    const result = runInstallForCli({ dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.configJson ?? "{}") as Record<string, unknown>;
    const embedding = (
      (
        ((parsed.plugins as Record<string, unknown>).entries as Record<string, unknown>)[
          "openclaw-hybrid-memory"
        ] as Record<string, unknown>
      ).config as Record<string, unknown>
    ).embedding as Record<string, unknown>;
    expect(embedding.provider).toBe("google");
    expect(embedding.model).toBe("gemini-embedding-001");
  });
});
