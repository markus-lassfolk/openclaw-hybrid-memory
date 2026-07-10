/**
 * Regression test for cli/commands/manage/register-council.ts:
 *
 * `council provenance-headers --mode <mode>` cast `opts.mode` directly to `CouncilProvenanceMode`
 * with no runtime validation. `buildProvenanceMetadata` (utils/provenance.ts) only does equality
 * checks against the known modes with no `else` error case, so a typo'd `--mode` (e.g.
 * `meta-receipt` instead of `meta+receipt`) silently matched none of them and returned
 * `{ headers: null, receipt: null }` printed as valid-looking JSON with exit code 0 -- silently
 * dropping the provenance metadata a council review session was supposed to carry.
 */
import { describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageCouncil } from "../cli/commands/manage/register-council.js";
import type { Chainable } from "../cli/shared.js";

type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

function captureActions(): { actions: Map<string, ActionFn>; mem: Chainable } {
  const actions = new Map<string, ActionFn>();
  let currentCommand = "";
  const chainable: Chainable = {
    command(name: string) {
      currentCommand = name;
      return chainable;
    },
    description() {
      return chainable;
    },
    option() {
      return chainable;
    },
    requiredOption() {
      return chainable;
    },
    action(fn: ActionFn) {
      actions.set(currentCommand, fn);
      return chainable;
    },
  };
  return { actions, mem: chainable };
}

function makeBindings(): ManageBindings {
  return { cfg: { maintenance: { council: {} } } } as unknown as ManageBindings;
}

describe("council provenance-headers --mode validation (regression)", () => {
  it("rejects an invalid --mode instead of silently returning null headers/receipt", async () => {
    const { actions, mem } = captureActions();
    registerManageCouncil(mem, makeBindings());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;

    await actions.get("provenance-headers")!({ mode: "meta-receipt" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--mode must be one of"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("still accepts a valid --mode", async () => {
    const { actions, mem } = captureActions();
    registerManageCouncil(mem, makeBindings());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;

    await actions.get("provenance-headers")!({ mode: "meta", sessionKey: "council-review-test" });

    expect(logSpy).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    logSpy.mockRestore();
    process.exitCode = undefined;
  });
});
