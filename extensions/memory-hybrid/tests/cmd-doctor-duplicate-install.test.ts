/**
 * `doctor` duplicate plugin-install detection (#2117).
 *
 * When both ~/.openclaw/extensions/<id> and the managed
 * ~/.openclaw/npm/projects/<id>/node_modules/<id> copy exist, the gateway logs
 * "duplicate plugin id detected". doctor must report both paths + versions + the
 * winning (canonical) source, and `doctor --fix` must quarantine the stale copy.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";

const PLUGIN_ID = "openclaw-hybrid-memory";

describe("doctor duplicate plugin install (#2117)", () => {
  const tmpRoots: string[] = [];
  let prevHome: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (prevHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = prevHome;
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupDualInstall(extVersion: string, npmVersion: string) {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-dup-"));
    tmpRoots.push(root);
    const home = join(root, ".openclaw");
    prevHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = home;

    const extDir = join(home, "extensions", PLUGIN_ID);
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "openclaw.plugin.json"), "{}");
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ version: extVersion }));

    const projectRoot = join(home, "npm", "projects", PLUGIN_ID);
    const npmDir = join(projectRoot, "node_modules", PLUGIN_ID);
    mkdirSync(join(npmDir, "dist"), { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ dependencies: { [PLUGIN_ID]: npmVersion } }));
    writeFileSync(join(npmDir, "openclaw.plugin.json"), "{}");
    writeFileSync(join(npmDir, "package.json"), JSON.stringify({ version: npmVersion }));
    writeFileSync(join(npmDir, "dist", "index.js"), "export default {};\n");

    const sqlitePath = join(root, "facts.db");
    const factsDb = new FactsDB(sqlitePath);
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerDoctorCommand(
      mem as never,
      { sqlitePath, embedding: { provider: "openai", apiKey: "sk-test-dup" } } as never,
      factsDb,
      { getAllIds: async () => [] } as never,
    );
    return { root, home, extDir, npmDir, factsDb, mem };
  }

  async function runDoctorJson(mem: Command, args: string[]) {
    let stdout = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") stdout += msg;
    });
    await mem.parseAsync(args, { from: "user" });
    return JSON.parse(stdout) as {
      checks: Array<{ name: string; status: string; message: string; fix?: string }>;
    };
  }

  it("reports both paths and the winning npm-project source when it is newer", async () => {
    const { npmDir, factsDb, mem } = setupDualInstall("2026.7.212", "2026.7.217");
    const report = await runDoctorJson(mem, ["doctor", "--json"]);
    const check = report.checks.find((c) => c.name === "Plugin install (duplicate id)");
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("2026.7.212");
    expect(check?.message).toContain("2026.7.217");
    // npm-project copy is strictly newer → it is the winning (canonical) source.
    expect(check?.message).toContain(`winning (canonical) source: ${npmDir}`);
    factsDb.close();
  });

  it("--fix quarantines the stale extensions copy to ~/.openclaw/.cache", async () => {
    const { home, extDir, npmDir, factsDb, mem } = setupDualInstall("2026.7.212", "2026.7.217");
    const report = await runDoctorJson(mem, ["doctor", "--json", "--fix"]);
    const check = report.checks.find((c) => c.name === "Plugin install (duplicate id)");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain(join(home, ".cache"));
    // The stale extensions copy is gone; the managed npm-project copy is untouched.
    expect(existsSync(extDir)).toBe(false);
    expect(existsSync(join(npmDir, "openclaw.plugin.json"))).toBe(true);
    factsDb.close();
  });

  it("does not report a duplicate when only one copy exists", async () => {
    const { extDir, factsDb, mem } = setupDualInstall("2026.7.217", "2026.7.217");
    // Remove the npm-project copy so only extensions remains.
    rmSync(join(extDir, "..", "..", "npm"), { recursive: true, force: true });
    const report = await runDoctorJson(mem, ["doctor", "--json"]);
    expect(report.checks.find((c) => c.name === "Plugin install (duplicate id)")).toBeUndefined();
    factsDb.close();
  });
});
