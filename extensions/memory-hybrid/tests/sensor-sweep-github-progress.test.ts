/**
 * Tests for sensor-sweep GitHub sensor `--verbose` progress reporting (audit follow-up).
 *
 * `sweepGitHub` shells out to the `gh` CLI sequentially: a version check, `pr list`,
 * `pr list --review-requested`, up to 5x `pr checks`, then `issue list` — up to ~7
 * sequential execFile calls, each with its own 15s timeout. Worst case is 100+ seconds
 * of silence for an operator watching a cron log. These tests assert that each call is
 * preceded by an onProgress label, in order, so a verbose caller can tell the sweep is
 * alive and which gh invocation it is currently on.
 *
 * `gh` invocations are mocked at the process-runner boundary (module-level mock, isolated
 * to this file) so PR/issue counts and ordering are deterministic without depending on a
 * real `gh` CLI or network access.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/process-runner.js", () => ({ execFile: execFileMock }));

import { EventBus } from "../backends/event-bus.js";
import { sweepGitHub } from "../services/sensor-sweep.js";

type ExecFileCallback = (err: Error | null, result?: { stdout: string }) => void;

let tmpDir: string;
let bus: EventBus;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sensor-sweep-github-progress-test-"));
  bus = new EventBus(join(tmpDir, "event-bus.db"));
  execFileMock.mockReset();
});

afterEach(() => {
  bus.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sweepGitHub --verbose progress", () => {
  it("reports a progress label before each sequential gh CLI call, in order, with correct pr-checks index/total", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      if (args[0] === "--version") {
        cb(null, { stdout: "gh version 2.40.0" });
        return;
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--review-requested")) {
        cb(null, { stdout: JSON.stringify([]) });
        return;
      }
      if (args[0] === "pr" && args[1] === "list") {
        cb(null, {
          stdout: JSON.stringify([
            { number: 1, title: "PR one", state: "open", url: "https://example/1" },
            { number: 2, title: "PR two", state: "open", url: "https://example/2" },
          ]),
        });
        return;
      }
      if (args[0] === "pr" && args[1] === "checks") {
        cb(null, { stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]) });
        return;
      }
      if (args[0] === "issue" && args[1] === "list") {
        cb(null, { stdout: JSON.stringify([]) });
        return;
      }
      cb(new Error(`unexpected gh invocation: ${args.join(" ")}`));
    });

    const progress: string[] = [];
    const cfg = { enabled: true, importance: 0.7, includeReviewRequests: true, staleIssueDays: 7 };
    const result = await sweepGitHub(bus, cfg, 0, (label) => progress.push(label));

    expect(result.error).toBeUndefined();
    expect(progress).toEqual([
      "github: checking gh CLI availability",
      "github: listing open PRs",
      "github: listing review-requested PRs",
      "github: pr checks (1/2)",
      "github: pr checks (2/2)",
      "github: listing open issues",
    ]);
  });

  it("caps pr-checks progress at 5 PRs, matching the ciFailures scan cap", async () => {
    const manyPrs = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      state: "open",
      url: `https://example/${i + 1}`,
    }));

    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      if (args[0] === "--version") {
        cb(null, { stdout: "gh version 2.40.0" });
        return;
      }
      if (args[0] === "pr" && args[1] === "list") {
        cb(null, { stdout: JSON.stringify(manyPrs) });
        return;
      }
      if (args[0] === "pr" && args[1] === "checks") {
        cb(null, { stdout: JSON.stringify([]) });
        return;
      }
      if (args[0] === "issue" && args[1] === "list") {
        cb(null, { stdout: JSON.stringify([]) });
        return;
      }
      cb(new Error(`unexpected gh invocation: ${args.join(" ")}`));
    });

    const progress: string[] = [];
    const cfg = { enabled: true, importance: 0.7, includeReviewRequests: false, staleIssueDays: 7 };
    await sweepGitHub(bus, cfg, 0, (label) => progress.push(label));

    const checkLabels = progress.filter((label) => label.startsWith("github: pr checks"));
    expect(checkLabels).toEqual([
      "github: pr checks (1/5)",
      "github: pr checks (2/5)",
      "github: pr checks (3/5)",
      "github: pr checks (4/5)",
      "github: pr checks (5/5)",
    ]);
  });

  it("reports only the gh-availability label when the gh CLI invocation errors (bails out before later calls)", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    });

    const progress: string[] = [];
    const cfg = { enabled: true, importance: 0.7, includeReviewRequests: false, staleIssueDays: 7 };
    const result = await sweepGitHub(bus, cfg, 0, (label) => progress.push(label));

    expect(result.error).toBe("gh CLI not available");
    expect(progress).toEqual(["github: checking gh CLI availability"]);
  });
});
