/**
 * Register user-friendly commands (setup, demo, providers, health, doctor, examples)
 */

import type { Command } from "commander";
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
}

export function registerUserFriendlyCommands(mem: Command, ctx: UserFriendlyContext): void {
  // Register each user-friendly command
  registerSetupCommand(mem, ctx.cfg);
  registerProvidersCommand(mem, ctx.cfg);
  registerDoctorCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb);
  registerHealthCommand(mem, ctx.cfg, ctx.factsDb, ctx.vectorDb);
  registerDemoCommand(mem, ctx.factsDb, ctx.vectorDb, ctx.embeddings);
  registerExamplesCommand(mem);
}
