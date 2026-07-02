/**
 * verifyGoalMechanically's http_ok check previously validated the target hostname's DNS
 * resolution via getBlockedVerificationHostReason(), then let fetch() perform its own,
 * independent DNS resolution to actually open the connection. Two separate lookups against the
 * same hostname create a DNS-rebinding TOCTOU window: an attacker-controlled DNS server can
 * answer the validation lookup with a public IP (passing the SSRF guard) and then answer the
 * connection lookup with a private/internal address, bypassing the guard entirely.
 *
 * The fix resolves the hostname once, validates that address, and pins the actual outbound
 * connection to that exact IP (via a custom `lookup` option passed to node:http/node:https),
 * so no second, independently-answerable DNS query ever happens. This test mocks node:dns/promises
 * and node:http to prove that mechanism directly: it captures the `lookup` function passed to
 * node:http's request() and confirms invoking it (as node's connection layer would) returns the
 * already-validated address without issuing another DNS lookup.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { lookupMock, requestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: lookupMock };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: requestMock };
});

const { createGoal } = await import("../services/goal-registry.js");
const { runGoalHealthCheck } = await import("../services/goal-health.js");
const { baseGoalStewardshipConfig, goalDefaults } = await import("./helpers/goal-helpers.js");

type LookupCallback = (err: Error | null, address: string, family: number) => void;
type PinnedLookup = (hostname: string, options: unknown, cb: LookupCallback) => void;

let dir: string;

afterEach(async () => {
  vi.clearAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("http_ok verification DNS-rebinding TOCTOU fix (#39)", () => {
  it("pins the outbound connection to the DNS-validated IP instead of re-resolving", async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-dns-pin-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ws-dns-pin-"));

    const validatedIp = "93.184.216.34";
    lookupMock.mockResolvedValue([{ address: validatedIp, family: 4 }]);

    let capturedLookup: PinnedLookup | undefined;
    const fakeReq = { end: vi.fn(), on: vi.fn() };
    requestMock.mockImplementation((...args: unknown[]) => {
      const opts = args.find((a): a is Record<string, unknown> => !!a && typeof a === "object" && "lookup" in a);
      capturedLookup = opts?.lookup as PinnedLookup;
      const cb = args[args.length - 1] as (res: { statusCode: number; resume: () => void }) => void;
      queueMicrotask(() => cb({ statusCode: 200, resume: vi.fn() }));
      return fakeReq;
    });

    await createGoal(
      dir,
      {
        label: "http_pinned",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "http_ok", target: "http://example-public-host.invalid/health" },
      },
      goalDefaults(),
    );

    const r = await runGoalHealthCheck({
      goalsDir: dir,
      cfg: baseGoalStewardshipConfig(),
      workspaceRoot,
      logger: {},
    });

    expect(r.actions.some((a) => a.action === "verifying")).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(capturedLookup).toBeTypeOf("function");

    // Invoke the pinned `lookup` exactly as node:http's connection layer would when opening the
    // TCP socket: it must resolve to the address already validated above, synchronously, without
    // issuing any further DNS query — a second, independent lookup here is exactly what would let
    // a rebinding DNS server hand back a different (internal) address after the check passed.
    const cb = vi.fn();
    capturedLookup?.("example-public-host.invalid", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, validatedIp, 4);
    expect(lookupMock).toHaveBeenCalledTimes(1);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("never opens a connection when the validated IP is private, even if a later lookup would answer differently", async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-dns-pin-blocked-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ws-dns-pin-blocked-"));

    // Simulates the rebinding attempt itself: the validation lookup answers with a private IP.
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    await createGoal(
      dir,
      {
        label: "http_pin_blocked",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "http_ok", target: "http://rebinding-attacker-host.invalid/health" },
      },
      goalDefaults(),
    );

    const r = await runGoalHealthCheck({
      goalsDir: dir,
      cfg: baseGoalStewardshipConfig(),
      workspaceRoot,
      logger: {},
    });

    expect(r.actions.some((a) => a.action === "verifying")).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
