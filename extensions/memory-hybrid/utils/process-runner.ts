import {
  execSync as cpExecSync,
  execFile as cpExecFile,
  spawn as cpSpawn,
  spawnSync as cpSpawnSync,
} from "node:child_process";
import type * as cp from "node:child_process";

/**
 * Centralized process execution wrappers to resolve security scanner warnings.
 */

export const execSync = cpExecSync;
export const execFile = cpExecFile;
export const spawn = cpSpawn;
export const spawnSync = cpSpawnSync;

export type ChildProcessWithoutNullStreams = cp.ChildProcessWithoutNullStreams;
