/**
 * Read `hybrid-mem -v/--verbose` from the parent Commander command chain.
 */

import { getEnv } from "../utils/env-manager.js";

/** Minimal Commander command shape for reading inherited opts (hybrid-mem --verbose). */
export type CommanderOptsParent = {
  opts: () => { verbose?: boolean };
  parent?: CommanderOptsParent | null;
};

export function readHybridMemVerbose(cmd: CommanderOptsParent | undefined): boolean {
  let c: CommanderOptsParent | undefined = cmd;
  while (c) {
    const o = c.opts() as { verbose?: boolean };
    if (o.verbose) return true;
    c = c.parent ?? undefined;
  }
  return false;
}

/** Scan raw argv for `-v` / `--verbose` after `hybrid-mem` (OpenClaw lazy CLI reparse safety). */
export function argvHasHybridMemVerbose(argv: readonly string[] = process.argv): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--verbose" || arg === "-v") return true;
  }
  return false;
}

/** Resolve verbose from explicit opts, Commander parent chain, env, or raw argv. */
export function resolveHybridMemVerbose(
  opts?: { verbose?: boolean },
  cmd?: CommanderOptsParent,
  argv: readonly string[] = process.argv,
): boolean {
  if (opts?.verbose) return true;
  if (readHybridMemVerbose(cmd)) return true;
  if (getEnv("HYBRID_MEMORY_VERBOSE") === "1") return true;
  return argvHasHybridMemVerbose(argv);
}
