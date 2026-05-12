/**
 * Register user-friendly commands (setup, demo, providers, health, doctor, examples)
 */

import type { Chainable } from "./shared.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { registerDemoCommand } from "./cmd-demo.js";
import { registerDoctorCommand } from "./cmd-doctor.js";
import { registerExamplesCommand } from "./cmd-examples.js";
import { registerHealthCommand } from "./cmd-health.js";
import { registerProvidersCommand } from "./cmd-providers.js";
import { registerSetupCommand } from "./cmd-setup.js";

export interface UserFriendlyContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  runConfigSet?: (
    key: string,
    value: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
}

function hasCommand(mem: Chainable, name: string): boolean {
  const maybeCommands = (mem as { commands?: Array<{ name?: string | (() => string); _name?: string }> }).commands;
  return Array.isArray(maybeCommands)
    ? maybeCommands.some(
        (command) =>
          command._name === name ||
          (typeof command.name === "function" ? command.name() === name : command.name === name),
      )
    : false;
}

function registerIfMissing(mem: Chainable, name: string, register: () => void): void {
  if (hasCommand(mem, name)) return;
  register();
}

export function registerUserFriendlyCommands(mem: Chainable, ctx: UserFriendlyContext): void {
  registerIfMissing(mem, "setup", () => registerSetupCommand(mem, ctx.cfg, ctx.runConfigSet));
  registerIfMissing(mem, "providers", () => registerProvidersCommand(mem, ctx.cfg));
  registerIfMissing(mem, "doctor", () => registerDoctorCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb));
  registerIfMissing(mem, "health", () => registerHealthCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb));
  registerIfMissing(mem, "demo", () => registerDemoCommand(mem, ctx.factsDb, ctx.vectorDb, ctx.embeddings));
  registerIfMissing(mem, "examples", () => registerExamplesCommand(mem));
}
