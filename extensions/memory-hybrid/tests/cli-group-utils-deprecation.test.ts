/**
 * wrapChainableWithDeprecated must keep associating a command's action with its top-level flat
 * name even when that command is registered through a nested `.command().command()` chain (e.g.
 * `mem.command("entity-mentions").command("audit")`) — otherwise the nested subcommand's own
 * name silently replaces the flat lookup key and the deprecation warning is never emitted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapChainableWithDeprecated } from "../cli/commands/cli-group-utils.js";
import type { Chainable } from "../cli/shared.js";

class FakeCommand implements Chainable {
  children: FakeCommand[] = [];
  handler: ((...args: unknown[]) => unknown) | null = null;
  constructor(public name = "root") {}
  command(name: string): FakeCommand {
    const child = new FakeCommand(name);
    this.children.push(child);
    return child;
  }
  description(): this {
    return this;
  }
  action(fn: (...args: unknown[]) => void | Promise<void>): this {
    this.handler = fn;
    return this;
  }
  option(): this {
    return this;
  }
  requiredOption(): this {
    return this;
  }
  alias(): this {
    return this;
  }
  argument(): this {
    return this;
  }
}

describe("wrapChainableWithDeprecated nested commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still warns for a top-level flat command (single .command() call)", () => {
    const root = new FakeCommand();
    const wrapped = wrapChainableWithDeprecated(root, {
      "cgu-test-flat-top": "cgu-test-flat-top-grouped path",
    });

    wrapped.command("cgu-test-flat-top").action(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (root.children[0].handler as () => void)();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cgu-test-flat-top-grouped path"));
  });

  it("still warns when the command is registered through a nested .command() chain", () => {
    const root = new FakeCommand();
    const wrapped = wrapChainableWithDeprecated(root, {
      "cgu-test-nested-parent": "cgu-test-nested-parent-grouped path",
    });

    const parent = wrapped.command("cgu-test-nested-parent");
    parent.command("audit").action(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nestedNode = root.children[0].children[0];
    (nestedNode.handler as () => void)();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cgu-test-nested-parent-grouped path"));
  });
});
