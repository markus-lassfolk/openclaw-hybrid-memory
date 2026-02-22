/**
 * CLI Registration Wiring
 *
 * Registers all hybrid-mem CLI commands with the OpenClaw API.
 * Delegates to handler functions in cli/handlers.ts and cli/register.ts.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import { registerHybridMemCli, type CliContext } from "../cli/register.js";
import type { HandlerContext } from "../cli/handlers.js";
import * as handlers from "../cli/handlers.js";

export interface CliRegistrationContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
}

/**
 * Register all CLI commands with the OpenClaw API.
 * Creates handler context and delegates to cli/register.ts.
 */
export function registerCli(ctx: CliRegistrationContext, api: ClawdbotPluginApi): void {
  const handlerContext: HandlerContext = {
    factsDb: ctx.factsDb,
    vectorDb: ctx.vectorDb,
    embeddings: ctx.embeddings,
    openai: ctx.openai,
    cfg: ctx.cfg,
    credentialsDb: ctx.credentialsDb,
    wal: ctx.wal,
    proposalsDb: ctx.proposalsDb,
    resolvedSqlitePath: ctx.resolvedSqlitePath,
    resolvedLancePath: ctx.resolvedLancePath,
    pluginId: ctx.pluginId,
    logger: api.logger,
  };

  const cliContext: CliContext = {
    ...handlerContext,
    handlers,
  };

  api.registerCli(({ program }) => {
    registerHybridMemCli(program, cliContext, api.logger);
  });
}
