import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";
import { promptHiddenWithInterface } from "../cli/cmd-setup.js";
import { resolvers } from "../routes/graphql-resolvers.js";
import {
  matchesFactCreatedSubscription,
  matchesFactUpdatedSubscription,
  matchesLinkCreatedSubscription,
} from "../routes/graphql-server.js";
import { CollaborationService } from "../services/collaboration.js";
import { ProgressSpinner, showCompletionSummary, statusMessage } from "../utils/progress-indicators.js";
import { detectAvailableProviders, recommendProvider } from "../utils/provider-detection.js";

type ResolverArgs = Record<string, unknown>;
type ResolverContext = Parameters<typeof resolvers.Mutation.supersedeFact>[2];

class FakeCommand {
  children: FakeCommand[] = [];
  handler: ((...args: unknown[]) => unknown) | null = null;
  constructor(public name = "root") {}
  command(name: string): FakeCommand {
    const child = new FakeCommand(name.split(/\s+/)[0]);
    this.children.push(child);
    return child;
  }
  description(): FakeCommand {
    return this;
  }
  action(fn: (...args: unknown[]) => unknown): FakeCommand {
    this.handler = fn;
    return this;
  }
}

describe("PR #1332 unresolved feedback remediation", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("filters GraphQL fact and link subscription payloads by schema arguments", () => {
    expect(
      matchesFactCreatedSubscription(
        { fact: { id: "match", category: "preference", scope: "user" }, category: "preference", scope: "user" },
        { category: "preference", scope: "user" },
      ),
    ).toBe(true);
    expect(
      matchesFactCreatedSubscription(
        { fact: { id: "skip", category: "fact", scope: "user" }, category: "fact", scope: "user" },
        { category: "preference", scope: "user" },
      ),
    ).toBe(false);
    expect(
      matchesLinkCreatedSubscription(
        { link: { id: "match", sourceId: "a", targetId: "b" }, sourceId: "a", targetId: "b" },
        { sourceId: "a", targetId: "b" },
      ),
    ).toBe(true);
    expect(
      matchesLinkCreatedSubscription(
        { link: { id: "skip", sourceId: "a", targetId: "c" }, sourceId: "a", targetId: "c" },
        { sourceId: "a", targetId: "b" },
      ),
    ).toBe(false);
  });

  it("filters fact updates by fact id and category", () => {
    expect(
      matchesFactUpdatedSubscription(
        { fact: { id: "wanted", category: "preference" }, factId: "wanted", category: "preference" },
        { factId: "wanted", category: "preference" },
      ),
    ).toBe(true);
    expect(
      matchesFactUpdatedSubscription(
        { fact: { id: "other", category: "preference" }, factId: "other", category: "preference" },
        { factId: "wanted", category: "preference" },
      ),
    ).toBe(false);
  });

  it("fails GraphQL supersede mutation when the old fact is missing or already superseded", () => {
    const facts = new Map([
      ["new", { id: "new", text: "new" }],
      ["old", { id: "old", text: "old" }],
    ]);
    const context = {
      factsDb: {
        getById: vi.fn((id: string) => facts.get(id) ?? null),
        supersede: vi.fn((oldId: string) => oldId === "old"),
      },
    } as unknown as ResolverContext;

    expect(() =>
      resolvers.Mutation.supersedeFact(null, { oldFactId: "missing", newFactId: "new" } as ResolverArgs, context),
    ).toThrow(/missing/);
    expect(() =>
      resolvers.Mutation.supersedeFact(null, { oldFactId: "old", newFactId: "new" } as ResolverArgs, context),
    ).not.toThrow();
    context.factsDb.supersede = vi.fn(() => false) as never;
    expect(() =>
      resolvers.Mutation.supersedeFact(null, { oldFactId: "old", newFactId: "new" } as ResolverArgs, context),
    ).toThrow(/did not apply/);
  });

  it("does not treat an OpenAI key as Google provider configuration", async () => {
    const providers = await detectAvailableProviders("openai-key", undefined);
    const google = providers.find((provider) => provider.provider === "google");
    expect(google?.available).toBe(false);
    expect(providers.find((provider) => provider.provider === "openai")?.available).toBe(true);
  });

  it("doctor checks disk space at configured sqlite memory directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-pr1332-"));
    tmpRoots.push(root);
    const command = new FakeCommand();
    registerDoctorCommand(
      command as never,
      { sqlitePath: join(root, "custom", "facts.db"), embedding: { provider: "openai", apiKey: "sk-test" } } as never,
      { getCount: () => 1 } as never,
      { getAllIds: async () => ["v1"] } as never,
    );
    const doctor = command.children.find((child) => child.name === "doctor");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await doctor?.handler?.();
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(join(root, "custom"));
    expect(output).not.toContain(".openclaw/plugins/memory-hybrid");
  });

  it("progress helpers emit completion/status output in non-TTY mode", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spinner = new ProgressSpinner("work");
    spinner.success("done");
    spinner.fail("failed");
    statusMessage("success", "Demo complete");
    showCompletionSummary("Import", { facts: 2 }, 1500);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("✓ done");
    expect(output).toContain("✗ failed");
    expect(output).toContain("✓ Demo complete");
    expect(output).toContain("✓ Import complete");
    expect(output).toContain("facts: 2");
  });

  it("constructs CollaborationService in ESM without require being globally defined", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-collab-pr1332-"));
    tmpRoots.push(root);
    expect(() => new CollaborationService(join(root, "collab.db"))).not.toThrow();
  });

  it("promptHidden resolves typed answer once instead of close fallback", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const close = vi.fn();
    const callbacks = new Map<string, () => void>();
    await expect(
      promptHiddenWithInterface("key: ", () => ({
        question: (_question: string, cb: (answer: string) => void) => cb("secret-key"),
        close: () => {
          close();
          setTimeout(() => callbacks.get("close")?.(), 0);
        },
        on: vi.fn((event: string, cb: () => void) => {
          callbacks.set(event, cb);
          return undefined;
        }),
      })),
    ).resolves.toBe("secret-key");
    expect(close).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("\n");
  });

  it("promptHidden preserves typed answer when close emits synchronously", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const close = vi.fn();
    const callbacks = new Map<string, () => void>();
    await expect(
      promptHiddenWithInterface("key: ", () => ({
        question: (_question: string, cb: (answer: string) => void) => cb("secret-key"),
        close: () => {
          close();
          callbacks.get("close")?.();
        },
        on: vi.fn((event: string, cb: () => void) => {
          callbacks.set(event, cb);
          return undefined;
        }),
      })),
    ).resolves.toBe("secret-key");
    expect(close).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("\n");
  });
});
