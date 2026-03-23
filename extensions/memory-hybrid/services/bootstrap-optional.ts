import { dirname, join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { ApitapStore } from "../backends/apitap-store.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { EventLog } from "../backends/event-log.js";
import { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import { IssueStore } from "../backends/issue-store.js";
import { PersonaStateStore } from "../backends/persona-state-store.js";
import { ProposalsDB } from "../backends/proposals-db.js";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { WriteAheadLog } from "../backends/wal.js";
import type { BootstrapPhaseConfig, HybridMemoryConfig } from "../config.js";
import { ProvenanceService } from "./provenance.js";
import { AliasDB } from "./retrieval-aliases.js";
import { VerificationStore } from "./verification-store.js";
import type { FactsDB } from "../backends/facts-db.js";

export interface OptionalBootstrapContext {
  cfg: HybridMemoryConfig;
  api: ClawdbotPluginApi;
  factsDb: FactsDB;
  resolvedSqlitePath: string;
}

export interface OptionalBootstrapServices {
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  identityReflectionStore: IdentityReflectionStore | null;
  personaStateStore: PersonaStateStore | null;
  eventLog: EventLog | null;
  aliasDb: AliasDB | null;
  issueStore: IssueStore;
  workflowStore: WorkflowStore;
  crystallizationStore: CrystallizationStore;
  toolProposalStore: ToolProposalStore;
  verificationStore: VerificationStore | null;
  provenanceService: ProvenanceService | null;
  apitapStore: ApitapStore;
}

export type OptionalBootstrapInstaller = BootstrapPhaseConfig & {
  id: string;
  install(context: OptionalBootstrapContext): OptionalBootstrapServices;
};

export const optionalBootstrapInstaller: OptionalBootstrapInstaller = {
  id: "adjacentFeatures",
  bootstrapPhase: "optional",
  install({ cfg, api, factsDb, resolvedSqlitePath }) {
    const baseDir = dirname(resolvedSqlitePath);

    let credentialsDb: CredentialsDB | null = null;
    if (cfg.credentials.enabled) {
      const credPath = join(baseDir, "credentials.db");
      credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey ?? "");
      const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
      api.logger.info(
        encrypted
          ? `memory-hybrid: credentials vault enabled (encrypted) (${credPath})`
          : `memory-hybrid: credentials vault enabled (plaintext; secure by other means) (${credPath})`,
      );
    }

    let wal: WriteAheadLog | null = null;
    if (cfg.wal.enabled) {
      const walPath = cfg.wal.walPath || join(baseDir, "memory.wal");
      wal = new WriteAheadLog(walPath, cfg.wal.maxAge);
      api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
    }

    let proposalsDb: ProposalsDB | null = null;
    if (cfg.personaProposals.enabled) {
      const proposalsPath = join(baseDir, "proposals.db");
      proposalsDb = new ProposalsDB(proposalsPath);
      api.logger.info(`memory-hybrid: persona proposals enabled (${proposalsPath})`);
    }

    let identityReflectionStore: IdentityReflectionStore | null = null;
    if (cfg.identityReflection.enabled || cfg.personaProposals.enabled) {
      const identityReflectionsPath = join(baseDir, "identity-reflections.db");
      identityReflectionStore = new IdentityReflectionStore(identityReflectionsPath);
      api.logger.info(`memory-hybrid: identity reflections enabled (${identityReflectionsPath})`);
    }

    let personaStateStore: PersonaStateStore | null = null;
    if (cfg.identityPromotion.enabled || cfg.personaProposals.enabled) {
      const personaStatePath = join(baseDir, "persona-state.db");
      personaStateStore = new PersonaStateStore(personaStatePath);
      api.logger.info(`memory-hybrid: persona state store enabled (${personaStatePath})`);
    }

    let eventLog: EventLog | null = null;
    if (cfg.nightlyCycle.enabled || cfg.graph?.autoSupersede || cfg.passiveObserver.enabled) {
      const eventLogPath = join(baseDir, "event-log.db");
      eventLog = new EventLog(eventLogPath);
      api.logger.info(`memory-hybrid: event log initialized (${eventLogPath})`);
    }

    let aliasDb: AliasDB | null = null;
    if (cfg.aliases?.enabled) {
      const aliasPath = join(baseDir, "aliases.db");
      const aliasLancePath = join(baseDir, "aliases.lance");
      aliasDb = new AliasDB(aliasPath, aliasLancePath, cfg.embedding.dimensions);
      api.logger.info(`memory-hybrid: retrieval aliases enabled (${aliasPath}, ${aliasLancePath})`);
    }

    const issueStorePath = join(baseDir, "issues.db");
    const issueStore = new IssueStore(issueStorePath);
    api.logger.info(`memory-hybrid: issue store initialized (${issueStorePath})`);

    const workflowStorePath = join(baseDir, "workflow-traces.db");
    const workflowStore = new WorkflowStore(workflowStorePath);
    api.logger.info(`memory-hybrid: workflow store initialized (${workflowStorePath})`);

    const crystallizationStorePath = join(baseDir, "crystallization-proposals.db");
    const crystallizationStore = new CrystallizationStore(crystallizationStorePath);
    api.logger.info(`memory-hybrid: crystallization store initialized (${crystallizationStorePath})`);

    const toolProposalStorePath = join(baseDir, "tool-proposals.db");
    const toolProposalStore = new ToolProposalStore(toolProposalStorePath);
    api.logger.info(`memory-hybrid: tool proposal store initialized (${toolProposalStorePath})`);

    let verificationStore: VerificationStore | null = null;
    if (cfg.verification.enabled) {
      verificationStore = new VerificationStore(factsDb.getRawDb(), {
        backupPath: cfg.verification.backupPath,
        reverificationDays: cfg.verification.reverificationDays,
        logger: api.logger,
      });
      api.logger.info("memory-hybrid: verification store enabled");
    }

    let provenanceService: ProvenanceService | null = null;
    if (cfg.provenance.enabled) {
      const provenancePath = join(baseDir, "provenance.db");
      provenanceService = new ProvenanceService(provenancePath);
      api.logger.info(`memory-hybrid: provenance tracing enabled (${provenancePath})`);
    }

    const apitapStorePath = join(baseDir, "apitap-endpoints.db");
    const apitapStore = new ApitapStore(apitapStorePath);
    api.logger.info(`memory-hybrid: apitap store initialized (${apitapStorePath})`);

    return {
      credentialsDb,
      wal,
      proposalsDb,
      identityReflectionStore,
      personaStateStore,
      eventLog,
      aliasDb,
      issueStore,
      workflowStore,
      crystallizationStore,
      toolProposalStore,
      verificationStore,
      provenanceService,
      apitapStore,
    };
  },
};

export function installOptionalBootstrapServices(context: OptionalBootstrapContext): OptionalBootstrapServices {
  return optionalBootstrapInstaller.install(context);
}
