/** Procedure extraction and auto-skill CLI. Split from cmd-extract.ts. */
import { capturePluginError } from "../services/error-reporter.js";
import { extractProceduresFromSessions } from "../services/procedure-extractor.js";
import { auditAutoSkills, quarantineAutoSkills } from "../services/auto-skills-audit.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
import type { HandlerContext } from "./handlers.js";
import { resolveScanMaintenanceOverrides } from "./maintenance-overrides.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import type { ExtractProceduresResult, GenerateAutoSkillsResult } from "./types.js";

import { getSessionFilePathsSince, getMaxMtime } from "./cmd-extract-sessions.js";
export async function runExtractProceduresForCli(
  ctx: HandlerContext,
  opts: {
    sessionDir?: string;
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
    force?: boolean;
  },
): Promise<ExtractProceduresResult> {
  const { bypassScanCooldown, bypassWatermark } = resolveScanMaintenanceOverrides(opts);
  const { factsDb, vectorDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-procedures";
  if (cfg.procedures?.enabled === false) {
    return {
      sessionsScanned: 0,
      proceduresStored: 0,
      positiveCount: 0,
      negativeCount: 0,
      dryRun: opts.dryRun,
    };
  }
  const sessionDir = opts.sessionDir ?? cfg.procedures.sessionsDir;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when overrides request a forced rerun)
  if (!bypassScanCooldown && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return {
        sessionsScanned: 0,
        proceduresStored: 0,
        positiveCount: 0,
        negativeCount: 0,
        dryRun: false,
        skipped: true,
      };
  }

  let filePaths: string[] | undefined;
  if (!bypassWatermark && cursor) {
    // Incremental: only sessions modified after the last processed session timestamp
    filePaths = getSessionFilePathsSince(sessionDir, opts.days ?? 7, cursor.lastSessionTs);
    logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
  } else if (opts.days != null && opts.days > 0) {
    filePaths = getSessionFilePathsSince(sessionDir, opts.days);
  }

  try {
    const result = await extractProceduresFromSessions(
      factsDb,
      {
        sessionDir: filePaths ? undefined : sessionDir,
        filePaths,
        minSteps: cfg.procedures.minSteps,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      },
      {
        info: (s) => logger.info?.(s) ?? console.log(s),
        warn: (s) => logger.warn?.(s) ?? console.warn(s),
      },
    );
    if (!opts.dryRun) {
      let lastSessionTs: number | undefined;
      if (filePaths) {
        lastSessionTs = getMaxMtime(filePaths);
      } else {
        const allFiles = getSessionFilePathsSince(sessionDir, 0, 0);
        lastSessionTs = getMaxMtime(allFiles);
      }
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "runExtractProceduresForCli",
    });
    throw err;
  } finally {
    if (!bypassScanCooldown && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate auto-skills from procedures
 */
export async function runGenerateAutoSkillsForCli(
  ctx: HandlerContext,
  opts: {
    dryRun: boolean;
    apply?: boolean;
    verbose?: boolean;
    max?: number;
    policy?: string;
    json?: boolean;
    bypassDuplicateSkillCache?: boolean;
  },
): Promise<GenerateAutoSkillsResult> {
  const { factsDb, cfg, logger } = ctx;
  const info = opts.verbose ? (s: string) => logger.info?.(s) ?? console.log(s) : () => {};
  const warn = (s: string) => logger.warn?.(s) ?? console.warn(s);
  try {
    const result = await generateAutoSkills(
      factsDb,
      {
        skillsAutoPath: cfg.procedures.skillsAutoPath,
        validationThreshold: cfg.procedures.validationThreshold,
        skillTTLDays: cfg.procedures.skillTTLDays,
        dryRun: opts.dryRun,
        apply: opts.apply,
        maxPerRun: opts.max,
        policy: opts.policy,
        bypassDuplicateSkillCache: opts.bypassDuplicateSkillCache,
      },
      { info, warn },
    );
    if (opts.apply && !opts.dryRun && result.generated > 0) {
      const audit = auditAutoSkills(cfg.procedures.skillsAutoPath);
      if (audit.quarantinable > 0) {
        warn(
          `memory-hybrid: auto-skills post-generate audit: ${audit.quarantinable} quarantinable of ${audit.scanned} scanned`,
        );
        if (cfg.procedures.quarantineAfterGenerate) {
          const toMove = audit.entries.filter(
            (e) => !e.loadable || e.transcriptLike || e.secretLike || e.injectionLike,
          );
          quarantineAutoSkills(cfg.procedures.skillsAutoPath, toMove);
        }
      }
      return { ...result, quarantinable: audit.quarantinable };
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "runGenerateAutoSkillsForCli",
    });
    throw err;
  }
}
