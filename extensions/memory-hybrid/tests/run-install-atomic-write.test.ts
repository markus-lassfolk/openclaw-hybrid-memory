/**
 * runUninstallForCli's openclaw.json update — regression coverage for the switch from a plain
 * writeFileSync to atomicWriteFile (write-to-temp-then-rename), since openclaw.json is the
 * entire gateway's config, not just this plugin's.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUninstallForCli } from "../cli/install/run-install.js";
import { getEnv, setEnv } from "../utils/env-manager.js";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `run-install-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
  originalHome = getEnv("HOME");
  setEnv("HOME", tmpHome);
});

afterEach(() => {
  setEnv("HOME", originalHome);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("runUninstallForCli openclaw.json update", () => {
  it("writes valid JSON with the plugin disabled, using atomic write (no leftover tmp file)", () => {
    const configPath = join(tmpHome, ".openclaw", "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { "openclaw-hybrid-memory": { enabled: true } } } }, null, 2),
      "utf-8",
    );

    const ctx = {
      resolvedSqlitePath: join(tmpHome, ".openclaw", "memory", "facts.db"),
      resolvedLancePath: join(tmpHome, ".openclaw", "memory", "facts.lance"),
    } as never;

    const result = runUninstallForCli(ctx, { cleanAll: false, leaveConfig: false });
    expect(result.outcome).toBe("config_updated");

    const written = JSON.parse(readFileSync(configPath, "utf-8")) as {
      plugins: { entries: Record<string, { enabled: boolean }>; slots: { memory: string } };
    };
    expect(written.plugins.entries["openclaw-hybrid-memory"].enabled).toBe(false);
    expect(written.plugins.slots.memory).toBe("memory-core");

    // atomicWriteFile writes to `${target}.tmp-<pid>-<rand>` then renames — no leftover tmp file.
    const dirEntries = readdirSync(join(tmpHome, ".openclaw"));
    expect(dirEntries.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("does not corrupt openclaw.json when a concurrent read happens mid-uninstall (rename is atomic)", () => {
    const configPath = join(tmpHome, ".openclaw", "openclaw.json");
    const original = JSON.stringify({ plugins: { entries: {} }, other: "untouched-plugin-config" }, null, 2);
    writeFileSync(configPath, original, "utf-8");

    const ctx = {
      resolvedSqlitePath: join(tmpHome, ".openclaw", "memory", "facts.db"),
      resolvedLancePath: join(tmpHome, ".openclaw", "memory", "facts.lance"),
    } as never;

    runUninstallForCli(ctx, { cleanAll: false, leaveConfig: false });

    // File must always be fully valid JSON afterward — never a truncated partial write.
    expect(existsSync(configPath)).toBe(true);
    expect(() => JSON.parse(readFileSync(configPath, "utf-8"))).not.toThrow();
  });
});
