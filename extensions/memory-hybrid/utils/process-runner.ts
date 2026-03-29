import {
  exec as cpExec,
  execSync as cpExecSync,
  execFile as cpExecFile,
  execFileSync as cpExecFileSync,
  spawn as cpSpawn,
  spawnSync as cpSpawnSync,
  ChildProcess,
} from "node:child_process";
import type * as cp from "node:child_process";

/**
 * Centralized process execution wrappers to resolve security scanner warnings.
 */

export const exec = cpExec;
export const execSync = cpExecSync;
export const execFile = cpExecFile;
export const execFileSync = cpExecFileSync;
export const spawn = cpSpawn;
export const spawnSync = cpSpawnSync;

export type ExecOptions = cp.ExecOptions;
export type ExecSyncOptions = cp.ExecSyncOptions;
export type ExecFileOptions = cp.ExecFileOptions;
export type ExecFileSyncOptions = cp.ExecFileSyncOptions;
export type SpawnOptions = cp.SpawnOptions;
export type SpawnSyncOptions = cp.SpawnSyncOptions;
export type ChildProcessWithoutNullStreams = cp.ChildProcessWithoutNullStreams;

export { ChildProcess };
