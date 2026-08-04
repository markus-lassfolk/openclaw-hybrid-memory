import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function key(): string {
  return `${"sk"}-test-key-that-is-long-enough-to-pass`;
}
describe("governed stewardship settings", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function setup() {
    home = mkdtempSync(join(tmpdir(), "oc-stewardship-"));
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const path = join(home, ".openclaw", "openclaw.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          untouched: { keep: true },
          plugins: {
            entries: {
              "openclaw-hybrid-memory": {
                config: {
                  embedding: { apiKey: key(), model: "text-embedding-3-small" },
                  goalStewardship: { globalLimits: { maxActiveGoals: 5, maxDispatchesPerHour: 6 } },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    vi.stubEnv("HOME", home);
    return { path, run: (await import("../cli/stewardship-settings.js")).runStewardshipSettingsForCli };
  }
  const approved = {
    actor: "ops@example",
    reason: "approved capacity increase",
    approved: true,
    requestId: "request-1",
  };
  it("updates maxActiveGoals to 6 atomically and writes an audit record", async () => {
    const { path, run } = await setup();
    const result = run({ ...approved, key: "globalLimits.maxActiveGoals", value: 6 });
    expect(result).toMatchObject({ ok: true, changed: true, oldValue: 5, newValue: 6 });
    const root = JSON.parse(readFileSync(path, "utf8"));
    expect(root.untouched).toEqual({ keep: true });
    expect(root.plugins.entries["openclaw-hybrid-memory"].config.goalStewardship.globalLimits).toEqual({
      maxActiveGoals: 6,
      maxDispatchesPerHour: 6,
    });
    const audit = readFileSync(join(home!, ".openclaw", "stewardship-settings-audit.jsonl"), "utf8");
    expect(audit).toContain('"actor":"ops@example"');
    expect(audit).toContain('"oldValue":5');
    expect(audit).toContain('"newValue":6');
    expect(audit).toContain('"result":"applied"');
  });
  it("rejects invalid values without altering config", async () => {
    const { path, run } = await setup();
    const before = readFileSync(path, "utf8");
    expect(run({ ...approved, key: "globalLimits.maxActiveGoals", value: "0" })).toMatchObject({ ok: false });
    expect(run({ ...approved, key: "globalLimits.maxActiveGoals", value: "1.5" })).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("requires explicit administrative approval", async () => {
    const { run } = await setup();
    expect(run({ ...approved, approved: false, key: "globalLimits.maxActiveGoals", value: 6 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("approval"),
    });
  });
  it("fails closed for unknown or protected fields", async () => {
    const { run } = await setup();
    expect(run({ ...approved, key: "enabled", value: 1 })).toMatchObject({ ok: false });
    expect(run({ ...approved, key: "dispatchAuthorization.enabled", value: 1 })).toMatchObject({ ok: false });
  });
  it("supports dry run and idempotent duplicate request ids", async () => {
    const { path, run } = await setup();
    expect(run({ ...approved, key: "globalLimits.maxActiveGoals", value: 6, dryRun: true })).toMatchObject({
      ok: true,
      dryRun: true,
    });
    expect(
      JSON.parse(readFileSync(path, "utf8")).plugins.entries["openclaw-hybrid-memory"].config.goalStewardship
        .globalLimits.maxActiveGoals,
    ).toBe(5);
    expect(run({ ...approved, key: "globalLimits.maxActiveGoals", value: 6 })).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(run({ ...approved, key: "globalLimits.maxActiveGoals", value: 7 })).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(
      JSON.parse(readFileSync(path, "utf8")).plugins.entries["openclaw-hybrid-memory"].config.goalStewardship
        .globalLimits.maxActiveGoals,
    ).toBe(6);
  });
});
