import { Type } from "@sinclair/typebox";

/**
 * Mock for openclaw/plugin-sdk — provides just the exports
 * that index.ts actually uses so tests can import the module.
 */

/** CLI program type for registerCli — use any for action callback to accept Commander-style handlers. */
type CliProgram = {
  command: (name: string) => CliProgram;
  description: (d: string) => CliProgram;
  option: (flags: string, desc: string, defaultValue?: string) => CliProgram;
  requiredOption: (flags: string, desc: string, defaultValue?: string) => CliProgram;
  argument: (name: string, desc?: string, defaultValue?: string) => CliProgram;
  action: (fn: (...args: any[]) => any) => CliProgram;
};

export type ClawdbotPluginApi = {
  resolvePath: (p: string) => string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerCli: (fn: (opts: { program: CliProgram }) => void, options?: { commands?: string[] }) => void;
  on: (event: string, handler: (ev: unknown) => void | Promise<void> | Promise<unknown>) => void;
  /** Register an HTTP route with the OpenClaw gateway (2026.5+ object API). */
  registerHttpRoute: (params: {
    path: string;
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void | Promise<void>;
    auth: "gateway" | "plugin";
    match?: "exact";
  }) => void;
  [key: string]: unknown;
};
