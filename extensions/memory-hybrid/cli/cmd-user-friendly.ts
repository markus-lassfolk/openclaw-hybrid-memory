/**
 * Register user-friendly commands (setup, demo, providers, health, doctor, examples)
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { registerBootstrapCommand } from "./cmd-bootstrap.js";
import { registerDemoCommand } from "./cmd-demo.js";
import { registerDoctorCommand } from "./cmd-doctor.js";
import { registerExamplesCommand } from "./cmd-examples.js";
import { registerFocusCommands } from "./cmd-focus.js";
import { registerVaultCommands } from "./cmd-vaults.js";
import { registerHealthCommand } from "./cmd-health.js";
import { registerMineCommand } from "./cmd-mine.js";
import { registerProvidersCommand } from "./cmd-providers.js";
import { registerSetupCommand } from "./cmd-setup.js";
import type { Chainable } from "./shared.js";

export interface UserFriendlyContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  wal?: WriteAheadLog | null;
  embeddings: EmbeddingProvider;
  runConfigSet?: (
    key: string,
    value: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  runConfigMode?: (mode: string) => { ok: boolean; error?: string; message?: string } | Promise<{ ok: boolean; error?: string; message?: string }>;
  runInstall?: (opts: { dryRun: boolean }) => Promise<{ ok: boolean }>;
  runMine?: (path: string) => Promise<void>;
}

function hasCommand(mem: Chainable, name: string): boolean {
  const maybeCommands = (
    mem as {
      commands?: Array<{
        name?: string | (() => string);
        _name?: string;
        aliases?: () => string[];
        _aliases?: string[];
      }>;
    }
  ).commands;
  return Array.isArray(maybeCommands)
    ? maybeCommands.some((command) => {
        const commandName = typeof command.name === "function" ? command.name() : command.name;
        const aliases = typeof command.aliases === "function" ? command.aliases() : (command._aliases ?? []);
        return command._name === name || commandName === name || aliases.includes(name);
      })
    : false;
}

function registerIfMissing(mem: Chainable, name: string, register: () => void): void {
  if (hasCommand(mem, name)) return;
  register();
}

export function registerUserFriendlyCommands(mem: Chainable, ctx: UserFriendlyContext): void {
  registerIfMissing(mem, "setup", () => registerSetupCommand(mem, ctx.cfg, ctx.runConfigSet));
  registerIfMissing(mem, "providers", () => registerProvidersCommand(mem, ctx.cfg));
  registerIfMissing(mem, "doctor", () =>
    registerDoctorCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb, ctx.wal ?? null),
  );
  registerIfMissing(mem, "health", () =>
    registerHealthCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb, ctx.wal ?? null),
  );
  registerIfMissing(mem, "demo", () => registerDemoCommand(mem, ctx.factsDb, ctx.vectorDb, ctx.embeddings));
  registerIfMissing(mem, "examples", () => registerExamplesCommand(mem));
  registerIfMissing(mem, "mine", () => registerMineCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb, ctx.embeddings));
  registerIfMissing(mem, "bootstrap", () =>
    registerBootstrapCommand(mem, ctx.cfg, ctx.factsDb, {
      runConfigMode: ctx.runConfigMode,
      runInstall: ctx.runInstall ? async () => {
        await ctx.runInstall!({ dryRun: false });
      } : undefined,
      runMine: ctx.runMine,
    }),
  );
  registerIfMissing(mem, "focus", () => registerFocusCommands(mem));
  registerIfMissing(mem, "list-vaults", () => registerVaultCommands(mem, ctx.cfg));
}
